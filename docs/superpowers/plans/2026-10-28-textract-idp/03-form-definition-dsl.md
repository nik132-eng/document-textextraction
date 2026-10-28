# 03 — Form Definition DSL (the extensibility core)

**Principle:** a form is **data**. One definition file says how to recognize the form, which Textract API and features to call, where each field comes from, what type it is, what it means canonically, and which rules check it. The pipeline, Textract layer, mapper, flattener, API and DB know nothing about specific forms.

Behaviour that needs code (resolvers, normalizers, rules) lives in shared libraries and is referenced **by name**. That keeps definitions serializable, so they can move to the DB later (`FormDefinitionRecord`, P9 option) without code changes.

---

## 1. Types (`src/forms/dsl/form-definition.types.ts`)

```ts
export type ValueType =
  | 'string' | 'name' | 'date' | 'money' | 'code' | 'number'
  | 'boolean' | 'enum' | 'phone' | 'zip' | 'state';

export type TextractApi = 'AnalyzeDocument' | 'AnalyzeID' | 'AnalyzeExpense';
export type AnalyzeFeature = 'FORMS' | 'TABLES' | 'QUERIES' | 'LAYOUT' | 'SIGNATURES';

/** Text matcher used everywhere a label is matched against OCR text. */
export interface TextMatch {
  /** Any of these, compared after normalizeLabel() (uppercase, alnum + space, collapsed). */
  anyOf: string[];
  mode?: 'contains' | 'startsWith' | 'equals' | 'regex';   // default 'contains'
  /** Allow this many OCR character edits per token (Levenshtein). Default 0 for codes, 1 for words ≥5 chars. */
  fuzzy?: number;
}

// ── Where a value comes from. Tried in order; first non-empty result wins
//    unless `pick: 'bestConfidence'` is set on the field. ──
export type FieldSource =
  | { kind: 'query'; alias: string; text: string }                 // Textract QUERIES
  | { kind: 'key'; key: TextMatch; valuePart?: 'text' | 'selection' } // FORMS key/value pair
  | { kind: 'region'; anchor: TextMatch; box: RegionBox; join?: ' ' | '\n' } // words inside a box relative to an anchor
  | { kind: 'checkbox'; label: TextMatch; maxDistance?: number }  // single SELECTION_ELEMENT nearest a label
  | { kind: 'layout'; blockType: LayoutBlockType; match?: TextMatch; capture?: string } // LAYOUT text + optional regex capture group
  | { kind: 'idField'; type: string }                              // AnalyzeID field type, e.g. 'FIRST_NAME'
  | { kind: 'expenseField'; type: string; scope?: 'summary' }       // AnalyzeExpense summary field, e.g. 'TOTAL'
  | { kind: 'const'; value: string | boolean | null };             // rare: fixed values (e.g. form edition)

export interface RegionBox {
  /** Offsets and size in page-normalized units (0..1), relative to the anchor's bbox top-left. */
  dx: number; dy: number; width: number; height: number;
}

export type LayoutBlockType =
  | 'LAYOUT_TITLE' | 'LAYOUT_HEADER' | 'LAYOUT_SECTION_HEADER' | 'LAYOUT_TEXT'
  | 'LAYOUT_KEY_VALUE' | 'LAYOUT_LIST' | 'LAYOUT_PAGE_NUMBER' | 'LAYOUT_FOOTER';

export interface FieldDef {
  path: string;                 // native path, dot notation, stable forever: 'box1a', 'box2.last'
  label: string;                // printed label, used in UI and GENERIC promotion
  type: ValueType;
  canonical?: string;           // canonical key; must exist in CANONICAL_KEYS
  enumValues?: string[];        // for type 'enum'
  sources: FieldSource[];       // at least one
  pick?: 'first' | 'bestConfidence';            // default 'first'
  split?: SplitSpec;            // derive sub-fields from one value (e.g. NAME → last/first/middle)
  minConfidence?: number;       // overrides form default
  rules?: FieldRuleRef[];       // e.g. [{ rule: 'NPI' }]
  required?: boolean;           // → REQUIRED_CORE warning when null
  dateKind?: 'dob' | 'service' | 'other';       // two-digit-year handling
}

/** Check-one groups: CMS-1500 Box 1, Box 6, sex boxes, UB-04 checkboxes. */
export interface CheckboxGroupDef {
  path: string;
  label: string;
  canonical?: string;
  /** Each option: enum value + where its box is. */
  options: { value: string; label: TextMatch; anchor?: TextMatch }[];
  /** Restrict search to a region near this anchor (avoids matching 'M' elsewhere on the page). */
  scope?: { anchor: TextMatch; box: RegionBox };
  multiple?: boolean;           // default false → >1 selected = flag multi_selected
  minConfidence?: number;
}

/** Repeating rows: CMS-1500 Box 24, UB-04 FL42–48, booking procedures. */
export interface GroupDef {
  path: string;                 // 'box24'
  name: string;                 // 'service_line'  (ExtractedField.groupName)
  label: string;
  maxRows?: number;             // validation (MAX_ROWS rule), not extraction
  sources: GroupSource[];       // tried in order; first producing ≥1 row wins
  columns: ColumnDef[];
  /** Drop rows where every column is empty. Default true. */
  dropEmptyRows?: boolean;
}

export type GroupSource =
  | { kind: 'table'; headerMatch: number; titleMatch?: TextMatch }  // ≥headerMatch column headers must match
  | { kind: 'grid'; anchor: TextMatch; firstRowDy: number; rowHeight: number; rows: number }
  | { kind: 'expenseLineItems' }                                     // AnalyzeExpense LineItemGroups
  | { kind: 'keyRepeat'; key: TextMatch };                           // repeated keys, e.g. 'Procedure 1', 'Procedure 2'

export interface ColumnDef {
  path: string;                 // relative: 'cptHcpcs'
  label: string;
  type: ValueType;
  canonical?: string;           // e.g. 'line.cpt_hcpcs' (stored as pattern 'box24[*].cptHcpcs')
  header?: TextMatch;           // for 'table' source
  x?: [number, number];         // for 'grid' source: left..right in page units
  expenseType?: string;         // for 'expenseLineItems': 'ITEM' | 'PRICE' | 'QUANTITY' | ...
  array?: { separator: RegExp | string; max?: number }; // e.g. modifiers '25 59' → ['25','59']
  rules?: FieldRuleRef[];
  dateKind?: 'dob' | 'service' | 'other';
}

export interface SplitSpec {
  /** Named parsers in the normalize library: 'personName' | 'cityStateZip' | 'dollarsCents' | 'dateMmDdYy' */
  parser: string;
  into: Record<string, string>;  // parser output key → native sub-path
}

export interface FieldRuleRef { rule: string; params?: Record<string, unknown>; severity?: 'error' | 'warning' }
export interface FormCheckRef { rule: string; params: Record<string, unknown>; severity?: 'error' | 'warning' }

export interface ClassifierCue {
  match: TextMatch;
  weight: number;               // positive = evidence for, negative = evidence against
  region?: 'top' | 'bottom' | 'any';   // top = first 20% of page height
}

export interface SubtypeDef {
  id: string;                   // 'ANESTHESIA'
  docTypeLabel: string;         // host doc-type label
  when: { path: string; regex: string } | { hint: string };  // any matching value → subtype
}

export interface SegmentationSpec {
  /** How pages of this form group into segments. */
  mode: 'perPage' | 'consecutive' | 'pageOfTotal';
  /** For 'pageOfTotal': regex with two groups (page, total), run on page LINE text. */
  pageOfTotal?: string;
  /** For 'consecutive': a page with no strong cue continues this form if it has any of these. */
  continuationCues?: TextMatch[];
  maxPages?: number;
}

export interface FormDefinition {
  id: string;                    // 'CMS1500' — stable forever, [A-Z0-9_]+
  version: string;               // 'cms1500@0212.3' — bump on any change
  displayName: string;
  docTypeLabel?: string;         // default host doc-type label
  engine:
    | { api: 'AnalyzeDocument'; features: AnalyzeFeature[] }
    | { api: 'AnalyzeID' }
    | { api: 'AnalyzeExpense' };
  classifier: {
    cues: ClassifierCue[];
    minScore: number;            // 0..1 normalized score needed to claim a page
    priority?: number;           // tie-break: higher wins
  };
  segmentation: SegmentationSpec;
  defaults: { minConfidence: number };     // e.g. 80
  fields: FieldDef[];
  checkboxGroups?: CheckboxGroupDef[];
  groups?: GroupDef[];
  checks?: FormCheckRef[];       // form-level rules: SUM_EQUALS, DATE_ORDER, POINTER_REFS, ...
  subtypes?: SubtypeDef[];
  subjectHints?: Record<'patientLast' | 'patientFirst' | 'patientDob' | 'memberId', string>; // native paths
  /** GENERIC only: capture every KV/table/line not claimed by a field. */
  captureUnmapped?: boolean;     // default true for every form → nothing is lost
}
```

