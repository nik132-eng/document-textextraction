# Textract Document Extraction (IDP) — Technical Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone NestJS service that accepts any PDF/image packet, splits it into forms, extracts every visible field with Amazon Textract, normalizes and validates it, stores it with form type, canonical key, confidence and page location, and exposes it to any host platform (plug-and-play) for preview, autofill and human-approved apply.

**Architecture:** Upload → S3 → rasterize to page PNGs → classify each page with cheap Textract text (`DetectDocumentText`) against a registry of form cues → group pages into segments → per segment, call the Textract API the form definition names (`AnalyzeDocument` / `AnalyzeID` / `AnalyzeExpense`) → convert Textract blocks into an engine-neutral **Evidence** model → a generic **mapper** fills the form's fields from declarative **form definitions** → normalize, validate, flatten into field rows → Postgres. Raw Textract JSON is kept, so a changed form definition can be re-mapped without paying Textract again.

**Tech Stack:** Node 24 LTS · NestJS 12 · TypeScript (strict) · Prisma 7.10 + PostgreSQL 16/17 · Zod 4 · `@aws-sdk/client-textract` / `client-s3` v3 · sharp · poppler `pdftoppm` · BullMQ 5 + Redis/Valkey · Jest + `@swc/jest`.

**Spec / source documents (read before starting):**
- [idp-workflow.md](../../../../idp-workflow.md) — **the confirmed workflow.** Textract is the default reader, classification uses registry cues, review is in the host platform, apply is human-only, GENERIC is a first-class outcome.
- [document-extraction-system-spec-1.md](../../../../document-extraction-system-spec-1.md) — first-phase spec. It is still the source for the form catalogs (§8), canonical dictionary (§9), normalization/validation rules (§12), flattener (§13), API (§14) and the eval metrics (§17). Its **LLM provider layer (§10–11) is replaced** by the Textract layer in this plan.
- [Multi-Form Document Extraction for NestJS…](../../../../Multi-Form%20Document%20Extraction%20for%20NestJS_%20CMS-1500,%20UB-04%20and%20B.md) — research. It contributes the storage principles: immutable raw output, EAV field rows, canonical plus native keys, and provenance (page, bbox, confidence).

**Status:** Plan only. No code is written yet.

---

## 1. Documents in this plan

| File | What it holds | Read when |
|---|---|---|
| `00-overview.md` (this) | Decisions, architecture, global constraints, repo layout, phase index | First |
| [`01-aws-setup.md`](01-aws-setup.md) | Every manual AWS step (BAA, AI opt-out, KMS, S3, IAM, VPC endpoints, quotas, alarms, budgets, async SNS/SQS role, fixture capture), with JSON policies and CLI | Before P2; ops owner |
| [`02-data-model.md`](02-data-model.md) | **Schema plan, written before any code.** Full Prisma schema, the reasons for each change from spec-1, indexes, migrations, retention | Before P0 |
| [`03-form-definition-dsl.md`](03-form-definition-dsl.md) | The extensibility core: the declarative form definition, canonical dictionary, rule library, and how to add a new form with no pipeline change | Before P3 |
| [`04-textract-layer.md`](04-textract-layer.md) | Textract client, call strategy, block-graph parser → Evidence model, field resolvers (query / key / region / checkbox / table / grid / layout), confidence, cost accounting | Before P2 |
| [`05-pipeline-and-api.md`](05-pipeline-and-api.md) | Stage contracts, classification and segmentation algorithm, normalization, validation, flattening, review, autofill, apply contract, integration events, REST API | Before P1 |
| [`06-phases-and-tasks.md`](06-phases-and-tasks.md) | The build: phases P0–P9 broken into tasks with files, interfaces, test cases and acceptance criteria | During the build |
| [`08-integration-scan-prompt.md`](08-integration-scan-prompt.md) | Ready-to-paste prompt that makes an AI agent scan any host project and report where and how to plug IDP in | Before integrating into a host |
| [`07-testing-and-eval.md`](07-testing-and-eval.md) | Fixture strategy (recorded Textract JSON), fakes, golden dataset, eval metrics and report | Before P2 |

---

## 2. Decisions locked by this plan

