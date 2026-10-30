import type { FormDefinition } from '../../forms/form-definition';
import { getAtPath } from '../../forms/json-schema.builder';
import type { BBox, EngineField } from '../engine.port';
import { clamp01 } from '../http';
import { walkSchemaResult, type ValueMeta } from '../schema-result';

/**
 * VLM Run prediction.response -> EngineField[] (pure).
 *
 * ASSUMED SHAPE — UNVERIFIED (vlm-run/research.md §6.6, §8 Q3). Replace with the shape seen in the
 * first recorded synthetic fixture, and keep the guesswork in this one file. Accepted today:
 *   (a) sibling key:  { member: { id: "X", id_metadata: { bboxes: [...], confidence: "hi" } } }
 *   (b) parent map:   { member: { id: "X", _metadata: { id: { ... } } } }
 *   (c) root map:     { ..., _metadata: { "member.id": {...}, "serviceLines[0].cptHcpcs": {...} } }
 * Group rows and otherFields items use (a)/(b) inside the row object.
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
  const rootMap = asObject(asObject(response)?._metadata);
  return walkSchemaResult(form, response, (container, key, fullPath) => {
    const meta =
      findLocalMeta(container, key) ??
      asMeta(rootMap?.[fullPath]) ??
      asMeta(rootMap?.[fullPath.replace(/\[(\d+)\]/g, '.$1')]);
    return meta ? toValueMeta(meta, confidenceMap) : undefined;
  });
}

function findLocalMeta(container: unknown, key: string): VlmMeta | undefined {
  const segs = key.split('.');
  const leaf = segs.at(-1)!;
  const parent = asObject(
    segs.length > 1 ? getAtPath(container, segs.slice(0, -1).join('.')) : container,
  );
  if (!parent) return undefined;
  return asMeta(parent[`${leaf}_metadata`]) ?? asMeta(asObject(parent._metadata)?.[leaf]);
}

function toValueMeta(meta: VlmMeta, map: Record<string, number>): ValueMeta {
  const boxes = (meta.bboxes ?? []).filter((b) => Array.isArray(b.xywh) && b.xywh.length === 4);
  const first = boxes[0];
  const { confidence, source } = toConfidence(meta.confidence, map);
  return {
    confidence,
    confidenceSource: source,
    page: typeof first?.page === 'number' ? first.page + 1 : null,
    bbox: unionBox(boxes),
    groundingText: meta.bboxes?.[0]?.content,
  };
}

function toConfidence(c: string | number | undefined, map: Record<string, number>) {
  if (typeof c === 'number')
    return { confidence: c <= 1 ? c * 100 : c, source: 'numeric' as const };
  if (typeof c === 'string') {
    const band = BAND_ALIASES[c.toLowerCase()] ?? c.toLowerCase();
    if (map[band] !== undefined) return { confidence: map[band], source: 'band' as const };
  }
  return { confidence: null, source: 'none' as const };
}

/** Several boxes for one value (e.g. a name on two lines) -> their union on the first page, clamped. */
function unionBox(boxes: VlmBox[]): BBox | null {
  if (boxes.length === 0) return null;
  const same = boxes.filter((b) => b.page === boxes[0]!.page);
  const left = clamp01(Math.min(...same.map((b) => b.xywh![0]!)));
  const top = clamp01(Math.min(...same.map((b) => b.xywh![1]!)));
  const right = clamp01(Math.max(...same.map((b) => b.xywh![0]! + b.xywh![2]!)));
  const bottom = clamp01(Math.max(...same.map((b) => b.xywh![1]! + b.xywh![3]!)));
  return { left, top, width: right - left, height: bottom - top };
}

const asObject = (x: unknown) =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined;
const asMeta = (x: unknown) => asObject(x) as VlmMeta | undefined;
