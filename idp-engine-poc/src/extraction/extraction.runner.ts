import { gzipSync } from 'node:zlib';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { EngineError, type EngineResult } from '../engines/engine.port';
import { EngineRegistry } from '../engines/engine-registry';
import { FormRegistry } from '../forms/form-registry';
import { buildJsonSchema } from '../forms/json-schema.builder';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE, storageKeys, type StoragePort } from '../storage/storage';
import { flagsFor, thresholdFor } from './review-flags';

/**
 * Runs one Extraction row end to end. Idempotent: a SUCCEEDED row is left alone, so a re-delivered
 * queue job costs nothing. Raw output is written to storage before the DB update (plan 04 §3).
 */
@Injectable()
export class ExtractionRunner {
  private readonly logger = new Logger(ExtractionRunner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly engines: EngineRegistry,
    private readonly forms: FormRegistry,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async run(extractionId: string): Promise<void> {
    const ex = await this.prisma.extraction.findUnique({
      where: { id: extractionId },
      include: { document: { include: { pages: { orderBy: { pageNumber: 'asc' } } } } },
    });
    if (!ex) throw new NotFoundException({ code: 'EXTRACTION_NOT_FOUND' });
    if (ex.status === 'SUCCEEDED') return;

    await this.prisma.extraction.update({
      where: { id: ex.id },
      data: {
        status: 'RUNNING',
        startedAt: new Date(),
        attempts: { increment: 1 },
        errorCode: null,
      },
    });
    const started = Date.now();
    const log = {
      extractionId: ex.id,
      documentId: ex.documentId,
      engine: ex.engine,
      formType: ex.formType,
    };
    this.logger.log({ msg: 'extraction.started', ...log, pages: ex.document.pageCount });

    try {
      const form = this.forms.get(ex.formType);
      const { schema } = buildJsonSchema(form);
      const [original, ...pageBytes] = await Promise.all([
        this.storage.get(ex.document.storageKey),
        ...ex.document.pages.map((p) => this.storage.get(p.storageKey)),
      ]);
      const result: EngineResult = await this.engines.get(ex.engine).extract({
        tenantId: ex.tenantId,
        documentId: ex.documentId,
        form,
        schema,
        document: {
          bytes: original!,
          mimeType: ex.document.mimeType,
          pageCount: ex.document.pageCount,
        },
        pages: ex.document.pages.map((p, i) => ({
          pageNumber: p.pageNumber,
          bytes: pageBytes[i]!,
        })),
      });

      const rawKey = storageKeys.raw(ex.tenantId, ex.documentId, ex.engine, ex.id);
      await this.storage.put(rawKey, gzipSync(JSON.stringify(result.raw)), 'application/gzip');

      const byPath = new Map(result.fields.map((f) => [f.path, f]));
      let needsReview = false;
      const rows: Prisma.ExtractedFieldCreateManyInput[] = form.fields.map((def) => {
        const f = byPath.get(def.path)!;
        const flags = flagsFor(
          def,
          f,
          thresholdFor(form, def, this.cfg.engines.defaultMinConfidence),
          result.warnings,
        );
        if (flags.length) needsReview = true;
        return {
          tenantId: ex.tenantId,
          extractionId: ex.id,
          path: def.path,
          label: def.label,
          canonicalKey: def.canonicalKey ?? null,
          valueType: def.type,
          value: f.value === null ? undefined : f.value,
          confidence: f.confidence,
          confidenceSource: f.confidenceSource,
          page: f.page,
          bbox: f.bbox ? { ...f.bbox } : undefined,
          groundingText: f.groundingText ?? null,
          flags,
        };
      });

      const latencyMs = Date.now() - started;
      await this.prisma.$transaction([
        this.prisma.extractedField.deleteMany({ where: { extractionId: ex.id } }),
        this.prisma.extractedField.createMany({ data: rows }),
        this.prisma.extraction.update({
          where: { id: ex.id },
          data: {
            status: 'SUCCEEDED',
            needsReview,
            rawKey,
            externalId: result.externalId ?? null,
            costUsd: result.costUsd ?? null,
            estCostUsd: result.estCostUsd ?? null,
            modelVersion: result.modelVersion ?? null,
            latencyMs,
            finishedAt: new Date(),
          },
        }),
      ]);
      this.logger.log({
        msg: 'extraction.succeeded',
        ...log,
        latencyMs,
        fields: rows.length,
        flagged: rows.filter((r) => (r.flags as string[]).length).length,
      });
    } catch (e) {
      const code = e instanceof EngineError ? e.code : e instanceof Error ? e.name : 'INTERNAL';
      await this.prisma.extraction.update({
        where: { id: ex.id },
        data: {
          status: 'FAILED',
          errorCode: code.slice(0, 120),
          finishedAt: new Date(),
          latencyMs: Date.now() - started,
        },
      });
      this.logger.warn({
        msg: 'extraction.failed',
        ...log,
        code,
        retryable: e instanceof EngineError && e.retryable,
      });
      throw e;
    }
  }
}
