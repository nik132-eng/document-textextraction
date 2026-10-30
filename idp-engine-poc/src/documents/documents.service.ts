import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { detectMime, extensionFor, sha256 } from '../common/util';
import { ConverterService } from '../conversion/converter.service';
import { EngineRegistry } from '../engines/engine-registry';
import type { EngineName } from '../engines/engine.port';
import { ExtractionDispatcher } from '../extraction/extraction.dispatcher';
import { classifyText, type Classification } from '../forms/classifier';
import type { FormDefinition } from '../forms/form-definition';
import { FormRegistry } from '../forms/form-registry';
import { buildJsonSchema } from '../forms/json-schema.builder';
import type { Document, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RasterizerService, type RasterPage } from '../rasterizer/rasterizer.service';
import { STORAGE, storageKeys, type StoragePort } from '../storage/storage';

export interface ExtractionSummary {
  id: string;
  engine: string;
  status: string;
  needsReview: boolean;
  errorCode: string | null;
  reused: boolean;
}

/** Pages OCR'd for classification when there is no text layer (cost guard). */
const MAX_OCR_PAGES = 3;
/** Below this many characters a page counts as having no text layer. */
const MIN_TEXT_CHARS = 20;

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly forms: FormRegistry,
    private readonly engines: EngineRegistry,
    private readonly converter: ConverterService,
    private readonly rasterizer: RasterizerService,
    private readonly dispatcher: ExtractionDispatcher,
    @Inject(STORAGE) private readonly storage: StoragePort,
  ) {}

  /**
   * Upload -> detect type -> sha256 dedupe -> convert (Word -> PDF) -> store original, normalized
   * and page PNGs -> classify (unless formType given) -> one extraction per requested engine.
   */
  async upload(tenantId: string, bytes: Buffer, formType?: string, enginesCsv?: string) {
    const mime = detectMime(bytes);
    if (!mime) {
      throw new UnsupportedMediaTypeException({
        code: 'UNSUPPORTED_FILE',
        message: 'Accepted: PDF, PNG, JPEG, TIFF, DOCX',
      });
    }
    if (formType) this.forms.get(formType); // 404 early on an unknown hint
    const engineNames = this.engines.resolve(enginesCsv);
    const hash = sha256(bytes);

    let doc = await this.prisma.document.findUnique({
      where: { tenantId_sha256: { tenantId, sha256: hash } },
    });
    const deduplicated = !!doc;
    if (!doc) {
      const id = randomUUID();
      const normalized = await this.converter.normalize(bytes, mime);
      const storageKey = storageKeys.original(tenantId, id, extensionFor(mime));
      await this.storage.put(storageKey, bytes, mime);
      let normalizedKey: string | null = null;
      if (normalized.conversion !== 'none') {
        normalizedKey = storageKeys.normalized(tenantId, id);
        await this.storage.put(normalizedKey, normalized.bytes, normalized.mimeType);
      }
      const pages = await this.rasterizer.rasterize(normalized.bytes, normalized.mimeType);
      const classification = formType ? hint(formType) : await this.classify(pages);

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
          formType: classification.formType,
          formTypeSource: classification.source,
          classification: {
            score: classification.score,
            scores: classification.scores,
            hadText: classification.hadText,
          } as Prisma.InputJsonValue,
          storageKey,
          conversion: normalized.conversion,
          normalizedKey,
          normalizedMimeType: normalizedKey ? normalized.mimeType : null,
          pages: { create: pageRows },
        },
      });
      this.logger.log({
        msg: 'document.ingested',
        documentId: id,
        pages: pages.length,
        sizeBytes: bytes.length,
        conversion: normalized.conversion,
        formType: classification.formType,
        formTypeSource: classification.source,
        score: classification.score,
      });
    }

    const form = this.forms.get(formType ?? doc.formType);
    const extractions: ExtractionSummary[] = [];
    for (const engine of engineNames)
      extractions.push(await this.requestExtraction(tenantId, doc, engine, form));
    return {
      documentId: doc.id,
      deduplicated,
      pageCount: doc.pageCount,
      mimeType: doc.mimeType,
      conversion: doc.conversion,
      formType: form.id,
      classification: {
        formType: doc.formType,
        source: doc.formTypeSource,
        ...(doc.classification as object | null),
      },
      extractions,
    };
  }

  /** Cue scoring on the PDF text layer; OCR (if configured) only for pages without one. */
  private async classify(pages: RasterPage[]): Promise<Classification> {
    const ocr = this.engines.pageOcr();
    const texts: string[] = [];
    let ocrUsed = 0;
    for (const p of pages) {
      if (p.text.trim().length >= MIN_TEXT_CHARS) texts.push(p.text);
      else if (ocr && ocrUsed < MAX_OCR_PAGES) {
        texts.push(await ocr(p.png));
        ocrUsed++;
      }
    }
    return classifyText(texts.join('\n'), this.forms.list());
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
      conversion: doc.conversion,
      sizeBytes: doc.sizeBytes,
      pageCount: doc.pageCount,
      classification: {
        formType: doc.formType,
        source: doc.formTypeSource,
        ...(doc.classification as object | null),
      },
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

  /**
   * One run with its values: `fields` (scalars), `groups` (rows of cells, e.g. Box 24) and
   * `other` (any other labelled value), plus a flat `values` map path -> value for easy use.
   */
  async getExtraction(tenantId: string, id: string) {
    const ex = await this.prisma.extraction.findFirst({
      where: { id, tenantId },
      include: { fields: true },
    });
    if (!ex) throw new NotFoundException({ code: 'EXTRACTION_NOT_FOUND' });
    const form = this.forms.has(ex.formType) ? this.forms.get(ex.formType) : undefined;
    const order = new Map((form?.fields ?? []).map((f, i) => [f.path, i]));
    const view = (f: (typeof ex.fields)[number]) => ({
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
    });

    const scalars = ex.fields
      .filter((f) => f.source === 'field')
      .sort((a, b) => (order.get(a.path) ?? 999) - (order.get(b.path) ?? 999))
      .map(view);
    const groups: Record<string, ReturnType<typeof view>[][]> = {};
    for (const g of form?.groups ?? []) {
      const cells = ex.fields.filter((f) => f.source === 'group' && f.groupPath === g.path);
      const rowCount = Math.max(-1, ...cells.map((c) => c.rowIndex ?? -1)) + 1;
      groups[g.path] = Array.from({ length: rowCount }, (_, r) =>
        g.columns
          .map((col) => cells.find((c) => c.rowIndex === r && c.path.endsWith(`].${col.path}`)))
          .filter((c): c is (typeof ex.fields)[number] => !!c)
          .map(view),
      );
    }
    const other = ex.fields
      .filter((f) => f.source === 'other')
      .sort((a, b) => (a.rowIndex ?? 0) - (b.rowIndex ?? 0))
      .map(view);

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
      fields: scalars,
      groups,
      other,
      values: valuesTree(ex.fields),
    };
  }

  private async getDocumentRow(tenantId: string, id: string): Promise<Document> {
    const doc = await this.prisma.document.findFirst({ where: { id, tenantId } });
    if (!doc) throw new NotFoundException({ code: 'DOCUMENT_NOT_FOUND' });
    return doc;
  }
}

