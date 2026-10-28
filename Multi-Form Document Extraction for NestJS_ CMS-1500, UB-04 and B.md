# Multi-Form Document Extraction for NestJS (HCFA/CMS-1500, UB-04, Booking Sheets): Architecture, Tools and Storage

The best minimal-dependency approach is to skip template OCR entirely: send each page image from NestJS to a BAA-covered vision-language model with a per-form JSON Schema, validate the result with Zod, and store both the raw JSON and a flattened, canonical field table in PostgreSQL. Run a self-hosted Chandra OCR 2 microservice only if you cannot send PHI to a cloud provider. No open-source "drop-in HCFA/UB-04 to JSON" engine exists that is mature enough to bet a billing platform on; the pieces that work are a VLM with a schema, an AWS-native extractor as a checkbox cross-check, and your own form dictionaries.

## TL;DR
- **Recommended path:** NestJS → S3 → BullMQ job → page images → Gemini on Vertex AI (or Claude on Bedrock) with a JSON Schema per form type → Zod validation → Postgres (raw JSONB + EAV field table). It adds two npm dependencies (an LLM SDK and Zod), needs no Python, and handles layout drift on booking sheets without regex.
- **Top 3 tools/repos:** (1) Amazon Bedrock Data Automation / Textract, the AWS-native, HIPAA-eligible option with a published CMS-1500 blueprint sample and native checkbox status; (2) datalab-to/chandra (Chandra OCR 2), the strongest self-hostable layout OCR with checkbox support, but it returns layout HTML/Markdown/JSON, not semantic key-values, and its weights carry a revenue-capped licence; (3) Mistral OCR 4 Document AI, which takes a JSON Schema and returns fields in one call. GdoczAI and docfold/extractfold are interesting but immature. The "zync-nest-ai-module" and "Dokra" projects could not be found and should not be relied on.
- **Storage:** Keep an immutable `Extraction` row (raw model JSON, model and version, schema version, form type) plus an `ExtractedField` EAV table keyed by a canonical key (e.g. `patient.name`) *and* the form-native key (e.g. `cms1500.box2`). Autofill then queries the canonical key regardless of source form.

## Key Findings

**1. VLM + schema beats Tesseract + templates for your mix of documents.** Tesseract (and tesseract.js) gives you text and word boxes only. Tesseract.js's own README says it "does not support PDF files and does not modify the Tesseract recognition model to improve accuracy." [github](https://github.com/naptha/tesseract.js/) Template matching can work for the fixed CMS-1500/UB-04 grids, but it breaks on booking sheets with free-form layouts, handwriting and checkboxes. That leaves you writing per-layout coordinates or regex, which is exactly the brittleness you want to avoid. Schema-driven VLM extraction fixes the field list in the schema, not the coordinates, so a new booking-sheet layout needs no code change. [gdoczai](https://gdoczai.com/)

**2. "Form extraction" claims often mean raw text. Here is how each candidate stands:**

