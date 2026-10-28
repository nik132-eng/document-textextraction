# 02 — Data Model (schema plan, decided before code)

This is the full schema for P0–P9. It is created in **one initial migration in P0**, so later phases add rows, not tables. Later columns or tables appear only where marked *(P9 option)*.

## 1. Changes from spec-1 §5, and why

| Change | Spec-1 had | Now | Reason |
|---|---|---|---|
| New `TextractCall` table | — | One row per Textract API call, raw JSON in S3 | Audit, cost, **free re-mapping** (D6), idempotency of billed calls |
| `Extraction.provider/model/strategy/promptVersion/tokens` | LLM metadata | `engine`, `engineApiVersion`, `features[]`, `formVersion`, `mapperVersion`, `pagesBilled`, `estCostUsd`, `textractCallIds[]` | Textract has no prompts or tokens; cost is per page |
| `ExtractedField` provenance | none | `confidence`, `page`, `bbox`, `source`, `label` | Textract returns confidence and geometry. The review UI can highlight. Low confidence drives review |
| `ExtractedField.flags` values | 4 values | adds `low_confidence`, `multi_selected`, `not_found` | Textract-specific review triggers |
| `Page` | dims only | adds `dpi`, `sha256`, `sizeBytes`, `classification` columns | Classification per page is stored and re-usable |
| `Segment` | — | adds `subtype`, `docTypeLabel`, `classifierScore`, `classifierEvidence` | Host doc-type labels (Physician / Anesthesia / Facility claim) and explainable cue matches |
| `Document` | — | adds `source`, `formTypeHint`, `docTypeLabel`, `uploadedBy` | Staff hint lets us skip the classify pass (Workflow §9.2) |
| New `DocumentLink` | — | Links a document to external entities (patient, bundle, claim) | Integration with any host platform without foreign keys into its DB |
| New `FieldReviewEvent` | only latest `reviewedValue` | Append-only history of reviews | Audit: who changed what, when |
| New `ApplyEvent` | — | Records that the host platform applied values to a target | Closes the loop; this service still never writes to the host platform |
| New `OutboxEvent` | — | Transactional outbox for integration events | Reliable delivery to the host platform (webhook/SQS) without dual-write bugs |
| `Document` dedupe | `@@unique([tenantId, sha256])` | same, plus re-link through `DocumentLink` | The same file dropped on two patients is stored once and linked twice |
| `FormDefinitionRecord` *(P9 option)* | — | Definitions stored as versioned JSON | Lets new forms be added without a deploy, after the DSL is stable |
| Status enums | one `DocStatus` | `DocumentStatus` + `SegmentStatus` + `TextractCallStatus` | Document and segment lifecycles differ |

`formType` stays a `String`, so new forms need no migration.

## 2. Prisma 7 configuration

`prisma.config.ts` (repo root):

```ts
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL! },
});
```

Runtime (`src/prisma/prisma.service.ts`):

```ts
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { AppConfig } from '../config/env.schema';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(cfg: AppConfig) {
    super({ adapter: new PrismaPg({ connectionString: cfg.DATABASE_URL }) });
  }
  async onModuleInit() { await this.$connect(); }
  async onModuleDestroy() { await this.$disconnect(); }
}
```

> Verified on 2026-10-28 with Prisma 7.10.1: `prisma init` emits `provider = "prisma-client"` with an `output` path and no `url` in the datasource. The generated `client.ts` imports siblings with a `.ts` extension by default. Set `moduleFormat = "cjs"` and **`importFileExtension = ""`** so Nest's CommonJS `tsc` build compiles it. P0 Task 3 verifies this with `npm run build`. If the build fails, try `importFileExtension = "js"` and record which one worked in the task notes.

## 3. Full schema

