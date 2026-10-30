import {
  capturesOther,
  groupCellPath,
  OTHER_FIELDS_PATH,
  otherPath,
  type FormDefinition,
} from '../forms/form-definition';
import { getAtPath } from '../forms/json-schema.builder';
import { fieldsInFormOrder, type BBox, type EngineField } from './engine.port';

/** Provenance an engine can attach to one value. */
export interface ValueMeta {
  confidence: number | null;
  confidenceSource: EngineField['confidenceSource'];
  page: number | null;
  bbox: BBox | null;
  groundingText?: string;
}

/**
 * Looks up provenance for one value.
 * @param container the object holding the value (root, a group row, or an otherFields item)
 * @param key       the value's path inside the container ('member.id', 'cptHcpcs', 'value')
 * @param fullPath  the engine-neutral path ('serviceLines[0].cptHcpcs', 'otherFields[2]')
 */
export type MetaLookup = (
  container: unknown,
  key: string,
  fullPath: string,
) => ValueMeta | undefined;

const NO_META: ValueMeta = { confidence: null, confidenceSource: 'none', page: null, bbox: null };

/**
 * Walks a schema-shaped JSON result (VLM Run response, Meibel output.json, fake output) and emits
 * EngineFields for scalars, group rows and otherFields. Shared so every schema engine treats
 * nulls, empty rows and row caps identically; each engine only supplies its MetaLookup.
 */
export function walkSchemaResult(
  form: FormDefinition,
  data: unknown,
  meta: MetaLookup,
): EngineField[] {
  const found = new Map<string, EngineField>();
  for (const field of form.fields) {
    const raw = getAtPath(data, field.path);
    if (raw === undefined) continue;
    found.set(field.path, build(field.path, raw, meta(data, field.path, field.path)));
  }
  const out = fieldsInFormOrder(form, found);

  for (const group of form.groups ?? []) {
    const rows = getAtPath(data, group.path);
    if (!Array.isArray(rows)) continue;
    let rowIndex = 0;
    for (const row of rows) {
      if (rowIndex >= group.maxRows) break;
      const cells = group.columns.map((col) => {
        const path = groupCellPath(group, rowIndex, col);
        return build(path, getAtPath(row, col.path) ?? null, meta(row, col.path, path));
      });
      if (cells.every((c) => c.value === null)) continue; // drop blank rows, keep numbering dense
      out.push(...cells);
      rowIndex++;
    }
  }

  if (capturesOther(form)) {
    const items = getAtPath(data, OTHER_FIELDS_PATH);
    if (Array.isArray(items)) {
      let i = 0;
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const label = toValue((item as Record<string, unknown>).label);
        if (typeof label !== 'string') continue;
        const path = otherPath(i++);
        out.push({
          ...build(
            path,
            (item as Record<string, unknown>).value ?? null,
            meta(item, 'value', path),
          ),
          label,
        });
      }
    }
  }
  return out;
}

function build(path: string, raw: unknown, m: ValueMeta | undefined): EngineField {
  const value = toValue(raw);
  const md = m ?? NO_META;
  return {
    path,
    value,
    confidence: value === null ? null : md.confidence,
    confidenceSource: value === null ? 'none' : md.confidenceSource,
    page: md.page,
    bbox: md.bbox,
    ...(md.groundingText ? { groundingText: md.groundingText } : {}),
  };
}

export function toValue(raw: unknown): string | boolean | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return String(raw);
  if (typeof raw === 'string') return raw.trim() === '' ? null : raw.trim();
  return null;
}
