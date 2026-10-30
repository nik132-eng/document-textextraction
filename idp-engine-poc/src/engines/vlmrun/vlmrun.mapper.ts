import type { FormDefinition } from '../../forms/form-definition';
import { getAtPath } from '../../forms/json-schema.builder';
import { clamp01 } from '../http';
import { fieldsInFormOrder, type BBox, type EngineField } from '../engine.port';

/**
 * VLM Run prediction.response -> EngineField[] (pure).
 *
 * ASSUMED SHAPE — UNVERIFIED (vlm-run/research.md §6.6, §8 Q3). Replace with the shape seen in the
 * first recorded synthetic fixture, and keep the guesswork in this one file. Accepted today:
 *   (a) sibling key:  { member: { id: "X", id_metadata: { bboxes: [...], confidence: "hi" } } }
 *   (b) parent map:   { member: { id: "X", _metadata: { id: { ... } } } }
 *   (c) root map:     { member: { id: "X" }, _metadata: { "member.id": { ... } } }
 * bboxes[].xywh: normalized [x, y, w, h], top-left origin. bboxes[].page: 0-based.
 * confidence: band ("high"|"hi"|"medium"|"med"|"low"|"lo") mapped via VLMRUN_CONFIDENCE_MAP.
 */
interface VlmBox {
  content?: string;
  xywh?: number[];
  page?: number;
}
interface VlmMeta {
  bboxes?: VlmBox[];
  confidence?: string | number;
}

const BAND_ALIASES: Record<string, string> = { hi: 'high', med: 'medium', lo: 'low' };

export function mapVlmRunResponse(
  form: FormDefinition,
  response: unknown,
  confidenceMap: Record<string, number>,
): EngineField[] {
  const found = new Map<string, EngineField>();
  for (const field of form.fields) {
    const raw = getAtPath(response, field.path);
    if (raw === undefined) continue;
    const value = toValue(raw);
    const meta = findMeta(response, field.path);
    const box = meta?.bboxes?.find((b) => Array.isArray(b.xywh) && b.xywh.length === 4);
    const { confidence, source } = toConfidence(meta?.confidence, confidenceMap);
    found.set(field.path, {
      path: field.path,
      value,
      confidence: value === null ? null : confidence,
      confidenceSource: value === null ? 'none' : source,
      page: typeof box?.page === 'number' ? box.page + 1 : null,
      bbox: box ? unionBox(meta!.bboxes!) : null,
      groundingText: meta?.bboxes?.[0]?.content,
    });
  }
  return fieldsInFormOrder(form, found);
}

function toValue(raw: unknown): string | boolean | null {
  if (raw === null) return null;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return String(raw);
  if (typeof raw === 'string') return raw.trim() === '' ? null : raw.trim();
  return null;
}

function findMeta(response: unknown, path: string): VlmMeta | undefined {
  const segs = path.split('.');
  const leaf = segs.at(-1)!;
  const parent = segs.length > 1 ? getAtPath(response, segs.slice(0, -1).join('.')) : response;
  const asMeta = (x: unknown) => (x && typeof x === 'object' ? (x as VlmMeta) : undefined);
  if (parent && typeof parent === 'object') {
    const p = parent as Record<string, unknown>;
    const sibling = asMeta(p[`${leaf}_metadata`]);
    if (sibling) return sibling;
    const map = p._metadata as Record<string, unknown> | undefined;
    if (map && typeof map === 'object' && asMeta(map[leaf])) return asMeta(map[leaf]);
  }
  const root = (response as Record<string, unknown> | null)?._metadata as
    | Record<string, unknown>
    | undefined;
  return root && typeof root === 'object' ? asMeta(root[path]) : undefined;
}

function toConfidence(
  c: string | number | undefined,
  map: Record<string, number>,
): { confidence: number | null; source: EngineField['confidenceSource'] } {
  if (typeof c === 'number') return { confidence: c <= 1 ? c * 100 : c, source: 'numeric' };
  if (typeof c === 'string') {
    const band = BAND_ALIASES[c.toLowerCase()] ?? c.toLowerCase();
    if (map[band] !== undefined) return { confidence: map[band], source: 'band' };
  }
  return { confidence: null, source: 'none' };
}

/** Several boxes for one value (e.g. a name on two lines) -> their union, clamped to 0..1. */
function unionBox(boxes: VlmBox[]): BBox | null {
  const valid = boxes.filter((b) => Array.isArray(b.xywh) && b.xywh.length === 4);
  if (valid.length === 0) return null;
  const firstPage = valid[0]!.page;
  const same = valid.filter((b) => b.page === firstPage);
  const left = Math.min(...same.map((b) => b.xywh![0]!));
  const top = Math.min(...same.map((b) => b.xywh![1]!));
  const right = Math.max(...same.map((b) => b.xywh![0]! + b.xywh![2]!));
  const bottom = Math.max(...same.map((b) => b.xywh![1]! + b.xywh![3]!));
  const l = clamp01(left);
  const t = clamp01(top);
  return { left: l, top: t, width: clamp01(right) - l, height: clamp01(bottom) - t };
}
