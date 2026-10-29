# Engine Comparison — Amazon Textract vs VLM Run vs Meibel

**For:** choosing how patient documents uploaded by staff get read, so that the patient, insurance and bundle screens can be prefilled, with a human applying every value.
**Date:** 2026-10-29. Figures come from public pricing and docs ([VLM Run research](vlm-run/research.md), [Meibel research](meibel/research.md), plan `04` §9 for Textract). Costs are **estimates** until measured with real (synthetic) calls.

## 1. Bottom line

1. **Keep Textract as the default engine.** It is deterministic OCR with native checkboxes, numeric per-word confidence and geometry. It is already covered by the AWS BAA, the data never leaves our account, and the plan is built around it.
2. **Add VLM Run second**, behind the shared adapter. Use it first as an **overlay** for handwritten or faxed low-confidence fields. Then make it the **primary engine for variable layouts** (booking sheets, intake, referrals) wherever the bake-off shows it wins. It needs the **Pro plan ($799/mo) for the BAA**.
3. **Park Meibel** for form prefill. It has no public BAA/HIPAA statement, no documented checkboxes or per-field confidence, a deep-transform API still in preview, and per-field pricing that makes claim forms about 4× Textract. Revisit it if the BAA or BYOC is confirmed **and** the product wants agents or Q&A across a patient's documents. That is where Meibel is strongest.

## 2. Side by side

| Dimension | Amazon Textract | VLM Run | Meibel |
|---|---|---|---|
| **Kind of engine** | OCR + form/table/query models (evidence-first) | Vision-language model, schema-first JSON | Parsing + LLM transform + agents platform |
| **Who finds the fields** | Our resolvers, using definitions (keys, regions, grids) | The model, from our JSON Schema | The model, from our JSON Schema |
| **Checkboxes** | **Native** SELECTION_ELEMENT (selected / not) | Booleans via schema (claimed) | **Not documented** |
| **Handwriting** | Yes (word `TextType`) | Yes (marketing + healthcare page) | Claimed on marketing. Not in the formats doc |
| **Tables / line items** | TABLES feature + our grid resolver | Arrays via schema | Strong table parse (spans, headers) |
| **Per-field confidence** | **Numeric 0–100 per word/KV** | Doc → JSON: **band** high/med/low. System One: numeric + `p_null` | Element layout confidence. Job-level `aeq`. Per-field AEQ via scoring jobs (API **UNVERIFIED**) |
| **Location (page + bbox)** | Every block | `_metadata.bboxes` per field (`xywh` normalized + page) | Element bboxes (parse). `provenance.json` spans (transform, format **UNVERIFIED**) |
| **Hallucination risk** | Very low (reads what is printed) | **Present** (generative). Mitigated by grounding + OCR cross-check | **Present** (generative). Same mitigation |
| **Unknown layouts ("extract everything")** | **Yes.** Every KV/table/line (our GENERIC) | Needs a schema (or a generic KV schema) | Parse gives structure. Transform needs a schema |
| **Packet split / classify** | Ours (cue scoring on `DetectDocumentText`) | System One choice per page + calibrated probabilities. "Packet triage" agent | Not documented |
| **Prebuilt healthcare** | AnalyzeID, AnalyzeExpense (generic) | **Insurance card, intake, referral, medical history, HIPAA release, US DL/passport, invoice** domains. CMS-1500/UB-04 via custom schema | Generic "medical" and "insurance" metadata models |
| **HIPAA / BAA** | **Yes** (AWS BAA, HIPAA-eligible) | **BAA on Pro/Enterprise.** SOC 2 Type II. HIPAA-ready | **Not stated publicly.** SOC 2 badge only |
| **Data location** | Stays in our AWS account and region | Leaves AWS (SaaS). **In-VPC on Enterprise** | SaaS, **BYOC (AWS/Azure)**, on-prem |
| **Training / retention** | AI opt-out policy (`01` §2) | ZDR on Pro+. **Must send `allow_training/logging/retention=false`** (defaults are true) | **UNVERIFIED** |
| **Node/NestJS fit** | AWS SDK v3 | Node SDK `vlmrun`, REST, webhooks (HMAC) | TypeScript SDK, REST, async jobs |
| **Async model** | Sync per page (our choice). Async optional | `batch=true` + poll / webhook (2 attempts) | Async jobs + poll. SSE trace |
| **Rate limits** | Account TPS quota (raise via Service Quotas) | 240/min key (gateway). Plan limits 10 (Starter) / 100 (Pro) req/min | 6 req/s Starter |
| **Maturity** | GA for years | Gateway **beta** | Deep transform **preview**. Document Intelligence launched May 2026 |
| **Lock-in** | Low (Evidence model) | Low (plain JSON Schema) | Low via adapter. High if datasources/agents are adopted |

