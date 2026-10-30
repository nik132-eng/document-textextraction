# Manual setup: what a human has to do

The code is done and tested with the `fake` engine. Everything below needs a person: an account, a console, a signature, or a decision. Work top to bottom. Sections 1–4 are enough for a POC on **synthetic** documents. Section 5 is the gate before any real patient document.

Sources: plan repo `docs/superpowers/plans/2026-10-28-textract-idp/01a-aws-walkthrough.md` (AWS), `docs/research/vendors/vlm-run/*` and `docs/research/vendors/meibel/*` (vendors).

| # | What | Who | Time | Blocks |
|---|---|---|---|---|
| 0 | Local machine | Dev | 10 min | Running anything |
| 1 | AWS Textract (dev track) | AWS admin + dev | ~1 h | `textract` engine |
| 2 | VLM Run account + key | Product/dev | 15 min | `vlmrun` engine |
| 3 | Meibel account + key | Product/dev | 15 min | `meibel` engine |
| 4 | First real run + fix the assumed vendor shapes | Dev | 1–2 h | Trusting VLM Run / Meibel output |
| 5 | Compliance gates before real PHI | Compliance + ops | days–weeks | Any real document |
| 6 | Decisions owed | Tech lead + product | — | Next build steps |

---

## 0. Local machine

- [ ] Node **22.21.1**: `nvm install 22.21.1 && nvm use` (the repo has `.nvmrc`). Prisma 7.4 supports Node 20.19+, 22.12+ or 24. Your machine currently runs Node 25, which works but prints a warning.
- [ ] pnpm 9: `corepack enable && corepack prepare pnpm@9.5.0 --activate`.
- [ ] **Start Docker Desktop**, then run `docker compose up -d` (Postgres 15 on 5433, Redis 7 on 6380).
- [ ] `cp .env.example .env`, `pnpm install`, `pnpm prisma:deploy`, `pnpm test`, `pnpm test:e2e`, `pnpm start:dev`, then open http://localhost:3000/docs.
- [ ] `pnpm samples` creates the synthetic card PNG and intake PDF used below.

No poppler is needed. PDFs render with pdfjs-dist, so the `brew install poppler` step in 01a is not needed for this POC.

## 1. Amazon Textract (dev track, synthetic data)

This follows `01a` Track 1. **Never create IAM access keys and never put keys in `.env`.** The app uses the AWS default credential chain.

1. **Pick the region.** Use the region of the main project's S3 bucket (S3 console → bucket → Properties → *AWS Region*). Write it down as `AWS_REGION`.
2. **Check the features.** Console → region picker → search "Textract" → *Try Amazon Textract* → Analyze Document must show **Forms** and **Queries**. Upload `samples/insurance-card.synthetic.png` and look at the Queries tab.
3. **Quotas.** Service Quotas → Amazon Textract → note the TPS for `AnalyzeDocument`. The defaults are fine for the POC.
4. **Developer access (IAM Identity Center).**
   - Enable Identity Center (with AWS Organizations if offered). Add your user.
   - Permission sets → Create → Custom → inline policy:
     ```json
     {
       "Version": "2012-10-17",
       "Statement": [{
         "Sid": "TextractSyncDev",
         "Effect": "Allow",
         "Action": ["textract:AnalyzeDocument", "textract:DetectDocumentText", "textract:AnalyzeID", "textract:AnalyzeExpense"],
         "Resource": "*"
       }]
     }
     ```
     Name it `IdpDeveloper`, with an 8 h session.
   - AWS accounts → tick the account → Assign the user + `IdpDeveloper`.
   - Copy the **access portal URL** (`https://d-xxxx.awsapps.com/start`).
5. **Connect the laptop.**
   ```bash
   aws configure sso            # session "idp", portal URL, pick the account + IdpDeveloper, profile "idp-dev"
   aws sso login --profile idp-dev
   aws sts get-caller-identity --profile idp-dev   # ARN must contain AWSReservedSSO_IdpDeveloper
   ```
