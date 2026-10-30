import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { detectMime, extensionFor, sha256 } from '../common/util';
import { EngineRegistry } from '../engines/engine-registry';
import type { EngineName } from '../engines/engine.port';
import { ExtractionDispatcher } from '../extraction/extraction.dispatcher';
import type { FormDefinition } from '../forms/form-definition';
import { FormRegistry } from '../forms/form-registry';
import { buildJsonSchema } from '../forms/json-schema.builder';
import type { Document } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RasterizerService } from '../rasterizer/rasterizer.service';
import { STORAGE, storageKeys, type StoragePort } from '../storage/storage';

export interface ExtractionSummary {
  id: string;
  engine: string;
  status: string;
  needsReview: boolean;
  errorCode: string | null;
  reused: boolean;
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly forms: FormRegistry,
    private readonly engines: EngineRegistry,
    private readonly rasterizer: RasterizerService,
    private readonly dispatcher: ExtractionDispatcher,
    @Inject(STORAGE) private readonly storage: StoragePort,
  ) {}

  /** Upload -> sha256 dedupe -> store original + page PNGs -> one extraction per requested engine. */
  async upload(tenantId: string, bytes: Buffer, formType: string, enginesCsv?: string) {
    const mime = detectMime(bytes);
    if (!mime) {
      throw new UnsupportedMediaTypeException({
        code: 'UNSUPPORTED_FILE',
        message: 'PDF, PNG, JPEG or TIFF only',
      });
    }
    const form = this.forms.get(formType);
    const engineNames = this.engines.resolve(enginesCsv);
    const hash = sha256(bytes);

    let doc = await this.prisma.document.findUnique({
      where: { tenantId_sha256: { tenantId, sha256: hash } },
    });
    const deduplicated = !!doc;
    if (!doc) {
      const id = randomUUID();
      const storageKey = storageKeys.original(tenantId, id, extensionFor(mime));
      await this.storage.put(storageKey, bytes, mime);
      const pages = await this.rasterizer.rasterize(bytes, mime);
      const pageRows = [];
      for (const p of pages) {
        const key = storageKeys.page(tenantId, id, p.pageNumber);
        await this.storage.put(key, p.png, 'image/png');
        pageRows.push({
          tenantId,
          pageNumber: p.pageNumber,
          storageKey: key,
          sha256: sha256(p.png),
          widthPx: p.width,
          heightPx: p.height,
        });
      }
      doc = await this.prisma.document.create({
        data: {
          id,
          tenantId,
          sha256: hash,
          mimeType: mime,
          sizeBytes: bytes.length,
          pageCount: pages.length,
          formType,
          storageKey,
          pages: { create: pageRows },
        },
      });
      this.logger.log({
        msg: 'document.ingested',
        documentId: id,
        pages: pages.length,
        sizeBytes: bytes.length,
      });
    }

    const extractions: ExtractionSummary[] = [];
    for (const engine of engineNames)
      extractions.push(await this.requestExtraction(tenantId, doc, engine, form));
    return { documentId: doc.id, deduplicated, pageCount: doc.pageCount, formType, extractions };
  }

  async extractAgain(tenantId: string, documentId: string, engine: string, formType?: string) {
    const doc = await this.getDocumentRow(tenantId, documentId);
    const form = this.forms.get(formType ?? doc.formType);
    const name = this.engines.resolve(engine)[0]!;
    return this.requestExtraction(tenantId, doc, name, form);
  }

  /**
   * Same engine + form version + schema + file -> reuse the earlier run instead of paying again
   * (plan 04 §1 requestHash rule). An in-flight run is also returned instead of starting a second.
   */
  private async requestExtraction(
    tenantId: string,
    doc: Document,
    engine: EngineName,
    form: FormDefinition,
  ): Promise<ExtractionSummary> {
    const { schemaHash } = buildJsonSchema(form);
    const requestHash = sha256([engine, form.id, form.version, schemaHash, doc.sha256].join('|'));
    const existing = await this.prisma.extraction.findFirst({
      where: { tenantId, requestHash, status: { in: ['QUEUED', 'RUNNING', 'SUCCEEDED'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return summary(existing, true);

    const created = await this.prisma.extraction.create({
      data: {
        tenantId,
        documentId: doc.id,
        engine,
        formType: form.id,
        formVersion: form.version,
        schemaHash,
        requestHash,
      },
    });
    await this.dispatcher.dispatch(created.id);
    const fresh = await this.prisma.extraction.findUniqueOrThrow({ where: { id: created.id } });
    return summary(fresh, false);
  }

  async getDocument(tenantId: string, id: string) {
    const doc = await this.prisma.document.findFirst({
      where: { id, tenantId },
      include: { extractions: { orderBy: { createdAt: 'desc' } } },
    });
    if (!doc) throw new NotFoundException({ code: 'DOCUMENT_NOT_FOUND' });
    return {
      id: doc.id,
      formType: doc.formType,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes,
      pageCount: doc.pageCount,
      createdAt: doc.createdAt,
      extractions: doc.extractions.map((e) => ({
        ...summary(e, false),
        formType: e.formType,
        costUsd: e.costUsd === null ? null : Number(e.costUsd),
        estCostUsd: e.estCostUsd === null ? null : Number(e.estCostUsd),
        latencyMs: e.latencyMs,
        createdAt: e.createdAt,
      })),
    };
  }

  async getPage(tenantId: string, documentId: string, pageNumber: number): Promise<Buffer> {
    const page = await this.prisma.page.findFirst({ where: { tenantId, documentId, pageNumber } });
    if (!page) throw new NotFoundException({ code: 'PAGE_NOT_FOUND' });
    return this.storage.get(page.storageKey);
  }

  async getExtraction(tenantId: string, id: string) {
    const ex = await this.prisma.extraction.findFirst({
      where: { id, tenantId },
      include: { fields: { orderBy: { path: 'asc' } } },
    });
    if (!ex) throw new NotFoundException({ code: 'EXTRACTION_NOT_FOUND' });
    const order = new Map(
      this.forms.has(ex.formType)
        ? this.forms.get(ex.formType).fields.map((f, i) => [f.path, i])
        : [],
    );
    return {
      ...summary(ex, false),
      documentId: ex.documentId,
      formType: ex.formType,
      formVersion: ex.formVersion,
      modelVersion: ex.modelVersion,
      costUsd: ex.costUsd === null ? null : Number(ex.costUsd),
      estCostUsd: ex.estCostUsd === null ? null : Number(ex.estCostUsd),
      latencyMs: ex.latencyMs,
      attempts: ex.attempts,
      fields: ex.fields
        .sort((a, b) => (order.get(a.path) ?? 999) - (order.get(b.path) ?? 999))
        .map((f) => ({
          path: f.path,
          label: f.label,
          canonicalKey: f.canonicalKey,
          valueType: f.valueType,
          value: f.value ?? null,
          confidence: f.confidence,
          confidenceSource: f.confidenceSource,
          page: f.page,
          bbox: f.bbox,
          flags: f.flags,
        })),
    };
  }

  private async getDocumentRow(tenantId: string, id: string): Promise<Document> {
    const doc = await this.prisma.document.findFirst({ where: { id, tenantId } });
    if (!doc) throw new NotFoundException({ code: 'DOCUMENT_NOT_FOUND' });
    return doc;
  }
}

function summary(
  e: { id: string; engine: string; status: string; needsReview: boolean; errorCode: string | null },
  reused: boolean,
): ExtractionSummary {
  return {
    id: e.id,
    engine: e.engine,
    status: e.status,
    needsReview: e.needsReview,
    errorCode: e.errorCode,
    reused,
  };
}
