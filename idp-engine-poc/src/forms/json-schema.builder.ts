import { sha256, stableStringify } from '../common/util';
import {
  capturesOther,
  OTHER_FIELDS_PATH,
  type FieldDef,
  type FormDefinition,
} from './form-definition';

export interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  maxItems?: number;
}

/**
 * Form definition -> JSON Schema for schema-first engines (shared-engine-adapter §4).
 * - Text as printed (normalization stays in our code), checkbox -> boolean.
 * - Every key required + nullable, so engines return explicit nulls instead of dropping keys.
 * - Groups -> arrays of row objects (maxItems = printed rows).
 * - otherFields -> [{ label, value }] for anything else printed ("capture any value").
 * - Descriptions carry labels only, never example values (no PHI in prompts).
 * - schemaHash feeds requestHash: a changed schema means a new, billed run.
 */
export function buildJsonSchema(def: FormDefinition): { schema: JsonSchema; schemaHash: string } {
  const root = objectNode(def.title);
  for (const field of def.fields) addAt(root, field.path, leafNode(field));
  for (const group of def.groups ?? []) {
    const row = objectNode();
    for (const col of group.columns) addAt(row, col.path, leafNode(col));
    addAt(root, group.path, {
      type: 'array',
      description: `${group.label}. One item per printed row, top to bottom. Skip rows that are completely blank.`,
      maxItems: group.maxRows,
      items: row,
    });
  }
  if (capturesOther(def)) {
    addAt(root, OTHER_FIELDS_PATH, {
      type: 'array',
      description: def.generic
        ? 'Every labelled value printed on the document, in reading order. Label and value exactly as printed.'
        : 'Every other labelled value printed on the document that is not covered by the properties above. Label and value exactly as printed.',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'The printed label or caption' },
          value: { type: ['string', 'null'], description: 'The printed value; null if blank' },
        },
        required: ['label', 'value'],
        additionalProperties: false,
      },
    });
  }
  return { schema: root, schemaHash: sha256(stableStringify(root)) };
}

function addAt(root: JsonSchema, path: string, node: JsonSchema): void {
  const segments = path.split('.');
  let cur = root;
  for (const seg of segments.slice(0, -1)) {
    cur.properties![seg] ??= objectNode();
    if (!cur.required!.includes(seg)) cur.required!.push(seg);
    cur = cur.properties![seg]!;
  }
  const leaf = segments.at(-1)!;
  cur.properties![leaf] = node;
  cur.required!.push(leaf);
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