### Why `captureUnmapped` defaults to `true` for every form

Even on a known form, any Textract key/value pair not used by a field is stored as a `generic:<slug>` row (`source='generic'`). Nothing visible is lost when a definition misses a field, and the next definition version can promote those labels.

## 2. Definition validator (`form-definition.schema.ts`)

The registry runs this at boot and throws, so the app refuses to start, on any of:

| Check | Error code |
|---|---|
| Zod structural parse of the definition | `DEF_SHAPE` |
| `id` not `^[A-Z0-9_]+$` or duplicate across registry | `DEF_ID` |
| Duplicate `path` across fields/checkboxGroups/groups (after expanding `split.into`) | `DEF_PATH_DUP` |
| Path not `^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)*$` | `DEF_PATH` |
| `canonical` not present in `CANONICAL_KEYS` | `DEF_CANONICAL` |
| `canonical` type incompatible with field `type` (e.g. date → money) | `DEF_CANONICAL_TYPE` |
| `rule` / `split.parser` names not in libraries | `DEF_RULE` |
| `query` source used but `QUERIES` not in features | `DEF_FEATURE` |
| `table` group source used but `TABLES` not in features | `DEF_FEATURE` |
| `layout` source used but `LAYOUT` not in features | `DEF_FEATURE` |
| `idField` used with api ≠ AnalyzeID; `expenseField`/`expenseLineItems` with api ≠ AnalyzeExpense | `DEF_API` |
| **More than 15 distinct query aliases** (sync limit) | `DEF_QUERY_LIMIT` |
| Query alias not `^[A-Z0-9_]{1,64}$`, query text > 200 chars | `DEF_QUERY` |
| `enum` field without `enumValues` | `DEF_ENUM` |
| `classifier.cues` empty (except GENERIC) | `DEF_CUES` |

