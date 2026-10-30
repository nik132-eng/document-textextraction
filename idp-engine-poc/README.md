# IDP engine POC

Upload **any document** (PDF, scan, photo, Word). The service works out **which form it is** (CMS-1500, UB-04, hospital booking sheet, insurance card, intake, or anything else), extracts **every value**, and returns it in the form's own shape, with confidence, page location and review flags.

The extraction engine can be swapped: Amazon Textract, VLM Run, Meibel, or a `fake` engine that needs no credentials. You choose with env vars, and you can run several engines on the same file and compare them field by field.

It is a proof of concept for decision **D14 (multi-engine)** from the plan repo (`docs/research/vendors/shared-engine-adapter.md`), built on the main project's stack: Node 22, NestJS 11, Prisma 7.4, Joi, Zod (form DSL), Vitest, Pino, BullMQ.

> **Synthetic documents only** until the compliance gates in [docs/MANUAL-SETUP.md](docs/MANUAL-SETUP.md) §5 are done. With `PHI_MODE=true` the app refuses to boot unless they are.

---

## 1. What happens under the hood

```
POST /v1/documents (file, formType?, engines?)
  │  type from magic bytes + ZIP contents (never the file name) · sha256 dedupe per tenant
  ▼
CONVERT    pdf / png / jpg / tiff ─ as is
           docx ─ pure-JS text PDF (paragraphs + tables + checkboxes; no system dependency)
           anything else (doc, odt, rtf, txt, ...) ─ 415
  ▼
RASTERIZE  one PNG per page (pdfjs-dist + @napi-rs/canvas, sharp) + the page's PDF text layer
  ▼
CLASSIFY   formType given? → use it. Else cue phrases scored on the page text
           (scans: optional Textract OCR, max 3 pages) → best form ≥ its minScore, otherwise GENERIC
  ▼
EXTRACT    one Extraction per engine · requestHash reuse (no double billing) · sync or BullMQ queue
           ExtractionEngine.extract(request)   ◀── THE SEAM (src/engines/engine.port.ts)
             textract : FORMS key match (box captions) + TABLES (line items) + Queries (batches of 15)
             vlmrun   : upload → document/generate(JSON Schema, grounding, confidence) → poll → delete
             meibel   : deep-transform(JSON Schema, guidance) → poll → output.json + provenance.json
             fake     : synthetic values, same shape
  ▼
EngineField[]  scalars        patient.dob
               group cells    serviceLines[0].cptHcpcs   (CMS-1500 Box 24, UB-04 FL42-48, procedures)
               other values   otherFields[3] + printed label   ("capture any value")
  ▼
raw response → storage (gzip, immutable) · review flags (same rules for every engine):
  low_confidence · not_found · ungrounded · engine_fallback · unmapped
  ▼
ExtractedField rows (EAV + provenance) → GET /v1/extractions/:id  { fields, groups, other, values }
```

## 2. Forms

| Form | Detected by | Header fields | Rows (groups) |
|---|---|---|---|
| `CMS1500` | "HEALTH INSURANCE CLAIM FORM", NUCC, box captions | 41 (boxes 1–33, Box 21 A–L) | `serviceLines` Box 24, max 6 × 10 columns |
| `UB04` | "UB-04", NUBC, TYPE OF BILL, REV. CD. … | 35 (FL1–FL76) | `revenueLines` FL42–48, max 22 × 7 columns |
| `BOOKING_SHEET` | BOOKING, SURGERY, SURGEON, ANESTHESIA, CPT … | 25 (patient, surgeon, date/time, anesthesia, insurance, auth, allergies…) | `procedures` CPT / description / side / modifier |
| `INSURANCE_CARD` | MEMBER ID, RXBIN, COPAY … | 10 | — |
| `PATIENT_INTAKE` | PATIENT REGISTRATION, EMERGENCY CONTACT … | 13 | — |
| `GENERIC` | fallback | none: every labelled value goes to `otherFields` | — |
| *yours* | your cue phrases | a JSON file in `FORMS_DIR` | yes |

**"Any value":** every form (not only GENERIC) also captures printed label/value pairs that the definition doesn't cover, as `otherFields` (flagged `unmapped`, no canonical key). Turn it off per form with `"captureOther": false`.

**Add a form without code:** drop a JSON file into `FORMS_DIR` (example: [test/fixtures/forms/referral.json](test/fixtures/forms/referral.json)). It is validated with Zod at boot, and a bad file stops the app with the file name and the reason. A JSON form with the same `id` as a built-in one replaces it, which is how you add a hospital's own booking-sheet layout.

```json
{ "id": "REFERRAL", "version": 1, "title": "Referral letter", "description": "...",
  "cues": { "phrases": ["REFERRAL", "REFERRING PHYSICIAN", "REASON FOR REFERRAL"], "minScore": 0.6 },
  "fields": [ { "path": "patient.name", "label": "Patient name", "type": "name",
                "canonicalKey": "patient.name.full", "keyAliases": ["PATIENT NAME"], "required": true } ],
  "groups": [ { "path": "items", "label": "Items", "maxRows": 10,
                "columns": [ { "path": "code", "label": "Code", "type": "code", "keyAliases": ["CODE"] } ] } ] }
```

