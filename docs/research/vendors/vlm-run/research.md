# VLM Run — Research for Patient-Document Prefill

**Researched:** 2026-10-29, from public pages and docs only (no account, no API calls). Anything the docs don't state is marked **UNVERIFIED**. Confirm it with a recorded fixture or with the vendor before you rely on it.
**Use case it is measured against:** staff upload patient documents (packets, faxes, cards, claims, intake forms). We store them, split them into forms, extract the fields, staff review them, and the patient, insurance and bundle screens are prefilled. Values are applied only by a human ([`idp-workflow.md`](../../../../idp-workflow.md)).

---

## 1. What it is

VLM Run is a "visual intelligence" API for documents, images and video. The pieces that matter for us:

| Piece | What it does | Relevance |
|---|---|---|
| **Doc → JSON** `POST /v1/document/generate` | File plus `domain` (a prebuilt schema) or a custom `json_schema` → typed JSON. Optional per-field **grounding** (bbox + page) and **confidence** | **Core extraction API for us** |
| **Domains / Hub** | Prebuilt schemas. Open source `vlmrun-hub` (Apache-2.0, Pydantic) has `healthcare.medical-insurance-card`, `healthcare.hipaa-release`, `document.us-drivers-license`, `document.us-passport`, `document.invoice`, and more. The docs also name `healthcare.patient-intake`, `healthcare.patient-referral` and `healthcare.medical-history` (dashboard hub) | Insurance card, ID and intake are ready-made |
| **System One** `POST gateway.vlm.run/typesafe/v1/systemone` | Typed "questions" (text/date/number/list/choice/noul/box) → answers with numeric `confidence` and `p_null` (probability the field is absent) | Best confidence signal. Good for classification and overlay |
| **Orion agent** `client.agent.execute` | Agentic reasoning over files. Healthcare page: "packet triage" classifies each page and reconciles into one record | Demo-friendly, but less deterministic. Not for the core pipeline |
| **Gateway** | One API key for many models (their own `orion-2`/`vlm-1`, open-weight models, plus third-party Claude/GPT/Gemini/Grok). OpenAI-compatible. MCP server | **Risk:** third-party routing is a PHI-scope question (§6) |
| **Files** `POST /v1/files`, `DELETE /v1/files/{id}` | Upload once, reuse by `file_id`, delete after | Lets us remove vendor-side copies |
| **Predictions** `GET /v1/predictions/{id}` | Status and result of async jobs | Polling |
| **Webhooks** | `callback_url` per request. HMAC-SHA256 `X-VLMRun-Signature: sha256=<hex>` over the raw body. **Only 2 attempts**, 30 s timeout | Optional speed-up, never the only path |
| **Redaction** | PII/PHI redaction guide | Possible future use for exports |

SDKs: **Python** (`vlmrun`) and **Node** (`vlmrun` on npm; `client.document`, `client.files`, `client.predictions`). There is also a CLI and the MCP server.

## 2. API details that matter

**Doc → JSON request** (`Authorization: Bearer <VLMRUN_API_KEY>`):

| Field | Use for us |
|---|---|
| `file_id` or `url` | `file_id` after upload. **Never** a public URL for PHI |
| `domain` | e.g. `healthcare.medical-insurance-card`. Omit it when sending `config.json_schema` |
| `model` | `vlm-1` (default), `vlm-1:fast`, `vlm-1:pro`, `vlm-1:auto`. **Pin it.** |
| `batch` | default `true` = async. Keep it true and poll |
| `callback_url` | optional webhook |
| `metadata.allow_logging` / `allow_training` / `allow_retention` | **all default `true`, so we must send `false`** for PHI |
| `metadata.environment` | `dev` / `staging` / `prod` |
| `config.json_schema` | our schema from the form definition (shared §4) |
| `config.grounding` | `true` → each field gets `_metadata.bboxes[]` with `{ content, xywh (normalized), page }` |
| `config.confidence` | `true` → per-field band `high` / `medium` / `low` |
| `config.page_indices` | 0-based pages. Restrict to the segment's pages |
| `config.detail` | `auto` / `hi` / `lo`. Use `hi` for dense claim forms |
| `config.temperature` | default `0`. Keep it |
| `config.service_tier` | `flex` (0.5×, slower) for batch backfills, `priority` (1.8×) for interactive |
| `config.use_context_cache` | default `true`. Cheaper repeated calls on the same file |

