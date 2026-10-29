# Meibel — Research for Patient-Document Prefill

**Researched:** 2026-10-29, from public pages, docs and the AWS Marketplace listing only (no account, no API calls). Anything the sources don't state is marked **UNVERIFIED**. Confirm it with the vendor before you rely on it.
**Use case it is measured against:** staff upload patient documents (packets, faxes, cards, claims, intake forms). We store them, split them into forms, extract the fields, staff review them, and the patient, insurance and bundle screens are prefilled. Values are applied only by a human ([`idp-workflow.md`](../../../../idp-workflow.md)).

---

## 1. What it is

Meibel is an **AI agent and document-intelligence platform**. Document parsing and extraction are the first layer. On top of them sit **agents**, **datasources** (a vector/table store called "Recall"), **execution policies** ("Hardrails") and **confidence scoring**. The public case studies are RFPs, construction, technical writing and federal proposals. **None are healthcare.**

| Piece | What it does | Relevance |
|---|---|---|
| **Document parsing** `POST /v2/documents/parse` (sync, about 10 MB or less, or async) → `GET /documents/{job_id}/structured` | Layout elements in reading order (Title, SectionHeader, Table, Chart…), tables with cells and spans, element bboxes, OCR on scanned pages, orientation fix, 25+ formats (PDF, Office, images, EML, ZIP) | Gives us page structure + tables. **No key/value pairs or checkboxes documented** |
| **Deep transform** (preview) `POST /v2/documents/deep-transform` (async) | File (or a parsed doc) + **JSON Schema** + `root_name` + `guidance` → `output.json` + `provenance.json` (each value → source spans / page regions). Job metrics include an `aeq` extraction-quality score | **Core extraction API for us** |
| **Metadata models** | 7 built-in: insurance, legal, medical, manufacturing, construction, bibliography, custom (e.g. `policy_number`, `effective_date`) | Generic, not form-specific (no CMS-1500/UB-04 models) |
| **Confidence scoring** | 15 modules. 11 "judged" (LLM evaluator, 0–10 Likert: correctness, faithfulness, completeness…) and 4 "statistical" (0–1: Artifact Extraction Quality **per field**, Data Grounding, Observed Consistency, OCR Confidence). Runs as async background jobs | Rich, but mostly **output-level**. Per-field = AEQ only. API shape **UNVERIFIED** |
| **Agents / sessions / batch** | Versioned agent definitions, approval gates, batch executions with retry, SSE streaming | Not needed for prefill. Could serve "ask questions across a patient's documents" later |
| **Datasources / Recall / ingest** | Chunk + embed documents into a vector/table store | **Avoid for PHI** unless explicitly covered. It adds a second copy of PHI |
| **Hardrails** | Policy enforcement before model calls, retrieval and tools | Governance for agent use cases |

SDKs: **Python, TypeScript, Go, CLI**. REST base `https://api.meibel.ai/v2`, header `Meibel-API-Key`. OpenAPI spec at `docs.meibel.ai/api-v2.json`.

## 2. API details that matter

**Deep transform:**
- Submit: `POST /v2/documents/deep-transform`, multipart `file`, `schema` (JSON Schema), `root_name`, `guidance` (optional markdown), `max_pages` (optional).
- Alternative submit: `POST /documents/deep-transform/from-document` with a parse job id.
- Status: `GET /v2/documents/deep-transform/{job_id}`, which moves `queued → running → succeeded | failed`. The succeeded response includes `metrics`, `aeq` and `artifacts`.
- Download: `GET /v2/documents/deep-transform/{job_id}/artifact/{name}` for `output.json` and `provenance.json`.
- **Idempotent on (document, schema):** resubmitting returns the same job. That fits our `requestHash` reuse.
- Values for the same entity are **merged across pages**. That helps multi-page forms, but it hides which page a value came from unless provenance gives it.
- **UNVERIFIED:** the `provenance.json` format (span → page → bbox?), per-field confidence in the output, and any limits.

