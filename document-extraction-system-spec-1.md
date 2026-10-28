# Multi-Form Document Extraction System — Build Specification

**Stack:** NestJS (TypeScript) · PostgreSQL · Prisma · Zod
**Scope:** Upload any scanned/printed document (CMS-1500/HCFA, UB-04, booking sheets, unknown forms) → extract every data point as structured JSON → store it with its form type for later autofill.
**Key property:** Model-agnostic. Any vision-capable LLM (Gemini, Claude, OpenAI/Azure, Bedrock, Mistral, self-hosted vLLM such as Qwen-VL or Chandra) can be plugged in through one adapter interface.

---

## 0. How to use this document

### For humans
Read sections 1–3 for the design, section 18 for the build order, and section 17 for how to measure accuracy before choosing a model.

### For AI coding assistants (Claude, GPT, Gemini, Copilot, Cursor, etc.)
Follow these rules when implementing from this spec:

1. **Build in the phase order in section 18.** Do not start a phase until the previous phase's acceptance criteria pass.
2. **No provider-specific code outside `src/extraction/providers/`.** Everything else talks to the `ModelProvider` interface (section 10).
3. **All form knowledge lives in `FormDefinition` files** (section 7). Adding a form must never require changes to the pipeline, controller, or database schema.
4. **Models transcribe; code normalizes.** Models return values as printed. Dates, money, codes, and names are normalized in TypeScript (section 12).
5. **Never let a model invent data.** Blank → `null`. Unreadable → `null` + listed in `_meta.unreadable`.
6. **Dependency budget** (section 3). Do not add libraries outside it without writing a one-line justification in the PR.
7. **Every stage gets a unit test using `FakeProvider`** (section 17.1). Tests must not call real model APIs.
8. **Never log extracted values or document content.** Log IDs, statuses, timings, token counts only.
9. When a requirement here is ambiguous, implement the simplest version and leave a `// SPEC-QUESTION:` comment.

---

## 1. Goals, non-goals, glossary

### Goals
- Accept PDF, PNG, JPG, TIFF (fax), HEIC (phone photo), and multi-page/multi-document PDFs.
- Identify the form type of each page/segment automatically.
- Extract **every** field, including checkboxes, tables, and repeating line items.
- Store the raw model output, a normalized version, and one flat row per value tagged with form type and a canonical key.
- Unknown documents still get all label/value pairs saved (generic fallback).
- Swap or combine models through configuration only.

### Non-goals (POC)
- Submitting claims, X12 837 generation, eligibility checks.
- Patient identity resolution across documents (store hints only; see section 20).
- A full review UI (API endpoints only; UI later).

### Glossary
| Term | Meaning |
|---|---|
| **Document** | One uploaded file. |
| **Page** | One rasterized image of a page in the document. |
| **Segment** | A contiguous page range that represents one logical form (one claim, one booking sheet). A PDF with 5 scanned claims = 5 segments. |
| **FormDefinition** | Code object describing a form type: schema, prompts, canonical mappings, validation. |
| **Native path** | Field location in the form's own structure, e.g. `box24[2].cpt`, `fl67.principal`. |
| **Canonical key** | Form-independent meaning used by autofill, e.g. `patient.dob`, `line.cpt_hcpcs`. |
| **Provider** | Adapter for one model API (Gemini, Anthropic, OpenAI-compatible, Bedrock…). |
| **Strategy** | How structured JSON is obtained: native schema, tool call, or prompt-only JSON. |

---

## 2. Architecture

```
            ┌───────────────┐
 Upload ───▶│ POST /documents│  (multer, size/type checks, sha256 dedupe)
            └──────┬────────┘
                   ▼
          ┌──────────────────┐      ┌───────────────┐
          │ Storage (local/S3)│◀────│ Normalizer     │ any file → page PNGs
          └──────────────────┘      └──────┬────────┘
                                           ▼
                                  ┌──────────────────┐
                                  │ Classifier       │ per-page form type
                                  │ + Segmenter      │ → segments
                                  └──────┬───────────┘
                                         ▼  (for each segment)
                                  ┌──────────────────┐
                                  │ Extractor        │ FormDefinition.schema
                                  │  └ ProviderRouter│ → ModelProvider(s)
                                  └──────┬───────────┘
                                         ▼
                                  ┌──────────────────┐
                                  │ Validator +      │ Zod + domain rules,
                                  │ Normalizer (code)│ dates/money/codes
                                  └──────┬───────────┘
                                         ▼
                                  ┌──────────────────┐
                                  │ Flattener        │ native path + canonical key
                                  └──────┬───────────┘
                                         ▼
                         Postgres: Document · Page · Segment · Extraction · ExtractedField
                                         ▼
                         GET /autofill?keys=patient.name,insured.id&match[...]
```

POC runs the pipeline synchronously inside the request (`PIPELINE_MODE=sync`). Phase 9 moves it to a queue (`PIPELINE_MODE=queue`) with no change to stage code, because each stage is a plain service method.

---

## 3. Tech stack and dependency budget

| Purpose | Package | Notes |
|---|---|---|
| Framework | `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`, `@nestjs/config` | Multer ships with platform-express. |
| DB | `prisma`, `@prisma/client` | PostgreSQL. |
| Schemas | `zod` (v4) | Use `z.toJSONSchema()`. If stuck on Zod v3, add `zod-to-json-schema`. |
| Images | `sharp` | TIFF/HEIC/JPG → PNG, resize, multi-page TIFF. |
| PDF raster | **`pdftoppm` (poppler-utils)** via `child_process` | System package in Docker. Alternative without system deps: `pdfjs-dist` + `@napi-rs/canvas`. Avoid `mupdf` (AGPL) unless licensing is cleared. |
| HTTP to models | native `fetch` (Node 20+) | No SDK required for Gemini (AI Studio), Anthropic, OpenAI-compatible, Mistral. |
| Optional | `@aws-sdk/client-bedrock-runtime` | Only if Bedrock enabled (needs SigV4). |
| Optional | `google-auth-library` | Only if Vertex AI enabled (needs OAuth token). |
| Optional (Phase 9) | `@nestjs/bullmq`, `bullmq`, `@aws-sdk/client-s3` | Async + S3. |

Install provider SDKs only for providers you enable.

**Dockerfile addition:**
```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/*
```

---

## 4. Repository structure

```
src/
  extraction/
    extraction.module.ts
    controllers/
      documents.controller.ts        // upload, status, results, reprocess
      fields.controller.ts           // review corrections
      autofill.controller.ts
    pipeline/
      pipeline.service.ts            // orchestrates stages
      normalizer.service.ts          // file → pages
      classifier.service.ts          // page → form type, segments
      extractor.service.ts           // segment → raw JSON
      validator.service.ts           // Zod + domain rules
      value-normalizer.ts            // dates, money, codes, names
      flattener.ts                   // JSON → field rows
    forms/
      form-definition.ts             // interface + shared types
      registry.ts                    // all forms, lookup by id
      shared/meta.schema.ts          // _meta block every form includes
      shared/address.schema.ts
      cms1500/cms1500.form.ts
      cms1500/cms1500.schema.ts
      cms1500/cms1500.validate.ts
      ub04/ub04.form.ts
      ub04/ub04.schema.ts
      ub04/ub04.validate.ts
      booking-sheet/booking-sheet.form.ts
      generic/generic.form.ts
    providers/
      model-provider.ts              // interface + types
      provider-router.ts             // primary/fallback/consensus
      structured-output.service.ts   // strategy, parse, repair, retry
      portable-schema.ts             // Zod → portable JSON Schema → dialects
      gemini.provider.ts
      anthropic.provider.ts
      openai-compatible.provider.ts  // OpenAI, Azure, vLLM, Mistral chat, LM Studio, Ollama
      bedrock.provider.ts
      fake.provider.ts               // tests
    prompts/
      system.prompt.ts
      classifier.prompt.ts
      extraction.prompt.ts
      prompt-version.ts              // bump on any prompt change
    storage/
      storage.interface.ts
      local.storage.ts
      s3.storage.ts
  prisma/schema.prisma
test-data/
  CMS1500/<case-id>/input.pdf + expected.json
  UB04/...
  BOOKING_SHEET/...
  GENERIC/...
scripts/
  eval.ts                            // accuracy report per provider/form
```

---

## 5. Data model (Prisma)

`formType` is a `String`, not an enum, so new forms need no migration.