const hint = (formType: string): Classification => ({
  formType,
  source: 'hint',
  score: 1,
  scores: [],
  hadText: false,
});

/** Rebuilds the form's JSON shape from rows: { patient: { dob }, serviceLines: [{...}], otherFields: [{label, value}] }. */
function valuesTree(
  fields: { path: string; label: string; source: string; value: unknown }[],
): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const f of [...fields].sort((a, b) =>
    a.path.localeCompare(b.path, 'en', { numeric: true }),
  )) {
    if (f.source === 'other') {
      const list = (root.otherFields ??= []) as unknown[];
      list.push({ label: f.label, value: f.value ?? null });
      continue;
    }
    const segs = f.path.replace(/\[(\d+)\]/g, '.$1').split('.');
    let cur: Record<string, unknown> | unknown[] = root;
    segs.forEach((seg, i) => {
      const last = i === segs.length - 1;
      const nextIsIndex = /^\d+$/.test(segs[i + 1] ?? '');
      const key = /^\d+$/.test(seg) ? Number(seg) : seg;
      const container = cur as Record<string | number, unknown>;
      if (last) container[key] = f.value ?? null;
      else cur = (container[key] ??= nextIsIndex ? [] : {}) as Record<string, unknown> | unknown[];
    });
  }
  return root;
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
