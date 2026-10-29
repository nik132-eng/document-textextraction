# VLM Run Engine — Implementation Plan

> **For agentic workers:** this plan extends the IDP plan in [`docs/superpowers/plans/2026-10-28-textract-idp/`](../../../superpowers/plans/2026-10-28-textract-idp/00-overview.md). It is executed **inside the host project** with the one-shot prompt [`09-host-implementation-prompt.md`](../../../superpowers/plans/2026-10-28-textract-idp/09-host-implementation-prompt.md). Set `REQUIREMENT` to e.g. `"VLM Run engine: tasks S1–S8 and V1–V8 from docs/research/vendors/vlm-run/implementation-plan.md"`. Host conventions win on *how* (`00` §9). Every task follows the TDD steps of `06`.

**Goal:** add VLM Run as a second, schema-first extraction engine behind the shared adapter. It is used as **M1 overlay** for low-confidence fields and **M2 primary** for forms where it wins the bake-off. No pipeline, API or flattener changes.

**Inputs to read first:** [`research.md`](research.md), [`../shared-engine-adapter.md`](../shared-engine-adapter.md), [`../comparison.md`](../comparison.md).

**Depends on IDP phases:** P0–P3 done (data model, storage, Evidence, DSL, resolvers, finalizer). P4 for the eval script. P8 if queue mode is on.

---

## V0 — Prerequisites (not code; owner in brackets)

- [ ] **[Product/ops]** Create the VLM Run org. Start on **Starter for synthetic-only** development.
- [ ] **[Compliance]** Before any real document: upgrade to **Pro ($799/mo) and sign the BAA**, or go Enterprise in-VPC. Get written answers to research §8 Q1, Q2 and Q6. Record them in `docs/compliance/vlmrun-baa.md` (host repo).
- [ ] **[Ops]** Create two API keys (dev, prod) and a **webhook secret** in the VLM Run dashboard (Settings → API Keys). Store them in **AWS Secrets Manager** as `idp/<env>/vlmrun` (`apiKey`, `webhookSecret`). Inject them as task secrets. They never go in `.env` files in git.
- [ ] **[Ops]** If the egress allowlist is on: allow `api.vlm.run:443` and `gateway.vlm.run:443` from the worker tasks (NAT/egress proxy). VPC endpoints do not apply, because this traffic is external.
- [ ] **[Tech lead]** Pin the model (`vlm-1` or a specific `orion-2` variant). **Never** pass third-party model ids for PHI (research §6.2).
- [ ] **[Dev]** Record **synthetic** fixtures for 3 CMS-1500, 3 insurance cards and 3 booking sheets (V6) before writing the parser (V3).

## Environment (add to `05` §12)

```bash
ENGINE_VLMRUN_ENABLED=false
ENGINE_VLMRUN_BAA_CONFIRMED=false        # PHI_MODE=true + ENABLED=true requires true
VLMRUN_API_KEY=                          # from Secrets Manager
VLMRUN_BASE_URL=https://api.vlm.run      # Enterprise in-VPC: your private endpoint
VLMRUN_MODEL=vlm-1                       # pinned
VLMRUN_DETAIL=hi                         # hi for claim forms
VLMRUN_SERVICE_TIER=standard             # flex for backfills
VLMRUN_POLL_MS=2000
VLMRUN_TIMEOUT_MS=120000
VLMRUN_RPM=90                            # stay under the plan limit
VLMRUN_WEBHOOK_ENABLED=false
VLMRUN_WEBHOOK_SECRET=
VLMRUN_CONFIDENCE_MAP={"high":95,"medium":75,"low":40}   # calibrated by eval (V7)
ENGINE_MAX_USD_PER_DOC=1.00              # budget guard (shared S4)
```