Field keys:

| Key | Meaning |
|---|---|
| `path` | where the value lands in the output |
| `label` | the printed caption |
| `type` | `text`, `name`, `date`, `code`, `phone`, `money`, `number` or `checkbox` |
| `canonicalKey` | the plan-03 dictionary key used for autofill |
| `keyAliases` | printed captions (scalars) or column headers (groups) that Textract matches |
| `query` | forces a Textract Query |
| `required` | flags `not_found` when the value is blank |
| `minConfidence` | per-field review threshold |

## 3. What can be swapped, and how

| Seam | Interface | Adapters | How to switch |
|---|---|---|---|
| **Extraction engine** | `ExtractionEngine` (`src/engines/engine.port.ts`) | `textract`, `vlmrun`, `meibel`, `fake` | `ENGINES_ENABLED`, `ENGINE_DEFAULT`, per request `engines=textract,vlmrun` |
| Document conversion | `ConverterService` | none, DOCX text-PDF | automatic by file type |
| Classification text | PDF text layer, Textract OCR | — | `CLASSIFY_OCR=none\|textract` |
| Forms | `FormDefinition` (data, Zod-validated) | built-in TS + JSON files | `FORMS_DIR` |
| Object storage | `StoragePort` | local, S3 (SSE-KMS) | `STORAGE_DRIVER` |
| Execution | `ExtractionDispatcher` | inline, BullMQ | `PIPELINE_MODE`, `APP_ROLE` |
| Tenant / auth | `@TenantId()` | `x-tenant-id` (dev) | host guard adapter |

Schema engines (VLM Run, Meibel, fake) share one walker (`src/engines/schema-result.ts`) for scalars, rows and other values. Each adapter only supplies its provenance lookup. **A fifth engine** means:
1. `src/engines/<name>/` with a transport client and a pure mapper.
2. A `case` in `buildEngines`.
3. Its env vars and rules in `app-config.ts`.

## 4. Quick start

Requirements: Node 22.21.1 (`nvm use`), pnpm 9, and Docker Desktop **running**.

```bash
pnpm install                     # also runs prisma generate
cp .env.example .env             # works as is: fake engine, auto classification, DOCX supported
docker compose up -d             # postgres:15 :5433, redis:7 :6380
pnpm prisma:deploy
pnpm start:dev                   # http://localhost:3000/docs

pnpm samples                     # samples/: cms1500, ub04, booking-sheet (.pdf + .docx), intake, letter, card
curl -s -X POST localhost:3000/v1/documents -H 'x-tenant-id: demo' -F file=@samples/booking-sheet.synthetic.docx
#   → { formType: "BOOKING_SHEET", classification: { source: "classifier", score: 1 }, conversion: "docx-text", extractions: [...] }
curl -s localhost:3000/v1/extractions/<id> -H 'x-tenant-id: demo'
#   → { fields: [...], groups: { procedures: [[...], [...]] }, other: [...], values: { patient: {...}, procedures: [...] } }
```

**Real engines:** fill the matching `.env` block (see [docs/MANUAL-SETUP.md](docs/MANUAL-SETUP.md)), then set `ENGINES_ENABLED=fake,textract,vlmrun,meibel`. **Bake-off on one file:** upload with `-F engines=textract,vlmrun,meibel`, then call `GET /v1/documents/<id>/compare`. **Queue mode:** `PIPELINE_MODE=queue`, running `APP_ROLE=api` plus N × `APP_ROLE=worker` from the same image.

## 5. API

All `/v1/*` routes except the catalog need `x-tenant-id`.