```prisma
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }

enum DocStatus {
  RECEIVED
  NORMALIZED
  CLASSIFIED
  EXTRACTING
  EXTRACTED
  NEEDS_REVIEW
  APPROVED
  FAILED
}

model Document {
  id           String    @id @default(uuid())
  tenantId     String
  originalName String
  mimeType     String
  sizeBytes    Int
  sha256       String
  storageKey   String
  pageCount    Int?
  status       DocStatus @default(RECEIVED)
  error        String?
  pages        Page[]
  segments     Segment[]
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  @@unique([tenantId, sha256])
  @@index([tenantId, status])
}

model Page {
  id         String   @id @default(uuid())
  documentId String
  document   Document @relation(fields: [documentId], references: [id], onDelete: Cascade)
  pageNumber Int      // 1-based
  storageKey String
  widthPx    Int
  heightPx   Int

  @@unique([documentId, pageNumber])
}

model Segment {
  id                   String       @id @default(uuid())
  documentId           String
  document             Document     @relation(fields: [documentId], references: [id], onDelete: Cascade)
  formType             String       // 'CMS1500' | 'UB04' | 'BOOKING_SHEET' | 'GENERIC' | ...
  formVersion          String?      // FormDefinition.version used
  pageStart            Int
  pageEnd              Int
  classifierConfidence Float?
  classifierProvider   String?
  subjectHints         Json?        // e.g. { patientLast, patientDob, memberId } for later matching
  status               DocStatus    @default(CLASSIFIED)
  extractions          Extraction[]

  @@index([formType])
}

model Extraction {
  id               String           @id @default(uuid())
  segmentId        String
  segment          Segment          @relation(fields: [segmentId], references: [id], onDelete: Cascade)
  provider         String           // 'gemini' | 'anthropic' | 'openai-compatible:vllm' ...
  model            String
  strategy         String           // 'native-schema' | 'tool-call' | 'prompt-json'
  formVersion      String
  promptVersion    String
  raw              Json             // model output exactly as parsed (immutable)
  normalized       Json?            // code-normalized version
  meta             Json?            // _meta: unreadable, uncertain, notes
  validationIssues Json?
  isCurrent        Boolean          @default(true)
  inputTokens      Int?
  outputTokens     Int?
  latencyMs        Int?
  attempts         Int              @default(1)
  fields           ExtractedField[]
  createdAt        DateTime         @default(now())

  @@index([segmentId, isCurrent])
}

model ExtractedField {
  id              String     @id @default(uuid())
  extractionId    String
  extraction      Extraction @relation(fields: [extractionId], references: [id], onDelete: Cascade)
  tenantId        String
  formType        String
  nativePath      String     // 'box24[0].cpt'
  nativePattern   String     // 'box24[*].cpt'
  canonicalKey    String?    // 'line.cpt_hcpcs' — null if unmapped (still saved)
  groupName       String?    // 'service_line'
  groupIndex      Int?
  valueType       String     // 'string' | 'date' | 'money' | 'boolean' | 'code' | 'number' | 'enum'
  rawValue        String?
  normalizedValue Json?
  flags           String[]   // 'unreadable' | 'uncertain' | 'validation_error' | 'disagreement'
  reviewedValue   Json?
  reviewedBy      String?
  reviewedAt      DateTime?

  @@index([tenantId, canonicalKey])
  @@index([tenantId, formType, nativePattern])
  @@index([extractionId])
}
```

Add after the first migration:
```sql
CREATE INDEX extraction_normalized_gin ON "Extraction" USING GIN (normalized jsonb_path_ops);
```

**Effective value rule** (used by autofill): `reviewedValue ?? normalizedValue ?? rawValue`.

---

## 6. Processing pipeline — stage contracts

Each stage is idempotent, takes IDs, reads/writes the DB, and updates `Document.status`.

### 6.1 Ingest (`POST /documents`)
- Accept: `application/pdf`, `image/png`, `image/jpeg`, `image/tiff`, `image/heic`, `image/heif`, `image/webp`. Detect by magic bytes, not extension.
- Reject > `MAX_UPLOAD_MB` (default 25).
- Compute sha256. If `(tenantId, sha256)` exists, return the existing document (no reprocessing unless `?force=true`).
- Store original via `StorageService`. Create `Document(status=RECEIVED)`.

### 6.2 Normalize (`NormalizerService.run(documentId)`)
| Input | Action |
|---|---|
| PDF | `pdftoppm -r ${RASTER_DPI} -png in.pdf out` (default 200 DPI). |
| TIFF (incl. multi-page fax) | `sharp(buf, { pages: -1 })` → iterate pages → PNG. |
| HEIC/HEIF/JPG/WEBP | `sharp(buf).rotate()` (EXIF auto-orient) → PNG. |
| PNG | Re-encode via sharp (strips metadata). |

Then for every page:
- Downscale so long side ≤ `MAX_IMAGE_LONG_SIDE` (default 2000 px). Providers may downscale further via their capability (section 10.2).
- Convert to grayscale only if `RASTER_GRAYSCALE=true` (keep colour by default — CMS-1500 red ink helps models find box labels).
- Reject documents with > `MAX_PAGES` (default 30) in POC.
- Store page PNGs, create `Page` rows, set `NORMALIZED`.

### 6.3 Classify & segment (`ClassifierService.run(documentId)`)
- If `SEGMENTATION_MODE=single`: one segment = whole document; classify using the first ≤3 pages.
- If `SEGMENTATION_MODE=per-page` (default): send pages in batches (`CLASSIFIER_BATCH_PAGES`, default 8) at reduced size (long side 1024) to the classifier provider with the classifier schema (section 11.2). Output per page: `formType`, `confidence`, `continuesPrevious`.
- Segment rule: start a new segment when `formType` changes or `continuesPrevious=false`.
- Pages with `confidence < CLASSIFIER_MIN_CONFIDENCE` (default 0.6) → `GENERIC`.
- Create `Segment` rows, set `CLASSIFIED`.

Notes:
- CMS-1500: each page is normally its own claim (claims with >6 lines are separate forms with their own totals). Treat each page as its own segment unless the classifier is certain it continues.
- UB-04: multi-page claims show "PAGE __ OF __" on line 23. Group them into one segment.

### 6.4 Extract (`ExtractorService.run(segmentId)`)
1. Load `FormDefinition` by `segment.formType`.
2. Load segment page images.
3. If the form defines `sections` (large forms like UB-04), run one structured call per section and deep-merge results; otherwise one call with the full schema.
4. Call `ProviderRouter.extract(...)` (section 10.7).
5. Save `Extraction(raw, meta, provider, model, strategy, tokens, latency)`. Mark previous extractions for the segment `isCurrent=false` when this one becomes current.

### 6.5 Validate & normalize (`ValidatorService.run(extractionId)`)
1. `form.schema.safeParse(raw)` — structural check (should pass when strategy enforced the schema; still required for prompt-json strategy).
2. `normalizeValues(form, raw)` → `normalized` (section 12.1).
3. `form.validate(normalized)` → issues `{ path, code, message, severity: 'error'|'warning' }`.
4. Any `error` or any `_meta.unreadable/uncertain` entry → segment `NEEDS_REVIEW`; else `EXTRACTED`.

### 6.6 Flatten & persist (`Flattener`)
Walk `normalized` (and the matching `raw` path for `rawValue`), emit one `ExtractedField` per leaf (section 13). Skip `_meta`. Persist in one Prisma `$transaction` together with the Extraction update.

### 6.7 Review
`PATCH /fields/:id` sets `reviewedValue`, `reviewedBy`, `reviewedAt`. When no `error` issues and no unresolved flags remain, segment → `APPROVED`. Reviewed fields become the gold set for evaluation (section 17).

---

## 7. Form definition contract

