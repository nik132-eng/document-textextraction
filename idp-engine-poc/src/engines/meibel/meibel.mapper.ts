import type { FormDefinition } from '../../forms/form-definition';
import type { BBox, EngineField } from '../engine.port';
import { clamp01 } from '../http';
import { walkSchemaResult } from '../schema-result';

/**
 * Meibel deep-transform artifacts -> EngineField[] (pure).
 *
 * ASSUMED SHAPE — UNVERIFIED (meibel/research.md §2, §8 Q5). Fix here after the first recorded
 * synthetic fixture. Accepted today:
 *   output.json:     { "<root_name>": {...} }  or the object itself
 *   provenance.json: { "<path>": entry | entry[] }  or  { fields: entry[] }  or  entry[]
 *     path  = 'member.id', 'serviceLines[0].cptHcpcs' or 'serviceLines.0.cptHcpcs',
 *             'otherFields[2]' / 'otherFields[2].value'; optionally prefixed with root_name
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
  return walkSchemaResult(form, data, (_container, _key, fullPath) => {
    const entry = prov.get(fullPath) ?? prov.get(`${fullPath}.value`);
    const numeric = entry?.aeq ?? entry?.confidence;
    let confidence: number | null = null;
    let confidenceSource: EngineField['confidenceSource'] = 'none';
    if (typeof numeric === 'number') {
      confidence = numeric <= 1 ? numeric * 100 : numeric;
      confidenceSource = 'numeric';
    } else if (opts.defaultFieldConfidence !== undefined) {
      confidence = opts.defaultFieldConfidence;
      confidenceSource = 'judged';
    }
    const page = entry ? (entry.page_number ?? entry.page) : undefined;
    return {
      confidence,
      confidenceSource,
      page: typeof page === 'number' ? page + 1 : null,
      bbox: entry ? toBBox(entry) : null,
    };
  });
}

function unwrapRoot(output: unknown, rootName: string): unknown {
  if (output && typeof output === 'object' && rootName in (output as object)) {
    if (Object.keys(output as object).length === 1)
      return (output as Record<string, unknown>)[rootName];
  }
  return output;
}

/** Index by canonical bracket path: 'a.0.b' -> 'a[0].b'; root prefix stripped. */
function indexProvenance(provenance: unknown, rootName: string): Map<string, ProvEntry> {
  const out = new Map<string, ProvEntry>();
  const canon = (p: string) =>
    (p.startsWith(`${rootName}.`) ? p.slice(rootName.length + 1) : p).replace(
      /\.(\d+)(?=\.|$)/g,
      '[$1]',
    );
  const add = (path: string | undefined, e: unknown) => {
    const entry = (Array.isArray(e) ? e[0] : e) as ProvEntry | undefined;
    const key = path ?? entry?.path ?? entry?.field;
    if (key && entry && typeof entry === 'object' && !out.has(canon(key)))
      out.set(canon(key), entry);
  };
  if (Array.isArray(provenance)) provenance.forEach((e) => add(undefined, e));
  else if (provenance && typeof provenance === 'object') {
    const p = provenance as Record<string, unknown>;
    if (Array.isArray(p.fields)) p.fields.forEach((e) => add(undefined, e));
    else Object.entries(p).forEach(([k, v]) => add(k, v));
  }
  return out;
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