| Method | Path | What |
|---|---|---|
| POST | `/v1/documents` | multipart `file`, optional `formType` (otherwise auto-detected), optional `engines`. Returns 202 with `documentId`, `formType`, `classification`, `conversion` and the extractions |
| GET | `/v1/documents/:id` | document, classification, conversion, every run (status, cost, latency) |
| POST | `/v1/documents/:id/extractions` | `{ engine, formType? }`: another engine, or re-extract as a different form |
| GET | `/v1/documents/:id/compare` | latest run per engine side by side, including rows and other values (matched by label) |
| GET | `/v1/documents/:id/pages/:n` | page PNG (bboxes are 0..1 of this image) |
| GET | `/v1/extractions/:id` | `fields` (scalars), `groups` (rows of cells), `other` (any other value), `values` (the form's JSON shape, ready for prefill) |
| GET | `/v1/engines` · `/v1/forms` · `/v1/forms/:id` | catalog; `/forms/:id` includes the JSON Schema sent to schema engines |
| GET | `/health` · `/docs` | DB health · Swagger |

## 6. Tests

```bash
pnpm test        # 69 unit tests: no network, no DB
pnpm test:e2e    # 10 e2e tests over HTTP on real Postgres with the fake engine
pnpm lint && pnpm typecheck
```

What they cover:
- **Conversion:** zip reader, DOCX → lines (paragraphs, tables, checkboxes, entities), text → PDF (wrap, pages, WinAnsi), magic bytes (accepted and rejected formats).
- **Classification:** all 5 forms plus the GENERIC fallback, on raw text and on rendered PDFs.
- **Textract (hand-built block graphs):** CMS-1500 box captions with one key per field, Box 24 and UB-04 tables, blank rows dropped, checkbox selection, unclaimed keys → otherFields, query batching, cost.
- **VLM Run / Meibel:** privacy flags, auth headers, retries, rows with per-row metadata, the row cap, otherFields, bbox conversions.
- **Forms:** Zod validation, FORMS_DIR loading and rejection, JSON Schema arrays, no example values in prompts, hash stability.
- **e2e:** CMS-1500/UB-04 PDF and Word booking sheet auto-detected end to end, GENERIC, a JSON form, dedupe and reuse, compare, tenant isolation, 400/404/415 cases.

## 7. Layout

```
src/
  conversion/      zip reader, docx-text, text-pdf, ConverterService (DOCX → text PDF)
  rasterizer/      PDF/TIFF/image → page PNG + page text
  forms/           DSL (Zod), definitions/ (cms1500, ub04, booking-sheet, simple), registry (+FORMS_DIR),
                   classifier, JSON Schema builder
  engines/         engine.port (THE SEAM), schema-result walker, http, engines.module, registry,
                   textract/ vlmrun/ meibel/ fake/
  extraction/      runner (rows + flags), dispatcher (sync | BullMQ), review flags
  documents/       controllers, DTOs, documents + compare services
  testing/         synthetic CMS-1500 / UB-04 / booking (PDF + DOCX) / card generators, zip writer
prisma/            schema + 2 migrations (init, any_file_any_form)
test/              e2e + fixtures/forms/referral.json
```

## 8. Versions

These are pinned as requested:

| Area | Packages |
|---|---|
| Runtime and language | Node ≥22 (`node:22.21.1-alpine`), pnpm 9, TypeScript 5.7.3 |
| NestJS | Nest 11.0.1, CLI 11.0.0, config 4.0.2, swagger 11.2.3, terminus 11.0.0, testing 11.0.1, Express 5.2.1 |
| Database | Prisma 7.4.1 with adapter-pg and `prisma.config.ts`, pg 8.16.3 |
| Validation | Joi 18.0.2 (env), class-validator 0.14.3 / class-transformer 0.5.1 (HTTP DTOs), **Zod 4.3.6 (form DSL only)** |
| Tooling | Vitest 3.2.4, supertest 7.0.0, ESLint 9.18.0, typescript-eslint 8.20.0, Prettier 3.4.2, Pino 10.1.0 |
| AWS and other | AWS SDK 3.958.0 (S3, Textract), rxjs 7.8.1 |

These were added:

| Package | Version | Why |
|---|---|---|
| `bullmq` | 5.81.5 | Stable 5.x API (6.x is a fresh major) |
| `pdfjs-dist` | 5.7.284 | PDF render and text layer without poppler |
| `@napi-rs/canvas` | 0.1.100 | Must match pdfjs-dist's own copy, or `Path2D` breaks |
| `sharp` | 0.34.5 | Image handling |
| `aws-sdk-client-mock`, `unplugin-swc`, `@swc/core`, `@eslint/js` | — | Dev only |

Word support uses no extra npm package and no system dependency: there is a built-in zip reader and PDF writer.

Not added: Nest 12, Node 24, Prisma ≥7.10, Jest, poppler, extra IDP secrets.

## 9. Limits of the POC (the plan has them)

- **One form per upload.** Splitting a mixed packet page by page (plan P5) is not built; the whole file is classified once. Upload claims one at a time, or pass `formType`.
- **Word = DOCX only, and layout is not kept.** Labels, values and tables survive; positions don't, so bboxes refer to the generated PDF. `.doc`, `.odt` and `.rtf` are rejected: save them as DOCX or PDF.
- **Textract on CMS-1500 Box 24 depends on TABLES detection.** The plan's `grid` resolver (fixed row geometry) is the fallback to add if accuracy is low. VLM Run's per-row schema output usually fits that box better; measure with `/compare`.
- **Not yet built:** value normalization and rules (dates, NPI and ICD checks; plan P3/P4), M1 overlay, review PATCH, autofill, outbox (P7), RLS, retention, eval script (P9/S7).
- **Vendor response shapes are still UNVERIFIED.** Each guess lives in one mapper file (`vlmrun.mapper.ts`, `meibel.mapper.ts`). See MANUAL-SETUP §4.