```ts
// src/extraction/forms/form-definition.ts
import { z } from 'zod';

export type ValueType = 'string' | 'date' | 'money' | 'boolean' | 'code' | 'number' | 'enum';

export interface ValidationIssue {
  path: string;                 // native path
  code: string;                 // 'NPI_CHECKSUM', 'TOTAL_MISMATCH', ...
  message: string;
  severity: 'error' | 'warning';
}

export interface FormSection {
  name: string;                 // 'header' | 'lines' | 'codes' | 'providers'
  schema: z.ZodObject<any>;     // must include _meta
  instructions: string;
}

export interface FormDefinition<T = any> {
  id: string;                   // 'CMS1500'
  version: string;              // 'cms1500@0212.1' — bump when schema/mappings change
  displayName: string;          // 'CMS-1500 Health Insurance Claim Form (02/12)'
  classifier: {
    description: string;        // one paragraph the classifier sees
    visualCues: string[];       // printed titles, layout hints
  };
  schema: z.ZodObject<any>;     // full schema incl. _meta
  sections?: FormSection[];     // optional split for large forms
  instructions: string;         // form-specific extraction rules
  valueTypes: Record<string, ValueType>;     // nativePattern → type, drives normalization
  canonicalMap: Record<string, string>;      // nativePattern → canonical key
  repeatingGroups?: Record<string, string>;  // array path → group name, e.g. 'box24' → 'service_line'
  validate?: (normalized: T) => ValidationIssue[];
  subjectHints?: (normalized: T) => Record<string, string | null>;
}
```

```ts
// src/extraction/forms/shared/meta.schema.ts
export const MetaSchema = z.object({
  unreadable: z.array(z.string()).describe('Native paths present on the page but not legible'),
  uncertain: z.array(z.string()).describe('Native paths whose reading may be wrong'),
  notes: z.string().nullable().describe('Anything important that does not fit the schema'),
});
```

Every form schema includes `_meta: MetaSchema`.

```ts
// src/extraction/forms/registry.ts
export const FORMS: FormDefinition[] = [cms1500Form, ub04Form, bookingSheetForm, genericForm];
export const getForm = (id: string) => FORMS.find(f => f.id === id) ?? genericForm;
```

### Schema-writing rules (all forms)
1. Every leaf is `.nullable()`. Never `.optional()` — portable schemas require every key present.
2. Dates, money, phone, IDs → `z.string()` (as printed). Normalization happens in code.
3. Checkboxes → `z.boolean().nullable()` or `z.enum([...]).nullable()` for "check one" groups.
4. Repeating rows → `z.array(Row)`. Put row-count limits in `validate()`, not in the schema.
5. Every field has `.describe()` containing the box/FL number and the printed label. Models rely on this.
6. Keys are short, stable, and mirror the form: `box2`, `box24`, `fl42`. Do not rename keys after release — bump `version` and add new keys instead.

---

## 8. Form catalogs

### 8.1 CMS-1500 (02/12) — `CMS1500`

Classifier cues: title "HEALTH INSURANCE CLAIM FORM"; "APPROVED BY NATIONAL UNIFORM CLAIM COMMITTEE (NUCC) 02/12"; red-ink grid; boxes numbered 1–33; "CARRIER" label on right edge; footer "FORM 1500 (02-12)". Ignore "SAMPLE" watermarks.

| Native key | Box | Label | Type |
|---|---|---|---|
| `carrier.name`, `carrier.address` | top-right | Carrier block (payer name/address) | string |
| `box1.insuranceType` | 1 | MEDICARE / MEDICAID / TRICARE / CHAMPVA / GROUP HEALTH PLAN / FECA BLK LUNG / OTHER | enum |
| `box1a` | 1a | Insured's ID number | code |
| `box2.last`, `.first`, `.middle` | 2 | Patient's name | string |
| `box3.dob` | 3 | Patient's birth date (MM DD YY) | date |
| `box3.sex` | 3 | M / F | enum |
| `box4.last`, `.first`, `.middle` | 4 | Insured's name | string |
| `box5.street`, `.city`, `.state`, `.zip`, `.phone` | 5 | Patient's address & telephone | string |
| `box6` | 6 | Patient relationship to insured: SELF / SPOUSE / CHILD / OTHER | enum |
| `box7.street`, `.city`, `.state`, `.zip`, `.phone` | 7 | Insured's address & telephone | string |
| `box8` | 8 | Reserved for NUCC use | string |
| `box9.last`, `.first`, `.middle` | 9 | Other insured's name | string |
| `box9a` | 9a | Other insured's policy or group number | code |
| `box9b`, `box9c` | 9b/9c | Reserved for NUCC use | string |
| `box9d` | 9d | Other insured's insurance plan name | string |
| `box10a` | 10a | Condition related to employment | boolean |
| `box10b.value`, `box10b.state` | 10b | Auto accident + place (state) | boolean, string |
| `box10c` | 10c | Other accident | boolean |
| `box10d` | 10d | Claim codes (designated by NUCC) | code |
| `box11` | 11 | Insured's policy group or FECA number | code |
| `box11a.dob`, `box11a.sex` | 11a | Insured's date of birth, sex | date, enum |
| `box11b.qualifier`, `box11b.value` | 11b | Other claim ID | code |
| `box11c` | 11c | Insurance plan or program name | string |
| `box11d` | 11d | Is there another health benefit plan? | boolean |
| `box12.signed`, `box12.date` | 12 | Patient's signature (e.g. "SIGNATURE ON FILE"/"SOF") and date | string, date |
| `box13.signed` | 13 | Insured's signature | string |
| `box14.date`, `box14.qualifier` | 14 | Date of current illness/injury/pregnancy (QUAL) | date, code |
| `box15.qualifier`, `box15.date` | 15 | Other date | code, date |
| `box16.from`, `box16.to` | 16 | Dates patient unable to work | date |
| `box17.qualifier`, `box17.name` | 17 | Name of referring provider or other source | code, string |
| `box17a.qualifier`, `box17a.value` | 17a | Other ID | code |
| `box17b` | 17b | Referring NPI | code |
| `box18.from`, `box18.to` | 18 | Hospitalization dates | date |
| `box19` | 19 | Additional claim information | string |
| `box20.outsideLab`, `box20.charges` | 20 | Outside lab? $ charges | boolean, money |
| `box21.icdIndicator` | 21 | ICD Ind. (9 or 0) | code |
| `box21.codes.A` … `box21.codes.L` | 21 | Diagnosis codes A–L | code |
| `box22.code`, `box22.originalRef` | 22 | Resubmission code, original ref. no. | code |
| `box23` | 23 | Prior authorization number | code |
| `box24[]` | 24 | Service lines (up to 6) — see row below | array |
| `box25.value`, `box25.type` | 25 | Federal tax ID, SSN/EIN checkbox | code, enum |
| `box26` | 26 | Patient's account no. | code |
| `box27` | 27 | Accept assignment? | boolean |
| `box28` | 28 | Total charge | money |
| `box29` | 29 | Amount paid | money |
| `box30` | 30 | Reserved for NUCC use | string |
| `box31.signature`, `box31.date` | 31 | Physician/supplier signature, date | string, date |
| `box32.name`, `.street`, `.city`, `.state`, `.zip` | 32 | Service facility location | string |
| `box32a`, `box32b` | 32a/32b | Facility NPI, other ID | code |
| `box33.name`, `.street`, `.city`, `.state`, `.zip`, `.phone` | 33 | Billing provider info & phone | string |
| `box33a`, `box33b` | 33a/33b | Billing NPI, other ID | code |

**Box 24 row (`box24[i]`):**
`supplementalInfo` (shaded upper line), `dateFrom`, `dateTo` (24A), `placeOfService` (24B), `emg` (24C), `cptHcpcs`, `modifiers[]` (24D, up to 4), `diagnosisPointer` (24E, letters A–L), `charges` (24F), `units` (24G), `epsdt` (24H), `idQualifier` (24I), `renderingProviderId` (24J shaded), `renderingNpi` (24J).

Skeleton:
```ts
const ServiceLine = z.object({
  supplementalInfo: z.string().nullable().describe('24 shaded upper area: supplemental info'),
  dateFrom: z.string().nullable().describe('24A FROM date as printed'),
  dateTo: z.string().nullable().describe('24A TO date as printed'),
  placeOfService: z.string().nullable().describe('24B place of service code'),
  emg: z.string().nullable().describe('24C EMG'),
  cptHcpcs: z.string().nullable().describe('24D CPT/HCPCS code'),
  modifiers: z.array(z.string()).describe('24D modifiers, up to 4'),
  diagnosisPointer: z.string().nullable().describe('24E letters A-L'),
  charges: z.string().nullable().describe('24F $ charges as printed, dollars and cents'),
  units: z.string().nullable().describe('24G days or units'),
  epsdt: z.string().nullable().describe('24H EPSDT/family plan'),
  idQualifier: z.string().nullable().describe('24I ID qual'),
  renderingProviderId: z.string().nullable().describe('24J shaded: other rendering provider ID'),
  renderingNpi: z.string().nullable().describe('24J rendering provider NPI'),
});

export const Cms1500Schema = z.object({
  carrier: z.object({ name: z.string().nullable(), address: z.string().nullable() }),
  box1: z.object({
    insuranceType: z.enum(['MEDICARE','MEDICAID','TRICARE','CHAMPVA','GROUP_HEALTH_PLAN','FECA_BLK_LUNG','OTHER'])
      .nullable().describe('Box 1: the single checked insurance type'),
  }),
  box1a: z.string().nullable().describe("Box 1a: INSURED'S I.D. NUMBER"),
  box2: PersonName.describe("Box 2: PATIENT'S NAME (Last, First, Middle Initial)"),
  // ... continue exactly per the table above
  box24: z.array(ServiceLine).describe('Box 24 service lines 1-6, only lines that contain data'),
  // ...
  _meta: MetaSchema,
});
```