```prisma
generator client {
  provider            = "prisma-client"
  output              = "../src/generated/prisma"
  moduleFormat        = "cjs"
  importFileExtension = ""
}

datasource db {
  provider = "postgresql"
}

// ───────────── Enums ─────────────

enum DocumentStatus {
  RECEIVED       // stored original, nothing else yet
  RASTERIZED     // Page rows + PNGs exist
  CLASSIFIED     // Segment rows exist
  EXTRACTING     // at least one segment in progress
  PROCESSED      // every segment reached a terminal extraction state
  FAILED
}

enum SegmentStatus {
  PENDING        // created by segmenter
  EXTRACTING
  EXTRACTED      // no issues requiring review
  NEEDS_REVIEW
  APPROVED       // reviewer approved (all flags resolved)
  REJECTED       // reviewer says "not usable" (wrong scan, duplicate, etc.)
  FAILED
}

enum TextractCallStatus {
  PENDING        // async job started
  SUCCEEDED
  FAILED
}

enum DocumentSource {
  API
  NEW_PATIENT
  DOCUMENTS_TAB
  FAX_INBOX
  EMAIL_INBOX
}

// ───────────── Documents and pages ─────────────

model Document {
  id            String         @id @default(uuid()) @db.Uuid
  tenantId      String
  originalName  String         // PHI-adjacent: never logged
  mimeType      String         // detected by magic bytes
  sizeBytes     Int
  sha256        String         @db.Char(64)
  storageKey    String
  pageCount     Int?
  source        DocumentSource @default(API)
  formTypeHint  String?        // staff-provided; skips classification when single-form
  docTypeLabel  String?        // host doc-type label (configurable list), defaults: 'BOOKING_SHEET' | 'FACILITY_CLAIM' | 'PHYSICIAN_CLAIM' | 'ANESTHESIA_CLAIM' | 'LETTER' | 'OTHER'
  status        DocumentStatus @default(RECEIVED)
  error         String?        // safe message, no PHI
  uploadedBy    String?
  pages         Page[]
  segments      Segment[]
  textractCalls TextractCall[]
  links         DocumentLink[]
  createdAt     DateTime       @default(now())
  updatedAt     DateTime       @updatedAt

  @@unique([tenantId, sha256])
  @@index([tenantId, status, createdAt])
}

model DocumentLink {
  id          String   @id @default(uuid()) @db.Uuid
  tenantId    String
  documentId  String   @db.Uuid
  document    Document @relation(fields: [documentId], references: [id], onDelete: Cascade)
  entityType  String   // 'patient' | 'bundle' | 'claim' | 'patient_document'
  entityId    String   // host-platform id (opaque string)
  createdBy   String?
  createdAt   DateTime @default(now())

  @@unique([documentId, entityType, entityId])
  @@index([tenantId, entityType, entityId])
}

model Page {
  id                   String   @id @default(uuid()) @db.Uuid
  documentId           String   @db.Uuid
  document             Document @relation(fields: [documentId], references: [id], onDelete: Cascade)
  pageNumber           Int      // 1-based
  storageKey           String
  widthPx              Int
  heightPx             Int
  dpi                  Int
  sizeBytes            Int
  sha256               String   @db.Char(64)
  // classification (P5)
  formType             String?
  classifierScore      Float?
  classifierEvidence   Json?    // { matchedCues: [{cue, weight}], runnerUp: {formType, score}, pageOfTotal?: [x,y] }
  continuesPrevious    Boolean?
  imagesDeletedAt      DateTime? // retention (P9)

  @@unique([documentId, pageNumber])
}

// ───────────── Textract calls (immutable) ─────────────

model TextractCall {
  id               String             @id @default(uuid()) @db.Uuid
  tenantId         String
  documentId       String             @db.Uuid
  document         Document           @relation(fields: [documentId], references: [id], onDelete: Cascade)
  pageNumbers      Int[]              // sync: exactly one; async: range
  api              String             // 'DetectDocumentText' | 'AnalyzeDocument' | 'AnalyzeID' | 'AnalyzeExpense' | 'StartDocumentAnalysis' | ...
  features         String[]           // ['FORMS','TABLES','QUERIES','LAYOUT'] for AnalyzeDocument
  queriesHash      String?            // sha256 of the QueriesConfig JSON, so the same queries are detectable
  requestHash      String             // sha256(api + features + queriesHash + page sha256) — idempotency key
  status           TextractCallStatus @default(SUCCEEDED)
  jobId            String?            // async only
  awsRequestId     String?
  modelVersion     String?            // response *ModelVersion field
  pagesBilled      Int
  estCostUsd       Decimal            @db.Decimal(10, 5)
  latencyMs        Int?
  responseKey      String?            // S3/local key of gzip JSON
  responseBytes    Int?
  error            String?            // AWS error name + message (no document content)
  createdAt        DateTime           @default(now())

  @@unique([tenantId, requestHash])   // the same billed call is never made twice unless forced
  @@index([documentId])
  @@index([tenantId, createdAt])
}

// ───────────── Segments and extractions ─────────────

model Segment {
  id                 String        @id @default(uuid()) @db.Uuid
  tenantId           String
  documentId         String        @db.Uuid
  document           Document      @relation(fields: [documentId], references: [id], onDelete: Cascade)
  ordinal            Int           // 1..n within document
  formType           String        // 'CMS1500' | 'UB04' | 'BOOKING_SHEET' | 'INSURANCE_CARD' | 'US_ID' | 'INVOICE' | 'GENERIC' | ...
  subtype            String?       // e.g. 'ANESTHESIA' for CMS1500 (from definition.subtypes)
  docTypeLabel       String?       // host doc-type label derived from formType/subtype or hint
  pageStart          Int
  pageEnd            Int
  classifierScore    Float?
  classifiedBy       String        // 'cues' | 'hint' | 'single' | 'manual'
  subjectHints       Json?         // { patientLast, patientFirst, patientDob, memberId } for matching (normalized)
  status             SegmentStatus @default(PENDING)
  error              String?
  approvedBy         String?
  approvedAt         DateTime?
  extractions        Extraction[]
  applyEvents        ApplyEvent[]
  createdAt          DateTime      @default(now())
  updatedAt          DateTime      @updatedAt

  @@unique([documentId, ordinal])
  @@index([tenantId, formType, status])
}

model Extraction {
  id               String           @id @default(uuid()) @db.Uuid
  tenantId         String
  segmentId        String           @db.Uuid
  segment          Segment          @relation(fields: [segmentId], references: [id], onDelete: Cascade)
  engine           String           // 'textract'
  engineApi        String           // 'AnalyzeDocument' | 'AnalyzeID' | 'AnalyzeExpense'
  engineModelVersion String?
  features         String[]
  formType         String
  formVersion      String           // definition.version, e.g. 'cms1500@0212.3'
  mapperVersion    String           // MAPPER_VERSION constant; bump when resolver code changes
  mode             String           // 'analyze' | 'remap' | 'reanalyze'
  textractCallIds  String[]         // TextractCall ids used (remap reuses old ones)
  raw              Json             // mapped native JSON as resolved (pre-normalization), immutable
  normalized       Json?            // code-normalized native JSON
  provenance       Json             // { [nativePath]: { source, confidence, page, bbox, label } }
  meta             Json             // { unreadable[], uncertain[], notFound[], notes, unmapped: [...] }
  validationIssues Json             // ValidationIssue[]
  isCurrent        Boolean          @default(true)
  pagesBilled      Int              @default(0)
  estCostUsd       Decimal          @default(0) @db.Decimal(10, 5)
  latencyMs        Int?
  fields           ExtractedField[]
  createdAt        DateTime         @default(now())

  @@index([segmentId, isCurrent])
  @@index([tenantId, formType, createdAt])
}

model ExtractedField {
  id              String     @id @default(uuid()) @db.Uuid
  extractionId    String     @db.Uuid
  extraction      Extraction @relation(fields: [extractionId], references: [id], onDelete: Cascade)
  tenantId        String
  formType        String
  nativePath      String     // 'box24[0].cptHcpcs'
  nativePattern   String     // 'box24[*].cptHcpcs'  or  'generic:patient-name'
  canonicalKey    String?    // 'line.cpt_hcpcs' — null if unmapped (still saved)
  groupName       String?    // 'service_line'
  groupIndex      Int?
  valueType       String     // 'string'|'date'|'money'|'boolean'|'code'|'number'|'enum'|'name'|'phone'|'zip'|'state'
  label           String?    // printed label / query text that produced this value
  rawValue        String?
  normalizedValue Json?
  confidence      Float?     // 0..100 (Textract scale)
  page            Int?
  bbox            Json?      // { left, top, width, height } normalized 0..1
  source          String?    // 'query'|'key'|'region'|'checkbox'|'table'|'grid'|'layout'|'id'|'expense'|'generic'
  flags           String[]   // 'unreadable'|'uncertain'|'low_confidence'|'validation_error'|'multi_selected'|'not_found'
  reviewedValue   Json?
  reviewedBy      String?
  reviewedAt      DateTime?

  @@index([tenantId, canonicalKey])
  @@index([tenantId, formType, nativePattern])
  @@index([extractionId])
}

model FieldReviewEvent {
  id            String   @id @default(uuid()) @db.Uuid
  tenantId      String
  fieldId       String   @db.Uuid
  extractionId  String   @db.Uuid
  previousValue Json?
  newValue      Json?
  action        String   // 'edit' | 'confirm' | 'clear_flag'
  reviewer      String
  createdAt     DateTime @default(now())

  @@index([fieldId])
  @@index([tenantId, createdAt])
}

// ───────────── Integration ─────────────

model ApplyEvent {
  id           String   @id @default(uuid()) @db.Uuid
  tenantId     String
  segmentId    String   @db.Uuid
  segment      Segment  @relation(fields: [segmentId], references: [id], onDelete: Cascade)
  extractionId String   @db.Uuid
  profile      String   // 'default.patient' | 'default.insurance' | 'default.bundle'
  targetType   String   // 'patient' | 'bundle' | ...
  targetId     String
  appliedKeys  Json     // [{ canonicalKey, fieldId, value }]
  appliedBy    String
  createdAt    DateTime @default(now())

  @@index([tenantId, targetType, targetId])
}

model OutboxEvent {
  id           String    @id @default(uuid()) @db.Uuid
  tenantId     String
  type         String    // 'document.processed' | 'segment.needs_review' | 'segment.approved' | 'document.failed'
  aggregateId  String
  payload      Json      // IDs + statuses only — never field values
  createdAt    DateTime  @default(now())
  publishedAt  DateTime?
  attempts     Int       @default(0)
  lastError    String?

  @@index([publishedAt, createdAt])
}

// ───────────── (P9 option) DB-stored form definitions ─────────────

model FormDefinitionRecord {
  id          String   @id @default(uuid()) @db.Uuid
  formId      String   // 'CMS1500'
  version     String   // 'cms1500@0212.3'
  status      String   // 'draft' | 'active' | 'retired'
  definition  Json     // validated by FormDefinitionSchema at load
  createdBy   String
  createdAt   DateTime @default(now())

  @@unique([formId, version])
}
```