A unit test loads `DEFINITIONS` and asserts no throw. Every new form is therefore checked in CI.

## 3. Canonical dictionary (`canonical-keys.ts`)

A single source of truth for autofill. It is spec-1 §9 extended with card, ID and invoice keys.

```ts
export interface CanonicalKeyDef { type: ValueType | 'array'; description: string; pii: boolean }

export const CANONICAL_KEYS = {
  'patient.name.last':          { type: 'name', description: 'Patient last name', pii: true },
  'patient.name.first':         { type: 'name', description: 'Patient first name', pii: true },
  'patient.name.middle':        { type: 'name', description: 'Patient middle name/initial', pii: true },
  'patient.dob':                { type: 'date', description: 'Patient date of birth', pii: true },
  'patient.sex':                { type: 'enum', description: 'M | F | U', pii: true },
  'patient.address.street':     { type: 'string', description: '', pii: true },
  'patient.address.city':       { type: 'string', description: '', pii: true },
  'patient.address.state':      { type: 'state', description: '', pii: true },
  'patient.address.zip':        { type: 'zip', description: '', pii: true },
  'patient.phone':              { type: 'phone', description: '', pii: true },
  'patient.account_number':     { type: 'code', description: 'Provider patient account no.', pii: true },
  'patient.mrn':                { type: 'code', description: 'Medical record number', pii: true },
  'insured.id':                 { type: 'code', description: 'Member / subscriber ID', pii: true },
  'insured.name.last':          { type: 'name', description: '', pii: true },
  'insured.name.first':         { type: 'name', description: '', pii: true },
  'insured.name.middle':        { type: 'name', description: '', pii: true },
  'insured.relationship':       { type: 'enum', description: 'SELF | SPOUSE | CHILD | OTHER', pii: false },
  'insured.group_number':       { type: 'code', description: '', pii: false },
  'insured.dob':                { type: 'date', description: '', pii: true },
  'payer.name':                 { type: 'string', description: 'Payer / carrier name as printed', pii: false },
  'payer.id':                   { type: 'code', description: 'Payer ID / health plan ID', pii: false },
  'payer.phone':                { type: 'phone', description: 'Payer customer-service phone', pii: false },
  'plan.name':                  { type: 'string', description: '', pii: false },
  'plan.rx_bin':                { type: 'code', description: 'Card RxBIN', pii: false },
  'plan.rx_pcn':                { type: 'code', description: 'Card RxPCN', pii: false },
  'plan.copay':                 { type: 'string', description: 'Copay text as printed', pii: false },
  'claim.prior_auth':           { type: 'code', description: '', pii: false },
  'claim.diagnosis_codes':      { type: 'code', description: 'Repeated per code', pii: true },
  'claim.principal_diagnosis':  { type: 'code', description: '', pii: true },
  'claim.statement_from':       { type: 'date', description: '', pii: false },
  'claim.statement_to':         { type: 'date', description: '', pii: false },
  'claim.admission_date':       { type: 'date', description: '', pii: true },
  'claim.total_charge':         { type: 'money', description: '', pii: false },
  'claim.amount_paid':          { type: 'money', description: '', pii: false },
  'claim.type_of_bill':         { type: 'code', description: '', pii: false },
  'provider.billing.npi':       { type: 'code', description: '', pii: false },
  'provider.billing.tax_id':    { type: 'code', description: '', pii: false },
  'provider.billing.name':      { type: 'string', description: '', pii: false },
  'provider.rendering.npi':     { type: 'code', description: '', pii: false },
  'provider.referring.npi':     { type: 'code', description: '', pii: false },
  'provider.attending.npi':     { type: 'code', description: '', pii: false },
  'provider.surgeon.name':      { type: 'name', description: '', pii: false },
  'facility.name':              { type: 'string', description: '', pii: false },
  'facility.npi':               { type: 'code', description: '', pii: false },
  'line.service_date_from':     { type: 'date', description: '', pii: true },
  'line.service_date_to':       { type: 'date', description: '', pii: true },
  'line.cpt_hcpcs':             { type: 'code', description: '', pii: true },
  'line.modifiers':             { type: 'code', description: '', pii: false },
  'line.revenue_code':          { type: 'code', description: '', pii: false },
  'line.units':                 { type: 'number', description: '', pii: false },
  'line.charge':                { type: 'money', description: '', pii: false },
  'line.place_of_service':      { type: 'code', description: '', pii: false },
  'line.diagnosis_pointer':     { type: 'code', description: '', pii: false },
  'booking.id':                 { type: 'code', description: '', pii: false },
  'booking.date':               { type: 'date', description: '', pii: false },
  'booking.procedure_date':     { type: 'date', description: '', pii: true },
  'booking.procedure_time':     { type: 'string', description: '', pii: false },
  'booking.anesthesia_type':    { type: 'string', description: '', pii: false },
  'booking.admission_type':     { type: 'enum', description: 'INPATIENT | OUTPATIENT | OBSERVATION_23H', pii: false },
  'booking.procedure_description': { type: 'string', description: '', pii: true },
  'id.document_number':         { type: 'code', description: 'DL / passport number', pii: true },
  'id.expiration_date':         { type: 'date', description: '', pii: true },
  'id.issuing_state':           { type: 'state', description: '', pii: false },
  'invoice.vendor_name':        { type: 'string', description: '', pii: false },
  'invoice.number':             { type: 'code', description: '', pii: false },
  'invoice.date':               { type: 'date', description: '', pii: false },
  'invoice.total':              { type: 'money', description: '', pii: false },
} as const satisfies Record<string, CanonicalKeyDef>;

export type CanonicalKey = keyof typeof CANONICAL_KEYS;
```