**Parse structured output:**
- Element `bbox` is in **pixels, top-left origin**. Normalize it with `page.image_size`.
- `page_bbox` is in **PDF points, bottom-left origin**.
- `page_number` is **0-based**.
- Element `confidence` is **layout-detection** confidence (0–1), **not** the correctness of the text.
- Page `ocr_score` tells whether OCR was needed. It is not a quality score.

**Rate limits:** Starter 6 req/s (pricing page). Other limits: see `api-reference/rate-limits.md` (**UNVERIFIED**).

## 3. Feature fit for our flow

| Flow step | Meibel capability | Fit |
|---|---|---|
| Capture | 25+ formats, scanned pages with OCR, orientation fix | Good |
| Classify + split a mixed packet | Not documented (images "can be classified"). An agent could do it | **Weak.** Our cue classifier and segmenter stay |
| Extract every field | Deep transform with our JSON Schema. Parse for tables/layout | Medium. **No native key/value or checkbox extraction documented.** Handwriting is claimed on the marketing page, but the formats doc does not list it |
| Confidence | Element layout confidence. Job-level `aeq`. Per-field AEQ via the scoring jobs | **Weak for field review.** No documented per-field confidence in the transform output |
| Provenance | Strong claims ("every value traces to page + region", citation graph, a review UI with bbox overlay) | Good in their app. File format **UNVERIFIED** |
| Checkboxes (CMS-1500/UB-04) | Not documented | **Gap.** Big for claim forms |
| Tables / line items | Strong table recovery (spans, headers) | Good |
| Review | Their own review UI (side-by-side, bbox overlays). Our review is in the host (D9) | Not used (it would duplicate the host UI) |
| Prefill | None | Our autofill/profiles stay |

## 4. Pricing (from meibel.ai/pricing, 2026-10-29)

| Plan | Price | Includes |
|---|---|---|
| Starter | $0 platform fee | $25 credits, 1 user/project, 3 agents, 250 MB Recall, 6 req/s, community support |
| Builder | contact sales | 5 users, 2 GB Recall, object-store connectors, 99.5% SLA |
| Growth | contact sales | SSO, 10 GB Recall, all integrations, lower rates |
| Enterprise | custom | unlimited, RBAC, Slack, 99.99% SLA |

**Usage rates:**
- Text page $0.008. **Advanced layout/OCR page $0.04.**
- **Field extracted $0.0015.**
- Agent action $0.01.
- AI query tokens $9 / 1M input, $35 / 1M output.
- Recall storage $2.50/GB-month. Ingestion $0.25 per 1M tokens.
- Third-party LLM usage at cost.

AWS Marketplace: SaaS private offers (12/24/36 months), metered at $0.01 units, "No Refunds".

**Estimates.** The **per-field fee dominates** for claim forms. **UNVERIFIED:** whether null fields are billed, and whether transform also bills tokens.

| Document | Fields | Calculation | Per page |
|---|---|---|---|
| CMS-1500 (≈ 80 header fields + 6 service lines × 14 columns ≈ 165 leaf fields) | 165 | $0.04 + 165 × $0.0015 | ≈ **$0.29** |
| Insurance card | ≈ 15 | $0.04 + 15 × $0.0015 | ≈ **$0.06** |
| UB-04 (≈ 120 header fields + 22 lines × 7 columns) | ≈ 274 | $0.04 + 274 × $0.0015 | ≈ **$0.45** |

**Monthly at 10,000 claim pages:** ≈ $2,900–$4,500. Compare Textract ≈ $700 and VLM Run ≈ $150–$550 usage (or $799 minimum for the BAA).

## 5. Security and compliance

| Item | Public claim | Source |
|---|---|---|
| SOC 2 | "SOC2 Compliant" badge (type and report not stated) | homepage, pricing |
| **HIPAA / BAA** | **Not mentioned anywhere public.** Search found no evidence | homepage, pricing, docs, web search |
| Deployment | **SaaS, Bring-Your-Own-Cloud** (control plane + data plane, data plane in your AWS/Azure account) and **on-premises**. Client-side processing is on the roadmap | document-intelligence page, AWS Marketplace, Azure blog |
| Data retention / training | **UNVERIFIED** (not in docs) | — |
| Audit | Immutable versioned agent definitions, audit trails, approval gates | homepage |
| Maturity | Deep transform is a **preview** feature (shapes may change). Document Intelligence launched in **May 2026** | docs, Business Wire |
| Healthcare references | **None found** | case studies |

