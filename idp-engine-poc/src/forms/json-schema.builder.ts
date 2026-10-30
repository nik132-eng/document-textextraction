import { sha256, stableStringify } from '../common/util';
import type { FieldDef, FormDefinition } from './form-definition';

export interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
}

/**
 * Form definition -> JSON Schema for schema-first engines (shared-engine-adapter §4).
 * - Ask for text as printed (normalization stays in our code), checkbox -> boolean.
 * - Every key is required and nullable, so engines return explicit nulls instead of omitting keys.
 * - Descriptions carry the label only, never example values (no PHI in prompts).
 * - schemaHash feeds the extraction requestHash: a changed schema means a new billed run.
 */
export function buildJsonSchema(def: FormDefinition): { schema: JsonSchema; schemaHash: string } {
  const root: JsonSchema = objectNode(def.title);
  for (const field of def.fields) {
    const segments = field.path.split('.');
    let node = root;
    for (const seg of segments.slice(0, -1)) {
      node.properties![seg] ??= objectNode();
      if (!node.required!.includes(seg)) node.required!.push(seg);
      node = node.properties![seg]!;
    }
    const leaf = segments.at(-1)!;
    node.properties![leaf] = leafNode(field);
    node.required!.push(leaf);
  }
  return { schema: root, schemaHash: sha256(stableStringify(root)) };
}

const objectNode = (title?: string): JsonSchema => ({
  type: 'object',
  ...(title ? { title } : {}),
  properties: {},
  required: [],
  additionalProperties: false,
});

function leafNode(f: FieldDef): JsonSchema {
  if (f.type === 'checkbox') {
    return {
      type: ['boolean', 'null'],
      description: `${f.label}. true if checked, false if unchecked, null if not on the page.`,
    };
  }
  return {
    type: ['string', 'null'],
    description: `${f.label}. Exactly as printed; null if blank.`,
  };
}

/** Reads a dot path from a nested object. Missing -> undefined. */
export function getAtPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