Adding a canonical key is a code change, reviewed deliberately, because downstream profiles depend on it. Adding a **form** that maps into existing keys is not.

## 4. Libraries referenced by name

### 4.1 Value normalizers (`normalize/value-normalizers.ts`)

| Type | Input examples | Output | Rule |
|---|---|---|---|
| `date` | `03 12 84`, `03/12/1984`, `031284`, `2026-09-01`, `3-12-84` | `"1984-03-12"` | MM DD YY(YY) first (US forms). 2-digit year: `dateKind:'dob'` → most recent past year; `service`/`other` → 2000+YY, unless that is more than 1 year in the future, then 1900+YY. Unparseable → `null` + flag `validation_error` + issue `DATE_UNPARSEABLE`. |
| `money` | `125 00`, `$1,250.00`, `125.`, `1250 00` | `125.00` (number, 2dp) | Strip `$`, `,`. `D CC` with a single space and exactly 2 trailing digits → `D.CC`. |
| `code` | ` e11.9 `, `0450`, `99213-25` | `"E11.9"`, `"0450"` | Trim, uppercase, collapse inner spaces, **never strip leading zeros**. ICD-10 → `{ code, codeNoDot }`. |
| `name` | `DOE , JANE A` | `"DOE, JANE A"` | Trim, collapse whitespace, fix comma spacing. Case preserved. |
| `phone` | `(555) 123-4567` | `"5551234567"` | Digits only. 10 digits, or 11 starting with 1 → strip it. Otherwise keep raw + warning. |
| `zip` | `12345 6789` | `"12345-6789"` | |
| `state` | `ca` | `"CA"` | Uppercase; must be a USPS code (rule `STATE_FORMAT`). |
| `boolean` | `SELECTED`/`NOT_SELECTED`, `Y`/`N`, `YES`/`NO`, `X` | `true`/`false` | |
| `number` | `1`, `1.0`, `01` | `1` | |
| `enum` | label text or option value | option value | Case-insensitive match against `enumValues`. Otherwise null + `uncertain`. |

