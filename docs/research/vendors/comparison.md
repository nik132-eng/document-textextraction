# Engine Comparison — Amazon Textract vs VLM Run vs Meibel

**For:** choosing how patient documents uploaded by staff get read, so that the patient, insurance and bundle screens can be prefilled, with a human applying every value.
**Date:** 2026-10-29; pricing in §3 re-checked on the vendor sites **2026-11-02** for **2,000 claim pages/month**. Figures come from public pricing and docs ([VLM Run research](vlm-run/research.md), [Meibel research](meibel/research.md), plan `04` §9 for Textract). Costs are **estimates** until measured with real (synthetic) calls.

## 1. Bottom line

1. **Keep Textract as the default engine.** It is deterministic OCR with native checkboxes, numeric per-word confidence and geometry. It is already covered by the AWS BAA, the data never leaves our account, and the plan is built around it.
2. **Add VLM Run second**, behind the shared adapter. Use it first as an **overlay** for handwritten or faxed low-confidence fields. Then make it the **primary engine for variable layouts** (booking sheets, intake, referrals) wherever the bake-off shows it wins. It needs the **Pro plan ($799/mo) for the BAA**.
   **Cost at 2,000 claim pages/month (§3.3):** Textract ≈ $170; VLM Run ≈ $799, set by the Pro minimum that a BAA requires, with only $11–62 of actual usage; VLM Run primary + Textract fallback (D15, prompt `10`) ≈ $808–833. VLM Run becomes the cheaper option only above ≈ 9,400 pages/month.
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

## 3. Cost: detailed, at **2,000 claim pages per month**

Prices are list prices from each vendor's pricing page, read on **2026-11-02** (links in Sources). The Textract page quotes US West (Oregon) in its examples; confirm your region in the AWS Pricing Calculator. Everything marked *estimate* depends on an assumption stated next to it. Replace it with measured numbers after the synthetic bake-off (§6).

### 3.1 Unit prices (official)

| Vendor | Item | Price |
|---|---|---|
| **Textract** | AnalyzeDocument Forms / Tables / Queries | $0.05 / $0.015 / $0.015 per page |
| | Bundle Forms + Tables + Queries | **$0.070** per page |
| | Tables + Queries | $0.020 per page |
| | DetectDocumentText (classification OCR) | $0.0015 per page |
| | Free tier (new accounts, 3 months) | 100 pages/month of F+T+Q, 1,000 pages/month Detect |
| **VLM Run** | Starter / **Pro** / Enterprise | $0 (10 req/min, no BAA) / **$799/mo incl. $1,000 usage, 100 req/min, BAA + ZDR** / custom (in-VPC, HIPAA) |
| | Extraction (Doc → JSON) | token-billed: orion-2 fast/auto **$0.30 in / $2.50 out** per 1M tokens; `:pro` $1.00 / $10.00; cached input 10% |
| | Grounding + confidence | $0.001 per page |
| | OCR + layout (separate tool, if used) | $0.01 per page (fast), $0.04 (pro) |
| | Service tier | Flex 0.5× (backfills) · Standard 1.0× · Priority 1.8× |
| **Meibel** | Starter / Builder / Growth / Enterprise | $0 with $25 credits, 6 req/s / contact sales / contact sales / custom |
| | Deep transformation | **$0.008 per page + $0.0015 per field extracted** |
| | Advanced layout + OCR | $0.04 per page |
| | Confidence scores | $0.01 per action |
| | BAA / HIPAA | **not mentioned** on the pricing page |

### 3.2 Per page, for our claim forms

**Textract.** This is the call plan built in the POC (`planTextract`). CMS-1500 and UB-04 each need **24 / 18 queries**, which is more than the 15-per-call limit, so every page costs **one F+T+Q call plus one extra QUERIES call**.

| | CMS-1500 | UB-04 |
|---|---|---|
| F+T+Q ($0.070) + 2nd query batch ($0.015) | $0.085 | $0.085 |
| + classification OCR for scans ($0.0015) | $0.0865 | $0.0865 |
| Optimised: move queries to key aliases (≤15 queries, one call) | $0.0715 | $0.0715 |

**VLM Run.** Billing is per token, and VLM Run publishes no tokens-per-page figure for documents. The ranges below are *estimates* (orion-2 auto, standard tier, grounding on):