## 4. Extra SQL in the first migration

Created with `npx prisma migrate dev --create-only --name init`, then append:

```sql
CREATE INDEX extraction_normalized_gin ON "Extraction" USING GIN (normalized jsonb_path_ops);
CREATE INDEX extracted_field_flags_gin ON "ExtractedField" USING GIN (flags);
-- autofill hot path: current extractions only
CREATE INDEX extraction_current_idx ON "Extraction" ("segmentId") WHERE "isCurrent";
-- only one current extraction per segment
CREATE UNIQUE INDEX extraction_one_current ON "Extraction" ("segmentId") WHERE "isCurrent";
```

`extraction_one_current` forces the "mark previous not current, insert new current" logic to run inside a single transaction, in that order (see `05` §7).

## 5. Value semantics

- **Effective value** (autofill, profiles): `reviewedValue ?? normalizedValue ?? rawValue`.
- **Null leaves are stored.** "The field was blank" is information. Autofill skips nulls by default (spec-1 open decision 2, default kept).
- `confidence` uses Textract's 0–100 scale. A field with several sources uses the **minimum** of the key and value confidences (see `04` §6).
- `bbox` uses Textract's normalized page coordinates, so the UI multiplies them by the rendered page size.

## 6. Storage keys (app-enforced; one helper in `common/util/paths.ts`)