| Tool | Output | Meets autofill requirement? |
|---|---|---|
| Tesseract / tesseract.js | Text + word boxes | ❌ Raw text only |
| olmOCR 2 (Apache-2.0) | Markdown/plain text | ❌ Text only, needs an LLM schema step | [aidreamhub](https://aidreamhub.com/tools/olmocr)
| Chandra OCR 2 | Layout-preserving HTML/Markdown/JSON with block types, bboxes, checkboxes | ⚠️ Structure, not semantics: still need a schema step to map to "Box 2 = Patient Name" | [github](https://github.com/datalab-to/chandra) [github](https://github.com/datalab-to/chandra/releases)
| Textract AnalyzeDocument (FORMS/TABLES/QUERIES) | Key-value pairs, tables, `SELECTION_ELEMENT` with SELECTED/NOT_SELECTED | ✅ Generic KV; Queries give named fields | [medium](https://medium.com/@richardhightower/document-intelligence-with-amazon-textract-from-ocr-to-structured-insights-a9165d853de5) [amazon](https://docs.aws.amazon.com/textract/latest/dg/how-it-works-selectables.html)
| Bedrock Data Automation (custom blueprint) | Your named fields + confidence + location | ✅ |
| Mistral OCR 4 + `document_annotation_format` | JSON matching your schema | ✅ | [marketingscoop](https://www.marketingscoop.com/ai/mistral-annotations-how-structured-document-extraction-works-beyond-plain-ocr/)
| Gemini/Claude/GPT with JSON Schema | JSON matching your schema | ✅ (no native confidence; add validation) |

**3. HIPAA/PHI changes which "Gemini" you can use.** The Gemini Developer API via Google AI Studio is *not* on Google's BAA covered-products list. [bonamisoftware](https://www.bonamisoftware.com/blog-is-chatgpt-claude-gemini-hipaa-compliant) Gemini on Google Cloud (Vertex AI, renamed "Gemini Enterprise Agent Platform" in 2026) is covered under the Google Cloud BAA, per a September 2026 review of the covered-products list. [aiprovidertrust](https://aiprovidertrust.com/offerings/gemini-vertex/) [normgrid](https://www.normgrid.com/hipaa/vendors/google-cloud/) Amazon Textract became HIPAA-eligible on October 10, 2019; AWS's "What's New" announcement said: "Starting today, Amazon Textract is a HIPAA eligible service. HIPAA eligibility applies to all AWS Regions where Amazon Textract is available." Since you are already on AWS, Bedrock and Textract keep PHI inside your existing AWS BAA boundary. For UK clients, the same pipeline needs UK GDPR treatment (special-category health data, processor agreements, region choice). Pick EU/UK regions where the provider offers them.

**4. Chandra OCR 2 is the best self-hostable engine, but read its licence.** The datalab-to/chandra repo has about 12.6k stars and was updated October 22, 2026. [github](https://github.com/datalab-to) Datalab reports 85.9% on olmOCR-Bench (vendor-run) versus 82.4 for olmOCR 2. [huggingface](https://huggingface.co/kimleang123/chandra-ocr-2) [github](https://github.com/datalab-to/chandra/releases) The model has 4B parameters (down from 9B), and Datalab's GitHub release notes cite "2 pages/sec on H100 with 96 concurrent requests"; its features list "Reconstructs forms accurately, including checkboxes" and "Excellent handwriting support." The code is Apache-2.0, but the weights use a modified OpenRAIL-M licence: "free for research, personal use, and startups under $2M funding/revenue, cannot be used competitively with our API." [github](https://github.com/datalab-to/chandra) Above that threshold you need a commercial licence. [docsumo](https://www.docsumo.com/blog/best-ocr-models) It serves an OpenAI-compatible endpoint via `vllm serve datalab-to/chandra-ocr-2`, so NestJS can call it with plain `fetch`, with no Python in your Node process. [huggingface](https://huggingface.co/datalab-to/chandra-ocr-2) One weak spot: the datalab-to/chandra-ocr-2 Hugging Face model card (Datalab's own benchmarks) gives it 49.8 on olmOCR-Bench "Old Scans" (versus 47.7 for olmOCR 2), which matters for faxed, photocopied claims.

**5. Existing repos and modules checked:**
- **GramosoftAI/GdoczAI**: a real repo ("turns raw PDFs and images into clean, structured JSON — powered by multi-engine OCR and AI-driven schema extraction"), Python, tags include olmOCR2/Qwen/Gemini, about 9 stars, last seen updated July 2026. [github](https://github.com/topics/intelligent-document-processing) The vendor says it is MIT licensed, but I could not read the LICENSE file. [gramopro](https://gramopro.ai/) A REST API (`POST /api/v1/parsers/:id/upload`) is documented for the hosted product; it is not confirmed for the open-source code. Its "single-sample" teaching model is attractive for booking sheets, but adoption is too low to make it a core dependency for PHI. [gdoczai](https://gdoczai.com/)
- **Mihailorama/docfold + extractfold**: docfold (about 18 stars) wraps several engines (Docling, PyMuPDF, Tesseract, Marker, Mistral OCR) with an evaluation harness. [github](https://github.com/Mihailorama/docfold) [github](https://github.com/Mihailorama/docfold) Its sibling extractfold takes "document + JSON Schema -> schema-conformant Python dict." [github](https://github.com/Mihailorama/extractfold) The design is right but the project is early-stage. Use it to benchmark engines on your own HCFA/UB-04 samples, not in production.
- **Zipstack/unstract**: an "LLM-Driven Extraction of Unstructured Data — Built for API Deployments." [github](https://github.com/topics/pdf-extraction?l=python&o=desc&s=stars) It is a heavier platform, the opposite of minimal.
- **zync-nest-ai-module**: not found on npm or GitHub. Only unrelated "Zync" projects exist (a video studio, a code generator, a SaaS chat app). [github +2](https://github.com/rafay-kh-dev/Zync-AI) Treat it as non-existent or misnamed. The working NestJS equivalents are `@nestjs-ai/platform` (OpenAI and Google GenAI providers, structured output via Standard Schema/Zod) and plain SDK calls. [npmjs](https://www.npmjs.com/package/@nestjs-ai/platform)
- **Dokra**: no matching Node.js project. `panderanish-cmyk/Dokra` is an empty AI Studio template (1 commit, no code), and `EllyMandliel/Dokra` is an unrelated Python library. [github](https://github.com/EllyMandliel/Dokra) [github](https://github.com/panderanish-cmyk/Dokra) You may be thinking of **Doctra** (Python, Tesseract + VLMs, outputs "Markdown, Excel, and structured JSON"). [github](https://github.com/AdemBoukhris457/Doctra) The *pattern* you described (pdf-parse/tesseract.js + LLM) is valid and common, but OCR-then-LLM loses checkbox state and layout. Send the image itself to the VLM.
- **HCFA/UB-04 parsers**: there is no maintained open-source parser. The commercial options are UiPath Document Understanding, whose CMS-1500 package "has over 80 fields covering all types of info that the form can contain" and which also documents a separate UB04 document type (extracting fields such as patient-name, bill-notype, admission-date and total-amount), and Hewto.ai's fine-tuned VLM for UB-04, which covers "81 boxes, revenue-code grids." The most useful open artifact is AWS's Bedrock Data Automation guidance sample, which includes a `claims-review-cms-1500` blueprint. [deepwiki](https://deepwiki.com/aws-solutions-library-samples/guidance-for-multimodal-data-processing-using-amazon-bedrock-data-automation/2.3-creating-custom-blueprints)

## Recommended Architecture

```
[React/Next upload] ──presigned PUT──▶ [S3 (SSE-KMS, PHI bucket)]
        │
        ▼
[NestJS API] ── create Document row (status=UPLOADED) ──▶ [Postgres]
        │
        └─ enqueue job ─▶ [BullMQ / SQS]
                              │
                              ▼
                 [NestJS Extraction Worker]
                  1. Rasterize PDF → page PNGs (pdftoppm/sharp)
                  2. CLASSIFY: VLM call → {formType: CMS1500|UB04|BOOKING_SHEET|UNKNOWN, confidence}
                  3. EXTRACT: engine adapter chosen by config
                       ├─ A) Vertex Gemini / Bedrock Claude + JSON Schema (default)
                       ├─ B) Bedrock Data Automation blueprint / Textract FORMS+QUERIES (checkbox cross-check)
                       └─ C) Self-hosted Chandra 2 (vLLM, OpenAI-compatible) → layout JSON → LLM schema map
                  4. VALIDATE: Zod + domain rules (NPI checksum, ICD-10/CPT/revenue-code formats, dates, totals)
                  5. PERSIST: Extraction (raw JSONB) + ExtractedField rows (canonical + native keys)
                  6. ROUTE: low confidence / failed rules → human review queue
                              │
                              ▼
                 [Autofill service] ── SELECT by canonical_key, patient/booking match ──▶ forms/UI
```

Why this shape: Every engine sits behind one `ExtractionEngine` interface, so you can swap Gemini for Bedrock for Chandra without touching storage. The raw output is immutable, so you can re-map it later when your canonical dictionary grows. That is your future-proofing.

## Top 3 Tools/Repos

1. **Amazon Bedrock Data Automation + Textract (AWS, paid)**: github.com/aws-samples/sample-document-processing-with-amazon-bedrock-data-automation and the AWS Solutions "multimodal data processing using Amazon Bedrock Data Automation" guidance, which has a CMS-1500 blueprint. [github](https://github.com/aws-samples/sample-document-processing-with-amazon-bedrock-data-automation) [deepwiki](https://deepwiki.com/aws-solutions-library-samples/guidance-for-multimodal-data-processing-using-amazon-bedrock-data-automation/2.3-creating-custom-blueprints)
   - *Why it fits:* It is already in your AWS account and under your BAA, and it returns named fields with confidence and location. [drpranayjha](https://drpranayjha.com/bedrock-data-automation-multimodal/) Textract's `SELECTION_ELEMENT` blocks give an explicit `SelectionStatus` for checkboxes (e.g. CMS-1500 Box 6/10a–c, UB-04 condition codes). [amazon](https://docs.aws.amazon.com/textract/latest/dg/how-it-works-selectables.html)
   - *Cost:* AWS's Bedrock pricing page states that "The per page price for any blueprint with 30 fields or less is $0.040," plus $0.0005 per page for each field above 30. On that formula ("$0.040 + (# of additional fields above 30 * $0.0005 per field)"), an 81-field UB-04 blueprint costs $0.040 + 51×$0.0005 = $0.0655/page; AWS's own worked example prices a 40-field blueprint at $0.045/page.
   - *Verdict:* Best accuracy-per-effort for the two fixed claim forms. You call it via `@aws-sdk/client-bedrock-data-automation-runtime` / `@aws-sdk/client-textract`, so no Python is needed.
2. **datalab-to/chandra (Chandra OCR 2)**: github.com/datalab-to/chandra
   - *Why it fits:* It is the top self-hostable OCR for handwriting, forms and checkboxes, and its vLLM server speaks the OpenAI API. [huggingface](https://huggingface.co/datalab-to/chandra-ocr-2) [docsumo](https://www.docsumo.com/blog/best-ocr-models)
   - *Gaps:* It returns layout, not field semantics, so pair it with a small LLM mapping step. It needs a GPU (H100-class benchmark), and its weights are licence-capped at $2M revenue/funding. [huggingface](https://huggingface.co/datalab-to/chandra-ocr-2) [docsumo](https://www.docsumo.com/blog/best-ocr-models)
   - *Verdict:* Use it when PHI must never leave your VPC (it runs on EC2 GPU or ECS GPU).
3. **Mistral OCR 4 Document AI (hosted, with a self-host option)**: docs.mistral.ai/api/endpoint/ocr
   - *Why it fits:* One `/v1/ocr` call with `document_annotation_format` (JSON Schema) returns schema-conformant JSON plus bounding boxes, block types and word-level confidence. [danilchenko](https://www.danilchenko.dev/posts/mistral-ocr-4-tutorial/) [nativeport](https://docs.nativeport.ai/mistral) The Rundown AI's Mistral OCR 4.1 guide and DigitalApplied ("$5 for schema-driven Document AI") put it at $5 per 1,000 annotated pages, versus $4 per 1,000 for standard OCR and $2 in batch.
   - *Caveat:* I could not confirm a Mistral BAA, so for US PHI use it only via a self-hosted container or after you have a signed BAA.

Honourable mentions: GdoczAI (watch it, don't depend on it), extractfold (for benchmarking), olmOCR 2 (Apache-2.0, fully open weights, but text-only output). [huggingface](https://huggingface.co/allenai/olmOCR-7B-0225-preview/blob/main/README.md?code=true) [aidreamhub](https://aidreamhub.com/tools/olmocr)

## Storage Schema

Principles: (1) keep the raw output immutable and versioned; (2) use a canonical field dictionary that maps form-native keys to autofill keys; (3) store one EAV row per extracted value, with provenance (page, bbox, confidence, engine); (4) store repeating groups (CMS-1500 Box 24 lines, UB-04 FL42–47 revenue lines) with a `groupIndex`.

```prisma
enum FormType { CMS1500 UB04 BOOKING_SHEET UNKNOWN }
enum ExtractionStatus { UPLOADED CLASSIFIED EXTRACTED NEEDS_REVIEW APPROVED FAILED }

model Document {
  id          String   @id @default(uuid())
  tenantId    String
  s3Key       String
  sha256      String   @unique          // dedupe re-uploads
  pageCount   Int?
  formType    FormType @default(UNKNOWN)
  formVariant String?                   // e.g. "CMS-1500 (02/12)", "booking-sheet:clinicA:v3"
  status      ExtractionStatus @default(UPLOADED)
  extractions Extraction[]
  createdAt   DateTime @default(now())
  @@index([tenantId, formType])
}

model Extraction {
  id            String   @id @default(uuid())
  documentId    String
  document      Document @relation(fields: [documentId], references: [id])
  engine        String   // "vertex-gemini" | "bedrock-bda" | "textract" | "chandra2"
  modelVersion  String
  schemaVersion String   // e.g. "cms1500@1.3.0"
  rawOutput     Json     // untouched engine/LLM JSON (JSONB)
  normalized    Json     // validated, schema-shaped JSON
  validation    Json?    // rule failures
  isCurrent     Boolean  @default(true)
  fields        ExtractedField[]
  createdAt     DateTime @default(now())
}

model FieldDefinition {            // canonical dictionary for autofill
  key          String @id          // "patient.name.last", "insured.id", "booking.id"
  dataType     String              // string|date|money|code|boolean
  description  String
  mappings     FormFieldMapping[]
}

model FormFieldMapping {
  id          String   @id @default(uuid())
  formType    FormType
  nativeKey   String   // "cms1500.box2", "ub04.fl8b", "booking.guest_name"
  canonicalKey String
  canonical   FieldDefinition @relation(fields: [canonicalKey], references: [key])
  @@unique([formType, nativeKey])
}

model ExtractedField {
  id           String   @id @default(uuid())
  extractionId String
  extraction   Extraction @relation(fields: [extractionId], references: [id])
  tenantId     String
  formType     FormType
  nativeKey    String          // always stored, even if unmapped
  canonicalKey String?         // null until mapped -> "save everything now, map later"
  groupKey     String?         // "service_line", "revenue_line"
  groupIndex   Int?
  valueText    String?
  valueJson    Json?           // typed/normalized value, checkbox booleans, code arrays
  confidence   Float?
  page         Int?
  bbox         Json?           // {x,y,w,h} normalized 0-1
  verifiedBy   String?         // human reviewer id
  @@index([tenantId, canonicalKey])
  @@index([tenantId, formType, nativeKey])
}
```

Add a GIN index on `Extraction.normalized` (`CREATE INDEX ... USING GIN (normalized jsonb_path_ops)`) for ad-hoc queries. Encrypt PHI columns or rely on RDS/KMS encryption plus row-level tenant isolation.

Sample normalized extraction (CMS-1500):

```json
{
  "formType": "CMS1500",
  "schemaVersion": "cms1500@1.3.0",
  "fields": {
    "cms1500.box1a": { "value": "XYZ123456789", "canonical": "insured.id", "confidence": 0.97, "page": 1 },
    "cms1500.box2":  { "value": { "last": "DOE", "first": "JANE", "mi": "A" }, "canonical": "patient.name" },
    "cms1500.box3":  { "value": { "dob": "1984-03-12", "sex": "F" }, "canonical": "patient.dob_sex" },
    "cms1500.box10a":{ "value": false, "canonical": "claim.related_to_employment", "source": "checkbox" },
    "cms1500.box21": { "value": ["E11.9", "I10"], "canonical": "claim.diagnosis_codes" }
  },
  "groups": {
    "service_line": [
      { "box24a_from": "2026-09-01", "box24d_cpt": "99213", "box24d_mod": ["25"], "box24f_charge": 125.00, "box24g_units": 1, "box24j_npi": "1234567893" }
    ]
  },
  "unmappedFields": { "booking.custom_note": "Pt prefers AM" }
}
```

Autofill query: `SELECT value_json FROM extracted_field WHERE tenant_id=$1 AND canonical_key='patient.name' AND ... ORDER BY verified_by IS NOT NULL DESC, confidence DESC, created_at DESC LIMIT 1;`

Postgres covers both needs (JSONB for the raw blob, relational tables for EAV). You do not need MongoDB.

## Implementation Path (NestJS)

1. **Define schemas first.** Write Zod schemas per form type: `cms1500.schema.ts` (Boxes 1–33, with Box 24 as an array of up to 6 lines), `ub04.schema.ts` (FL1–81, with FL42–49 as an array of up to 22 lines), and `booking.schema.ts` (core fields plus a free `additionalFields: Record<string,string>` so unknown booking-sheet fields are still captured). Convert each to JSON Schema with `zod-to-json-schema` and seed `FieldDefinition`/`FormFieldMapping` rows from the same source.
2. **Upload module.** Use a presigned S3 PUT from React. NestJS creates the `Document` (with sha256 dedupe) and enqueues an `extract` job (`@nestjs/bullmq` on ElastiCache, or SQS).
3. **Engine abstraction.**
   ```ts
   export interface ExtractionEngine {
     classify(pages: Buffer[]): Promise<{ formType: FormType; confidence: number }>;
     extract(pages: Buffer[], formType: FormType, jsonSchema: object): Promise<{ raw: unknown; data: unknown }>;
   }
   ```
   Register `VertexGeminiEngine`, `BedrockEngine`, `TextractEngine` and `ChandraEngine` as providers, and pick one by tenant/config (`EXTRACTION_ENGINE=vertex-gemini`).
4. **Default engine (Node-native).** Rasterize the PDF at 200–300 DPI and send the page images inline with `responseMimeType: 'application/json'` + `responseSchema` (Vertex `@google-cloud/vertexai` or `@google/genai` in Vertex mode, not an AI Studio key). With Bedrock, use the Converse API with a tool/JSON schema. Prompt rules: "return null when a box is blank; never infer values; checkboxes as booleans; copy codes exactly; include page numbers." Set temperature to 0.
5. **Checkbox/critical-field cross-check.** For CMS-1500/UB-04, also run Textract `AnalyzeDocument` with `FeatureTypes: ['FORMS','QUERIES']` (or a BDA blueprint) and compare: Box 1 insurance type, Box 6, Box 10a–c, NPIs, totals. [medium](https://medium.com/@richardhightower/document-intelligence-with-amazon-textract-from-ocr-to-structured-insights-a9165d853de5) [amazon](https://docs.aws.amazon.com/textract/latest/dg/API_AnalyzeDocument.html) Any disagreement goes to `NEEDS_REVIEW`. This compensates for VLMs lacking calibrated confidence.
6. **Validation.** Run `schema.safeParse`, then domain checks: NPI Luhn check, ICD-10 pattern, CPT/HCPCS format, UB-04 revenue codes (4 digits), the sum of line charges equalling the total, and date sanity checks.
7. **Persist.** In one Prisma `$transaction`, insert the `Extraction` (raw + normalized), flatten it to `ExtractedField` rows (resolving `canonicalKey` through `FormFieldMapping`), and mark older extractions `isCurrent=false`.
8. **Review UI.** In React, show the page image with bbox overlays for low-confidence fields. Reviewer edits set `verifiedBy`, and these corrections become your evaluation set.
9. **Optional self-host.** Deploy Chandra 2 on an ECS/EC2 GPU instance (`vllm serve datalab-to/chandra-ocr-2`) inside the VPC. [huggingface](https://huggingface.co/datalab-to/chandra-ocr-2) `ChandraEngine` calls `/v1/chat/completions` with the image, gets layout HTML/JSON, then makes a second call (to a local LLM or Bedrock) to map it to your schema. You only need Python if you want Chandra's CLI; the vLLM endpoint is language-agnostic.
10. **Evaluate before committing.** Hand-label 50–100 real documents per form type (including faxed and handwritten ones) and measure field-level exact match per engine. Docfold/extractfold's evaluation harness or a simple script both work. Choose the engine on *your* numbers.

## Accuracy Trade-off: Dedicated VLM Microservice vs Node-native LLM Call

- **Node-native frontier VLM (Gemini/Claude via BAA):** It has the best semantic mapping and is robust to new booking-sheet layouts. There is no infrastructure to run. Its risks are hallucinated values on blank or illegible boxes and no native confidence, which you mitigate with nulls-allowed schemas, validation rules and the Textract cross-check.
- **Dedicated OCR VLM (Chandra 2):** It gives better raw transcription of dense, tiny-text grids. On Datalab's own 90-language benchmark, Chandra 2 averaged 72.7% against Gemini 2.5 Flash's 60.8%, though that is a vendor benchmark on general documents, not claim forms. [huggingface](https://huggingface.co/datalab-to/chandra-ocr-2) It still needs a second schema-mapping step, and you take on GPU operations and licensing.
- **Textract/BDA:** It has the most reliable checkbox state and per-field confidence, and it is weaker on free-form handwriting semantics. It is ideal as a cross-check on the fixed claim forms.

My position: start Node-native with Vertex Gemini or Bedrock Claude and add the Textract cross-check for claim forms. Add Chandra only if a client contract forbids cloud AI processing of PHI.

## Caveats
- Benchmark numbers for Chandra and olmOCR come from the vendors (olmOCR-Bench, run by the model makers). [docsumo](https://www.docsumo.com/blog/best-ocr-models) None of them measure CMS-1500/UB-04 field accuracy specifically.
- Facts about GdoczAI's licence and API come from vendor marketing. [gramopro](https://gramopro.ai/) I could not read its GitHub LICENSE or README directly.
- Mistral OCR 4 pricing and features come from third-party write-ups and Mistral's API reference. Check BAA availability with Mistral before sending US PHI.
- One third-party blog claims Textract has "No checkbox detection capability"; AWS's own documentation contradicts this (`SELECTION_ELEMENT` with `SelectionStatus`). [signisys](https://www.signisys.com/blog/amazon-textract-the-complete-guide-to-aws-document-processing/) [amazon](https://docs.aws.amazon.com/textract/latest/dg/how-it-works-selectables.html) Trust AWS's documentation.
- Google renamed Vertex AI products in 2026. Match your exact product SKU against Google's current HIPAA covered-products list before going live. [normgrid](https://www.normgrid.com/hipaa/vendors/google-cloud/)