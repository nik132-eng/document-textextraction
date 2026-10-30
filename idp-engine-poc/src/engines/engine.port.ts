import type { FormDefinition } from '../forms/form-definition';
import type { JsonSchema } from '../forms/json-schema.builder';

/**
 * THE SEAM. Everything engine-specific lives behind `ExtractionEngine.extract`.
 * The pipeline, storage, review flags and API only ever see `EngineField[]`.
 *
 * To add or swap an engine: implement this interface in src/engines/<name>/, register it in
 * engines.module.ts, add its env vars to app-config.ts. Nothing else changes.
 */
export const ENGINE_NAMES = ['fake', 'textract', 'vlmrun', 'meibel'] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];

/** Normalized 0..1, top-left origin (Textract's convention; other engines convert to it). */
export interface BBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface EngineRequest {
  tenantId: string;
  documentId: string;
  form: FormDefinition;
  /** JSON Schema built from `form` (schema engines send it; Textract ignores it). */
  schema: JsonSchema;
  /**
   * The document after conversion (PDF or image; Word arrives here as PDF).
   * Schema engines send this file, so the vendor sees the real layout.
   */
  document: { bytes: Buffer; mimeType: string; pageCount: number };
  /** Rasterized pages (PNG, 1-based). Textract sends these, one sync call per page. */
  pages: { pageNumber: number; bytes: Buffer }[];
}

/**
 * One extracted value, engine-neutral (shared-engine-adapter §5 EvSchemaField). Paths:
 *   scalar      'patient.dob'
 *   group cell  'serviceLines[0].cptHcpcs'
 *   other value 'otherFields[3]'  (label = the printed caption)
 */
export interface EngineField {
  path: string;
  /** Printed label, for otherFields entries (form fields take the label from the definition). */
  label?: string;
  /** As printed. null = blank / not found. Never a guess. */
  value: string | boolean | null;
  /** 0..100 after mapping; null = engine gave none. */
  confidence: number | null;
  confidenceSource: 'numeric' | 'band' | 'judged' | 'none';
  /** Document page number (1-based). */
  page: number | null;
  bbox: BBox | null;
  groundingText?: string;
}

export interface EngineResult {
  /** One entry per scalar field (form order), then group cells of non-empty rows, then otherFields. */
  fields: EngineField[];
  /** Untouched vendor response; stored as immutable gzip JSON for audit and free re-mapping. */
  raw: unknown;
  externalId?: string;
  /** Actual cost from the vendor response, when it reports one. */
  costUsd?: number;
  /** Our estimate from the price table, when the vendor does not report cost. */
  estCostUsd?: number;
  modelVersion?: string;
  /** Run-level warnings that apply to every field, e.g. 'engine_fallback'. */
  warnings?: string[];
}

export interface ExtractionEngine {
  readonly name: EngineName;
  /**
   * Runs the whole vendor round trip (upload, submit, poll, fetch, cleanup) and maps the response.
   * Throws EngineError; `retryable` tells the queue whether to try again.
   */
  extract(req: EngineRequest): Promise<EngineResult>;
}

export const EXTRACTION_ENGINES = Symbol('EXTRACTION_ENGINES');

/** Errors carry a code and status only, never response bodies (they can contain PHI). */
export class EngineError extends Error {
  constructor(
    readonly engine: EngineName,
    readonly code: string,
    readonly retryable: boolean,
    readonly httpStatus?: number,
    readonly retryAfterMs?: number,
  ) {
    super(`${engine}:${code}${httpStatus ? `:${httpStatus}` : ''}`);
    this.name = 'EngineError';
  }
}

/** Builds the per-field list in form order, filling gaps with explicit nulls. */
export function fieldsInFormOrder(
  form: FormDefinition,
  found: Map<string, EngineField>,
): EngineField[] {
  return form.fields.map(
    (f) =>
      found.get(f.path) ?? {
        path: f.path,
        value: null,
        confidence: null,
        confidenceSource: 'none',
        page: null,
        bbox: null,
      },
  );
}