```ts
export const keys = {
  original: (t: string, d: string, sha: string, ext: string) => `t/${t}/d/${d}/original/${sha}.${ext}`,
  page:     (t: string, d: string, n: number) => `t/${t}/d/${d}/pages/${String(n).padStart(4, '0')}.png`,
  textract: (t: string, d: string, callId: string) => `t/${t}/d/${d}/textract/${callId}.json.gz`,
};
```

Every key is prefixed with `STORAGE_PREFIX` (empty by default, e.g. `idp/` when embedded in a host that shares the bucket). The prefix is applied inside the storage driver, so the stored `storageKey` values stay prefix-free and portable.

Tenant IDs and document IDs must match `^[A-Za-z0-9_-]{1,64}$` (validated in the tenancy guard) to prevent path traversal in local storage.

## 7. Retention (decide before prod; defaults below)

| Data | Default | Configurable env |
|---|---|---|
| Original file | keep while any `DocumentLink` exists | `RETAIN_ORIGINALS=true` |
| Page PNGs | delete 30 days after all segments are `APPROVED`/`REJECTED` | `PAGE_IMAGE_RETENTION_DAYS=30` |
| Textract JSON | keep (needed for remap); IA after 90 days | `TEXTRACT_JSON_RETENTION_DAYS=0` (0 = forever) |
| DB rows | keep | — |

`// SPEC-QUESTION:` final retention periods need a compliance decision (spec-1 open decision 5).

## 8. Migration policy

- One migration per phase at most. After P0, every migration must be **additive** (new nullable columns or new tables). Destructive changes need a two-step expand/contract across releases.
- `prisma migrate deploy` runs as a separate ECS one-off task (`idp_migrator` role) before the new service version starts.
- Never edit an applied migration.