Split parsers: `personName` (`LAST, FIRST MI` / `FIRST MI LAST` with a comma heuristic), `cityStateZip`, `dollarsCents`, `dateMmDdYy`, `qualifierValue` (e.g. `"0B 12345"` → `{qualifier:'0B', value:'12345'}`), `icdList`.

### 4.2 Rule library (`rules/rule-library.ts`)

Field rules (`FieldRuleRef.rule`):

| Rule | Check | Default severity |
|---|---|---|
| `NPI` | 10 digits; Luhn on `"80840" + first 9` equals 10th | error |
| `ICD10` | `^[A-TV-Z][0-9][0-9A-Z](\.?[0-9A-Z]{1,4})?$` | warning |
| `CPT_HCPCS` | `^([0-9]{4}[0-9A-Z]\|[A-V][0-9]{4})$` | warning |
| `REV_CODE` | `^[0-9]{4}$` | warning |
| `EIN_OR_SSN` | `^[0-9]{2}-?[0-9]{7}$` or `^[0-9]{3}-?[0-9]{2}-?[0-9]{4}$` | warning |
| `STATE_FORMAT` | USPS 2-letter | warning |
| `ZIP_FORMAT` | `^[0-9]{5}(-?[0-9]{4})?$` | warning |
| `POS_CODE` | `^[0-9]{2}$` | warning |
| `TOB` | `^0?[0-9]{3,4}$` | warning |
| `NOT_FUTURE_DATE` | ≤ today + 1 day | warning |

Form checks (`FormCheckRef.rule`, with params):

| Rule | Params | Check |
|---|---|---|
| `MAX_ROWS` | `{ group, max }` | rows ≤ max (error) |
| `SUM_EQUALS` | `{ items: 'box24[*].charges', total: 'box28', tolerance: 0.01 }` | only when every item and the total are present |
| `DATE_ORDER` | `{ before: 'box3.dob', after: 'box24[*].dateFrom' }` | |
| `POINTER_REFS` | `{ pointers: 'box24[*].diagnosisPointer', targets: 'box21.codes' }` | each letter references a non-null code |
| `REQUIRED_ANY` | `{ paths: [...] }` | at least one non-null (warning `REQUIRED_CORE`) |
| `PAGE_TOTALS` | `{ pageOf: 'line23.page', total: 'line23.of' }` | UB-04 page x ≤ y |

Rule signature:

```ts
export interface RuleContext { normalized: any; get(path: string): unknown[]; /* expands [*] */ }
export type FieldRule = (value: unknown, params: Record<string, unknown>) => string | null; // message or null
export type FormCheck = (ctx: RuleContext, params: Record<string, unknown>) => { path: string; message: string }[];
```