**CMS-1500 extraction instructions** (`instructions` field):
```
- Box numbers are printed at the top-left of each cell. Map values by box number, not by position guesses.
- The top-right block above the red line is the carrier (payer) name/address.
- Box 24 has 6 numbered lines. Each line has a shaded upper half (supplementalInfo / 24J other ID) and a white lower half. Return only lines that contain any data, in order.
- 24F and boxes 28/29 split dollars and cents with a vertical rule. Return "dollars cents" as printed, e.g. "125 00".
- Box 21 diagnosis slots are lettered A–L. Return an object keyed A–L; empty slots null.
- Pre-printed text such as "NPI", "QUAL", "$", "SEX", "M", "F" is not data.
- Ignore watermarks such as "SAMPLE".
```

### 8.2 UB-04 (CMS-1450) — `UB04`

Classifier cues: 81 form locators; title area "UB-04"; "NUBC National Uniform Billing Committee"; large revenue-line grid FL42–49 with 22 lines plus line 23 "PAGE __ OF __" and "TOTALS"; red ink.

Use `sections` because the full schema is large:

| Section | Form locators |
|---|---|
| `header` | FL1 billing provider name/address/phone · FL2 pay-to · FL3a patient control no. · FL3b medical record no. · FL4 type of bill · FL5 federal tax no. · FL6 statement period from/through · FL8a patient ID · FL8b patient name · FL9a–e patient address · FL10 birthdate · FL11 sex · FL12 admission date · FL13 admission hour · FL14 priority (type) of admission · FL15 point of origin · FL16 discharge hour · FL17 patient discharge status · FL18–28 condition codes · FL29 accident state |
| `codes` | FL31–34 occurrence codes + dates · FL35–36 occurrence span codes + from/through · FL38 responsible party name/address · FL39–41 value codes + amounts (a–d) |
| `lines` | FL42 revenue code · FL43 description · FL44 HCPCS/rate/HIPPS code · FL45 service date · FL46 service units · FL47 total charges · FL48 non-covered charges — up to 22 lines per page · line 23: page X of Y, creation date, totals |
| `payers` | FL50 payer name (A/B/C) · FL51 health plan ID · FL52 release of info · FL53 assignment of benefits · FL54 prior payments · FL55 estimated amount due · FL56 billing NPI · FL57 other provider ID · FL58 insured's name · FL59 patient's relationship · FL60 insured's unique ID · FL61 group name · FL62 insurance group no. · FL63 treatment authorization codes · FL64 document control number · FL65 employer name |
| `clinical` | FL66 diagnosis/procedure code qualifier (ICD version) · FL67 principal diagnosis + POA · FL67A–Q other diagnoses + POA · FL69 admitting diagnosis · FL70a–c patient reason for visit · FL71 PPS code · FL72a–c external cause of injury · FL74 principal procedure code + date · FL74a–e other procedures + dates |
| `providers` | FL76 attending (NPI, qual, ID, last/first) · FL77 operating · FL78–79 other providers (qual, NPI, ID, name) · FL80 remarks · FL81a–d code-code (qual, code, value) |

Reserved locators (FL7, 30, 37, 49, 68, 73, 75) → capture as `flNN` strings anyway; some payers use them.

Instructions:
```
- Form locator (FL) numbers are printed in each cell. Map by FL number.
- FL42–48 is a grid of up to 22 lines. Return only lines with data, in order. Line 23 holds page numbering and totals; return it separately in `line23`.
- Revenue codes are 4 digits; keep leading zeros exactly as printed (e.g. "0450").
- Diagnosis codes may have a one-character POA indicator in a separate small column; return it in `poa`.
- Money columns split dollars and cents; return as printed.
```

### 8.3 Booking sheet — `BOOKING_SHEET`

No standard layout. Schema = common fields + open-ended capture.

| Key | Meaning |
|---|---|
| `facilityName`, `facilityAddress`, `facilityPhone`, `facilityFax` | Where the procedure happens |
| `bookingId`, `bookingDate`, `requestedBy` | Booking reference |
| `procedureDate`, `procedureTime`, `estimatedDurationMin`, `arrivalTime` | Schedule |
| `patient.last/first/middle`, `patient.dob`, `patient.sex`, `patient.phone`, `patient.address`, `patient.mrn` | Patient |
| `surgeon`, `assistant`, `anesthesiaType`, `admissionType` (inpatient/outpatient/23h) | Clinical team |
| `procedures[]` → `{ description, cptCodes[], side (LEFT/RIGHT/BILATERAL/null) }` | Procedures |
| `diagnoses[]` → `{ description, icdCode }` | Diagnoses |
| `insurance[]` → `{ payerName, memberId, groupNumber, subscriberName, authorizationNumber, priority }` | Coverage |
| `equipment`, `implants`, `specialRequests`, `notes` | Free text |
| `additionalFields[]` → `{ label, value, section }` | **Every other labelled value on the sheet** |
| `tables[]` → `{ title, headers[], rows[][] }` | Any table not covered above |

Instruction: "Fill known keys when the sheet clearly contains them. Put every other labelled value into `additionalFields` using the label exactly as printed. Do not skip any visible field."

### 8.4 Generic fallback — `GENERIC`

Used for unknown documents and low-confidence classification. Guarantees "save every possible data point".

```ts
export const GenericSchema = z.object({
  documentTitle: z.string().nullable(),
  documentKindGuess: z.string().nullable().describe('Free-text guess, e.g. "EOB", "referral letter"'),
  fields: z.array(z.object({
    label: z.string().describe('Label exactly as printed'),
    value: z.string().nullable(),
    page: z.number(),
    section: z.string().nullable(),
    isCheckbox: z.boolean(),
    checked: z.boolean().nullable(),
  })),
  tables: z.array(z.object({
    title: z.string().nullable(),
    page: z.number(),
    headers: z.array(z.string()),
    rows: z.array(z.array(z.string().nullable())),
  })),
  freeText: z.array(z.object({ page: z.number(), text: z.string() }))
    .describe('Paragraphs or handwritten notes that are not label/value pairs'),
  _meta: MetaSchema,
});
```

Generic fields get `canonicalKey = null`, `nativePath = fields[i]`, and `groupName = 'generic_field'`. Store `label` as part of `nativePath` metadata: set `nativePattern = 'generic:' + slug(label)` so recurring labels across documents can be mapped later without re-extraction.

**Promotion path:** when the same `generic:<label>` appears often for one source, create a real `FormDefinition` for it.

---

## 9. Canonical field dictionary

Canonical keys are what autofill asks for. Mappings live in each `FormDefinition.canonicalMap` (version-controlled code, not DB rows).