6. **Smoke test from the CLI** (synthetic page):
   ```bash
   printf '{"Bytes":"%s"}' "$(base64 -i samples/insurance-card.synthetic.png)" > /tmp/doc.json
   aws textract detect-document-text --document file:///tmp/doc.json --profile idp-dev \
     --region "$AWS_REGION" --query 'Blocks[?BlockType==`LINE`].Text | [0:5]'
   ```
   You should see `SYNTHETIC HEALTH PLAN`, … For error meanings see 01a step 6 (AccessDenied = wrong profile or no assignment; expired = `aws sso login` again).
7. **Budget.** Billing → Budgets → monthly cost budget **$25**, filter *Service = Amazon Textract*, alerts at 50/80/100 %. Expect about $0.015 per page for queries and $0.065 with FORMS.
8. **.env**
   ```bash
   AWS_REGION=<step 1>
   AWS_PROFILE=idp-dev
   ENGINES_ENABLED=fake,textract
   ENGINE_DEFAULT=textract
   ```
   Restart the app, then upload a sample with `-F engines=textract`.

## 2. VLM Run (synthetic only on the free plan)

1. Sign up at https://vlm.run. The **Starter** plan ($0, $10 trial, 10 req/min) is fine for synthetic tests. It has **no BAA**, so it must never see real documents.
2. Dashboard → Settings → **API Keys** → create a `dev` key.
3. `.env`:
   ```bash
   VLMRUN_API_KEY=<key>
   VLMRUN_MODEL=vlm-1           # pin it. Never pass a third-party model id (Claude/GPT/Gemini) for PHI
   ENGINES_ENABLED=fake,textract,vlmrun
   ```
4. The client already forces `allow_logging/training/retention=false` on every call (the vendor defaults are `true`). A unit test checks this, so don't remove it.
5. **Before real PHI** (section 5): upgrade to **Pro ($799/mo) and sign the BAA**, or go Enterprise in-VPC. Send the 7 vendor questions in `vlm-run/research.md` §8 and file the answers. Then set `VLMRUN_BAA_CONFIRMED=true`.

## 3. Meibel (synthetic only; weakest fit, per the research)

1. Sign up at https://meibel.ai. **Starter** gives $25 credits and 6 req/s.
2. Settings → **API Keys** → create a key.
3. `.env`:
   ```bash
   MEIBEL_API_KEY=<key>
   MEIBEL_BASE_URL=https://api.meibel.ai/v2
   MEIBEL_DEFAULT_FIELD_CONFIDENCE=      # leave empty: no per-field confidence → everything goes to review
   ENGINES_ENABLED=fake,textract,vlmrun,meibel
   ```
4. The deep-transform API is a **preview**: shapes may change. The client can only call `/documents/deep-transform` and `/documents/parse` (allowlist). Never enable datasources, Recall or ingest for patient data.
5. **Before real PHI:** Meibel publishes **no BAA or HIPAA statement**. You need a signed BAA *or* an approved BYOC deployment in your AWS account. Send the 8 questions in `meibel/research.md` §8. Until then keep `MEIBEL_BAA_CONFIRMED=false` (boot refuses PHI mode).

## 4. First real run: confirm the assumed vendor shapes

The research could not call the vendor APIs, so two mappers are written against **assumed** shapes. Do this once per vendor, with synthetic files only:

```bash
curl -s -X POST localhost:3000/v1/documents -H 'x-tenant-id: demo' \
  -F formType=INSURANCE_CARD -F engines=textract,vlmrun,meibel \
  -F file=@samples/insurance-card.synthetic.png
curl -s localhost:3000/v1/documents/<documentId>/compare -H 'x-tenant-id: demo' | jq
```

