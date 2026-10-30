# IDP engine POC

One document-extraction pipeline with **swappable engines**: Amazon Textract, VLM Run, Meibel, plus a `fake` engine that needs no credentials. You pick the engine with env vars, and you can run several on the same file and compare them field by field.

It is a proof of concept for decision **D14 (multi-engine)** from the plan repo `document-textextraction` (`docs/research/vendors/shared-engine-adapter.md`), built on the stack of the main project (Node 22, NestJS 11, Prisma 7.4, Joi, Vitest, Pino, BullMQ).

> **Synthetic documents only** until the compliance gates in [docs/MANUAL-SETUP.md](docs/MANUAL-SETUP.md) §5 are done. With `PHI_MODE=true` the app refuses to boot unless they are.

---

## 1. What happens under the hood

```
POST /v1/documents (file + formType + engines?)
  │  magic-byte check · sha256 dedupe per tenant
  ▼
Storage (local | S3+KMS) ── original + one PNG per page (pdfjs-dist + @napi-rs/canvas, sharp)
  ▼
Extraction row per engine ── requestHash = engine|form|version|schemaHash|file sha256
  │                            same hash already done or running? → reuse it, no second vendor bill
  ▼
Dispatcher ── PIPELINE_MODE=sync: run in the request
  │           PIPELINE_MODE=queue: BullMQ job on Redis, worker process runs it (3 tries, backoff)
  ▼
ExtractionEngine.extract(request)   ◀── THE SEAM (src/engines/engine.port.ts)
  │   textract : page PNG → AnalyzeDocument(QUERIES [+FORMS]) per page → blocks
  │   vlmrun   : upload file → document/generate(json_schema, grounding, confidence) → poll → delete file
  │   meibel   : deep-transform(file, json_schema, guidance) → poll → output.json + provenance.json
  │   fake     : deterministic synthetic values
  ▼
EngineField[]  { path, value, confidence 0..100, confidenceSource, page, bbox (0..1, top-left) }
  ▼
Raw vendor response → storage (gzip, immutable)  →  review flags (same rules for every engine)
  │   low_confidence · not_found · ungrounded (value with no page/bbox) · engine_fallback
  ▼
ExtractedField rows (EAV + provenance)  →  GET /v1/extractions/:id · GET /v1/documents/:id/compare
```

**The form definition is the only input that describes a form** (`src/forms/definitions.ts`, pure data). The engines use it in two ways:

- **Textract** (evidence-first): each field becomes a Textract *Query* whose alias is the field path. Checkbox fields use FORMS key/value selection marks.
- **VLM Run / Meibel** (schema-first): the definition becomes a JSON Schema (`json-schema.builder.ts`). Every key is required and nullable, text is returned *as printed*, and the prompt carries labels only, never example values.

All engines end in the same `EngineField[]`, so storage, review flags, the API and the comparison never see vendor details.

## 2. What can be swapped, and how

| Seam | Interface | Adapters | How to switch |
|---|---|---|---|
| **Extraction engine** | `ExtractionEngine` (`src/engines/engine.port.ts`) | `textract`, `vlmrun`, `meibel`, `fake` | `ENGINES_ENABLED`, `ENGINE_DEFAULT`, or per request `engines=textract,vlmrun` |
| Object storage | `StoragePort` (`src/storage/storage.ts`) | `LocalStorage`, `S3Storage` (SSE-KMS) | `STORAGE_DRIVER=local\|s3` |
| Execution | `ExtractionDispatcher` | inline, BullMQ | `PIPELINE_MODE=sync\|queue`, `APP_ROLE=api\|worker\|all` |
| Tenant / auth | `@TenantId()` decorator | `x-tenant-id` header (dev) | In the host: an adapter over the host's guard |
| Forms | `FormDefinition` (data) | `INSURANCE_CARD`, `PATIENT_INTAKE` | Add a definition, no code |

**Adding a fifth engine** (e.g. Bedrock Data Automation, Azure Document Intelligence):
1. `src/engines/<name>/<name>.engine.ts` implements `extract(req) → EngineResult`. Keep transport in a `<name>.client.ts` and response mapping in a pure `<name>.mapper.ts`.
2. Add the name to `ENGINE_NAMES` (`engine.port.ts`) and a `case` in `buildEngines` (`engines.module.ts`).
3. Add its env vars and the "enabled ⇒ key required" rule in `src/config/app-config.ts`.
4. Write mapper tests on a recorded **synthetic** response.

