# Meibel Engine — Implementation Plan

> **For agentic workers:** this plan extends the IDP plan in [`docs/superpowers/plans/2026-10-28-textract-idp/`](../../../superpowers/plans/2026-10-28-textract-idp/00-overview.md). It is executed **inside the host project** with [`09-host-implementation-prompt.md`](../../../superpowers/plans/2026-10-28-textract-idp/09-host-implementation-prompt.md). Set `REQUIREMENT` to e.g. `"Meibel engine: tasks S1–S8 (if not done) and MB1–MB7 from docs/research/vendors/meibel/implementation-plan.md"`. Host conventions win on *how* (`00` §9). Every task follows the TDD steps of `06`.

**Status gate:** build only after **MB0** is done. Research ([`research.md`](research.md) §7) recommends Meibel as an **option**, not the next engine. If VLM Run's shared tasks S1–S8 are already built, this plan is only adapter work.

**Goal:** add Meibel behind the same `SchemaEnginePort`:
- **deep transform** for schema extraction (M2/M1);
- optionally **parse** for tables and layout evidence.

Meibel datasources, Recall, ingest and agents stay **out of the PHI path**.

**Depends on:** P0–P3 (and S1–S8). P4 for eval.

---

## MB0 — Prerequisites (not code; these block the build)

- [ ] **[Compliance]** Get written answers to research §8 Q1–Q4. **Hard gate:** a signed BAA, **or** an approved **BYOC on AWS** deployment where the data plane runs in our account and the control plane receives no document content. Record the answers in `docs/compliance/meibel-baa.md` (host repo).
- [ ] **[Tech lead]** Get answers to Q5 (the `provenance.json` format, per-field confidence) and Q6 (checkboxes, key/value forms). If checkboxes are unsupported, **exclude claim forms** (CMS1500, UB04) from M2 and use Meibel only for forms without checkboxes (letters, referrals, booking sheets) or as M1 for text fields.
- [ ] **[Ops / finance]** Confirm billing (Q7). Decide SaaS (AWS Marketplace private offer) or **BYOC (recommended for PHI)**.
- [ ] **[Ops]** BYOC: follow Meibel's deployment guide in a dedicated account or VPC, in the **same region** as the IDP bucket. Allow egress only to the Meibel control-plane endpoints they list. The API base becomes the BYOC endpoint.
- [ ] **[Ops]** Create the API key (Settings → API Keys) and store it in **Secrets Manager** `idp/<env>/meibel` (`apiKey`). Inject it as a task secret.
- [ ] **[Dev]** Record **synthetic** fixtures (MB5) before writing the parser (MB3).

## Environment (add to `05` §12)

```bash
ENGINE_MEIBEL_ENABLED=false
ENGINE_MEIBEL_BAA_CONFIRMED=false       # or BYOC approval; PHI_MODE=true + ENABLED requires true
MEIBEL_API_KEY=                         # Secrets Manager
MEIBEL_BASE_URL=https://api.meibel.ai/v2   # BYOC: your data-plane URL
MEIBEL_POLL_MS=2000
MEIBEL_TIMEOUT_MS=300000                # deep transform is async and slower
MEIBEL_RPS=4                            # Starter limit is 6 req/s
MEIBEL_USE_PARSE_EVIDENCE=true          # also call parse for tables/layout lines
MEIBEL_DEFAULT_FIELD_CONFIDENCE=        # empty = none → fields go to review (shared §6.3)
ENGINE_MAX_USD_PER_DOC=1.00
```

---

## Shared tasks first

Do **S1–S8** from [`../shared-engine-adapter.md`](../shared-engine-adapter.md) §10, if they are not already done for VLM Run.

## MB1 — MeibelClient (transport only)