**Response:** `{ id, status: pending|enqueued|running|completed|failed|paused, response, domain, fallback, usage: { elements_processed, credits_used, cost_dollars, standard_cost_dollars, duration_seconds, ... } }`.
- `fallback: true` means a fallback model produced the JSON. Store it and flag it.
- `usage.cost_dollars` gives the **actual** cost per call, which goes in `EngineCall.costUsd`.

**System One answers:** `{ answers: { <id>: { value, confidence (0..1), p_null (0..1) } } }`. Choice questions also return `probabilities` per label. Up to 16 PDF pages per call. `document_dpi` 72–400.

**Rate limits (Gateway FAQ):** 240 req/min and 10,000 req/hr with an API key. `429` includes `Retry-After`. Pricing page plans: Starter 10 req/min, Pro 100 req/min. **UNVERIFIED** which limit applies to `/v1/document/generate`.

## 3. Feature fit for our flow

| Flow step | VLM Run capability | Fit |
|---|---|---|
| Capture (PDF/JPG/PNG/TIFF, faxes, phone photos) | Handles faxes, rotated and skewed scans, and handwriting (marketing claims) | Good. Supported-files list: see the docs `supported-files.md` (**UNVERIFIED** for TIFF/HEIC) |
| Classify + split a mixed packet | System One `choice` per page with calibrated probabilities. The Orion "packet triage" claim | **Partial.** Per-page classification is documented. Grouping pages into documents is ours (our segmenter keeps working) |
| Extract every field | Custom JSON Schema or domains. Checkboxes as booleans. Medication lists as rows | Good for known forms. "Every visible field" (our GENERIC capture) needs a schema, so unknown layouts still need Textract or a generic KV schema |
| Confidence | Doc → JSON: **band** (high/medium/low). System One: **numeric** + `p_null` | Usable. The band is coarse, so map it and calibrate it with the eval |
| Provenance (page + bbox) | `_metadata.bboxes[{content, xywh, page}]` per field | Good. Bbox format **UNVERIFIED** (whether `xywh` is top-left or center). Verify with a fixture |
| Checkboxes (CMS-1500 boxes 1, 3, 6, 10a–c…) | "Checkboxes become booleans" | Good on paper. Measure against Textract's native SELECTION_ELEMENT |
| Tables / line items (Box 24, FL42–48) | Arrays of objects via schema | Good. Watch row alignment on 6/22-row grids |
| Review | Dashboard only. Our review UI is in the host | We keep our own review (D9) |
| Prefill | None (it's an extraction API) | Our autofill/profiles stay |
| Re-run without paying | No. We store the raw response ourselves (shared §7) | Same as Textract |

**Healthcare forms claimed on the healthcare page:** intake, medical history, referrals, faxed packets, insurance cards, EOBs, **CMS-1500 and UB-04**, lab reports. There is no public hub domain for CMS-1500 or UB-04, so use a custom `json_schema` generated from our definitions.

## 4. Pricing (from vlm.run/pricing, 2026-10-29)

| Plan | Price | Includes | Compliance |
|---|---|---|---|
| Starter | $0 | $10 trial balance, 10 req/min | **No BAA, so synthetic only** |
| **Pro** | **$799 / month** | $1,000 usage included, 100 req/min, Slack support | **BAA, Zero Data Retention (ZDR)** |
| Enterprise | custom | volume discounts, custom SLA | **In-VPC deployment**, ZDR, SOC 2, HIPAA, BAA |

**Unit prices:**
- Documents: OCR + layout $0.01 (fast) / $0.04 (pro) per page. Grounding surcharge **$0.001/page**. Parse/extract is billed by tokens.
- Tokens per 1M: `orion-2` (fast/auto) $0.30 in / $2.50 out; `orion-2:pro` $1.00 / $10.00. Cached input is 10%.
- Tiers: Flex 0.5×, Priority 1.8×.

**Estimate for one CMS-1500 page.** These are assumptions: hi-detail image plus schema ≈ 5k input tokens, grounded JSON output ≈ 5k tokens.
- `orion-2` rates: ≈ $0.0015 + $0.0125 + $0.001 grounding ≈ **$0.015/page**, plus the layout charge if used.
- `:pro` rates: ≈ $0.055/page.
- Measure the real figure with `usage.cost_dollars` on 10–20 synthetic pages. **UNVERIFIED:** which token rate `vlm-1` bills at.

**Monthly at 10,000 pages:**
- Usage ≈ $150–$550.
- The Pro minimum ($799, which includes $1,000 of usage) dominates until about 50–60k pages/month.
- Compare: Textract AnalyzeDocument FORMS+TABLES+QUERIES ≈ $0.07/page ≈ $700/month at that volume (`04` §9).

## 5. Security and compliance

| Item | Public claim | Source |
|---|---|---|
| SOC 2 Type II | Yes | homepage, healthcare page |
| HIPAA | "HIPAA-ready", "HIPAA-compliant infrastructure" | homepage, healthcare page, intake guide |
| **BAA** | **Pro and Enterprise only** | pricing, healthcare page |
| Zero data retention | Pro and Enterprise. Scope **UNVERIFIED** (do uploaded files under `/v1/files` count?) | pricing |
| Training on data | Gateway FAQ: "does not store your inputs or outputs, and it does not train on them". But `metadata.allow_training` defaults to `true` on Doc → JSON | FAQ, API ref |
| Deployment | SaaS. **In-VPC / private cloud on Enterprise.** No on-prem | homepage, pricing |
| GDPR | Yes | healthcare page |
| Trust center | trust.vlm.run (content not readable without JS). Subprocessors **UNVERIFIED** | — |
| Maturity | Gateway marked **beta** ("limits and catalog can change") | FAQ |

## 6. Risks for PHI

1. **Data leaves AWS.** The AWS BAA does not cover VLM Run. You need VLM Run's own BAA (Pro or above) before any real document. The alternative is Enterprise in-VPC.
2. **Third-party model routing.** The gateway can call Claude, GPT, Gemini, Grok and others. Get written confirmation that the BAA covers the models used by `/v1/document/generate`, or pin to VLM Run's own models (`vlm-1`/`orion-2`) and never pass a third-party model id.
3. **Unsafe defaults.** `allow_logging`, `allow_training` and `allow_retention` all default to `true`. Our client must always send `false` (enforced in code + a unit test).
4. **Generative output.** A value can be fluent but absent from the page. Mitigation: grounding is required and the OCR cross-check runs (shared §6).
5. **Webhook delivery is best effort** (2 attempts). Polling is the source of truth.
6. **Docs inconsistencies.** The intake guide's examples contain code errors and invalid JSON (noted during research), and the `_metadata` placement is not fully specified. Record fixtures before writing the parser.
7. **Vendor lock-in is low.** Our schemas are plain JSON Schema generated from our definitions, so switching costs one adapter.

## 7. Verdict for our use case

**Strong second engine.** It can be used for PHI on Pro once the BAA is signed. It is schema-first with per-field grounding and confidence, ships prebuilt healthcare domains (insurance card, intake, referral), has a Node SDK that fits NestJS, and costs less per page than Textract at volume. It does **not** replace our pipeline: GENERIC capture, cue classification, segmentation, review, autofill and apply events stay ours. Start with **M1 overlay** on handwritten/fax fields and **M2** for booking sheets and intake forms, then decide by bake-off ([shared §8](../shared-engine-adapter.md)).

## 8. Questions to send VLM Run before signing

1. Does the BAA cover `/v1/document/generate` with `json_schema`, `/v1/files`, predictions storage, and webhooks? Which underlying models and subprocessors handle that traffic?
2. What does ZDR cover: uploaded files, prediction results, logs? How long do results stay before they are deleted, with and without ZDR?
3. Exact `_metadata` shape: is `xywh` normalized top-left? Is `page` 0-based? Is grounding per leaf or per object? Are array rows grounded?
4. Can `confidence` be numeric on Doc → JSON (as System One provides)? Is it calibrated?
5. Rate limits for Doc → JSON on Pro. Max pages and file size per request. TIFF support.
6. Region and hosting location (US-only?). Is a US-only data residency commitment available?
7. Model version pinning and a deprecation notice period.

## Sources

- [vlm.run](https://vlm.run/) · [Pricing](https://vlm.run/pricing) · [Healthcare](https://vlm.run/solutions/healthcare) · [Trust center](https://trust.vlm.run/)
- [Docs index](https://docs.vlm.run/llms.txt) · [Doc → JSON API](https://docs.vlm.run/api-reference/v1/post-document-generate.md) · [Intake forms guide](https://docs.vlm.run/guides/doc-ai/guide-healthcare-parsing-intake-forms.md)
- [System One field extraction](https://docs.vlm.run/gateway/guides/systemone-field-extraction.md) · [Document classification](https://docs.vlm.run/gateway/guides/document-classification.md) · [Webhooks](https://docs.vlm.run/webhooks.md) · [Gateway FAQ](https://docs.vlm.run/gateway/faq.md)
- [vlmrun-hub (GitHub)](https://github.com/vlm-run/vlmrun-hub) · [Hub catalog](https://raw.githubusercontent.com/vlm-run/vlmrun-hub/main/vlmrun/hub/catalog.yaml)
