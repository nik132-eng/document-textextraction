# 10 — Host Prompt: VLM Run primary, Textract fallback (scan → design → build)

Paste the PROMPT block into an AI coding agent that has the **real host ("main") project** open. The agent:
1. learns the plan, the vendor research and the working POC;
2. scans the host;
3. writes a design in which **VLM Run is the primary extraction engine and Amazon Textract is the fallback, chosen by env**;
4. stops for your approval;
5. builds it slice by slice, in the host's own style.

**How this relates to `09`:** `09` builds the Textract-first plan. This prompt keeps `09`'s rules, scan and adaptation map, and changes the engine decision (D1 → D15 below). Use `10` instead of `09` when VLM Run is the primary engine.

## How to use

1. Give the agent the **absolute path** of this plan repo, so relative links keep working. The POC lives in the same repo at `idp-engine-poc/`.
2. Make sure the host working tree is clean (`git status`).
3. Fill in the `<<…>>` inputs and paste the whole PROMPT block as one message.
4. At **Checkpoint 1**, read `docs/idp/DESIGN.md` and `docs/idp/ADAPTATION.md` in the host and reply `approved` or give corrections. At **Checkpoint 2**, after the first slice, confirm the slice runs end to end.
5. To continue later, rerun the same prompt. The agent resumes from `docs/idp/PROGRESS.md`.

---

## PROMPT

````text
You are bringing an Intelligent Document Processing (IDP) capability into the host project open
in this workspace. Staff upload patient documents (PDF, scans, photos, Word .docx). The system
detects the form (CMS-1500, UB-04, hospital booking sheet, others, or GENERIC), extracts every
value with confidence and page location, and exposes it for human review and prefill.