| # | Decision | Why | Source |
|---|---|---|---|
| D1 | **Amazon Textract is the only extraction engine in v1.** | Already in the AWS account, HIPAA-eligible under the existing BAA, gives native checkbox state, per-value confidence and geometry. | Workflow §8.1 |
| D2 | **Classification = registry cues scored against `DetectDocumentText` lines**, in code. No Comprehend, no LLM. | A new form becomes a new cue list, with no training job. $0.0015/page. | Workflow §3.2, §8.2 |
| D3 | **Per-page synchronous Textract calls on our own rasterized PNG pages.** Async `StartDocumentAnalysis` is an optional path (P8) and not required. | Sync PDF/TIFF input is limited to 1 page and 10 MB. We rasterize anyway for preview, so every call is a single page. That removes the SNS/SQS plumbing from the critical path. | AWS set quotas |
| D4 | **The engine-neutral Evidence model sits between Textract and form mapping.** | Mappers never touch Textract blocks. A later engine (Bedrock Data Automation, a vision LLM) only has to produce Evidence. | Spec-1 rule 2, adapted |
| D5 | **Form definitions are pure data (declarative DSL), validated at boot.** Functions live only in a shared rule/resolver library, referenced by name. | A new form = one data file + fixtures, with no code changes. Definitions can later live in the DB (P9 option) without code change. | Spec-1 §7 and §19, made stricter |
| D6 | **Raw Textract responses are stored (S3, gzip JSON) and indexed in a `TextractCall` table.** | Audit, cost tracking, and **free re-mapping** after a definition changes. | New |
| D7 | **Textract reads the text; code normalizes it.** Dates, money, codes and names are normalized in TypeScript. | Deterministic and testable. | Spec-1 rule 4 |
| D8 | **Blank → null. Low confidence → flag, not a guess.** Below-threshold values are kept and flagged `low_confidence` → `NEEDS_REVIEW`. | Never invent data. | Spec-1 rule 5 |
| D9 | **Review and apply belong to the host platform.** This service exposes preview/autofill data and records apply events. It never writes `patient` or `claim`. | Human apply only. | Workflow §3.5, §8.4 |
| D10 | **No A2I, no Comprehend custom classifier, no Textract custom-queries adapters in v1.** Adapters are a documented upgrade path for CMS-1500/UB-04 accuracy. | Cost and complexity. A2I is closed to new customers. | Workflow §5.4 |
| D11 | **HEIC is not accepted in v1.** Textract accepts JPEG/PNG/PDF/TIFF. sharp's prebuilt binaries cannot decode HEVC-encoded HEIC. | Workflow capture formats are PDF/JPEG/PNG/TIFF. Add `heic-convert` later if phones become a channel. | Workflow §3.1 |
| D12 | **An independent product, plug-and-play in two ways:** (a) a standalone service that any platform calls over REST and consumes through outbox events, (b) an embeddable Nest dynamic module `IdpModule.forRoot({...})` that a larger NestJS project imports. Host-specific concerns (auth, entity links, doc-type labels, target DTO profiles, event delivery) sit behind ports with defaults, so no host name or host code lives in the core. | It can be reused across products and clients without forking. Host integration is configuration plus adapters, not changes to the core. See §8. | User decision |

---

## 3. Architecture

```mermaid
flowchart TD
  subgraph API[NestJS API]
    UP[POST /documents\nmagic bytes, sha256 dedupe]
    RD[GET documents / segments / fields / pages]
    RV[PATCH fields, approve segment]
    AF[GET autofill, GET preview/:profile]
    AP[POST segments/:id/apply-events]
  end
  subgraph Worker[NestJS worker — same image, WORKER=true]
    N[Normalize\nPDF/TIFF/JPG/PNG → page PNGs]
    C[Classify\nDetectDocumentText → cue scoring]
    S[Segment\nrules per form]
    X[Extract\nTextract API per form definition]
    E[Evidence builder\nblocks → KV, tables, queries, selections, lines, words]
    M[Mapper\nform definition → native JSON + per-field provenance]
    V[Normalize values + validate rules]
    F[Flatten → ExtractedField rows]
  end
  S3[(S3 SSE-KMS\noriginal, pages, textract JSON)]
  PG[(Postgres)]
  R[(Redis/Valkey — BullMQ)]
  TX[[Amazon Textract]]
  UP --> S3 --> N
  UP --> PG
  UP -- enqueue --> R --> Worker
  N --> C --> S --> X
  X <--> TX
  X --> S3
  X --> E --> M --> V --> F --> PG
  PG --> RD & AF
  RV --> PG
  PG -- outbox events --> HOST[Host platform]
  HOST --> AP
```

