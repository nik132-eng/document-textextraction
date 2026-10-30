import { gzipSync } from 'node:zlib';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { EngineError, type EngineField, type EngineResult } from '../engines/engine.port';
import { EngineRegistry } from '../engines/engine-registry';
import { resolvePath, type FormDefinition } from '../forms/form-definition';
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
    const doc = ex.document;
    const log = {
      extractionId: ex.id,
      documentId: ex.documentId,
      engine: ex.engine,
      formType: ex.formType,
    };
    this.logger.log({ msg: 'extraction.started', ...log, pages: doc.pageCount });

    try {
      const form = this.forms.get(ex.formType);
      const { schema } = buildJsonSchema(form);
      const [normalized, ...pageBytes] = await Promise.all([
        this.storage.get(doc.normalizedKey ?? doc.storageKey),
        ...doc.pages.map((p) => this.storage.get(p.storageKey)),
      ]);
      const result: EngineResult = await this.engines.get(ex.engine).extract({
        tenantId: ex.tenantId,
        documentId: ex.documentId,
        form,
        schema,
        document: {
          bytes: normalized!,
          mimeType: doc.normalizedMimeType ?? doc.mimeType,
          pageCount: doc.pageCount,
        },
        pages: doc.pages.map((p, i) => ({ pageNumber: p.pageNumber, bytes: pageBytes[i]! })),
      });

      const rawKey = storageKeys.raw(ex.tenantId, ex.documentId, ex.engine, ex.id);
      await this.storage.put(rawKey, gzipSync(JSON.stringify(result.raw)), 'application/gzip');

      const rows = toRows(form, result, ex.tenantId, ex.id, this.cfg.engines.defaultMinConfidence);
      const needsReview = rows.some((r) => (r.flags as string[]).length > 0);
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
        groupCells: rows.filter((r) => r.source === 'group').length,
        other: rows.filter((r) => r.source === 'other').length,
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

/** EngineResult -> EAV rows. Unknown paths from an engine are dropped (never stored unvalidated). */
export function toRows(
  form: FormDefinition,
  result: EngineResult,
  tenantId: string,
  extractionId: string,
  envMinConfidence: number,
): Prisma.ExtractedFieldCreateManyInput[] {
  const rows: Prisma.ExtractedFieldCreateManyInput[] = [];
  const seen = new Set<string>();
  for (const f of result.fields) {
    if (seen.has(f.path)) continue;
    const ref = resolvePath(form, f.path);
    if (!ref) continue;
    seen.add(f.path);
    const def = ref.kind === 'field' ? ref.def : ref.kind === 'group' ? ref.column : null;
    rows.push({
      tenantId,
      extractionId,
      path: f.path,
      label: def?.label ?? (f.label ?? 'Unlabelled').slice(0, 300),
      source: ref.kind,
      groupPath: ref.kind === 'group' ? ref.group.path : null,
      rowIndex: ref.kind === 'group' ? ref.row : ref.kind === 'other' ? ref.index : null,
      canonicalKey: def?.canonicalKey ?? null,
      valueType: def?.type ?? (typeof f.value === 'boolean' ? 'checkbox' : 'text'),
      value: f.value === null ? undefined : f.value,
      confidence: f.confidence,
      confidenceSource: f.confidenceSource,
      page: f.page,
      bbox: f.bbox ? { ...f.bbox } : undefined,
      groundingText: f.groundingText ?? null,
      flags: flagsFor(
        def,
        f as EngineField,
        thresholdFor(form, ref, envMinConfidence),
        result.warnings,
      ),
    });
  }
  return rows;
}