| Canonical key | CMS-1500 | UB-04 | Booking sheet |
|---|---|---|---|
| `patient.name.last` / `.first` / `.middle` | `box2.*` | `fl8b.*` | `patient.*` |
| `patient.dob` | `box3.dob` | `fl10` | `patient.dob` |
| `patient.sex` | `box3.sex` | `fl11` | `patient.sex` |
| `patient.address.*` | `box5.*` | `fl9.*` | `patient.address` |
| `patient.phone` | `box5.phone` | — | `patient.phone` |
| `patient.account_number` | `box26` | `fl3a` | — |
| `patient.mrn` | — | `fl3b` | `patient.mrn` |
| `insured.id` | `box1a` | `fl60[*]` | `insurance[*].memberId` |
| `insured.name.*` | `box4.*` | `fl58[*]` | `insurance[*].subscriberName` |
| `insured.relationship` | `box6` | `fl59[*]` | — |
| `insured.group_number` | `box11` | `fl62[*]` | `insurance[*].groupNumber` |
| `insured.dob` | `box11a.dob` | — | — |
| `payer.name` | `carrier.name`, `box11c` | `fl50[*]` | `insurance[*].payerName` |
| `claim.prior_auth` | `box23` | `fl63[*]` | `insurance[*].authorizationNumber` |
| `claim.diagnosis_codes` | `box21.codes.*` | `fl67`, `fl67a..q` | `diagnoses[*].icdCode` |
| `claim.principal_diagnosis` | `box21.codes.A` | `fl67.code` | `diagnoses[0].icdCode` |
| `claim.statement_from` / `_to` | — | `fl6.from` / `.through` | — |
| `claim.admission_date` | — | `fl12` | — |
| `claim.total_charge` | `box28` | `line23.totalCharges` | — |
| `claim.amount_paid` | `box29` | `fl54[*]` | — |
| `claim.type_of_bill` | — | `fl4` | — |
| `provider.billing.npi` | `box33a` | `fl56` | — |
| `provider.billing.tax_id` | `box25.value` | `fl5` | — |
| `provider.billing.name` | `box33.name` | `fl1.name` | — |
| `provider.rendering.npi` | `box24[*].renderingNpi` | — | — |
| `provider.referring.npi` | `box17b` | — | — |
| `provider.attending.npi` | — | `fl76.npi` | — |
| `provider.surgeon.name` | — | `fl77.name` | `surgeon` |
| `facility.name` / `.npi` | `box32.name` / `box32a` | `fl1.name` / `fl56` | `facilityName` |
| `line.service_date_from` | `box24[*].dateFrom` | `fl45[*]` (lines) | `procedureDate` |
| `line.cpt_hcpcs` | `box24[*].cptHcpcs` | `lines[*].hcpcs` | `procedures[*].cptCodes[*]` |
| `line.modifiers` | `box24[*].modifiers` | — | — |
| `line.revenue_code` | — | `lines[*].revenueCode` | — |
| `line.units` | `box24[*].units` | `lines[*].units` | — |
| `line.charge` | `box24[*].charges` | `lines[*].totalCharges` | — |
| `line.place_of_service` | `box24[*].placeOfService` | — | — |
| `booking.id` / `.date` / `.procedure_date` | — | — | `bookingId` / `bookingDate` / `procedureDate` |

Pattern syntax: `[*]` matches any array index. The flattener converts `box24[3].cptHcpcs` → `box24[*].cptHcpcs` for lookup and stores `groupIndex = 3`.

---

## 10. Model-agnostic provider layer

### 10.1 Interface

```ts
// src/extraction/providers/model-provider.ts
export interface PageImage {
  pageNumber: number;
  mimeType: 'image/png' | 'image/jpeg';
  base64: string;
  widthPx: number;
  heightPx: number;
}

export interface PortableSchema { [k: string]: unknown }   // JSON Schema subset, see 10.3

export interface ProviderCapabilities {
  nativeJsonSchema: boolean;        // decoding constrained to a JSON Schema
  toolCalling: boolean;             // can force a tool call with an input schema
  schemaDialect: 'json-schema' | 'openapi-3.0-subset';
  maxImagesPerRequest: number;
  maxImageLongSidePx: number;
  acceptsPdf: boolean;              // informational; pipeline always sends images
}

export interface StructuredRequest {
  system: string;
  instruction: string;
  pages: PageImage[];
  schema: PortableSchema;
  schemaName: string;               // [a-zA-Z0-9_]{1,64}
  temperature: number;              // default 0
  maxOutputTokens: number;
  timeoutMs: number;
  strategy: 'native-schema' | 'tool-call' | 'prompt-json';
}

export interface StructuredResponse {
  rawText: string;                  // exact text/arguments returned
  json: unknown;                    // parsed (may still fail Zod)
  model: string;
  strategy: StructuredRequest['strategy'];
  usage?: { inputTokens?: number; outputTokens?: number };
  latencyMs: number;
  finishReason?: string;
}

export interface ModelProvider {
  readonly id: string;              // 'gemini' | 'anthropic' | 'openai-compatible:<name>' | 'bedrock'
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  readonly phiApproved: boolean;    // set from config by an admin, never defaulted to true
  generate(req: StructuredRequest): Promise<StructuredResponse>;
}
```

### 10.2 Capabilities are configuration, not assumptions
Model APIs change. Each provider reads its capability overrides from env (e.g. `GEMINI_NATIVE_SCHEMA=true`, `OPENAI_COMPAT_MAX_IMAGES=10`). The defaults below are starting points; verify against each vendor's current docs and run the provider contract test (section 17.2) before enabling.

| Provider adapter | Default strategy | Dialect | Image input format |
|---|---|---|---|
| `gemini` (AI Studio or Vertex) | native-schema | json-schema via `responseJsonSchema`; fall back to `responseSchema` (OpenAPI subset) | `inline_data { mime_type, data }` |
| `anthropic` (direct API) | tool-call (forced) | json-schema in `input_schema` | `{ type:'image', source:{ type:'base64', media_type, data } }` |
| `bedrock` (Converse API, any vision model) | tool-call (`toolConfig`, forced tool) | json-schema in `inputSchema.json` | `{ image:{ format:'png', source:{ bytes } } }` |
| `openai-compatible` (OpenAI, Azure OpenAI, vLLM, Mistral chat, Ollama, LM Studio) | native-schema via `response_format: { type:'json_schema', json_schema:{ name, schema, strict:true } }` | json-schema (strict rules) | `{ type:'image_url', image_url:{ url:'data:image/png;base64,...' } }` |
| any provider without schema support | prompt-json | — | — |

### 10.3 Portable schema rules
`portable-schema.ts` converts a Zod schema into a JSON Schema subset that every provider accepts:

1. Generate: `z.toJSONSchema(schema)` (Zod v4).
2. Inline all `$ref`/`$defs` (some providers reject references).
3. Objects: `additionalProperties: false`; `required` = **all** property keys.
4. Nullability: express as `"type": ["string", "null"]` (or `anyOf: [{...}, {"type":"null"}]`). No other `anyOf`/`oneOf`/`allOf`.
5. Remove: `format`, `pattern`, `minLength`, `maxLength`, `minimum`, `maximum`, `minItems`, `maxItems`, `default`, `examples`, `$schema`.
6. Keep: `type`, `properties`, `required`, `items`, `enum`, `description`.
7. Keep `description` short (< 200 chars). It is the main hint models use.

Dialect converters:
- `toOpenApiSubset(schema)` for Gemini `responseSchema`: `"type": ["string","null"]` → `"type": "string", "nullable": true`; drop `additionalProperties`.
- OpenAI strict mode is satisfied by rules 3–5.

If a provider rejects the schema for size/depth, the extractor must use the form's `sections` (section 7). Do not silently drop fields.

```ts
export function toPortableSchema(zodSchema: z.ZodTypeAny): PortableSchema {
  const json = z.toJSONSchema(zodSchema) as any;
  return clean(inlineRefs(json));
}

const DROP = ['format','pattern','minLength','maxLength','minimum','maximum',
              'minItems','maxItems','default','examples','$schema','$defs','definitions'];

function clean(node: any): any {
  if (Array.isArray(node)) return node.map(clean);
  if (!node || typeof node !== 'object') return node;
  for (const k of DROP) delete node[k];
  if (node.anyOf) node = collapseNullableAnyOf(node);     // [{type:X},{type:'null'}] → {type:[X,'null']}
  if (node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object'))) {
    node.properties = Object.fromEntries(
      Object.entries(node.properties ?? {}).map(([k, v]) => [k, clean(v)]));
    node.required = Object.keys(node.properties);
    node.additionalProperties = false;
  }
  if (node.items) node.items = clean(node.items);
  return node;
}
```

### 10.4 Structured output strategy and repair loop

`StructuredOutputService.run(provider, req, zodSchema)`:

1. Choose strategy: `native-schema` if capable, else `tool-call` if capable, else `prompt-json`.
2. For `prompt-json`, append to the instruction:
   `Return ONLY a JSON object (no markdown fences) that validates against this JSON Schema:\n<schema JSON>`
