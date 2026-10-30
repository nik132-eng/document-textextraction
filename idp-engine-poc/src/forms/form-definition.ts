import { z } from 'zod';

/**
 * Form DSL (POC subset of plan 03). A form is pure data. TypeScript forms live in
 * ./definitions; JSON forms can be dropped into FORMS_DIR and are validated at boot.
 *
 * One definition drives every engine:
 *  - Textract:  scalar fields -> Queries (batched by 15) or FORMS key match (keyAliases);
 *               groups -> TABLES matched by column header; otherFields -> unclaimed key/values.
 *  - VLM Run / Meibel: the definition becomes a JSON Schema (json-schema.builder.ts).
 */
export const FIELD_TYPES = [
  'text',
  'name',
  'date',
  'code',
  'phone',
  'money',
  'number',
  'checkbox',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Reserved top-level path for "every other labelled value" capture. */
export const OTHER_FIELDS_PATH = 'otherFields';

const PATH_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/;

const fieldSchema = z.strictObject({
  /** Native path: dot-separated camelCase segments. In a group it is relative to the row. */
  path: z.string().regex(PATH_RE, 'camelCase dot path'),
  /** Label as printed; used in prompts, Textract query text, header matching and review. */
  label: z.string().min(1).max(200),
  type: z.enum(FIELD_TYPES),
  /** Canonical dictionary key (plan 03 §3) used by autofill. */
  canonicalKey: z.string().optional(),
  /** Textract query text. Setting it makes Textract use a Query for this field. */
  query: z.string().max(200).optional(),
  /** Printed key texts (scalars: FORMS key match) or column headers (groups: TABLES match). */
  keyAliases: z.array(z.string().min(1)).optional(),
  required: z.boolean().optional(),
  minConfidence: z.number().min(0).max(100).optional(),
});

const groupSchema = z.strictObject({
  /** Repeating rows, e.g. CMS-1500 Box 24 or UB-04 FL42-49. */
  path: z.string().regex(PATH_RE, 'camelCase dot path'),
  label: z.string().min(1),
  maxRows: z.number().int().min(1).max(100),
  columns: z.array(fieldSchema).min(1).max(30),
  /** Minimum header matches before a Textract table is accepted for this group. */
  minHeaderMatches: z.number().int().min(1).optional(),
});

export const formDefinitionSchema = z.strictObject({
  id: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'UPPER_SNAKE id'),
  version: z.number().int().min(1),
  title: z.string().min(1),
  description: z.string(),
  /** GENERIC: no fixed fields; capture every labelled value. */
  generic: z.boolean().optional(),
  /** Classification cues: printed phrases. score = matched / total; best >= minScore wins. */
  cues: z
    .strictObject({
      phrases: z.array(z.string().min(2)).min(1),
      minScore: z.number().min(0).max(1).optional(),
    })
    .optional(),
  fields: z.array(fieldSchema),
  groups: z.array(groupSchema).optional(),
  /** Also capture labelled values not covered by fields/groups (default true). */
  captureOther: z.boolean().optional(),
  defaults: z.strictObject({ minConfidence: z.number().min(0).max(100).optional() }).optional(),
});

export type FieldDef = z.infer<typeof fieldSchema>;
export type GroupDef = z.infer<typeof groupSchema>;
export type FormDefinition = z.infer<typeof formDefinitionSchema>;

export const GENERIC_FORM_ID = 'GENERIC';

// Plan 03 §3 canonical dictionary (subset used by the shipped forms). Unknown keys fail at boot.
export const CANONICAL_KEYS = new Set([
  'patient.name.last',
  'patient.name.first',
  'patient.name.middle',
  'patient.name.full',
  'patient.dob',
  'patient.sex',
  'patient.address.street',
  'patient.address.city',
  'patient.address.state',
  'patient.address.zip',
  'patient.phone',
  'patient.account_number',
  'patient.mrn',
  'patient.marital_status',
  'insured.id',
  'insured.name.last',
  'insured.name.first',
  'insured.name.full',
  'insured.relationship',
  'insured.group_number',
  'insured.dob',
  'insured.sex',
  'payer.name',
  'payer.id',
  'payer.phone',
  'plan.name',
  'plan.rx_bin',
  'plan.rx_pcn',
  'plan.copay',
  'claim.prior_auth',
  'claim.diagnosis_codes',
  'claim.principal_diagnosis',
  'claim.admitting_diagnosis',
  'claim.statement_from',
  'claim.statement_to',
  'claim.admission_date',
  'claim.admission_hour',
  'claim.admission_type',
  'claim.admission_source',
  'claim.discharge_status',
  'claim.total_charge',
  'claim.amount_paid',
  'claim.type_of_bill',
  'claim.patient_control_number',
  'claim.accept_assignment',
  'claim.principal_procedure',
  'claim.icd_version',
  'provider.billing.npi',
  'provider.billing.tax_id',
  'provider.billing.name',
  'provider.billing.address',
  'provider.billing.phone',
  'provider.rendering.npi',
  'provider.referring.name',
  'provider.referring.npi',
  'provider.attending.npi',
  'provider.attending.name',
  'provider.surgeon.name',
  'provider.surgeon.npi',
  'facility.name',
  'facility.npi',
  'facility.address',
  'line.service_date_from',
  'line.service_date_to',
  'line.cpt_hcpcs',
  'line.modifiers',
  'line.revenue_code',
  'line.description',
  'line.units',
  'line.charge',
  'line.non_covered_charge',
  'line.place_of_service',
  'line.diagnosis_pointer',
  'line.emergency',
  'line.laterality',
  'booking.procedure_date',
  'booking.procedure_time',
  'booking.anesthesia_type',
  'booking.patient_class',
  'booking.length_of_stay',
  'booking.allergies',
  'booking.latex_allergy',
  'booking.equipment',
  'booking.estimated_duration',
  'booking.diagnosis_text',
]);