## 3. Cost per page (estimates, list prices)

| Document | Textract | VLM Run | Meibel |
|---|---|---|---|
| CMS-1500 page (FORMS+TABLES+QUERIES / schema ≈165 fields) | ≈ **$0.07** | ≈ **$0.015–$0.055** (tokens + $0.001 grounding) | ≈ **$0.29** ($0.04 page + 165 × $0.0015) |
| Insurance card (≈15 fields) | ≈ $0.07 (or $0.05 without TABLES) | ≈ $0.005–$0.02 | ≈ $0.06 |
| UB-04 page (≈274 fields) | ≈ $0.07 | ≈ $0.02–$0.08 | ≈ $0.45 |
| Classification per page | $0.0015 (DetectDocumentText) | System One, token-billed (low detail ≈ 70 vision tokens) | n/a |
| **Fixed monthly to process PHI** | $0 | **$799 (Pro, includes $1,000 usage)** | Contract (private offer). BAA unknown |
| **10k claim pages / month** | ≈ $700 | ≈ $799 (minimum dominates) | ≈ $2,900–$4,500 |

Measure real numbers by recording 10–20 synthetic pages per engine and summing `usage.cost_dollars` (VLM Run) or the invoice (Meibel).

## 4. Fit with our flow (upload → store → classify/split → extract → review → prefill → apply)

| Step | Textract | VLM Run | Meibel |
|---|---|---|---|
| Upload + store (S3, dedupe, page images) | ours | ours (a vendor-side copy, deleted after) | ours (a vendor-side copy. Delete API **UNVERIFIED**) |
| Classify + split | ours (cues) | ours. Optional M3 fallback via System One | ours |
| Extract | **primary** | overlay (M1) → primary for variable layouts (M2) | optional M2/M1 for forms without checkboxes, after the gate |
| Normalize + validate | ours (D7) | ours (we ask for raw text) | ours |
| Review UI | host (D9) | host. Plus `ungrounded`/`ocr_mismatch`/`overlay_suggested` flags | host |
| Prefill + apply events | ours | ours | ours |

All three plug in through the **engine-neutral Evidence model** (D4) and the **shared adapter** ([shared-engine-adapter.md](shared-engine-adapter.md)), so forms, review, autofill, profiles and the REST API do not change.

## 5. When to pick what (per form)

| Form | Recommended engine | Why |
|---|---|---|
| CMS-1500, UB-04 | **Textract** (+ VLM Run overlay for weak fields) | Checkbox-heavy fixed layouts. Deterministic. Already planned |
| Insurance card | Textract queries **or** VLM Run `healthcare.medical-insurance-card`, decided by bake-off | Small; both are cheap |
| US driver license / passport | Textract AnalyzeID | Purpose-built, with normalized dates |
| Booking sheet (many layouts, handwriting) | **VLM Run (M2)**, if it wins the bake-off | Schema-first handles layout variety without region tuning |
| Patient intake / referral / medical history | **VLM Run (M2)** with its healthcare domains or our schema | Prebuilt domains. Variable layouts |
| Invoice | Textract AnalyzeExpense | Purpose-built |
| Unknown (GENERIC) | **Textract** | Only engine that captures every KV without a schema |
| Document Q&A across a patient's documents (future) | Meibel (after BAA/BYOC) | Agents + datasources + Hardrails |

## 6. Decision gates (no engine goes live without these)

1. Signed **BAA** (or an approved in-VPC/BYOC deployment) for that vendor, recorded under `docs/compliance/`.
2. **Bake-off** on the golden set (shared §8): accepted-but-wrong ≤ 1% on critical fields, ungrounded + mismatch ≤ 2%, review rate within 5 points of Textract.
3. **Kill switch tested:** flags off → Textract behaviour unchanged.
4. ADR written per form.

## Sources

See the Sources sections of [vlm-run/research.md](vlm-run/research.md) and [meibel/research.md](meibel/research.md). Textract figures are from plan `04` §9 and [`idp-workflow.md`](../../../idp-workflow.md) §9.