Nothing else changes: no pipeline, API, schema or review code.

## 3. Quick start

Requirements: Node 22.21.1 (`nvm use`), pnpm 9, and Docker Desktop **running**.

```bash
pnpm install                     # also runs `prisma generate`
cp .env.example .env             # works as is: fake engine only
docker compose up -d             # postgres:15 on :5433, redis:7 on :6380
pnpm prisma:deploy               # applies prisma/migrations
pnpm start:dev                   # http://localhost:3000/docs (Swagger)

pnpm samples                     # writes samples/*.synthetic.{png,pdf}
curl -s -X POST localhost:3000/v1/documents -H 'x-tenant-id: demo' \
  -F formType=INSURANCE_CARD -F file=@samples/insurance-card.synthetic.png
curl -s localhost:3000/v1/extractions/<extractionId> -H 'x-tenant-id: demo'
```

**Turn on real engines:** fill the matching block in `.env` (see [docs/MANUAL-SETUP.md](docs/MANUAL-SETUP.md) for how to get each credential), then for example:

```bash
ENGINES_ENABLED=fake,textract,vlmrun,meibel
ENGINE_DEFAULT=textract
```

Boot fails with a clear message if an enabled engine is missing its key or region.

**Bake-off on one file:**

```bash
curl -s -X POST localhost:3000/v1/documents -H 'x-tenant-id: demo' \
  -F formType=INSURANCE_CARD -F engines=textract,vlmrun,meibel \
  -F file=@samples/insurance-card.synthetic.png
curl -s localhost:3000/v1/documents/<documentId>/compare -H 'x-tenant-id: demo'
```

**Queue mode:** set `PIPELINE_MODE=queue`. `APP_ROLE=all` serves HTTP and consumes jobs. In production, run one container with `APP_ROLE=api` and N containers with `APP_ROLE=worker`, all from the same image.

## 4. API

All `/v1/*` routes except the catalog need the `x-tenant-id` header.

| Method | Path | What |
|---|---|---|
| POST | `/v1/documents` | multipart `file`, `formType`, optional `engines` (comma list). Returns 202 with `documentId` and one extraction per engine. A re-upload of the same file is deduplicated, and an identical run is reused |
| GET | `/v1/documents/:id` | document + every extraction run (status, cost, latency) |
| POST | `/v1/documents/:id/extractions` | `{ engine, formType? }`: run another engine on a stored document |
| GET | `/v1/documents/:id/compare` | latest successful run per engine, field by field, with `agree` per row and totals (filled, flagged, cost, latency) |
| GET | `/v1/documents/:id/pages/:n` | page PNG (for the review overlay; bboxes are 0..1 of this image) |
| GET | `/v1/extractions/:id` | fields: value, confidence, page, bbox, canonicalKey, flags |
| GET | `/v1/engines` | which engines exist and which are enabled |
| GET | `/v1/forms`, `/v1/forms/:id` | definitions and the JSON Schema sent to schema engines |
| GET | `/health` | DB check (terminus) |
| GET | `/docs` | Swagger UI |

## 5. Tests

```bash
pnpm test        # 43 unit tests, no network, no DB
pnpm test:e2e    # 6 e2e tests over HTTP on real Postgres with the fake engine (docker compose up -d first)
pnpm lint && pnpm typecheck
```

What the unit tests pin down:
- **VLM Run:** `allow_logging/training/retention=false` on every request, bearer auth, 429 retry with `Retry-After`, the remote file is deleted even on failure, and error bodies are never copied into errors (they can echo PHI).
- **Meibel:** the `Meibel-API-Key` header, multipart fields, a URL allowlist (no datasources/ingest/agents), pixel and PDF-point bbox conversion, and guidance without digits.
- **Textract (aws-sdk-client-mock):** one call per page, queries aliased by path, FORMS only when there are checkboxes, throttling marked retryable.
- **All engines:** review flags, JSON Schema shape and hash stability, boot validation and the PHI gates, and PDF/TIFF/PNG rasterization.