/** Structure (Zod) + semantics (paths, canonical keys). Returns error strings; empty = valid. */
export function validateForm(input: unknown): string[] {
  const parsed = formDefinitionSchema.safeParse(input);
  const id = (input as { id?: unknown } | null)?.id ?? '?';
  if (!parsed.success) {
    return parsed.error.issues.map(
      (i) => `${String(id)}: DEF_SHAPE ${i.path.join('.')} ${i.message}`,
    );
  }
  const def = parsed.data;
  const errors: string[] = [];
  const at = (msg: string) => errors.push(`${def.id}: ${msg}`);
  if (def.generic && (def.fields.length || def.groups?.length))
    at('DEF_GENERIC generic forms have no fields');
  if (!def.generic && def.fields.length === 0 && !def.groups?.length)
    at('DEF_EMPTY no fields or groups');

  const top = [...def.fields.map((f) => f.path), ...(def.groups ?? []).map((g) => g.path)];
  checkPaths(top, at, '');
  if (top.some((p) => p === OTHER_FIELDS_PATH || p.startsWith(`${OTHER_FIELDS_PATH}.`))) {
    at(`DEF_PATH_RESERVED "${OTHER_FIELDS_PATH}"`);
  }
  for (const g of def.groups ?? [])
    checkPaths(
      g.columns.map((c) => c.path),
      at,
      `${g.path}[].`,
    );

  const all = [...def.fields, ...(def.groups ?? []).flatMap((g) => g.columns)];
  for (const f of all) {
    if (f.canonicalKey && !CANONICAL_KEYS.has(f.canonicalKey)) {
      at(`DEF_CANONICAL unknown canonical key "${f.canonicalKey}" on "${f.path}"`);
    }
  }
  return errors;
}

function checkPaths(paths: string[], at: (m: string) => void, prefix: string) {
  const seen = new Set<string>();
  for (const p of paths) {
    if (seen.has(p)) at(`DEF_PATH_DUP "${prefix}${p}"`);
    seen.add(p);
  }
  // A path cannot be both a leaf and a parent ("member" and "member.id").
  for (const p of seen)
    for (const q of seen)
      if (q.startsWith(`${p}.`)) at(`DEF_PATH_CONFLICT "${prefix}${p}" vs "${prefix}${q}"`);
}

export const queryTextFor = (f: FieldDef): string => f.query ?? `What is the ${f.label}?`;

/** How Textract reads a scalar field: explicit query > key aliases (FORMS) > default query. */
export const textractSource = (f: FieldDef): 'query' | 'key' =>
  f.type === 'checkbox' ? 'key' : f.query ? 'query' : f.keyAliases?.length ? 'key' : 'query';

export const capturesOther = (def: FormDefinition): boolean =>
  def.generic === true || def.captureOther !== false;

/** Where an extracted path belongs in the form: a scalar field, a group cell, or an "other" value. */
export type PathRef =
  | { kind: 'field'; def: FieldDef }
  | { kind: 'group'; group: GroupDef; column: FieldDef; row: number }
  | { kind: 'other'; index: number };

const GROUP_CELL_RE = /^(.+?)\[(\d+)\]\.(.+)$/;
const OTHER_RE = new RegExp(`^${OTHER_FIELDS_PATH}\\[(\\d+)\\]$`);

export function resolvePath(form: FormDefinition, path: string): PathRef | null {
  const field = form.fields.find((f) => f.path === path);
  if (field) return { kind: 'field', def: field };
  const other = OTHER_RE.exec(path);
  if (other) return { kind: 'other', index: Number(other[1]) };
  const cell = GROUP_CELL_RE.exec(path);
  if (cell) {
    const group = form.groups?.find((g) => g.path === cell[1]);
    const column = group?.columns.find((c) => c.path === cell[3]);
    if (group && column) return { kind: 'group', group, column, row: Number(cell[2]) };
  }
  return null;
}

export const groupCellPath = (g: GroupDef, row: number, c: FieldDef): string =>
  `${g.path}[${row}].${c.path}`;
export const otherPath = (i: number): string => `${OTHER_FIELDS_PATH}[${i}]`;
