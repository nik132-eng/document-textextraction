import type { FormDefinition } from '../../forms/form-definition';
import { getAtPath } from '../../forms/json-schema.builder';
import { clamp01 } from '../http';
import { fieldsInFormOrder, type BBox, type EngineField } from '../engine.port';

/**
 * Meibel deep-transform artifacts -> EngineField[] (pure).
 *
 * ASSUMED SHAPE — UNVERIFIED (meibel/research.md §2, §8 Q5). Fix here after the first recorded
 * synthetic fixture. Accepted today:
 *   output.json:     { "<root_name>": {...} }  or the object itself
 *   provenance.json: { "<path>": entry | entry[] }  or  { fields: entry[] }  or  entry[]
 *     entry = { path?, page | page_number (0-based), bbox, image_size?, page_size?, origin?, confidence? | aeq? }
 *     bbox  = [x0,y0,x1,y1] or {x0,y0,x1,y1} in pixels (top-left, ÷ image_size),
 *             or PDF points with origin "bottom-left" (÷ page_size, y flipped),
 *             or {left,top,width,height} already normalized.
 * A value with no provenance gets bbox=null, which the review guard flags `ungrounded`.
 */
interface ProvEntry {
  path?: string;
  field?: string;
  page?: number;
  page_number?: number;
  bbox?: number[] | Record<string, number>;
  image_size?: { width: number; height: number };
  page_size?: { width: number; height: number };
  origin?: 'top-left' | 'bottom-left';
  confidence?: number;
  aeq?: number;
}

export interface MeibelMapOptions {
  rootName: string;
  /** MEIBEL_DEFAULT_FIELD_CONFIDENCE; undefined -> fields carry no confidence -> review. */
  defaultFieldConfidence?: number;
}

export function mapMeibelArtifacts(
  form: FormDefinition,
  output: unknown,
  provenance: unknown,
  opts: MeibelMapOptions,
): EngineField[] {
  const data = unwrapRoot(output, opts.rootName);
  const prov = indexProvenance(provenance, opts.rootName);
  const found = new Map<string, EngineField>();
  for (const field of form.fields) {
    const raw = getAtPath(data, field.path);
    if (raw === undefined) continue;
    const value = toValue(raw);
    const entry = prov.get(field.path);
    const page = entry ? (entry.page_number ?? entry.page) : undefined;
    let confidence: number | null = null;
    let source: EngineField['confidenceSource'] = 'none';
    const numeric = entry?.aeq ?? entry?.confidence;
    if (typeof numeric === 'number') {
      confidence = numeric <= 1 ? numeric * 100 : numeric;
      source = 'numeric';
    } else if (opts.defaultFieldConfidence !== undefined) {
      confidence = opts.defaultFieldConfidence;
      source = 'judged';
    }
    found.set(field.path, {
      path: field.path,
      value,
      confidence: value === null ? null : confidence,
      confidenceSource: value === null ? 'none' : source,
      page: typeof page === 'number' ? page + 1 : null,
      bbox: entry ? toBBox(entry) : null,
    });
  }
  return fieldsInFormOrder(form, found);
}

function unwrapRoot(output: unknown, rootName: string): unknown {
  if (output && typeof output === 'object' && rootName in (output as object)) {
    const keys = Object.keys(output as object);
    if (keys.length === 1) return (output as Record<string, unknown>)[rootName];
  }
  return output;
}

function indexProvenance(provenance: unknown, rootName: string): Map<string, ProvEntry> {
  const out = new Map<string, ProvEntry>();
  const strip = (p: string) => (p.startsWith(`${rootName}.`) ? p.slice(rootName.length + 1) : p);
  const add = (path: string | undefined, e: unknown) => {
    const entry = (Array.isArray(e) ? e[0] : e) as ProvEntry | undefined;
    const key = path ?? entry?.path ?? entry?.field;
    if (key && entry && typeof entry === 'object' && !out.has(strip(key)))
      out.set(strip(key), entry);
  };
  if (Array.isArray(provenance)) provenance.forEach((e) => add(undefined, e));
  else if (provenance && typeof provenance === 'object') {
    const p = provenance as Record<string, unknown>;
    if (Array.isArray(p.fields)) p.fields.forEach((e) => add(undefined, e));
    else Object.entries(p).forEach(([k, v]) => add(k, v));
  }
  return out;
}

function toValue(raw: unknown): string | boolean | null {
  if (raw === null) return null;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return String(raw);
  if (typeof raw === 'string') return raw.trim() === '' ? null : raw.trim();
  return null;
}

export function toBBox(e: ProvEntry): BBox | null {
  const b = e.bbox;
  if (!b) return null;
  if (!Array.isArray(b) && 'left' in b && 'top' in b) {
    return {
      left: clamp01(b.left!),
      top: clamp01(b.top!),
      width: clamp01(b.width ?? 0),
      height: clamp01(b.height ?? 0),
    };
  }
  const [x0, y0, x1, y1] = Array.isArray(b) ? b : [b.x0, b.y0, b.x1, b.y1];
  if ([x0, y0, x1, y1].some((n) => typeof n !== 'number')) return null;
  if (e.origin === 'bottom-left' && e.page_size) {
    // PDF points, origin bottom-left -> normalized top-left.
    const { width: w, height: h } = e.page_size;
    return box(x0! / w, 1 - y1! / h, x1! / w, 1 - y0! / h);
  }
  const size = e.image_size;
  if (!size) return null; // pixels without a page size cannot be normalized
  return box(x0! / size.width, y0! / size.height, x1! / size.width, y1! / size.height);
}

function box(l: number, t: number, r: number, btm: number): BBox {
  const left = clamp01(l);
  const top = clamp01(t);
  return { left, top, width: clamp01(r) - left, height: clamp01(btm) - top };
}