## 6. Layout

```
src/
  main.ts · app.module.ts · core.module.ts · health.controller.ts
  config/app-config.ts          Joi env schema + typed AppConfig + PHI boot gates
  common/                       util (hash, magic bytes), pino logger, tenant decorator
  prisma/prisma.service.ts      Prisma 7 client via @prisma/adapter-pg
  storage/storage.ts            StoragePort + local + S3
  rasterizer/                   PDF/TIFF/image → page PNGs
  forms/                        form DSL (data), definitions, registry, JSON Schema builder
  engines/
    engine.port.ts              THE SEAM: ExtractionEngine, EngineField, EngineError
    engines.module.ts           env → adapters (the only place that knows them all)
    http.ts                     fetch + timeout + retry + poll (vendor adapters)
    textract/ vlmrun/ meibel/ fake/
  extraction/                   runner, dispatcher (sync | BullMQ), review flags
  documents/                    controllers, DTOs, documents + compare services
  testing/                      synthetic document generators (+ `pnpm samples`)
prisma/schema.prisma            Document, Page, Extraction, ExtractedField
test/app.e2e-spec.ts
```

## 7. Versions, and where they differ from the requested stack

Pinned as requested: Node ≥22 (`.nvmrc` 22.21.1, image `node:22.21.1-alpine`), pnpm 9, TS 5.7.3, Nest 11.0.1 / CLI 11.0.0, config 4.0.2, swagger 11.2.3, terminus 11.0.0, testing 11.0.1, Express 5.2.1 (pnpm override), Prisma 7.4.1 + adapter-pg + `prisma.config.ts`, pg 8.16.3, Joi 18.0.2, class-validator 0.14.3, class-transformer 0.5.1, Vitest 3.2.4, supertest 7.0.0, ESLint 9.18.0, typescript-eslint 8.20.0, Prettier 3.4.2, Pino 10.1.0, AWS SDK 3.958.0 (S3, Textract), rxjs 7.8.1.

Added, with reasons:

| Package | Version | Why |
|---|---|---|
| `bullmq` | 5.81.5 | Queue. Latest is 6.x (new multi-backend peers); 5.x is the stable API |
| `pdfjs-dist` | 5.7.284 | PDF → PNG without poppler (6.x is a fresh major) |
| `@napi-rs/canvas` | 0.1.100 | Must be the **same** version pdfjs-dist 5.7 depends on. A second copy breaks `Path2D` |
| `sharp` | 0.34.5 | Images, TIFF pages, resize under the Textract limits |
| `aws-sdk-client-mock` | 4.1.0 (dev) | Textract tests without AWS |
| `unplugin-swc`, `@swc/core` | 2.0.0, 1.16.20 (dev) | Vitest needs SWC to emit decorator metadata for Nest DI |
| `@eslint/js` | 9.18.0 (dev) | ESLint 9 flat config base |
| `reflect-metadata` | 0.2.2 | Nest peer |

Not used: `uuid` (`crypto.randomUUID` is enough, and uuid 13 is ESM-only), Cognito/SES/Secrets SDKs (not needed in the POC; see MANUAL-SETUP §5 for Secrets Manager), Zod (kept for the later form DSL). Not added: Nest 12, Node 24, Prisma ≥7.10, Jest, poppler, or extra secrets.

## 8. Not in the POC yet (the plan has them)

Page classification and packet splitting (P5), repeating groups such as CMS-1500 Box 24 (P4), value normalizers and rules (P3/P4), M1 overlay and second-opinion candidates (V5), VLM Run webhooks (V8), field review PATCH / autofill / outbox events (P7), Postgres RLS / retention / audit (P9), the eval script over a golden set (P4/S7).

**Vendor response shapes are UNVERIFIED** (the research could not call the APIs). Each guess lives in exactly one file, with a header comment listing the shapes it accepts: `src/engines/vlmrun/vlmrun.mapper.ts` (`_metadata` placement, bbox format, page base) and `src/engines/meibel/meibel.mapper.ts` (`provenance.json`). The first real synthetic run tells you which shape is right. See MANUAL-SETUP §4.