3. Call `provider.generate(req)`.
4. Parse: strip ``` fences, take the substring from the first `{` to the matching last `}`, `JSON.parse`.
5. `zodSchema.safeParse(json)`.
6. On parse or validation failure: retry **once** with the same pages plus:
   `Your previous output was invalid: <first 20 Zod issues as path: message>. Return the corrected full JSON only.`
7. Still failing: throw `ExtractionFormatError` with raw text attached; the router may try the next provider.

Transient errors (HTTP 429, 5xx, timeouts): exponential backoff (`1s, 4s, 10s`), max 3 attempts, honour `Retry-After`. These retries are separate from the repair retry.

### 10.5 Adapter sketches

**OpenAI-compatible** (covers OpenAI, Azure OpenAI, vLLM, Mistral chat, Ollama, LM Studio):
```ts
async generate(req: StructuredRequest): Promise<StructuredResponse> {
  const started = Date.now();
  const content = [
    { type: 'text', text: req.instruction },
    ...req.pages.map(p => ({ type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${p.base64}` } })),
  ];
  const body: any = {
    model: this.model,
    temperature: req.temperature,
    max_tokens: req.maxOutputTokens,
    messages: [{ role: 'system', content: req.system }, { role: 'user', content }],
  };
  if (req.strategy === 'native-schema') {
    body.response_format = { type: 'json_schema', json_schema: { name: req.schemaName, schema: req.schema, strict: true } };
  }
  const res = await fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}`, ...this.extraHeaders },
    body: JSON.stringify(body),
  }, req.timeoutMs);
  if (!res.ok) throw await ProviderHttpError.from(res);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  return {
    rawText: text, json: safeJson(text), model: data.model ?? this.model, strategy: req.strategy,
    usage: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens },
    latencyMs: Date.now() - started, finishReason: data.choices?.[0]?.finish_reason,
  };
}
```
Azure note: base URL and auth header differ (`api-key` header, deployment name in path). Put this in `extraHeaders`/URL builder config, not in shared code.

**Anthropic (forced tool call):**
```ts
const body = {
  model: this.model, max_tokens: req.maxOutputTokens, temperature: req.temperature, system: req.system,
  tools: [{ name: req.schemaName, description: 'Return the extracted form data', input_schema: req.schema }],
  tool_choice: { type: 'tool', name: req.schemaName },
  messages: [{ role: 'user', content: [
    ...req.pages.map(p => ({ type: 'image', source: { type: 'base64', media_type: p.mimeType, data: p.base64 } })),
    { type: 'text', text: req.instruction },
  ]}],
};
// POST https://api.anthropic.com/v1/messages  headers: x-api-key, anthropic-version: 2023-06-01
// json = content.find(b => b.type === 'tool_use').input ; rawText = JSON.stringify(json)
```

**Gemini (native schema):**
```ts
const body = {
  systemInstruction: { parts: [{ text: req.system }] },
  contents: [{ role: 'user', parts: [
    ...req.pages.map(p => ({ inline_data: { mime_type: p.mimeType, data: p.base64 } })),
    { text: req.instruction },
  ]}],
  generationConfig: {
    temperature: req.temperature,
    maxOutputTokens: req.maxOutputTokens,
    responseMimeType: 'application/json',
    responseJsonSchema: req.schema,          // or responseSchema: toOpenApiSubset(req.schema)
  },
};
// AI Studio: POST https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=...
// Vertex:    POST https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent
//            (Bearer token from google-auth-library)
// text = candidates[0].content.parts.map(p => p.text).join('')
```

**Bedrock (Converse, forced tool):**
```ts
new ConverseCommand({
  modelId: this.model,
  system: [{ text: req.system }],
  messages: [{ role: 'user', content: [
    ...req.pages.map(p => ({ image: { format: 'png', source: { bytes: Buffer.from(p.base64, 'base64') } } })),
    { text: req.instruction },
  ]}],
  toolConfig: {
    tools: [{ toolSpec: { name: req.schemaName, inputSchema: { json: req.schema } } }],
    toolChoice: { tool: { name: req.schemaName } },
  },
  inferenceConfig: { temperature: req.temperature, maxTokens: req.maxOutputTokens },
});
// json = output.message.content.find(c => c.toolUse).toolUse.input
```

**Self-hosted OCR-specialist models** (e.g. Chandra, olmOCR) that return layout text rather than schema JSON: use a two-step `pipeline` provider — step 1 the OCR model returns markdown/HTML; step 2 a text-only LLM provider maps that text to the schema with `prompt-json` or `native-schema`. Implement as `ComposedProvider(ocrProvider, mapperProvider)` so it still satisfies `ModelProvider`. Note: checkbox state must survive step 1 — verify with the contract test.

### 10.6 Adding a provider
1. Create `src/extraction/providers/<name>.provider.ts` implementing `ModelProvider`.
2. Read all settings from `ConfigService` under a `<NAME>_` prefix.
3. Register in `provider-router.ts` factory map.
4. Pass the contract tests (section 17.2).
5. Set `<NAME>_PHI_APPROVED=true` only after a BAA/DPA is in place.

### 10.7 Router modes

```ts
type RouterMode = 'single' | 'fallback' | 'consensus';
```
- **single**: `EXTRACTION_PROVIDERS[0]` only.
- **fallback**: try providers in order; move to the next on `ExtractionFormatError`, schema rejection, or exhausted transient retries.
- **consensus**: run the first N providers (`CONSENSUS_N`, default 2) in parallel, store every result as its own `Extraction` (`isCurrent` only on the chosen one), compare **normalized** values per native path:
  - agree → keep, no flag.
  - disagree → keep primary's value, add flag `disagreement`, store alternatives in `Extraction.meta.alternatives[path]`, segment → `NEEDS_REVIEW`.
  - one null, one value → flag `disagreement` (often hallucination or a missed field).

Consensus is the model-agnostic replacement for confidence scores, which LLMs do not provide reliably. Use it for CMS-1500/UB-04 in production; skip it in early POC to save cost.

**PHI guard:** when `PHI_MODE=true`, the router refuses any provider with `phiApproved=false` and throws at startup if no approved provider is configured.

---

## 11. Prompts

All prompts live in `src/extraction/prompts/`. Bump `PROMPT_VERSION` on any change; it is stored on every `Extraction`.

### 11.1 System prompt (all extraction calls)
```
You are a document transcription engine for healthcare and administrative forms.
You receive page images of ONE form and return JSON that matches the provided schema exactly.