## 6. Risks for PHI

1. **No public BAA or HIPAA statement.** This blocks any real PHI until there is a signed BAA, **or** a BYOC deployment inside our AWS account with a written statement that no PHI reaches the Meibel control plane, reviewed by compliance.
2. **Preview API.** Request/response shapes may change. Pin versions, add contract tests, keep fixtures.
3. **Weak field-level signals.** There is no documented per-field confidence and no checkboxes, so most fields would land in review. That weakens the prefill value.
4. **Cost at form scale.** The per-field pricing makes claim forms about 4× Textract.
5. **Extra PHI copies** if datasources/ingest/Recall are used. Our adapter must use only parse/transform and delete remote documents afterwards. **UNVERIFIED:** that a delete endpoint exists for parsed documents and transform jobs.
6. **Cross-page merging** in deep transform can blur which page a value came from, so provenance must give the page per value.

## 7. Verdict for our use case

**Not the right primary engine for form prefill today.** Its strengths are layout/tables, corpus-level provenance, governed agents and BYOC deployment. Our problem needs checkbox-accurate, per-field-confident extraction from fixed healthcare forms, plus a BAA. Meibel's public material shows gaps in exactly those areas, and costs more per claim page.

**Keep it as an option** for a later phase if both hold:
- (a) the BAA is confirmed or BYOC is approved, and
- (b) the product wants **document Q&A / agents across a patient's documents** (e.g. "summarize prior authorizations"), where Meibel's datasources, agents and Hardrails fit better than a pure extraction API.

The implementation plan is written so it can be built behind the same adapter at low risk if those conditions are met.

## 8. Questions to send Meibel before any pilot

1. Will you sign a HIPAA BAA? For which deployment models (SaaS, BYOC, on-prem)? Which subprocessors and LLM providers touch document content?
2. In BYOC on AWS, what data, metadata or logs go to your control plane? Can the control plane run with no document content at all?
3. SOC 2 type (I or II), report date, and whether we can get it under NDA.
4. Retention and deletion: how do we delete parsed documents, transform jobs and artifacts? Is anything used for training?
5. The `provenance.json` format: page number and bbox per value? Per-field confidence on transform output?
6. Checkbox / selection-mark extraction and key/value form extraction: supported? On the roadmap?
7. Billing: are null or empty fields charged? Does transform also bill tokens? Volume pricing for 10k–100k pages/month.
8. When will deep transform reach GA, and what is the versioning and deprecation policy?

## Sources

- [meibel.ai](https://www.meibel.ai/) · [Pricing](https://www.meibel.ai/pricing) · [Document Intelligence](https://www.meibel.ai/document-intelligence)
- [Docs](https://docs.meibel.ai/) · [Docs index](https://docs.meibel.ai/llms.txt) · [Authentication](https://docs.meibel.ai/api-reference/authentication.md)
- [Deep transform](https://docs.meibel.ai/guides/deep-transform.md) · [Parse output schema](https://docs.meibel.ai/document-parsing/reference/output-schema.md) · [Formats and capabilities](https://docs.meibel.ai/document-parsing/reference/formats-and-capabilities.md) · [Confidence scoring](https://docs.meibel.ai/concepts/confidence-scoring.md)
- [AWS Marketplace listing](https://aws.amazon.com/marketplace/pp/prodview-7ejtvwlqp7j42) · [Azure Marketplace post](https://www.meibel.ai/post/meibel-is-now-on-the-azure-marketplace) · [Launch announcement (Business Wire)](https://www.businesswire.com/news/home/20260514849907/en/Meibel-Launches-Document-Intelligence-The-Grounding-Layer-That-Turns-Complex-Enterprise-Documents-Into-Trusted-Structured-Knowledge)
