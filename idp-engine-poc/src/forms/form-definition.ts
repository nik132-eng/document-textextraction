/**
 * POC subset of the form DSL (plan 03). A form is pure data: no engine code here.
 * The same definition drives every engine:
 *  - Textract: each non-checkbox field becomes a Query (alias = path); checkboxes use FORMS key/values.
 *  - VLM Run / Meibel: the definition becomes a JSON Schema (json-schema.builder.ts).
 * Not in the POC yet: repeating groups (Box 24 lines), region/grid sources, rules, normalizers.
 */
export type FieldType = 'text' | 'name' | 'date' | 'code' | 'phone' | 'money' | 'checkbox';

export interface FieldDef {
  /** Native path, dot-separated camelCase segments. Unique in the form. */
  path: string;
  /** Label as printed on the form; used in prompts, Textract query text and review UI. */
  label: string;
  type: FieldType;
  /** Key from the canonical dictionary (plan 03 §3) used by autofill. */
  canonicalKey?: string;
  /** Textract query text; defaults to "What is the <label>?". */
  query?: string;
  /** Printed key texts to match in Textract FORMS key/values (checkbox fields). Defaults to [label]. */
  keyAliases?: string[];
  required?: boolean;
  /** Overrides form/env min confidence for the low_confidence flag. */
  minConfidence?: number;
}

export interface FormDefinition {
  id: string;
  version: number;
  title: string;
  description: string;
  fields: FieldDef[];
  defaults?: { minConfidence?: number };
}

// Subset of plan 03 §3 used by the POC forms. Boot validation rejects anything else.
export const CANONICAL_KEYS = new Set([
  'patient.name.last',
  'patient.name.first',
  'patient.name.middle',
  'patient.dob',
  'patient.sex',
  'patient.address.street',
  'patient.address.city',
  'patient.address.state',
  'patient.address.zip',
  'patient.phone',
  'patient.mrn',
  'insured.id',
  'insured.name.last',
  'insured.name.first',
  'insured.group_number',
  'insured.relationship',
  'payer.name',
  'payer.id',
  'payer.phone',
  'plan.name',
  'plan.rx_bin',
  'plan.rx_pcn',
  'plan.copay',
]);

/** Textract sync AnalyzeDocument limit (00 §4). */
export const TEXTRACT_MAX_QUERIES = 15;

const PATH_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/;

/** Boot-time validation. Returns error strings; empty means valid. */
export function validateForm(def: FormDefinition): string[] {
  const errors: string[] = [];
  const at = (msg: string) => errors.push(`${def.id}: ${msg}`);
  if (!/^[A-Z][A-Z0-9_]*$/.test(def.id)) at('DEF_ID id must be UPPER_SNAKE');
  if (def.fields.length === 0) at('DEF_EMPTY no fields');
  const paths = new Set<string>();
  for (const f of def.fields) {
    if (!PATH_RE.test(f.path)) at(`DEF_PATH bad path "${f.path}"`);
    if (paths.has(f.path)) at(`DEF_PATH_DUP "${f.path}"`);
    paths.add(f.path);
    if (f.canonicalKey && !CANONICAL_KEYS.has(f.canonicalKey)) {
      at(`DEF_CANONICAL unknown canonical key "${f.canonicalKey}"`);
    }
  }
  // A path cannot be both a leaf and a parent object ("member" and "member.id").
  for (const p of paths) {
    for (const q of paths) if (q.startsWith(p + '.')) at(`DEF_PATH_CONFLICT "${p}" vs "${q}"`);
  }
  const queries = def.fields.filter((f) => f.type !== 'checkbox').length;
  if (queries > TEXTRACT_MAX_QUERIES) {
    at(`DEF_QUERY_LIMIT ${queries} queries > ${TEXTRACT_MAX_QUERIES} (Textract sync limit)`);
  }
  return errors;
}

export const queryTextFor = (f: FieldDef): string => f.query ?? `What is the ${f.label}?`;