- [ ] If VLM Run values arrive but `page`, `bbox` or `confidence` are null, open the stored raw response (`.data/idp-poc/t/demo/d/<doc>/engine/vlmrun/<extractionId>.json.gz`, `gunzip -c`). Adjust `findMeta` / `unionBox` in `src/engines/vlmrun/vlmrun.mapper.ts` to the real `_metadata` placement, xywh convention and page base. Copy that raw JSON (it is synthetic) into a new mapper test.
- [ ] Do the same for Meibel: `provenance.json` → `indexProvenance` / `toBBox` in `src/engines/meibel/meibel.mapper.ts`. If the job id field isn't `job_id`, fix `submitTransform`.
- [ ] Check the bboxes: `GET /v1/documents/<id>/pages/1` and draw the 0..1 boxes on it. They must sit on the printed values.
- [ ] Record the actual cost (`costUsd` for VLM Run; Meibel shows only an estimate, so compare it with the dashboard).
- [ ] Confirm `VLMRUN_CONFIDENCE_MAP` bands against the real `confidence` strings.

## 5. Gates before any real patient document (PHI)

`PHI_MODE=true` makes the app refuse to boot unless the engine-side gates are confirmed. The rest are organisational and the code cannot check them. Do them in order (`01a` Track 2), as IaC in the main project's infra folder.

| # | Gate | Where | Done when |
|---|---|---|---|
| 1 | **AWS BAA** covers the account | AWS Artifact → Agreements | Status *Accepted*, evidence filed |
| 2 | **AI-services opt-out** (Textract must not use content) | AWS Organizations → AI services opt-out policies | Effective policy `optOut` on the account |
| 3 | KMS key `alias/idp-<env>`, rotation on | KMS | Key exists → `S3_KMS_KEY_ID` |
| 4 | S3 bucket or prefix: block public access, SSE-KMS, versioning, TLS-only, lifecycle | S3 | `STORAGE_DRIVER=s3`, `S3_BUCKET`, `STORAGE_PREFIX` |
| 5 | ECS task role: the 4 Textract actions + S3 on the prefix + KMS | IAM | Policy simulator: allowed / everything else denied |
| 6 | VPC endpoints (S3 gateway, Textract interface) | VPC | Textract DNS resolves privately |
| 7 | RDS Postgres 15 (TLS forced), ElastiCache Redis (`noeviction`) | RDS, ElastiCache | `DATABASE_URL`, `REDIS_URL` |
| 8 | **Secrets Manager**: `idp/<env>/db`, `idp/<env>/vlmrun` (`apiKey`), `idp/<env>/meibel` (`apiKey`), injected as task secrets | Secrets Manager | No secret in the image, repo or `.env` |
| 9 | CloudTrail S3 data events, alarms (Textract throttling/errors), budgets, cost anomaly detection | CloudTrail, CloudWatch, Budgets | Alarms exist |
| 10 | Textract quota increase for production volume | Service Quotas | Approved |
| 11 | **VLM Run** Pro + signed BAA (or don't enable it) | Vendor | `VLMRUN_BAA_CONFIRMED=true` |
| 12 | **Meibel** signed BAA or approved BYOC (or don't enable it) | Vendor | `MEIBEL_BAA_CONFIRMED=true` |
| 13 | Turn it on | Deploy config | `PHI_MODE=true`, `STORAGE_DRIVER=s3`, `fake` removed from `ENGINES_ENABLED` |

The vendor engines send documents **outside AWS**. The AWS BAA does not cover them; only their own BAA does.

## 6. Decisions owed (plan repo `STATUS.md`)

- **Q15:** accept D14 (Textract default + schema engines)? This POC is the evidence.
- **Q16:** VLM Run Pro + BAA? Decide after the bake-off on 10–20 synthetic pages per form.
- **Q17:** pursue Meibel only if a BAA or BYOC is available **and** document Q&A/agents are wanted.
- Which forms go first (Q2), and whether this POC becomes the standalone service or gets folded into the main project as `IdpModule` (Q1).