## 5. Native JSON shape produced by the mapper

The mapper turns a definition plus Evidence into a **native object** whose shape is fully determined by the definition's paths:

- every `FieldDef.path` → leaf (`null` if not found)
- `split.into` sub-paths → leaves
- every `CheckboxGroupDef.path` → enum value / array / null
- every `GroupDef.path` → array of row objects with every column path
- `_unmapped` → array of `{ label, value, page, confidence, bbox, kind: 'kv'|'table'|'line'|'selection' }` (when `captureUnmapped`)

Because the shape comes from the definition, `buildSkeleton(def)` produces the all-null object, and `buildZodFromDefinition(def)` produces a Zod schema used to assert the mapper's output in tests.

## 6. Writing a good source list (authoring guide)

Order sources from **most precise to most forgiving**:

1. **`query`** for the 10–15 most critical fields (IDs, names, DOB, totals, NPIs). Textract Queries resolve meaning ("What is the insured's ID number?") even when the label is cut or the layout shifts. Write queries as natural questions, mentioning the box number when the form prints it. You get **15 per page** on the sync API, and the validator enforces that.
2. **`key`** for printed key/value pairs. Match the **box number plus a distinctive word** (`anyOf: ['1a INSURED', "INSURED'S I.D."]`). Inspect real Textract output (console, fixture JSON) to see the exact key text Textract produced. Do not guess.
3. **`region`** for dense grids where FORMS pairs are unreliable (CMS-1500 Box 21 code slots, Box 24 lines). Anchor on a stable printed label close to the value. Keep boxes small (≤0.25 page width). Region coordinates are relative to the anchor, so scan offsets and scale do not break them, though heavy skew can.
4. **`layout`** for free-form documents (booking sheets, letters), with a regex capture.

`pick: 'bestConfidence'` is useful when query and key often disagree. The default `first` is cheaper to reason about.

Checkbox groups: always set `scope`, so that `M` and `F` near Box 3 never match `M` and `F` near Box 11a.

## 7. Example — CMS-1500 excerpt (`definitions/cms1500.form.ts`)

The P4 task contains the complete list (all boxes 1–33 per spec-1 §8.1). This excerpt shows every construct:

```ts
import { FormDefinition } from '../dsl/form-definition.types';

export const cms1500: FormDefinition = {
  id: 'CMS1500',
  version: 'cms1500@0212.1',
  displayName: 'CMS-1500 Health Insurance Claim Form (02/12)',
  docTypeLabel: 'PHYSICIAN_CLAIM',
  engine: { api: 'AnalyzeDocument', features: ['FORMS', 'TABLES', 'QUERIES'] },
  classifier: {
    minScore: 0.45,
    priority: 10,
    cues: [
      { match: { anyOf: ['HEALTH INSURANCE CLAIM FORM'], fuzzy: 1 }, weight: 5, region: 'top' },
      { match: { anyOf: ['NATIONAL UNIFORM CLAIM COMMITTEE', 'NUCC'] }, weight: 3 },
      { match: { anyOf: ['FORM 1500', '1500 (02-12)', 'OMB-0938-1197'] }, weight: 3, region: 'bottom' },
      { match: { anyOf: ["INSURED'S I.D. NUMBER", 'INSUREDS ID NUMBER'] , fuzzy: 1 }, weight: 2 },
      { match: { anyOf: ['UB-04', 'NUBC'] }, weight: -5 },
    ],
  },
  segmentation: { mode: 'perPage' },
  defaults: { minConfidence: 80 },
  subjectHints: { patientLast: 'box2.last', patientFirst: 'box2.first', patientDob: 'box3.dob', memberId: 'box1a' },
  subtypes: [
    { id: 'ANESTHESIA', docTypeLabel: 'ANESTHESIA_CLAIM', when: { path: 'box24[*].cptHcpcs', regex: '^0[01][0-9]{3}$' } },
    { id: 'ANESTHESIA', docTypeLabel: 'ANESTHESIA_CLAIM', when: { hint: 'ANESTHESIA_CLAIM' } },
  ],
  fields: [
    { path: 'box1a', label: "1a. INSURED'S I.D. NUMBER", type: 'code', canonical: 'insured.id', required: true,
      sources: [
        { kind: 'query', alias: 'BOX1A', text: "What is the insured's ID number in box 1a?" },
        { kind: 'key', key: { anyOf: ["1A INSURED'S I.D. NUMBER", 'INSUREDS I D NUMBER'], fuzzy: 1 } },
      ] },
    { path: 'box2.full', label: "2. PATIENT'S NAME", type: 'name',
      sources: [
        { kind: 'query', alias: 'BOX2', text: "What is the patient's name in box 2?" },
        { kind: 'key', key: { anyOf: ["2 PATIENT'S NAME", 'PATIENTS NAME LAST NAME'] } },
      ],
      split: { parser: 'personName', into: { last: 'box2.last', first: 'box2.first', middle: 'box2.middle' } } },
    { path: 'box3.dob', label: "3. PATIENT'S BIRTH DATE", type: 'date', dateKind: 'dob', canonical: 'patient.dob',
      sources: [
        { kind: 'query', alias: 'BOX3_DOB', text: "What is the patient's birth date in box 3?" },
        { kind: 'region', anchor: { anyOf: ["3 PATIENT'S BIRTH DATE"] }, box: { dx: 0, dy: 0.008, width: 0.14, height: 0.018 } },
      ] },
    { path: 'box28', label: '28. TOTAL CHARGE', type: 'money', canonical: 'claim.total_charge',
      sources: [
        { kind: 'query', alias: 'BOX28', text: 'What is the total charge in box 28?' },
        { kind: 'key', key: { anyOf: ['28 TOTAL CHARGE'] } },
      ] },
    { path: 'box33a', label: '33a. NPI', type: 'code', canonical: 'provider.billing.npi', rules: [{ rule: 'NPI' }],
      sources: [
        { kind: 'query', alias: 'BOX33A', text: 'What is the billing provider NPI in box 33a?' },
        { kind: 'region', anchor: { anyOf: ['33 BILLING PROVIDER INFO'] }, box: { dx: 0, dy: 0.055, width: 0.12, height: 0.015 } },
      ] },
    // … box21.codes.A … box21.codes.L as 12 region fields with rules [{rule:'ICD10'}] and canonical 'claim.diagnosis_codes'
  ],
  checkboxGroups: [
    { path: 'box1.insuranceType', label: '1. Insurance type',
      scope: { anchor: { anyOf: ['MEDICARE'] }, box: { dx: -0.02, dy: -0.01, width: 0.62, height: 0.04 } },
      options: [
        { value: 'MEDICARE', label: { anyOf: ['MEDICARE'] } },
        { value: 'MEDICAID', label: { anyOf: ['MEDICAID'] } },
        { value: 'TRICARE', label: { anyOf: ['TRICARE'] } },
        { value: 'CHAMPVA', label: { anyOf: ['CHAMPVA'] } },
        { value: 'GROUP_HEALTH_PLAN', label: { anyOf: ['GROUP HEALTH PLAN'] } },
        { value: 'FECA_BLK_LUNG', label: { anyOf: ['FECA BLK LUNG', 'FECA'] } },
        { value: 'OTHER', label: { anyOf: ['OTHER'] } },
      ] },
    { path: 'box3.sex', label: '3. Sex', canonical: 'patient.sex',
      scope: { anchor: { anyOf: ["3 PATIENT'S BIRTH DATE"] }, box: { dx: 0.12, dy: 0, width: 0.12, height: 0.03 } },
      options: [ { value: 'M', label: { anyOf: ['M'], mode: 'equals' } }, { value: 'F', label: { anyOf: ['F'], mode: 'equals' } } ] },
  ],
  groups: [
    { path: 'box24', name: 'service_line', label: '24. Service lines', maxRows: 6,
      sources: [
        { kind: 'table', headerMatch: 3, titleMatch: { anyOf: ['DATE(S) OF SERVICE'] } },
        { kind: 'grid', anchor: { anyOf: ['24 A DATE(S) OF SERVICE', 'DATE(S) OF SERVICE'] }, firstRowDy: 0.035, rowHeight: 0.0335, rows: 6 },
      ],
      columns: [
        { path: 'dateFrom', label: '24A From', type: 'date', dateKind: 'service', canonical: 'line.service_date_from',
          header: { anyOf: ['FROM'] }, x: [0.03, 0.12] },
        { path: 'cptHcpcs', label: '24D CPT/HCPCS', type: 'code', canonical: 'line.cpt_hcpcs', rules: [{ rule: 'CPT_HCPCS' }],
          header: { anyOf: ['CPT/HCPCS', 'CPT HCPCS'] }, x: [0.30, 0.38] },
        { path: 'modifiers', label: '24D Modifier', type: 'code', canonical: 'line.modifiers',
          header: { anyOf: ['MODIFIER'] }, x: [0.38, 0.50], array: { separator: ' ', max: 4 } },
        { path: 'charges', label: '24F $ Charges', type: 'money', canonical: 'line.charge',
          header: { anyOf: ['CHARGES'] }, x: [0.60, 0.70] },
        // … supplementalInfo, dateTo, placeOfService, emg, diagnosisPointer, units, epsdt, idQualifier, renderingProviderId, renderingNpi
      ] },
  ],
  checks: [
    { rule: 'MAX_ROWS', params: { group: 'box24', max: 6 }, severity: 'error' },
    { rule: 'SUM_EQUALS', params: { items: 'box24[*].charges', total: 'box28', tolerance: 0.01 } },
    { rule: 'POINTER_REFS', params: { pointers: 'box24[*].diagnosisPointer', targets: 'box21.codes' } },
    { rule: 'DATE_ORDER', params: { before: 'box3.dob', after: 'box24[*].dateFrom' } },
    { rule: 'REQUIRED_ANY', params: { paths: ['box2.last', 'box1a'] } },
  ],
};
```