Boot rules: `ENABLED=true` ⇒ `VLMRUN_API_KEY` is required. `PHI_MODE=true` and `ENABLED=true` ⇒ `ENGINE_VLMRUN_BAA_CONFIRMED=true`. `VLMRUN_WEBHOOK_ENABLED=true` ⇒ a secret of 32 characters or more.

---

## Shared tasks first

Do **S1–S8** from [`../shared-engine-adapter.md`](../shared-engine-adapter.md) §10. VLM Run tasks start at V1.

## V1 — VlmRunClient (transport only)

**Files:** `src/engines/vlmrun/vlmrun.client.ts`, `vlmrun.errors.ts`, `vlmrun.types.ts`, spec.
**Dependency:** the official Node SDK `vlmrun` (pin an exact version at implementation time, after checking it on npm), **or** the host's HTTP client if the host has a standard one (`00` §9.2). Record the choice in `ADAPTATION.md`.
**Produces:**
```ts
class VlmRunClient {
  uploadFile(bytes: Buffer, filename: string): Promise<{ fileId: string }>;
  generate(req: { fileId: string; jsonSchema: object; pageIndices?: number[]; callbackUrl?: string }): Promise<{ id: string; status: string }>;
  getPrediction(id: string): Promise<VlmPrediction>;   // { id, status, response, fallback, usage }
  deleteFile(fileId: string): Promise<void>;
}
```
- [ ] **Failing tests** (HTTP mocked, no network):
  - every `generate` body has `metadata.allow_logging=false`, `allow_training=false` and `allow_retention=false`, plus `config.grounding=true`, `config.confidence=true`, `temperature=0`, `batch=true` and the pinned `model`. One test covers each flag, so a future change can't silently flip it.
  - the `Authorization: Bearer` header is set, and the key is never logged.
  - `429` → `VlmRunError.retryable=true` with `retryAfterMs` from `Retry-After`. `5xx`/timeout → retryable. `401`/`403` → non-retryable config error. `422` → non-retryable, with `detail[].loc` codes only (no values).
  - the client-side limiter holds calls to `VLMRUN_RPM`.
- [ ] Implement → pass → commit `feat(engines): vlm run client`.

## V2 — VlmRunEngine (implements `SchemaEnginePort`)

**Files:** `src/engines/vlmrun/vlmrun.engine.ts`, spec.
**Behaviour:**
- `submit(pages, schema)`: make **one call per segment**.
  1. Upload the **original document once** per document (`uploadFile`) and reuse the `fileId` across its segments. This needs no PDF-building dependency, and the vendor's context cache applies.
  2. `generate({ fileId, jsonSchema, pageIndices: segmentPages.map(p => p - 1) })`.
  3. Exception: an original that the vendor can't read (e.g. a TIFF, if research §8 Q5 says it is unsupported) → upload the rasterized page PNGs of the segment instead, one file per page. Decide this from the supported-files answer and record it in `ADAPTATION.md`.
- `poll(id)`: maps `pending|enqueued|running|paused` → `pending`, `completed` → `succeeded`, `failed` → `failed`.
- `fetch(id)`: returns `{ raw: prediction, costUsd: usage.cost_dollars, modelVersion: model + (fallback ? ':fallback' : '') }`.
- `deleteRemote`: once **all** segments of the document reach a terminal state, call `deleteFile(fileId)`. The `fileId` is kept on the Document (a new nullable column `engineFileRefs Json`, additive).
- [ ] **Failing tests:**
  - a document with 2 segments → 1 upload and 2 generate calls with the right `page_indices`;
  - a re-run with the same `requestHash` → no new calls;
  - the delete runs after the last segment;
  - `fallback=true` → the EngineCall row records it and every field from that call gets the flag `low_confidence`.
- [ ] Implement → pass → commit.

## V3 — Evidence builder for VLM Run responses