**Files:** `src/engines/meibel/meibel.client.ts`, `meibel.errors.ts`, `meibel.types.ts`, spec.
**Dependency:** the official TypeScript SDK (pin the exact version after checking npm), **or** the host's HTTP client (`00` §9.2). Record the choice in `ADAPTATION.md`.
**Produces:**
```ts
class MeibelClient {
  submitTransform(i: { file: Buffer; filename: string; schema: object; rootName: string; guidance?: string; maxPages?: number }): Promise<{ jobId: string }>;
  submitTransformFromDocument(i: { parseJobId: string; schema: object; rootName: string; guidance?: string }): Promise<{ jobId: string }>;
  getTransform(jobId: string): Promise<{ status: 'queued'|'running'|'succeeded'|'failed'; aeq?: number; metrics?: object; artifacts?: string[] }>;
  downloadArtifact(jobId: string, name: 'output.json' | 'provenance.json'): Promise<unknown>;
  parseAsync(file: Buffer, filename: string): Promise<{ jobId: string }>;
  getParseStatus(jobId: string): Promise<{ status: string }>;
  getStructured(jobId: string): Promise<MeibelStructuredDoc>;          // output-schema.md shape
  deleteRemote(ids: { parseJobId?: string; transformJobId?: string }): Promise<void>;   // only if MB0 confirms an endpoint; else no-op + metric
}
```
- [ ] **Failing tests** (HTTP mocked):
  - the `Meibel-API-Key` header is set, never `Authorization`, and the key is never logged;
  - multipart transform submit contains `file`, `schema` (JSON string), `root_name`, plus `guidance` and `max_pages` when given;
  - an idempotent resubmit returns the same `jobId` and the client does not treat it as an error;
  - `429`/`5xx`/timeout → retryable. `401`/`403` → config error. `4xx` → non-retryable, with the error code only;
  - **no** calls to the datasources, ingest, agents or sessions endpoints exist in the client. A test asserts the client's URL allowlist.
- [ ] Implement → pass → commit `feat(engines): meibel client`.

## MB2 — MeibelEngine (implements `SchemaEnginePort`)

**Files:** `src/engines/meibel/meibel.engine.ts`, spec.
**Behaviour:**
- `submit`:
  1. When `MEIBEL_USE_PARSE_EVIDENCE=true`: `parseAsync(original)` **once per document**, wait until it succeeds, then call `submitTransformFromDocument` per segment. That way only one copy is processed.
  2. Otherwise: `submitTransform` per segment, with the segment's pages packed as a PDF. Prefer `max_pages` and the original file if the API gains page selection. **UNVERIFIED:** page-range selection. Until it is confirmed, send the original only when the segment is the whole document, and otherwise use per-segment page PNGs uploaded as a ZIP container (Meibel parses ZIP children) **or** as single images. Choose after MB0 and record the choice in `ADAPTATION.md`.
  3. `rootName` = `def.id.toLowerCase()`. `guidance` = a generated markdown block: "Return text exactly as printed. Use null when a field is blank. Do not infer values that are not printed." plus the field labels. It contains **no example values**.
- `poll` / `fetch`: `getTransform`, then download `output.json` and `provenance.json`. `costUsd` = an estimate from page and field counts (the pricing table), because no actual cost is documented. Store `aeq` in `EngineCall.modelVersion` metadata (or a JSON column).
- `deleteRemote`: after all segments are terminal. If no delete API exists, increment `idp_engine_remote_retained_total{provider="meibel"}` and rely on the contract or BYOC retention (MB0).
- [ ] **Failing tests:**
  - 2 segments with parse evidence on → 1 parse and 2 transform calls;
  - reuse on the same `requestHash`;
  - a timeout → `FAILED` with code `ENGINE_TIMEOUT`;
  - a guidance string with no digits from fixture values (PHI-safety test).
- [ ] Implement → pass → commit.

## MB3 — Evidence builder for Meibel artifacts

**Files:** `src/engines/meibel/meibel.evidence.ts`, `meibel.parse-evidence.ts`, specs using **recorded fixtures** (MB5).

**Transform → `EvSchemaField[]`:**
- Walk `schema` and `output.json` in parallel. For each leaf path, find its provenance entry in `provenance.json`. Base the format on the fixtures and document it next to the parser, with the fixture name.
- `page` and `bbox` come from the provenance span → page region. Convert the coordinate system:
  - pixel top-left ÷ `image_size` → normalized;
  - PDF points with bottom-left origin → `top = 1 − (y1 / pageHeight)`.
  - Test both.