Rules:
1. Transcribe only what is visibly written, typed, or stamped in each field. Never infer, calculate, look up, or complete values from outside knowledge.
2. If a field is blank, return null. If something is present but illegible, return null and add the field path to _meta.unreadable.
3. Copy identifiers and codes character-for-character: member IDs, NPIs, tax IDs, ICD codes, CPT/HCPCS codes, revenue codes, authorization numbers. Keep leading zeros. Do not add or remove punctuation in codes.
4. Return dates and money exactly as printed (e.g. "03 12 84", "125 00"). Do not reformat.
5. Checkboxes: true only when clearly marked (X, check, fill, circle). Unmarked = false. If a mark is ambiguous, return null and add the path to _meta.uncertain.
6. For "check one" groups, return the single marked option; if several are marked, return the most clearly marked and list the path in _meta.uncertain.
7. Pre-printed labels, instructions, box numbers, and watermarks (e.g. "SAMPLE") are not data.
8. For repeating rows, return only rows that contain data, in top-to-bottom order.
9. If you are unsure whether a value belongs to a field, add the path to _meta.uncertain.
10. Output only the JSON.
```

### 11.2 Classifier
Schema:
```ts
z.object({
  pages: z.array(z.object({
    page: z.number(),
    formType: z.enum([...FORMS.map(f => f.id)]),   // includes 'GENERIC'
    confidence: z.number().describe('0 to 1'),
    continuesPrevious: z.boolean().describe('true if this page continues the form on the previous page'),
    reason: z.string().describe('Printed title or cue that decided it, max 15 words'),
  })),
})
```
Instruction template (built from the registry):
```
Classify each page. Possible form types:
{{#each forms}}
- {{id}}: {{classifier.description}} Visual cues: {{classifier.visualCues | join "; "}}
{{/each}}
- GENERIC: anything else.
Pages are given in order, numbered {{firstPage}}..{{lastPage}}.
```
Self-reported confidence is a weak signal. Use it only for the `GENERIC` threshold, never as field confidence.

### 11.3 Extraction instruction template
```
Form: {{form.displayName}} (schema {{form.version}})
Pages in this form: {{pageNumbers}}
{{#if section}}Extract ONLY the "{{section.name}}" section. {{section.instructions}}{{/if}}

Form-specific rules:
{{form.instructions}}

Return JSON for schema "{{schemaName}}".
```

---

## 12. Normalization and validation

### 12.1 Value normalization (code, deterministic)
Driven by `form.valueTypes[nativePattern]`.

| Type | Input examples | Normalized | Rule |
|---|---|---|---|
| `date` | `03 12 84`, `03/12/1984`, `031284`, `2026-09-01` | `1984-03-12` | Parse MM DD YY/YYYY first (US forms). Two-digit year: DOB fields → most recent past year; service dates → 2000 + YY. Unparseable → `null` + `validation_error` flag, keep `rawValue`. |
| `money` | `125 00`, `$1,250.00`, `125.` | `125.00` (number) | Strip `$`, commas; "D CC" with space → D.CC. |
| `code` | ` e11.9 `, `0450` | `E11.9`, `0450` | Trim, uppercase. Never strip leading zeros. |
| `string` | names, addresses | trimmed, internal whitespace collapsed | Case preserved. |
| `boolean`/`enum` | as returned | as returned | — |
| `number` | `1`, `1.0` | `1` | — |

ICD-10 dot rule: store both `code` (as printed, uppercased) and `codeNoDot` in `normalizedValue` so autofill can output either format.

### 12.2 Domain validation (form `validate()`)
| Code | Check | Severity |
|---|---|---|
| `NPI_CHECKSUM` | 10 digits; Luhn check on `"80840" + first 9 digits` equals 10th digit | error |
| `ICD10_FORMAT` | `^[A-TV-Z][0-9][0-9A-Z](\.?[0-9A-Z]{1,4})?$` (format only) | warning |
| `CPT_HCPCS_FORMAT` | `^([0-9]{4}[0-9A-Z]\|[A-V][0-9]{4})$` (format only) | warning |
| `REV_CODE_FORMAT` | `^[0-9]{4}$` | warning |
| `EIN_FORMAT` | `^[0-9]{2}-?[0-9]{7}$` (when SSN/EIN = EIN) | warning |
| `STATE_FORMAT` | 2-letter USPS code | warning |
| `ZIP_FORMAT` | `^[0-9]{5}(-?[0-9]{4})?$` | warning |
| `DATE_UNPARSEABLE` | date normalizer failed | error |
| `DATE_ORDER` | from ≤ to; DOB ≤ service dates | warning |
| `CMS1500_MAX_LINES` | `box24.length ≤ 6` | error |
| `CMS1500_DX_POINTER` | each pointer letter references a filled box21 code | warning |
| `CMS1500_TOTAL` | `sum(box24[*].charges) == box28` (±0.01), only when all present | warning |
| `UB04_MAX_LINES` | ≤ 22 lines per page | error |
| `UB04_TOTAL` | `sum(lines[*].totalCharges) == line23.totalCharges` (±0.01) | warning |
| `REQUIRED_CORE` | per form, e.g. CMS-1500 needs patient name, insured ID, ≥1 line | warning |

Validation never blocks storage. It only drives flags and `NEEDS_REVIEW`.

---

## 13. Flattener

```ts
export function flatten(form: FormDefinition, normalized: any, raw: any, meta: Meta): FieldRow[] {
  const rows: FieldRow[] = [];
  walk(normalized, '');
  return rows;

  function walk(node: any, path: string) {
    if (path === '_meta') return;
    if (Array.isArray(node)) {
      const isPrimitiveArray = node.every(v => v === null || typeof v !== 'object');
      if (isPrimitiveArray) return emit(path, node);           // e.g. modifiers[]
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
      return;
    }
    emit(path, node);
  }

  function emit(path: string, value: unknown) {
    const pattern = path.replace(/\[\d+\]/g, '[*]');
    const idx = path.match(/\[(\d+)\]/)?.[1];
    const topArray = path.split('[')[0];
    rows.push({
      nativePath: path,
      nativePattern: pattern,
      canonicalKey: form.canonicalMap[pattern] ?? null,
      groupName: idx !== undefined ? (form.repeatingGroups?.[topArray] ?? topArray) : null,
      groupIndex: idx !== undefined ? Number(idx) : null,
      valueType: form.valueTypes[pattern] ?? 'string',
      rawValue: stringifyOrNull(get(raw, path)),
      normalizedValue: value ?? null,
      flags: flagsFor(path, meta),     // unreadable/uncertain/validation_error/disagreement
    });
  }
}
```
Rules:
- **Emit null leaves too.** "Field was blank" is information (autofill must not reuse a stale value when the newest form says blank — configurable).
- Nested arrays (e.g. `procedures[1].cptCodes[0]`) keep the full path; `groupIndex` is the first index.

---

## 14. API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/documents` | multipart `file`; query `force`, `formTypeHint`. Sync mode returns full result; queue mode returns `202 { documentId }`. |
| `GET` | `/documents/:id` | Status, pages, segments, current extraction summary, validation issues. |
| `GET` | `/documents/:id/segments/:segId/data` | `{ formType, formVersion, normalized, raw, meta, issues }`. |
| `GET` | `/documents/:id/fields` | Paged field rows; filters `canonicalKey`, `formType`, `flag`. |
| `POST` | `/documents/:id/reprocess` | Body `{ providers?, mode?, formType? }` — re-run from classify or extract. New `Extraction`; old ones kept. |
| `PATCH` | `/fields/:id` | `{ value, reviewer }` → `reviewedValue`. |
| `POST` | `/segments/:id/approve` | Mark reviewed. |
| `GET` | `/autofill` | `keys=patient.name.last,insured.id&match[patient.dob]=1984-03-12&match[patient.name.last]=DOE` → latest effective values per key with source document/segment IDs. |
| `GET` | `/forms` | Registered forms, versions, canonical keys (for the frontend). |

Autofill query sketch:
```sql
WITH candidate_segments AS (
  SELECT e.segment_id
  FROM "ExtractedField" f JOIN "Extraction" e ON e.id = f.extraction_id AND e.is_current
  WHERE f.tenant_id = $1
    AND (f.canonical_key, COALESCE(f.reviewed_value, f.normalized_value)::text) IN (/* match pairs */)
  GROUP BY e.segment_id
  HAVING COUNT(DISTINCT f.canonical_key) = $matchCount
)
SELECT DISTINCT ON (f.canonical_key)
       f.canonical_key, COALESCE(f.reviewed_value, f.normalized_value) AS value,
       e.segment_id, f.flags, e.created_at
FROM "ExtractedField" f
JOIN "Extraction" e ON e.id = f.extraction_id AND e.is_current
WHERE e.segment_id IN (SELECT segment_id FROM candidate_segments)
  AND f.canonical_key = ANY($keys)
  AND COALESCE(f.reviewed_value, f.normalized_value) IS NOT NULL
ORDER BY f.canonical_key, (f.reviewed_by IS NOT NULL) DESC, cardinality(f.flags) ASC, e.created_at DESC;
```
(Adjust column names to Prisma's mapped names.)

---

## 15. Configuration

```bash
# Pipeline
PIPELINE_MODE=sync                 # sync | queue
SEGMENTATION_MODE=per-page         # single | per-page
MAX_UPLOAD_MB=25
MAX_PAGES=30
RASTER_DPI=200
MAX_IMAGE_LONG_SIDE=2000
RASTER_GRAYSCALE=false
CLASSIFIER_BATCH_PAGES=8
CLASSIFIER_MIN_CONFIDENCE=0.6
EXTRACTION_MAX_PAGES_PER_CALL=10

# Routing
PHI_MODE=true
CLASSIFIER_PROVIDER=gemini
EXTRACTION_PROVIDERS=gemini,anthropic    # order matters
ROUTER_MODE=fallback                     # single | fallback | consensus
CONSENSUS_N=2
EXTRACTION_TEMPERATURE=0
EXTRACTION_MAX_OUTPUT_TOKENS=16000
PROVIDER_TIMEOUT_MS=120000

# Gemini
GEMINI_MODE=vertex                       # aistudio | vertex
GEMINI_API_KEY=
GEMINI_VERTEX_PROJECT=
GEMINI_VERTEX_LOCATION=
GEMINI_MODEL=
GEMINI_NATIVE_SCHEMA=true
GEMINI_PHI_APPROVED=false

# Anthropic
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=
ANTHROPIC_PHI_APPROVED=false

# OpenAI-compatible (repeatable with a name suffix, e.g. OPENAI_COMPAT_VLLM_*)
OPENAI_COMPAT_NAME=openai
OPENAI_COMPAT_BASE_URL=https://api.openai.com/v1
OPENAI_COMPAT_API_KEY=
OPENAI_COMPAT_MODEL=
OPENAI_COMPAT_NATIVE_SCHEMA=true
OPENAI_COMPAT_MAX_IMAGES=10
OPENAI_COMPAT_PHI_APPROVED=false

# Bedrock
BEDROCK_REGION=
BEDROCK_MODEL_ID=
BEDROCK_PHI_APPROVED=false

# Storage
STORAGE_DRIVER=local                     # local | s3
STORAGE_LOCAL_DIR=./storage
S3_BUCKET=
S3_KMS_KEY_ID=
```
Model names are never hard-coded. Validate env at startup with a Zod config schema.

---

## 16. Errors, retries, idempotency

| Error | Where | Handling |
|---|---|---|
| Unsupported/corrupt file | Ingest/Normalize | `400` / `Document FAILED` with `error` message |
| Too many pages | Normalize | `FAILED` with clear message (POC) |
| Provider 429/5xx/timeout | Provider | Backoff retries (10.4), then router fallback |
| Schema rejected by provider | Provider | Use sections; else fallback provider |
| Invalid JSON / Zod failure after repair | StructuredOutput | `ExtractionFormatError` → fallback; if all fail, save raw text in `Extraction.raw = { _unparsed: text }`, segment `FAILED` |
| Output truncated (`finishReason` length/max_tokens) | Provider | Retry once with sections; else fail |
| No PHI-approved provider while `PHI_MODE=true` | Startup | Refuse to boot |

Idempotency: every stage checks status before acting; reprocessing creates new `Extraction` rows and never mutates old ones (audit trail).

---

## 17. Testing and evaluation

### 17.1 Unit tests (no network)
`FakeProvider` returns fixture JSON per `schemaName` and can simulate: invalid JSON, Zod-invalid JSON, 429, timeout, truncated output. Test every stage and the repair/fallback/consensus logic with it.

### 17.2 Provider contract tests (opt-in, real API, synthetic data only)
Run with `RUN_PROVIDER_TESTS=true`. For each enabled provider:
1. Accepts one and three PNG pages.
2. Returns schema-valid JSON for a small schema with nullable fields, enum, nested array.
3. Reads a ticked vs unticked checkbox fixture correctly.
4. Accepts the full CMS-1500 portable schema (or reports it needs sections).

### 17.3 Golden dataset
```
test-data/CMS1500/case-001/input.pdf
test-data/CMS1500/case-001/expected.json   # normalized form, same shape as schema (no _meta)
test-data/CMS1500/case-001/notes.md        # typed / handwritten / faxed / photo, quality notes
```
- Minimum for POC: 20 per form type (CMS-1500, UB-04, booking sheet) + 10 generic.
- Mix: typed, handwritten, faxed (200 DPI, noisy), phone photos (skewed), multi-claim PDFs.
- Use **synthetic patient data only** until a PHI-approved provider is configured. Fill blank official forms with fake data.

### 17.4 Metrics (`scripts/eval.ts`)
Compare normalized output to `expected.json` per native path:

| Metric | Definition |
|---|---|
| Field exact match | normalized equal / fields expected non-null |
| Hallucination rate | model returned a value where expected is null / expected-null fields |
| Miss rate | model returned null where expected has a value / expected non-null fields |
| Checkbox accuracy | correct booleans/enums / checkbox fields |
| Line-item accuracy | rows fully correct / expected rows |
| Critical-field accuracy | subset: patient name, DOB, insured ID, NPIs, codes, charges |
| Classification accuracy | correct form type per page |
| Cost & latency | tokens × configured price, p50/p95 latency |

Output a markdown report per provider × form. Choose the default provider from this report, not from vendor benchmarks.

Suggested POC targets (adjust after the first run): typed CMS-1500 critical fields ≥ 95% exact, hallucination ≤ 1%, checkbox ≥ 97%; handwritten/fax reported separately.

---

## 18. Build phases and acceptance criteria

| Phase | Build | Acceptance criteria |
|---|---|---|
| **P0 Skeleton** | Nest module, config validation, Prisma schema + migration, storage (local), health check | `npm run start` boots; migration applies; invalid env fails fast |
| **P1 Ingest + normalize** | Upload endpoint, magic-byte detection, sha256 dedupe, PDF/TIFF/HEIC/JPG → PNG pages | PDF 3 pages → 3 Page rows; multi-page TIFF works; HEIC auto-rotated; duplicate upload returns same id |
| **P2 Provider layer** | Interface, portable schema, StructuredOutputService, FakeProvider, one real provider + OpenAI-compatible | Unit tests for strategy choice, repair retry, backoff; contract test passes for the real provider |
| **P3 Generic end-to-end** | GENERIC form, extractor, flattener, `GET /fields` | Any uploaded file produces field rows with labels; nothing crashes on unknown forms |
| **P4 CMS-1500** | Full schema per 8.1, instructions, valueTypes, canonicalMap, normalization, validation | Golden CMS-1500 set runs through eval; NPI/ICD/total checks produce issues correctly |
| **P5 Classify + segment** | Classifier prompt/schema, per-page segmentation | Mixed PDF (2 CMS-1500 + 1 UB-04 + 1 unknown) → 4 correct segments |
| **P6 UB-04 + booking sheet** | Sectioned UB-04, booking sheet with additionalFields | Both pass eval harness; UB-04 sections merge into one normalized object |
| **P7 Review + autofill** | `PATCH /fields`, approve, `GET /autofill` | Reviewed value wins in autofill; match by DOB + last name returns latest values |
| **P8 Multi-provider** | Second provider, fallback + consensus modes, eval comparison report | Report compares ≥2 providers; disagreements flagged in consensus mode |
| **P9 Production hardening** | BullMQ queue, S3 + KMS, PHI_MODE enforcement, audit logging, rate limits | Upload returns 202; worker processes; no PHI in logs (log scan test) |

---

## 19. How to add a new form

1. Collect 10+ samples (synthetic data), add to `test-data/<FORM_ID>/`.
2. Create `src/extraction/forms/<form>/<form>.form.ts` with: `id`, `version`, `displayName`, `classifier`, `schema` (rules in section 7), `instructions`, `valueTypes`, `canonicalMap`, `repeatingGroups`, optional `validate`, optional `sections`.
3. Add to `FORMS` in `registry.ts`.
4. Run `npm run eval -- --form <FORM_ID>`.
5. No pipeline, controller, provider, or database changes should be needed. If they are, the design is being violated — fix the abstraction instead.

**Promoting a GENERIC source:** query `ExtractedField` for frequent `generic:*` patterns from one sender/layout, turn them into a form definition, and run `POST /documents/:id/reprocess` with `formType` on past documents.

---

## 20. Security, compliance, and open decisions

### Security & compliance
- **PHI**: CMS-1500/UB-04/booking sheets contain PHI. Only send real documents to providers covered by a signed BAA (US) / processor agreement (UK GDPR). Verify current eligibility per vendor and per product SKU before setting `*_PHI_APPROVED=true` — consumer/free API tiers are often excluded even when the vendor's enterprise product is covered.
- Encrypt at rest (S3 SSE-KMS, RDS encryption). TLS everywhere.
- Never log extracted values, prompts with content, or raw model output. Log IDs, counts, timings.
- Enforce `tenantId` on every query (Prisma middleware or RLS).
- Retention policy for originals and page images (configurable; delete pages after approval if not needed).
- Audit: who uploaded, who reviewed which field, which provider/model/prompt version produced each value — all already captured by the schema.

### Open decisions (mark with `// SPEC-QUESTION:` in code)
1. **Patient identity matching** for autofill across documents (exact DOB + name vs. member ID vs. fuzzy). `Segment.subjectHints` stores inputs; the matching rule is out of POC scope.
2. **Blank-overrides-old**: should a newer document's blank field hide an older non-blank value in autofill? Default: no (skip nulls).
3. **Bounding boxes**: LLM providers do not reliably return coordinates. If the review UI needs highlights, add an optional OCR-layout provider (e.g. a cloud OCR with word boxes) and match values to words post-hoc.
4. **Handwriting quality bar**: decide whether handwritten forms always go to review regardless of flags.
5. **Retention of page images** after approval.