**Files:** `src/engines/vlmrun/vlmrun.evidence.ts`, spec using **recorded fixtures** from V6 (write V6 first if fixtures don't exist yet).
**Algorithm:** walk `schema` and `response` in parallel. For every leaf path (including `[i]` rows):
- `value` = the leaf as returned (string, boolean or null).
- Read the field's grounding and confidence from `_metadata`. Its exact placement comes from the fixtures (research §8 Q3), so write it down in a comment with the fixture name.
- `page` = `segmentPages[bbox.page]` if the page index is segment-relative, else `bbox.page + 1`. Decide from the fixtures and assert it in a test.
- `bbox` = `xywh` → `{ left: x, top: y, width: w, height: h }` if top-left normalized. Convert if it turns out to be center-based. Several boxes → their union. **Assert** 0 ≤ all ≤ 1.
- `confidence` = `VLMRUN_CONFIDENCE_MAP[band]`, with `confidenceSource='band'`. Missing → null, `'none'`.
- `groundingText` = the first `bboxes[].content`.
- If the response also carries OCR text per box, add `EvLine`s to `pages[]` (used by the OCR cross-check and by unmapped capture). Otherwise, `pages` comes from the classification `DetectDocumentText` lines.
- [ ] **Failing tests:**
  - insurance-card fixture → `EvSchemaField` for every schema leaf;
  - nulls preserved as `value: null`;
  - a checkbox comes back as a boolean;
  - Box 24 rows → `box24[0..n].*` paths;
  - every bbox inside 0..1;
  - a page number mapped to the document page;
  - an unknown extra key in the response is ignored, with a counter metric `idp_engine_extra_keys_total` (no values logged).
- [ ] Implement → pass → commit `feat(engines): vlm run evidence builder`.

## V4 — Wire M2 (primary) for one form

**Files:** `src/forms/definitions/booking-sheet.form.ts` (a **variant** `booking-sheet.vlmrun.form.ts` with the same `id`, chosen by env `FORM_ENGINE_OVERRIDES={"BOOKING_SHEET":"vlmrun"}`), or a new form such as `PATIENT_INTAKE` that uses `engine: { api: 'Schema', provider: 'vlmrun' }` and `schemaField` sources only.
- The definition stays data. Only `engine` and the `sources` differ.
- Registry rule: the override may only swap to a variant that has the **same field paths and canonical keys** (validator `DEF_VARIANT_MISMATCH`). That keeps review, autofill and profiles unchanged.
- [ ] **Failing e2e** (fake engine replaying fixtures):
  - upload a booking-sheet fixture with the override on → segment `NEEDS_REVIEW`/`EXTRACTED`, field rows with `source='schemaField'`, bbox and confidence set;
  - zero Textract `AnalyzeDocument` calls;
  - one `EngineCall`;
  - remap → zero vendor calls.
- [ ] Implement → pass → commit.

## V5 — Wire M1 (overlay)

**Files:** definitions add `{ kind: 'overlay', provider: 'vlmrun', when: ['low_confidence','not_found','unreadable'] }` as the **last** source on chosen fields (start with: CMS-1500 box 2 name, box 3 DOB, box 1a insured id, box 21 codes, box 24 rows; booking sheet patient name, DOB, procedure).
**Behaviour:**
- After the primary mapping, collect the flagged paths per page.
- If there are any, make **one** overlay call per segment with a **reduced schema** that contains only those paths. That is cheaper, and the schema hash depends on the path set.
- Store the results as `overlays.vlmrun`. Candidates are shown to the reviewer.
- [ ] **Failing tests:**
  - no flagged fields → no overlay call;
  - 3 flagged → 1 call whose schema has exactly 3 leaves;
  - a primary value that is non-null and low-confidence keeps the primary value, adds a candidate and flags `overlay_suggested`;
  - a primary null → the overlay value is used, the field is flagged `overlay_suggested`, and it stays in review;
  - the budget guard stops overlay calls when `ENGINE_MAX_USD_PER_DOC` would be exceeded (flag `overlay_skipped_budget` in meta).
- [ ] Implement → pass → commit.

## V6 — Fixture recorder + fake engine

**Files:** extend `scripts/record-fixture.ts` with `--engine vlmrun`. Add `src/engines/vlmrun/fake-vlmrun.engine.ts`.
- The recorder refuses when `PHI_MODE=true`, and writes `test/fixtures/vlmrun/<FORM>/<case>/{prediction.json, schema.json, meta.json}`. `meta.json` holds `schemaHash`, `model` and `recordedAt`.
- The fake engine replays by `schemaHash`. On a mismatch it throws `FixtureMissing`, with the exact re-record command.
- [ ] **Failing test:** a missing fixture gives an error message that contains `record-fixture -- --engine vlmrun`.
- [ ] **Manual (synthetic, Starter plan OK):** record 3 cases per form for CMS1500, INSURANCE_CARD and BOOKING_SHEET. Commit the fixtures. Cost is a few cents.

## V7 — Bake-off + confidence calibration

- `npm run eval -- --form CMS1500 --engine vlmrun` and `--engine textract`, on the same golden set (synthetic).
- `--sweep-band-map` tries confidence maps (e.g. medium = 60/70/80) and picks the one that keeps **accepted-but-wrong ≤ 1%** on critical fields (`07` §4.1). Write the result to `VLMRUN_CONFIDENCE_MAP` and to the definition's version notes.
- Report: `reports/eval-<date>-<form>-vlmrun.md`, with the extra metrics from shared §8.
- [ ] **Decision record:** per form, adopt M2, keep M1, or reject. Write it in `docs/adr/NNNN-vlmrun-engine.md` (host ADR convention).

## V8 — Webhook (optional speed-up) + operations

**Files:** `src/engines/vlmrun/vlmrun-webhook.controller.ts` (`POST /webhooks/vlmrun`, outside the tenant guard but behind the signature check), spec.
- Verify `X-VLMRun-Signature` = `sha256=` + HMAC-SHA256(raw body, secret), with a constant-time compare. Do this **before** parsing JSON, and keep the raw body (host body-parser config).
- **Do not trust the payload content.** Look up `EngineCall` by `externalId`. If it is still `SUBMITTED`, enqueue `engine-fetch` (the same job polling uses). The response is always fetched via `getPrediction`.
- Polling stays on (webhooks have only 2 attempts). The webhook only shortens latency.
- Metrics: `idp_engine_calls_total{provider,api,status}`, `idp_engine_cost_usd_total{provider}`, `idp_engine_latency_ms{provider}`, `idp_engine_ungrounded_total{provider,formType}`.
- Alarms: cost per day > budget/30, failure rate > 5% over 15 min, p95 latency > 60 s.
- Runbook additions (`docs/runbooks/idp.md`): rotate the key, the vendor is down (switch overrides back to Textract with `FORM_ENGINE_OVERRIDES={}`, no deploy needed), re-record fixtures after a model upgrade.
- [ ] **Failing tests:** a bad signature → 401, with nothing enqueued; a good signature → one fetch job (deduped by jobId); a replayed webhook → no second fetch.

---

## Acceptance (whole plan)

1. With `ENGINE_VLMRUN_ENABLED=false`, behaviour equals the Textract-only build (the whole existing test suite passes unchanged).
2. Fixture e2e: M2 booking sheet and M1 overlay on CMS-1500 both pass, with zero network calls in tests.
3. `PHI_MODE=true` + enabled + no BAA → the app refuses to boot.
4. Every vendor request carries `allow_training/logging/retention=false` (tests).
5. The bake-off report is committed, and the ADR decision is recorded.
6. The log scan (P9 Task 9.2) finds no values in logs, including vendor error paths.

## Rollback

Set `ENGINE_VLMRUN_ENABLED=false` and `FORM_ENGINE_OVERRIDES={}`. Existing extractions stay readable. Re-run affected segments with `reanalyze` on Textract if needed (billed).