> The region and grid coordinates above are **starting values**. They are tuned in P4 against recorded fixtures by `scripts/tune-regions.ts`, which overlays the boxes on page PNGs for visual checking. Never tune them by guessing.

## 8. Versioning rules

- `version` = `<lowerid>@<edition>.<n>`. Bump `n` on any change to fields, sources, cues, rules or coordinates.
- **Never rename or reuse a `path`** after release. Add a new path, and mark the old one `deprecated: true` (an optional `FieldDef` flag, ignored by the mapper but kept for historic reads).
- `MAPPER_VERSION` (in `mapping.service.ts`) bumps when shared resolver/normalizer code changes behaviour. Both versions are stored on every `Extraction`.

## 9. Adding a new form — the checklist (the contract)

1. **Observe.** Find GENERIC segments of the new layout: `GET /fields?formType=GENERIC&label=...`, or the promotion report (`scripts/eval.ts --promotion-report`) that lists frequent `generic:*` labels by tenant.
2. **Collect samples.** 5–10 synthetic samples in `test-data/<FORM_ID>/case-NNN/input.pdf`, plus a hand-written `expected.json` (native shape, normalized).
3. **Record fixtures.** `npm run record-fixture -- --form <FORM_ID> --case case-001 --file test-data/.../input.pdf --features FORMS,TABLES,LAYOUT` (add `QUERIES` once the definition has queries).
4. **Write the definition** `src/forms/definitions/<form>.form.ts`: id, version, displayName, engine, classifier cues (read the `.detect.json` lines to choose cues), segmentation, fields/groups/checkboxGroups with sources, canonical keys, rules.
5. **Register** it in `definitions/index.ts`.
6. **Run** `npm test` (the definition validator plus a generic mapper test runs every fixture through its definition automatically), then `npm run eval -- --form <FORM_ID>`. Iterate until the targets are met.
7. **Back-fill** (optional): `npm run remap -- --from-form GENERIC --to <FORM_ID> --where-label "<distinctive label>"`. This is free when the definition uses no `query` sources. Otherwise use `--reanalyze` (billed; prints an estimate and asks for `--yes`).
8. **Host mapping** (only if the form feeds a new target): add canonical keys to an autofill profile (`05` §9). Usually nothing is needed, because it maps into existing canonical keys.

**Forbidden in a new-form PR:** changes under `src/pipeline/**`, `src/textract/**`, `src/ingest/**`, `prisma/**`, or controllers. CI enforces this with a path check when the PR label `new-form` is set (P9 Task).