**Two runtime roles, one codebase:** `APP_ROLE=api` serves HTTP. `APP_ROLE=worker` consumes BullMQ queues. `APP_ROLE=all` does both (local dev). `PIPELINE_MODE=sync` runs stages inline in the request (P1–P7 dev and tests). `PIPELINE_MODE=queue` uses BullMQ (P8+).

---

## 4. Global Constraints

Every task implicitly includes these.

- **Runtime:** Node `>=24` (LTS). TypeScript `strict: true`, `noUncheckedIndexedAccess: true`.
- **Framework:** `@nestjs/*` `12.x`. Do not mix major versions.
- **DB:** PostgreSQL `>=16`. Prisma `7.10.x` (pin exact; npm `latest` currently points at an 8.0 RC — **do not** use it). Prisma 7 rules: generator `provider = "prisma-client"`, explicit `output`, `moduleFormat = "cjs"`, connection URL in `prisma.config.ts` (not in `schema.prisma`), runtime connection through `@prisma/adapter-pg`.
- **Validation:** `zod` `4.x` for env config, DTOs and form-definition validation.
- **AWS SDK:** v3 modular clients only (`@aws-sdk/client-textract`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`). No v2 `aws-sdk`. Credentials always come from the default provider chain (ECS task role in AWS, IAM Identity Center SSO profile locally). **Never** read static access keys from env in code.
- **Dependency budget:** the packages above plus `sharp`, `@nestjs/bullmq`, `bullmq`, `ioredis` (BullMQ peer), `@nestjs/terminus`, `@nestjs/config`, `@nestjs/platform-express` (multer), `jest`, `@swc/jest`, `supertest`. Anything else needs a one-line justification in the PR.
- **System packages:** `poppler-utils` (`pdftoppm`, `pdfinfo`) in the Docker image and on dev machines.
- **Textract input:** JPEG/PNG/PDF/TIFF only; ≤10 MB per sync request; ≤10,000 px per side; text ≥15 px tall (≈8 pt at 150 DPI). Raster at **200 DPI** by default, and re-encode or downscale any page >9.5 MB.
- **Queries:** ≤**15 per page** on sync calls (30 async). The form-definition validator enforces this at boot.
- **PHI:** never log extracted values, Textract text, page images, or file names. Log IDs, statuses, counts, durations, Textract `RequestId` only. Enforced by a log-scan test (P9).
- **Tenancy:** every table carrying data has `tenantId`. Every query filters by it (Prisma client extension in P0, Postgres RLS in P9).
- **Immutability:** `TextractCall` and `Extraction.raw` are never updated after write. Reprocessing creates new rows.
- **No silent writes downstream:** this service never calls host-platform write APIs.
- **Form knowledge lives only in `src/forms/definitions/**`.** Adding a form must not touch pipeline, Textract, controller or schema code. If it does, fix the abstraction.
- **Every stage is idempotent**, takes IDs, and checks status before acting.
- **Tests never call AWS.** Unit and integration tests replay recorded Textract JSON. The live contract tests run only with `RUN_AWS_TESTS=true`, on synthetic data.
- **Synthetic data only** in fixtures, the golden set and console trials, until the BAA plus AI-services opt-out are confirmed (see `01-aws-setup.md` §1–2).
- When the spec is ambiguous: implement the simplest version and leave `// SPEC-QUESTION:` with the question.

---

## 5. Repository layout (target end state)

```
.
├─ docker/Dockerfile                      # node:24-bookworm-slim + poppler-utils
├─ docker-compose.yml                     # postgres:17, valkey:8 (dev only)
├─ prisma.config.ts                       # Prisma 7 config (datasource url, migrations path)
├─ prisma/schema.prisma
├─ prisma/migrations/**
├─ src/
│  ├─ main.ts                             # standalone mode: boots api | worker | all
│  ├─ app.module.ts                       # standalone mode: imports IdpModule.forRoot(fromEnv())
│  ├─ idp.module.ts                       # embeddable dynamic module: IdpModule.forRoot / forRootAsync
│  ├─ index.ts                            # public API barrel (module, ports, types, tokens)
│  ├─ ports/                              # host-integration seams (all have defaults)
│  │  ├─ auth.port.ts                     # resolve tenantId + userId from a request
│  │  ├─ event-sink.port.ts               # deliver outbox events (log | webhook | sqs | host callback)
│  │  ├─ target-profile.port.ts           # host DTO profiles for preview
│  │  ├─ doc-type-labels.port.ts          # host's document-type label list
│  │  └─ payer-directory.port.ts          # optional payer-name matching (enrich)
│  ├─ config/
│  │  ├─ env.schema.ts                    # Zod env schema (fail fast)
│  │  └─ config.module.ts
│  ├─ common/
│  │  ├─ logging/safe-logger.ts           # PHI-safe JSON logger
│  │  ├─ tenancy/tenant.guard.ts          # x-tenant-id / auth → request.tenantId
│  │  ├─ tenancy/prisma-tenant.extension.ts
│  │  ├─ errors/domain-errors.ts
│  │  └─ util/{hash.ts, magic-bytes.ts, paths.ts, text.ts}
│  ├─ prisma/prisma.service.ts            # PrismaClient + PrismaPg adapter
│  ├─ storage/
│  │  ├─ storage.port.ts                  # interface StoragePort
│  │  ├─ local.storage.ts
│  │  └─ s3.storage.ts
│  ├─ ingest/
│  │  ├─ documents.controller.ts          # POST /documents, GET /documents/:id, pages
│  │  └─ ingest.service.ts
│  ├─ pipeline/
│  │  ├─ pipeline.service.ts              # orchestrates stages (sync or queue)
│  │  ├─ rasterizer.service.ts            # file → page PNGs
│  │  ├─ classifier.service.ts            # pages → page classifications
│  │  ├─ segmenter.ts                     # pure function: classifications → segments
│  │  ├─ extractor.service.ts             # segment → TextractCall(s) → Evidence
│  │  ├─ mapping.service.ts               # Evidence + FormDefinition → MappedResult
│  │  ├─ finalizer.service.ts             # normalize, validate, flatten, persist
│  │  └─ queue/{queues.ts, processors/*.ts}  # P8
│  ├─ textract/
│  │  ├─ textract.client.ts               # thin wrapper over SDK, retries, metrics
│  │  ├─ textract-call.repository.ts      # TextractCall persistence + raw JSON storage
│  │  ├─ block-graph.ts                   # Block[] → indexed graph helpers
│  │  ├─ evidence.builder.ts              # AnalyzeDocument/ID/Expense → Evidence
│  │  ├─ queries.builder.ts               # definition → QueriesConfig
│  │  ├─ cost.ts                          # price table + estimator
│  │  └─ fake-textract.client.ts          # replay recorded JSON (tests)
│  ├─ evidence/
│  │  ├─ evidence.types.ts                # engine-neutral model
│  │  └─ geometry.ts                      # bbox math, reading order, nearest
│  ├─ forms/
│  │  ├─ dsl/form-definition.types.ts     # the DSL types
│  │  ├─ dsl/form-definition.schema.ts    # Zod validator for definitions
│  │  ├─ dsl/canonical-keys.ts            # canonical dictionary
│  │  ├─ registry/form-registry.ts        # load, validate, index, version
│  │  ├─ resolvers/*.resolver.ts          # query, key, region, checkbox, table, grid, layout, idField, expenseField
│  │  ├─ normalize/value-normalizers.ts   # date, money, code, name, phone, zip, state, boolean
│  │  ├─ rules/rule-library.ts            # NPI, ICD10, CPT, SUM_EQUALS, DATE_ORDER, ...
│  │  ├─ flatten/flattener.ts
│  │  └─ definitions/
│  │     ├─ generic.form.ts
│  │     ├─ cms1500.form.ts
│  │     ├─ ub04.form.ts
│  │     ├─ booking-sheet.form.ts
│  │     ├─ insurance-card.form.ts
│  │     ├─ us-id.form.ts
│  │     ├─ invoice.form.ts
│  │     └─ index.ts                      # export const DEFINITIONS = [...]
│  ├─ review/{fields.controller.ts, review.service.ts}
│  ├─ autofill/{autofill.controller.ts, autofill.service.ts, profiles/*.profile.ts}
│  ├─ integration/{outbox.service.ts, outbox.publisher.ts, apply-events.controller.ts}
│  └─ health/health.controller.ts
├─ scripts/
│  ├─ record-fixture.ts                   # call Textract once, save JSON fixture (synthetic only)
│  ├─ eval.ts                             # golden set → accuracy/cost report
│  └─ remap.ts                            # re-run mapping from stored TextractCalls
├─ test/
│  ├─ fixtures/textract/<FORM>/<case>/page-<n>.{analyze,detect}.json
│  ├─ builders/blocks.builder.ts          # hand-build tiny Textract Block graphs
│  └─ e2e/*.e2e-spec.ts
└─ test-data/<FORM>/<case>/{input.pdf, expected.json, notes.md}   # golden set
```

---

## 6. Phase index

Each phase ends with working, testable software. Do not start a phase until the previous phase's acceptance criteria pass. Full tasks are in [`06-phases-and-tasks.md`](06-phases-and-tasks.md).

| Phase | Feature delivered | Acceptance (summary) |
|---|---|---|
| **P0 Foundation** | Nest skeleton, embeddable `IdpModule` + host ports, Zod env, Prisma 7 schema + first migration, storage port (local), tenancy guard, safe logger, health | Boots; migration applies; bad env fails fast; `/health` green |
| **P1 Ingest + rasterize** | Upload, magic bytes, sha256 dedupe, PDF/TIFF/JPG/PNG → page PNGs, page image endpoint | 3-page PDF → 3 Page rows; multi-page TIFF works; duplicate upload returns same id |
| **P2 Textract layer** | Textract client, `TextractCall` persistence, block graph, Evidence builder, fixture recorder, fake client, cost estimator | Recorded fixture → Evidence with KV, tables, selections, queries; retries on throttling |
| **P3 Form DSL + GENERIC end-to-end** | DSL types + validator, registry, canonical dictionary, resolvers, mapper, normalizers, flattener, GENERIC form, `GET /fields` | Any file → field rows with labels, confidence, bbox; nothing crashes on unknown forms |
| **P4 CMS-1500** | Full definition (boxes 1–33, Box 24 grid), rule library, eval script | Golden CMS-1500 set runs through eval; NPI/ICD/total rules produce issues correctly |
| **P5 Classify + segment** | Cue scoring on `DetectDocumentText`, segmenter, staff hint bypass | Mixed PDF (2 CMS-1500 + 1 UB-04 + 1 unknown) → 4 correct segments |
| **P6 More forms** | UB-04, booking sheet, insurance card, US ID (`AnalyzeID`), invoice (`AnalyzeExpense`) | Each passes its eval; AnalyzeID/Expense routed by definition only |
| **P7 Review, autofill, integration** | Field review, approve, autofill by canonical key + subject match, target profiles (default patient/insurance/bundle preview; hosts add their own), outbox events, apply-event recording, signed page URLs | Reviewed value wins; profile preview returns host-shaped JSON; events emitted once |
| **P8 Queue + scale + reprocess** | BullMQ flows, Textract TPS limiter, retries, `remap` (free) and `reanalyze` (billed) reprocess, optional async Textract path | Upload returns 202; worker completes; remap creates new Extraction with zero Textract calls |
| **P9 Production hardening** | S3 + KMS storage, Postgres RLS, retention jobs, audit, PHI log-scan test, metrics/alarms, Docker/ECS deploy, optional DB-stored definitions | Log scan finds no PHI; RLS blocks cross-tenant reads; deploy runbook executed |

---

## 7. What "minimal change for a new form" means here

The core requirement is that new forms arrive with minimal change. This is the contract the design guarantees (details in `03-form-definition-dsl.md` §9):

1. Unknown form arrives → classified `GENERIC` → every key/value, checkbox, table and text line is still stored, with label, confidence and bbox. **No data is lost.**
2. To promote it: collect 5–10 synthetic samples, record fixtures (`scripts/record-fixture.ts`), write **one** definition file (cues + fields + canonical mappings + rules), add expected JSON, run `npm run eval -- --form NEW_FORM`.
3. Register it in `definitions/index.ts`. Boot validation checks query counts, canonical keys, rule names, path uniqueness.
4. `npm run remap -- --form-type GENERIC --to NEW_FORM --since 2026-11-01` re-maps old documents from their stored Textract JSON. This is free if the new definition uses only key/region/table/layout sources. Query sources need `reanalyze` (billed).

No new tables, endpoints, queues or Textract code. A new **rule** (e.g. a new checksum) or a new **resolver kind** is the only thing that needs code, and both are shared across all forms.

---

## 8. Plug-and-play: one product, any host platform

This service is a **product on its own**, not a feature of one client. No client names, client DTOs or client tables live in the core. A host platform (any EHR, billing system, practice-management app, or a large NestJS monolith) connects in one of two ways.

### 8.1 Mode A — standalone service (default)

```
Host platform ──REST──▶ IDP service (this repo, own DB, own S3 prefix)
Host platform ◀─events── outbox → webhook / SQS
```

- The host uploads with `POST /documents` and links documents to its own entities through `links: [{ entityType, entityId }]` (opaque strings, e.g. `patient:123`).
- The host reads previews from `GET /segments/:id/preview/:profile` and saves the data through **its own** APIs, then reports back with `POST /segments/:id/apply-events`.
- Auth: the host's JWT/OIDC, configured with `AUTH_JWKS_URL`, `AUTH_TENANT_CLAIM`, `AUTH_USER_CLAIM`. No code change.

### 8.2 Mode B — embedded Nest module

```ts
// In the host's NestJS app
import { IdpModule } from '@your-org/idp';

@Module({
  imports: [
    IdpModule.forRootAsync({
      inject: [HostConfig],
      useFactory: (cfg: HostConfig) => ({
        database: { url: cfg.idpDatabaseUrl },          // own schema/DB; never the host's tables
        storage: { driver: 's3', bucket: cfg.bucket, kmsKeyId: cfg.kmsKey, prefix: 'idp/' },
        textract: { region: cfg.region, tps: { analyze: 4, detect: 4, id: 1, expense: 1 } },
        pipeline: { mode: 'queue', redisUrl: cfg.redisUrl },
        http: { enabled: true, routePrefix: 'idp' },      // mount controllers under /idp, or false = services only
        ports: {
          auth: HostAuthAdapter,                          // implements AuthPort
          eventSink: HostEventBusAdapter,                 // implements EventSinkPort (in-process)
          targetProfiles: [hostPatientProfile, hostInsuranceProfile],
          docTypeLabels: ['BOOKING_SHEET', 'FACILITY_CLAIM', 'PHYSICIAN_CLAIM', 'ANESTHESIA_CLAIM', 'LETTER', 'OTHER'],
        },
        forms: { extra: [hostSpecificForm] },             // optional host-only form definitions
      }),
    }),
  ],
})
export class HostAppModule {}
```

Exported services for in-process use: `IdpDocumentsService` (ingest, get), `IdpReviewService`, `IdpAutofillService`, `IdpFormRegistry`.

### 8.3 Ports (host seams) and their defaults

| Port | Responsibility | Default (standalone) |
|---|---|---|
| `AuthPort` | request → `{ tenantId, userId }` | `x-tenant-id` header (dev) / JWT via JWKS (prod) |
| `EventSinkPort` | deliver outbox events | `log` / `webhook` (HMAC) / `sqs` |
| `TargetProfilePort` | host DTO shapes for preview | `default.patient`, `default.insurance`, `default.bundle` |
| `DocTypeLabelsPort` | allowed doc-type labels + mapping from formType/subtype | neutral list in §8.2 |
| `PayerDirectoryPort` | match the printed payer name to a host payer id | no-op (returns null) |
| `StoragePort` | object storage | `local` / `s3` |

### 8.4 Packaging rules (enforced from P0)

- **No host names in the core.** CI greps `src/` for a configurable deny-list of client names (`HOST_NAME_DENYLIST`) and fails if any appear. Host-specific code lives in the host repo or in `examples/<host>/`.
- The public API is only what `src/index.ts` exports. Everything else is internal and may change.
- The DB is **owned by the IDP** (own database or schema, own migrations). There are no foreign keys into host tables, only `DocumentLink` opaque ids.
- The S3 key prefix is configurable (`STORAGE_PREFIX`) so several hosts can share a bucket safely.
- Semantic versioning. Breaking changes to REST, events, the `index.ts` exports or the canonical dictionary need a major version bump.
- Publishing: the Docker image (Mode A) and an npm package `@your-org/idp` built from the same source (Mode B, P9 Task 9.10).