| Case | Assumption per page | Per page |
|---|---|---|
| Low | 6k input + 1k output tokens (VLM Run's own worked example) + $0.001 grounding | ≈ **$0.005** |
| Mid | 6k input + 4k output (grounded JSON for ~60 filled values + rows) + grounding | ≈ **$0.013** |
| High | 8k input + 7k output + grounding + OCR/layout $0.01 | ≈ **$0.031** |
| `:pro` model, mid tokens | | ≈ $0.047 |

VLM Run's worked example lists 6,000 + 1,000 tokens at $0.002, but the posted rates give $0.0043 for those tokens. We use the posted rates.

**Meibel.** Cost depends on whether **every schema field is billed or only filled ones**, which is still UNVERIFIED (research §8 Q7). Field counts below come from the POC definitions: CMS-1500 = 41 header fields + 6 × 10 Box 24 cells; UB-04 = 35 + 22 × 7 revenue cells.

| Case | CMS-1500 | UB-04 |
|---|---|---|
| Only filled fields billed (≈61 CMS: 41 + 2 lines; ≈56 UB: 35 + 3 lines) | 0.008 + 61 × 0.0015 = **$0.100** | 0.008 + 56 × 0.0015 = **$0.092** |
| Every schema leaf billed (101 CMS / 189 UB) | **$0.160** | **$0.292** |
| + advanced layout/OCR for scans | +$0.04 | +$0.04 |

### 3.3 Monthly at 2,000 claim pages (1,000 CMS-1500 + 1,000 UB-04)

| Engine setup | Usage | Fixed / minimum | **Monthly total** | Effective per page |
|---|---|---|---|---|
| **Textract only** (as built in the POC) | 2,000 × $0.085 = $170 (+ $3 classification OCR) | $0 (AWS BAA, no plan fee) | **≈ $170–173** | $0.085 |
| Textract only, optimised to one call per page | 2,000 × $0.0715 | $0 | **≈ $143** | $0.072 |
| **VLM Run only**, Starter (synthetic data only, no BAA) | $11 / $26 / $62 (low / mid / high) | $0 | $11–62 | $0.005–0.031 |
| **VLM Run only**, Pro (**required for PHI**) | $11–62, inside the $1,000 included | **$799** | **$799** | **$0.40** |
| **D15: VLM Run primary + Textract fallback** (prompt `10`) | VLM $11–62 (included) + Textract on 5% / 20% of pages = $8.50 / $34 | $799 | **≈ $808–833** | $0.40–0.42 |
| Textract primary + VLM Run overlay on flagged pages (original plan M1) | Textract $170 + VLM Run on ~20% of pages ≈ $3–12 (included) | $799 if the overlay touches PHI | **≈ $970** (or $170 without the overlay) | $0.49 |
| **Meibel only** | filled-only $192 · every-leaf $451 · +$80 OCR on scans | contract, BAA unknown | **≈ $192–531** | $0.10–0.27 |

### 3.4 What this means at 2,000 pages

1. **Textract is about 4.7× cheaper than VLM Run at this volume** ($170 vs $799). The difference is entirely VLM Run's **$799 Pro minimum, which a BAA requires**. VLM Run's real usage at 2,000 pages is only about $11–62.
2. **Break-even with Textract is about 9,400 claim pages/month** ($799 ÷ $0.085). Above that, VLM Run Pro is cheaper. Its $1,000 included usage lasts to roughly 75,000 pages/month at the mid estimate.
3. **D15 (VLM Run primary) costs about $640/month more than Textract-only** at this volume. It only pays off if the bake-off shows it saves review time: fewer fields flagged, and more accurate rows and handwriting. At $640/month, that means saving about 35 staff-minutes per working day at ~$50/h. Measure it before go-live.
4. **The Textract fallback is cheap insurance** under D15: $8–34/month at a 5–20% fallback rate, with no extra fixed fee.
5. **Meibel is within range on usage, but blocked** (no BAA). Its cost swings 2.5× on a billing question (filled vs all fields) that only the vendor can answer.
6. **Ways to cut cost:**
   - Textract: shrink the query count so each claim page needs one call (−16%).
   - VLM Run: use the Flex tier (0.5×) for backfills, and keep the `fast`/`auto` model, which is 3–4× cheaper than `:pro`.
   - Textract classification OCR: run it only on scans; PDFs with a text layer need none.

**Measure before deciding.** Record 10–20 synthetic pages per form and engine. For VLM Run, sum `usage.cost_dollars`; for Textract, use the POC's `estCostUsd` and the AWS bill; for Meibel, use its usage page. Then replace the *estimate* rows above.

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

Pricing (read 2026-11-02): [Amazon Textract pricing](https://aws.amazon.com/textract/pricing/) · [VLM Run pricing](https://vlm.run/pricing) · [VLM Run billing docs](https://docs.vlm.run/pricing) · [Meibel pricing](https://www.meibel.ai/pricing).
See also the Sources sections of [vlm-run/research.md](vlm-run/research.md) and [meibel/research.md](meibel/research.md). Textract figures are from plan `04` §9 and [`idp-workflow.md`](../../../idp-workflow.md) §9.