- `confidence`:
  - a per-field AEQ score, if MB0/Q5 confirms it is returned (0..1 → ×100, `confidenceSource='numeric'`);
  - else `MEIBEL_DEFAULT_FIELD_CONFIDENCE` if set (`'judged'`);
  - else `null`/`'none'`, which sends the field to review (shared §6.3).
- A value present in output with **no** provenance → `bbox=null` → `ungrounded`.

**Parse → `EvidencePage[]`** (when enabled):
- `elements` with text → `EvLine` (one line per element, words split on spaces with the element bbox. Approximate, so it is used for the OCR cross-check and unmapped capture only).
- `Table` → `EvTable`, with cells, spans, `isHeader` and normalized bboxes.
- Element `confidence` (layout) → `EvLine.confidence = 100 × confidence`. It is **labelled layout confidence** and is not used as value confidence.
- `page_number` is 0-based → document page = `+1`.

- [ ] **Failing tests:**
  - every schema leaf becomes an `EvSchemaField`;
  - nulls preserved;
  - both coordinate conversions are correct on a known box;
  - a value with no provenance → `ungrounded`;
  - parse tables → `EvTable` with merged cells expanded (as `04` §5.1);
  - page numbers shifted correctly.
- [ ] Implement → pass → commit `feat(engines): meibel evidence builder`.

## MB4 — Wire M2/M1 for the allowed forms

- Forms allowed after MB0: if checkboxes are unsupported, **only** forms with no checkbox groups (validator rule: `engine.provider='meibel'` and `checkboxGroups.length > 0` → `DEF_ENGINE_CAPABILITY` unless `MEIBEL_CHECKBOXES=true`).
- Same variant mechanism as VLM Run V4 (`FORM_ENGINE_OVERRIDES`, `DEF_VARIANT_MISMATCH`).
- Overlay as in VLM Run V5, with `provider: 'meibel'`.
- [ ] **Failing e2e** (fake engine):
  - a letter or booking-sheet fixture with the override → rows with `source='schemaField'`;
  - zero Textract AnalyzeDocument calls;
  - a CMS-1500 override with Meibel → boot validation error `DEF_ENGINE_CAPABILITY`;
  - remap → zero vendor calls.

## MB5 — Fixture recorder + fake engine

- `scripts/record-fixture.ts --engine meibel` (refuses when `PHI_MODE=true`) writes `test/fixtures/meibel/<FORM>/<case>/{structured.json, output.json, provenance.json, status.json, schema.json, meta.json}`.
- `FakeMeibelEngine` replays by `schemaHash`. A missing fixture → `FixtureMissing` with the command.
- [ ] **Manual (synthetic, Starter credits $25):** record 3 cases each for BOOKING_SHEET, GENERIC letter and INSURANCE_CARD.

## MB6 — Bake-off

- `npm run eval -- --form <ID> --engine meibel` against the same golden set.
- Meibel's score is only meaningful if per-field confidence exists. Otherwise the **review rate** is ~100% and the engine fails the gate by design. Report it anyway, together with exact-match and ungrounded rates, so the product can judge the value of a "suggest values, always review" mode.
- [ ] Decision record `docs/adr/NNNN-meibel-engine.md`: adopt (which forms, which mode) or park.

## MB7 — Operations

- Metrics, alarms and runbook as in VLM Run V8, with `provider="meibel"`. No webhook: deep transform is poll-only per the docs (the SSE trace is not used).
- A contract test, run nightly with `RUN_VENDOR_TESTS=true` on synthetic data: submit one fixture document and assert the response shape keys. This catches **preview API** changes early.
- Kill switch: `ENGINE_MEIBEL_ENABLED=false` and `FORM_ENGINE_OVERRIDES={}`.

---

## Acceptance (whole plan)

1. With Meibel disabled, the existing suite passes unchanged.
2. Fixture e2e for the allowed forms passes with zero network calls.
3. Boot refuses `PHI_MODE=true` + enabled + not confirmed. Boot refuses Meibel on checkbox forms unless the capability is confirmed.
4. The client cannot reach the datasource, ingest or agent endpoints (allowlist test).
5. The bake-off report and the ADR are committed.
6. The log scan finds no values in logs.

## Rollback

Same as VLM Run: flags off, overrides cleared. Stored extractions remain. Re-run on Textract with `reanalyze` if needed.