ENGINE DECISION (D15, new; supersedes plan D1 and the comparison doc's recommendation):
VLM Run is the PRIMARY extraction engine. Amazon Textract is the FALLBACK. Which engine runs is
decided by env, per form, and per run (fallback). The engine is a seam: one interface, adapters
behind it.

Three sources, three roles:
- PLAN (WHAT to build, invariants, data semantics):  PLAN_REPO/docs/superpowers/plans/2026-10-28-textract-idp/
- RESEARCH (vendor facts, risks, unverified items):   PLAN_REPO/docs/research/vendors/
- POC (a working reference for the concepts):         PLAN_REPO/idp-engine-poc/
- HOST (HOW it looks: framework, ORM, style, tests):  this workspace
The POC proves the concepts. It is reference code, not code to paste: re-express each concept in
the host's patterns. Plan = WHAT, host = HOW, POC = proof.

──────────────────────────────── INPUTS ────────────────────────────────
PLAN_REPO    = <<absolute path of the document-textextraction repo>>
REQUIREMENT  = <<what to deliver now, e.g.
                 "Slices S0–S2: module skeleton, VLM Run primary end to end, Textract fallback"
                 "Slices S0–S6: everything in this prompt">>
FIRST_FORMS  = <<e.g. "CMS1500, UB04, BOOKING_SHEET, GENERIC">>
CHECKPOINT   = <<yes | no>>   (yes = stop at Checkpoint 1 and Checkpoint 2. Default yes.)

──────────────────────────────── HARD RULES ────────────────────────────────
Apply PLAN/09-host-implementation-prompt.md "HARD RULES" 1–10 in full. In addition:
11. Tests never call VLM Run or AWS. Tests use injected fetch / aws-sdk-client-mock and recorded
    SYNTHETIC fixtures. Live vendor calls happen only when the user sets RUN_VENDOR_TESTS=true.
12. Every VLM Run request carries metadata.allow_logging=false, allow_training=false and
    allow_retention=false, plus grounding=true, confidence=true, temperature=0 and a pinned
    model. A unit test asserts each flag.
13. PHI gate: PHI_MODE=true with VLM Run enabled requires VLMRUN_BAA_CONFIRMED=true, or the app
    refuses to boot. A missing BAA is a configuration error, never a silent reroute to Textract.
14. Vendor error bodies never enter logs, errors or DB rows (they can echo document content).
    Store error codes only.
15. The fallback is visible: every extraction row records which engine ran, in which role
    (primary | fallback) and why the fallback ran.

──────────────────────────────── PHASE A — LEARN (read-only) ────────────────────────────────
A1. Plan. Read PLAN/00-overview.md fully (§2 decisions, §4 constraints, §8 plug-and-play, §9 host
    adaptation), then 02, 03, 05, 06, 07, STATUS.md. Skim 04 (Textract layer: you build it as
    the fallback adapter).
A2. Engine research. Read PLAN_REPO/docs/research/vendors/: shared-engine-adapter.md (fully:
    SchemaEnginePort, EvSchemaField, JSON Schema builder rules, hallucination guard, EngineCall
    table), vlm-run/research.md and vlm-run/implementation-plan.md (V0–V8; note every UNVERIFIED
    item), comparison.md (to state in the ADR what D15 changes and why). Meibel is out of scope.
A3. POC. Read idp-engine-poc/README.md, then these files. Each one is the proof of a concept:
      src/engines/engine.port.ts            the seam: ExtractionEngine, EngineField, EngineError
      src/engines/schema-result.ts          one walker for schema-engine JSON: scalars, rows, otherFields
      src/engines/vlmrun/*                  client (privacy flags, retry, poll), mapper (UNVERIFIED
                                            _metadata shapes kept in one file), engine (upload →
                                            generate → poll → delete)
      src/engines/textract/*                planTextract (queries in batches of 15, FORMS, TABLES),
                                            mapper (caption match one key per field, TABLES → rows,
                                            unclaimed KV → otherFields)
      src/engines/http.ts                   timeout, retry on 429/5xx with Retry-After, pollUntil
      src/forms/*                           form DSL (Zod), CMS1500 / UB04 / BOOKING_SHEET / GENERIC
                                            definitions, JSON forms via FORMS_DIR, classifier, JSON
                                            Schema builder
      src/conversion/*                      DOCX → text PDF in pure JS, zip reader, magic bytes
      src/rasterizer/*                      PDF → page PNG + text layer (pdfjs-dist + @napi-rs/canvas)
      src/extraction/*                      runner, toRows, review flags, dispatcher (sync | BullMQ)
      src/documents/compare.service.ts      per-document engine comparison
      prisma/schema.prisma + migrations     data model as built
      src/config/app-config.ts              env validation + PHI boot gates
A4. Produce a CONCEPT MAP (it goes into DESIGN.md §2): one row per POC concept above, with
    columns: concept | POC path | plan reference | keep as is / adapt / skip | reason.
    Done when every POC folder listed in A3 has a row and every "adapt" row names what changes.

──────────────────────────────── PHASE B — SCAN THE HOST (read-only) ────────────────────────────────
B1. Run PLAN/09 Phase B in full (B1 integration report via PLAN/08, B2 conventions scan +
    TEMPLATE MODULE, B3 commands). Write docs/idp/INTEGRATION-REPORT.md.
B2. Engine-specific scan. Find and cite (path:line, ≥2 examples each, or "none found"):
    - outbound HTTP client pattern (fetch / axios / HttpModule), its retry and timeout handling
    - AWS SDK usage, credential handling, S3 service, region config
    - queue / background job pattern (BullMQ, cron, SQS) and Redis config
    - env loading and validation (Joi / Zod / class-validator), feature flags, secrets source
    - existing document/file upload, storage keys, image or PDF handling
    - where staff would review values and where prefill would happen (screens, DTOs)
    - logger and redaction setup
    - test runner, HTTP mocking, e2e harness, DB setup in tests
B3. Done when INTEGRATION-REPORT.md answers every B2 bullet with evidence or "none found", and
    every plan default the host lacks is listed as "plan default adopted" for approval.

──────────────────────────────── PHASE C — DESIGN + PLAN ────────────────────────────────
Use these skills when the agent has them; otherwise follow the same discipline inline:
codebase-design (seam, depth, adapters), domain-modeling (glossary, ADR),
superpowers:brainstorming or grilling (to resolve open branches with the user),
superpowers:writing-plans (the task list).

C1. Write docs/idp/adr/NNNN-vlmrun-primary-textract-fallback.md in the host's ADR style (or
    the plan's style if the host has none): context (comparison.md recommended Textract-first),
    decision D15, consequences (BAA and Pro plan required before PHI; generative-output risk
    handled by the guard; checkbox accuracy measured by bake-off; Textract kept warm as fallback
    and kill switch), and the rollback (ENGINE_PRIMARY=textract).
C2. Write docs/idp/DESIGN.md with exactly these sections:
  1. Scope: REQUIREMENT, FIRST_FORMS, slices in scope.
  2. Concept map from A4.
  3. Module layout: host paths for the module, its public barrel, ports, adapters; plan path →
     host path for every file (copy the TEMPLATE MODULE's structure).
  4. Engine seam: the interface (one deep method, `extract(request) → result`, as the POC does,
     or the plan's 5-method SchemaEnginePort; choose one, with reasons). Adapters: vlmrun,
     textract, fake (tests only).
  5. Engine routing + fallback: the EngineRouter design below, adjusted to the host.
  6. Data model delta: plan 02 + shared-engine-adapter §7 EngineCall, the POC's additions
     (conversion, classification, field source/groupPath/rowIndex), plus the routing columns
     below. Express it in the host ORM and migration tool, as additive migrations.
  7. Env spec: the block below, in the host's config style, with boot-time validation rules.
  8. Forms: FIRST_FORMS, DSL v2 (groups, cues, otherFields, JSON forms), canonical keys mapped
     to host DTO fields for prefill.
  9. Input handling: accepted types (PDF, PNG, JPEG, TIFF, DOCX), conversion, page images,
     classification and the GENERIC fallback.
 10. Review + prefill integration points in the host (screens and services named in B2).
 11. Risks and UNVERIFIED items (VLM Run _metadata shape, bbox convention, page base, confidence
     bands, rate limits), each with the slice that verifies it.
 12. Open questions: who answers each one and what it blocks.
    Done when every section is filled and every host path in §3 resolves to the TEMPLATE
    MODULE's pattern.
C3. Write docs/idp/ADAPTATION.md per PLAN/09 Phase C (all 11 sections) and docs/idp/PLAN.md:
    the slices below broken into tasks of 2–5 minutes each, every task with its files, the test
    first, and its completion check. Create docs/idp/PROGRESS.md with one checkbox per task.

CHECKPOINT 1 (if CHECKPOINT = yes): STOP. Reply with: the module path, the template module, the
seam choice, the routing and fallback policy, the data model delta, new dependencies, and the
open questions. Wait for "approved" or corrections, and apply corrections before Phase D.

──────────────────────────────── ENGINE ROUTING + FALLBACK (reference for C2 §5) ────────────────────────────────
Env (names fixed, style per host config):
  ENGINE_PRIMARY=vlmrun                  # vlmrun | textract
  ENGINE_FALLBACK=textract               # textract | vlmrun | none
  ENGINE_FALLBACK_ON=error,timeout,unavailable      # optional extra trigger: quality
  ENGINE_FALLBACK_QUALITY_MAX_FLAGGED=0.30          # quality trigger: share of required fields
                                                    # that are null, ungrounded or low_confidence
  FORM_ENGINE_OVERRIDES={}               # per-form primary, e.g. {"GENERIC":"textract"}
  ENGINE_VLMRUN_ENABLED=true             # kill switch per engine
  ENGINE_TEXTRACT_ENABLED=true
  ENGINE_MAX_USD_PER_DOC=1.00            # budget guard across primary + fallback
  VLMRUN_API_KEY= (from the host's secrets source)  VLMRUN_BASE_URL  VLMRUN_MODEL (pinned)
  VLMRUN_DETAIL=hi  VLMRUN_POLL_MS  VLMRUN_TIMEOUT_MS  VLMRUN_CONFIDENCE_MAP  VLMRUN_BAA_CONFIRMED
  AWS_REGION (default credential chain, no keys)  TEXTRACT_MAX_ATTEMPTS
  PHI_MODE  DEFAULT_MIN_CONFIDENCE  CLASSIFY_OCR=none|textract  FORMS_DIR
Boot rules: an enabled engine must have its credentials and region; ENGINE_FALLBACK differs from
ENGINE_PRIMARY; both enabled or fallback = none; PHI_MODE=true requires VLMRUN_BAA_CONFIRMED=true
when vlmrun is enabled, and the AWS BAA + AI opt-out flags of plan 05 §12.

Routing per extraction (one document + form):
  primary  = FORM_ENGINE_OVERRIDES[form] ?? ENGINE_PRIMARY
  if primary is disabled (kill switch)     → run fallback, reason=unavailable
  run primary:
    success and quality ok                 → current result = primary
    success but quality fails, and 'quality' is in ENGINE_FALLBACK_ON
                                           → also run fallback, reason=quality; keep both;
                                             current = the one with fewer flagged required fields
    retryable error after retries / timeout → run fallback, reason=error|timeout
    non-retryable config error (401/403)    → run fallback, reason=error, and raise an alarm metric
  budget exceeded before the fallback       → no fallback, reason recorded as budget_skipped
  fallback = none                           → the extraction fails with the primary's error code
Per-run columns: engine, role (primary|fallback), fallbackOfId (the primary run's id),
fallbackReason, isCurrent. Exactly one current extraction per document+form.
Remap and reuse rules from plan 04 §1 apply per engine (requestHash includes the engine).
Field-level merge (taking single fields from the fallback) is out of scope for v1. Record it as
an open question.

──────────────────────────────── PHASE D — BUILD (slices) ────────────────────────────────
Execution skill when available: superpowers:subagent-driven-development or
superpowers:executing-plans, with superpowers:test-driven-development (or tdd) per task.
Pass every subagent the DESIGN.md, ADAPTATION.md and TEMPLATE MODULE paths, the task text, and
the HARD RULES.

Build each slice as a tracer bullet: thin, end to end, green, committed. Then widen it.
  S0  Module skeleton, config + boot rules, data model + migration, storage adapter over the
      host S3/storage service, upload + sha256 dedupe + magic bytes + page images.
  S1  Engine seam + VLM Run adapter (client, mapper, engine) + fake engine; JSON Schema builder;
      runner + rows + review flags (low_confidence, not_found, ungrounded, engine_fallback,
      unmapped); GET extraction. One form end to end through the fake engine and through
      recorded synthetic VLM Run fixtures.
      CHECKPOINT 2 (if CHECKPOINT = yes): show a synthetic upload → extraction response, then wait.
  S2  Textract adapter (planTextract, mapper, batching) + EngineRouter + fallback policy + kill
      switches + budget guard; routing columns; tests for every row of the routing table above.
  S3  Forms: FIRST_FORMS definitions with groups (CMS-1500 Box 24, UB-04 FL42–48, booking
      procedures), otherFields capture, GENERIC, JSON forms via FORMS_DIR; classifier;
      DOCX conversion; tests per form (classification, schema shape, rows).
  S4  Hallucination guard (shared-engine-adapter §6): ungrounded, plus an OCR cross-check when
      Textract text is available; the quality trigger; a compare endpoint or an admin view.
  S5  Queue mode in the host's job system (BullMQ if the host has none): jobs keyed by
      extraction id, UnrecoverableError for non-retryable errors, worker role; optional VLM Run
      webhook (HMAC, raw body, polling stays the source of truth).
  S6  Review + prefill insertion points in the host (from DESIGN §10), metrics (calls, cost,
      latency, fallback rate by reason), runbook (rotate key, vendor down → flip ENGINE_PRIMARY,
      re-record fixtures after a model change).
Per task: failing test first, confirmed red for the right reason; implement in host idioms;
task tests + typecheck + lint + affected suites green; commit in host style; tick PROGRESS.md.
A slice is done when its acceptance below passes with command output recorded in PROGRESS.md.

Slice acceptance:
  S1  synthetic PDF → VLM Run (fixture) → fields with value, confidence, page, bbox; privacy flags tested
  S2  every routing-table row has a passing test; ENGINE_PRIMARY=textract works with no code change;
      the kill switch moves traffic without a deploy
  S3  each of FIRST_FORMS is classified from a synthetic file and returns its rows; a DOCX works;
      an unknown document lands in GENERIC with otherFields
  S4  a value without a bbox is flagged; the quality trigger runs the fallback and records the reason
  S5  upload returns 202 and a worker completes the job; a redelivered job costs no vendor call
  S6  the host screen shows extracted values and applies them only after a human confirms

Manual and vendor steps (never run them yourself): record live synthetic fixtures, create the
VLM Run org and key, sign the BAA, AWS SSO setup. Add each to PROGRESS.md under "Manual steps
for a human" with the exact command or console path, linking PLAN/01a-aws-walkthrough.md,
PLAN_REPO/idp-engine-poc/docs/MANUAL-SETUP.md and vlm-run/implementation-plan.md V0.

STOP and ask when: a rule from HARD RULES or plan 00 §9.1 would break; the host lacks a pattern
and the plan default clashes with host style; a dependency outside ADAPTATION.md is needed; a
test fails twice for an unclear reason; the VLM Run response shape contradicts the mapper's
documented assumptions (update the mapper from the fixture, and note it in DESIGN §11).

──────────────────────────────── PHASE E — FINISH ────────────────────────────────
Run PLAN/09 Phase E (verification with output, self-review, PROGRESS and open questions, and
finishing-a-development-branch). Add to the self-review: privacy flags present, fallback reasons
recorded, no vendor body in logs or rows, kill switch tested.
Reply with: the branch, slices done with acceptance output, the current routing config,
manual steps waiting for a human, open questions, and the suggested next REQUIREMENT.
````

---

## Example runs

| Run | REQUIREMENT | Needs first |
|---|---|---|
| 1 | `Phases A–C only (design + plan, no code)` | nothing |
| 2 | `S0–S1: skeleton + VLM Run primary end to end (fake + synthetic fixtures)` | VLM Run Starter key for fixtures (synthetic) |
| 3 | `S2: Textract fallback + router + kill switches` | AWS dev track (01a) for fixtures |
| 4 | `S3–S4: CMS1500, UB04, BOOKING_SHEET, GENERIC + guard` | synthetic golden set (MANUAL-SETUP §0.1) |
| 5 | `S5–S6: queue, review/prefill insertion points, metrics, runbook` | host team answers on screens and DTOs |
| Go-live | `PHI_MODE=true` | VLM Run Pro + BAA, AWS BAA + AI opt-out, bake-off gates (comparison §6) |
