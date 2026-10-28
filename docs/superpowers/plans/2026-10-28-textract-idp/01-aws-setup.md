# 01 — AWS Setup (manual steps and infrastructure)

**Owner:** whoever administers the project AWS account.
**When:** §1–§6 before P2 (first Textract call). §7–§10 before the first non-synthetic document. §11 only if the async path in P8 is enabled.
**Rule:** do everything in the **same account and region** as the project document bucket. Textract, S3, KMS, SNS and SQS must share a region (Textract requires the SNS topic and S3 objects in the endpoint's region).

Variables used below. Replace them everywhere:

```bash
export AWS_PROFILE=idp-admin          # IAM Identity Center (SSO) profile, never static keys
export AWS_REGION=us-east-1              # same region as the project bucket
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export ENV=dev                           # dev | staging | prod
export BUCKET=idp-${ENV}-${ACCOUNT_ID}
export KEY_ALIAS=alias/idp-${ENV}
export APP_ROLE=idp-${ENV}-task   # ECS task role name
```

> **Recommended practice:** after you have walked through these steps once by hand in `dev`, codify them in IaC (CDK or Terraform module `infra/idp`). The JSON below is written so it can be pasted into either tool. Keep console clicks for discovery only.

---

## 1. Confirm the BAA covers this account (blocking for real PHI)

1. Console → **AWS Artifact** → **Agreements** → **Account agreements** (or **Organization agreements** if you use AWS Organizations).
2. Confirm **AWS Business Associate Addendum (BAA)** shows **Accepted** for this account or the organization.
3. Confirm Textract is on the [HIPAA Eligible Services Reference](https://aws.amazon.com/compliance/hipaa-eligible-services-reference/), along with S3, KMS, SNS, SQS, ElastiCache and RDS.
4. Record the date and who checked in `docs/compliance/aws-baa.md`. Until this is done, **only synthetic documents** may be sent.

## 2. Opt out of AI-service content use (blocking for real PHI)

Textract is one of the AWS AI services that can store and use processed content to improve the service unless you opt out. Opt out at the organization level:

1. Console → **AWS Organizations** → **Policies** → **AI services opt-out policies** → **Enable**.
2. **Create policy** `ai-optout-all`:
   ```json
   {
     "services": {
       "default": {
         "opt_out_policy": { "@@assign": "optOut" }
       }
     }
   }
   ```
3. Attach it to the **Root** (or the OU that contains the project account).
4. Verify in the member account: Organizations → **Effective policy** for AI services opt-out shows `optOut`.
5. If the account is **not** in an Organization, open an AWS Support case asking to opt out of content use for Amazon Textract in this account and region, and keep the case ID.

## 3. Region and feature check

1. Console → **Amazon Textract** (in `$AWS_REGION`) → **Try Textract** → **Analyze Document**. Confirm that **Forms, Tables, Queries, Layout** are all selectable. Queries and Layout are not available in every region.
2. Confirm that **Analyze ID** and **Analyze Expense** demos load in the same region.
3. Note the region's default quotas: **Service Quotas** console → **Amazon Textract** → record the current TPS for `AnalyzeDocument`, `DetectDocumentText`, `AnalyzeID` and `AnalyzeExpense`. Defaults are low (single-digit TPS in many regions). These values set `TEXTRACT_TPS_*` in env (see `05-pipeline-and-api.md` §11).

## 4. KMS key for documents

```bash
aws kms create-key --description "IDP documents ($ENV)" \
  --key-usage ENCRYPT_DECRYPT --key-spec SYMMETRIC_DEFAULT \
  --tags TagKey=app,TagValue=idp TagKey=env,TagValue=$ENV \
  --query KeyMetadata.KeyId --output text
# → KEY_ID
aws kms create-alias --alias-name $KEY_ALIAS --target-key-id <KEY_ID>
aws kms enable-key-rotation --key-id <KEY_ID>
```

Key policy statement to add (keeps the default root statement):

```json
{
  "Sid": "AllowIdpTaskRoleUse",
  "Effect": "Allow",
  "Principal": { "AWS": "arn:aws:iam::<ACCOUNT_ID>:role/<APP_ROLE>" },
  "Action": ["kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"],
  "Resource": "*",
  "Condition": { "StringEquals": { "kms:ViaService": "s3.<AWS_REGION>.amazonaws.com" } }
}
```

Why `kms:Decrypt` matters for Textract: when you pass `Document.S3Object`, Textract reads the object **with the caller's permissions**. The task role therefore needs both `s3:GetObject` and `kms:Decrypt` on the key.

## 5. S3 bucket

```bash
aws s3api create-bucket --bucket $BUCKET --region $AWS_REGION \
  $( [ "$AWS_REGION" != "us-east-1" ] && echo --create-bucket-configuration LocationConstraint=$AWS_REGION )
aws s3api put-public-access-block --bucket $BUCKET --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-ownership-controls --bucket $BUCKET \
  --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'
aws s3api put-bucket-versioning --bucket $BUCKET --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket $BUCKET --server-side-encryption-configuration '{
  "Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms","KMSMasterKeyID":"'$KEY_ALIAS'"},
            "BucketKeyEnabled":true}]}'
```

Bucket policy (TLS only, KMS only):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "DenyInsecureTransport", "Effect": "Deny", "Principal": "*",
      "Action": "s3:*", "Resource": ["arn:aws:s3:::<BUCKET>", "arn:aws:s3:::<BUCKET>/*"],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } } },
    { "Sid": "DenyNonKmsUploads", "Effect": "Deny", "Principal": "*",
      "Action": "s3:PutObject", "Resource": "arn:aws:s3:::<BUCKET>/*",
      "Condition": { "StringNotEquals": { "s3:x-amz-server-side-encryption": "aws:kms" } } }
  ]
}
```

> If the app relies on default bucket encryption and does not send the `x-amz-server-side-encryption` header, drop `DenyNonKmsUploads` or make `S3Storage` always send `ServerSideEncryption: 'aws:kms'` (the plan does the latter).

**Key layout** (the app must use exactly this; see `02-data-model.md` §6):

```
t/{tenantId}/d/{documentId}/original/{sha256}.{ext}
t/{tenantId}/d/{documentId}/pages/{pageNumber:04d}.png
t/{tenantId}/d/{documentId}/textract/{textractCallId}.json.gz
t/{tenantId}/d/{documentId}/exports/...            # future
```

**Lifecycle rules** (tune per retention decision in `02-data-model.md` §7):

```json
{ "Rules": [
  { "ID": "noncurrent-cleanup", "Status": "Enabled", "Filter": {},
    "NoncurrentVersionExpiration": { "NoncurrentDays": 30 },
    "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 } },
  { "ID": "textract-json-ia", "Status": "Enabled", "Filter": { "Prefix": "t/" },
    "Transitions": [ { "Days": 90, "StorageClass": "STANDARD_IA" } ] }
]}
```

Page PNG deletion after approval is done **by the app** (P9 retention job), not by lifecycle, because it depends on segment status.

**CORS** is only needed if the browser uploads directly with presigned PUT (optional, P7). Allow only the host application origin(s), `PUT` and `GET`, and the `Content-Type` and `x-amz-server-side-encryption*` headers.

## 6. IAM — application role (least privilege)

### 6.1 ECS task role policy `idp-${ENV}-app`

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "TextractSync", "Effect": "Allow",
      "Action": ["textract:DetectDocumentText", "textract:AnalyzeDocument",
                 "textract:AnalyzeID", "textract:AnalyzeExpense"],
      "Resource": "*" },
    { "Sid": "DocumentsRW", "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:GetObjectVersion"],
      "Resource": "arn:aws:s3:::<BUCKET>/t/*" },
    { "Sid": "DocumentsList", "Effect": "Allow", "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::<BUCKET>", "Condition": { "StringLike": { "s3:prefix": "t/*" } } },
    { "Sid": "Kms", "Effect": "Allow",
      "Action": ["kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"],
      "Resource": "arn:aws:kms:<AWS_REGION>:<ACCOUNT_ID>:key/<KEY_ID>" }
  ]
}
```

Textract actions do not support resource-level ARNs, so `Resource: "*"` is expected for them. Add the async statements from §11 only if async is enabled.

Trust policy for the ECS task role:

```json
{ "Version": "2012-10-17", "Statement": [{
  "Effect": "Allow", "Principal": { "Service": "ecs-tasks.amazonaws.com" },
  "Action": "sts:AssumeRole",
  "Condition": { "StringEquals": { "aws:SourceAccount": "<ACCOUNT_ID>" },
                 "ArnLike": { "aws:SourceArn": "arn:aws:ecs:<AWS_REGION>:<ACCOUNT_ID>:*" } } }] }
```

### 6.2 Developer access (local dev)

- Use **IAM Identity Center** permission set `IdpDeveloper` with the same policy as above, scoped to the `dev` bucket and key.
- Local: `aws configure sso` → profile `idp-dev` → `aws sso login --profile idp-dev`. The app picks it up through `AWS_PROFILE`. **No IAM users and no access keys.**
- Developers only ever point at the `dev` bucket with synthetic data.

## 7. Network — keep traffic private (prod and staging)

In the VPC that runs the ECS service:

1. **S3 gateway endpoint** `com.amazonaws.<region>.s3`, attached to the private subnets' route tables. Endpoint policy limited to `<BUCKET>`.
2. **Textract interface endpoint** `com.amazonaws.<region>.textract` (use `textract-fips` if you need FIPS endpoints), with **Private DNS enabled**, in private subnets, and a security group that allows 443 from the ECS tasks' SG.
3. Interface endpoints for `kms`, `logs`, `sts`, `ecr.api`, `ecr.dkr` if tasks have no NAT. Add `sns` and `sqs` only for async.
4. Optional: add `aws:SourceVpce` conditions to the bucket policy so that only the endpoint can read `t/*`.

No code change is needed: SDK v3 resolves the regional endpoint, and private DNS routes it through the VPC endpoint.

## 8. Data stores

- **RDS PostgreSQL 16/17** (or reuse an existing cluster in a new database `idp`): storage encryption on with the KMS key, `rds.force_ssl=1`, automated backups ≥7 days, Performance Insights on. App user `idp_app` without superuser; migrations run as `idp_migrator`.
- **ElastiCache for Valkey/Redis** (P8): in-transit encryption plus AUTH token (or IAM auth), at-rest encryption, in private subnets. BullMQ requires `maxmemory-policy noeviction`. Set it in the parameter group.
- Secrets (`DATABASE_URL`, `REDIS_URL`) live in **Secrets Manager** and are injected as ECS task secrets. They are never baked into the image.

## 9. Observability, audit and cost guardrails

1. **CloudTrail:** confirm the organization trail is on. Enable **S3 data events** for `<BUCKET>` (read and write) for an access audit of PHI objects.
2. **CloudWatch alarms** on the `AWS/Textract` namespace, per operation: `ThrottledCount > 0 for 5 min`, `ServerErrorCount > 0`, `UserErrorCount` spike, `ResponseTime p95`. The app also emits its own metrics (see `05` §12).
3. **AWS Budgets:** a monthly budget filtered to the service *Amazon Textract*, with alerts at 50/80/100% of the forecast (use the workflow doc §9.3 table: about $65 per 1,000 expected-packet pages).
4. **Cost Anomaly Detection:** a monitor for the AWS service dimension, with an alert subscription to the team email or Slack.
5. **Service Quotas:** use the Textract **Service Quotas Calculator** (Textract console) with expected pages per hour. Request increases for `AnalyzeDocument` and `DetectDocumentText` sync TPS before go-live.

## 10. First trial and fixture capture (synthetic only)

Goal: confirm access end to end and produce the recorded JSON fixtures the tests replay.

1. Fill a blank CMS-1500 (NUCC PDF) with fake data and export a page PNG at 200 DPI: `pdftoppm -r 200 -png -f 1 -l 1 cms1500-fake.pdf page`.
2. Upload: `aws s3 cp page-1.png s3://$BUCKET/t/dev/trial/page-1.png --sse aws:kms --sse-kms-key-id $KEY_ALIAS`.
3. Text pass (classifier input):
   ```bash
   aws textract detect-document-text \
     --document '{"S3Object":{"Bucket":"'$BUCKET'","Name":"t/dev/trial/page-1.png"}}' \
     > test/fixtures/textract/CMS1500/case-001/page-1.detect.json
   ```
4. Analysis with queries (`queries.json` is generated by `npm run queries -- CMS1500` from the definition in P4. For the very first trial, hand-write 2–3 queries):
   ```bash
   aws textract analyze-document \
     --document '{"S3Object":{"Bucket":"'$BUCKET'","Name":"t/dev/trial/page-1.png"}}' \
     --feature-types FORMS TABLES QUERIES LAYOUT \
     --queries-config file://queries.json \
     > test/fixtures/textract/CMS1500/case-001/page-1.analyze.json
   ```
   ```json
   { "Queries": [
     { "Text": "What is the insured's ID number?", "Alias": "BOX1A" },
     { "Text": "What is the patient's name?", "Alias": "BOX2" },
     { "Text": "What is the total charge?", "Alias": "BOX28" } ] }
   ```
5. Open the response in the console's **Analyze Document** view to see what Textract calls keys, tables and selections on this form. The definition author uses this to choose label patterns (see `03` §6).
6. From P2 onward, use `npm run record-fixture -- --form CMS1500 --case case-001 --file path.pdf`, which does steps 2–4 for every page and writes the files in the right place.

## 11. Async Textract (optional — only if P8 enables `TEXTRACT_MODE=async`)

Use this only for very large PDFs where per-page sync throughput is not enough. The async path gives 30 queries per page and up to 3,000 pages, but adds SNS/SQS plumbing and a 7-day result window.

1. **SNS topic.** The name **must start with `AmazonTextract`**: `AmazonTextract-idp-${ENV}`. Encrypt it with the KMS key.
2. **SQS queue** `idp-${ENV}-textract-done`, SSE-KMS, plus a DLQ (`maxReceiveCount=5`). Subscribe the queue to the topic with **raw message delivery off**. Queue policy allows `sns.amazonaws.com` `sqs:SendMessage` with `aws:SourceArn` = topic ARN.
3. **Textract service role** `idp-${ENV}-textract-sns`: trusted entity Textract, permissions policy `AmazonTextractServiceRole` (or an inline `sns:Publish` on the one topic), and the confused-deputy trust policy:
   ```json
   { "Version": "2012-10-17", "Statement": {
     "Effect": "Allow", "Principal": { "Service": "textract.amazonaws.com" },
     "Action": "sts:AssumeRole",
     "Condition": {
       "ArnLike": { "aws:SourceArn": "arn:aws:textract:<AWS_REGION>:<ACCOUNT_ID>:*" },
       "StringEquals": { "aws:SourceAccount": "<ACCOUNT_ID>" } } } }
   ```
   The KMS key policy must let this role `kms:GenerateDataKey` and `kms:Decrypt` (to publish to the encrypted topic).
4. **Add to the app task role:**
   ```json
   { "Sid": "TextractAsync", "Effect": "Allow",
     "Action": ["textract:StartDocumentAnalysis", "textract:GetDocumentAnalysis",
                "textract:StartDocumentTextDetection", "textract:GetDocumentTextDetection",
                "textract:StartExpenseAnalysis", "textract:GetExpenseAnalysis"],
     "Resource": "*" },
   { "Sid": "PassTextractRole", "Effect": "Allow", "Action": "iam:PassRole",
     "Resource": "arn:aws:iam::<ACCOUNT_ID>:role/idp-<ENV>-textract-sns",
     "Condition": { "StringEquals": { "iam:PassedToService": "textract.amazonaws.com" } } },
   { "Sid": "ConsumeDone", "Effect": "Allow",
     "Action": ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"],
     "Resource": "arn:aws:sqs:<AWS_REGION>:<ACCOUNT_ID>:idp-<ENV>-textract-done" }
   ```
5. The app passes `ClientRequestToken = sha256(documentId + pageRange + featureHash)` so retries don't start duplicate (billed) jobs. Tokens live 7 days.
6. Do **not** poll `Get*` in a loop. Wait for the SQS message, then page through `GetDocumentAnalysis` with `NextToken` (`MaxResults` ≤1000).

## 12. Environment checklist (hand to the developer)

| Env var | dev | prod |
|---|---|---|
| `AWS_REGION` | same as bucket | same as bucket |
| `AWS_PROFILE` | `idp-dev` | *(unset — task role)* |
| `STORAGE_DRIVER` | `local` or `s3` | `s3` |
| `S3_BUCKET` / `S3_KMS_KEY_ID` | dev bucket / alias | prod bucket / alias |
| `TEXTRACT_TPS_ANALYZE` / `_DETECT` / `_ID` / `_EXPENSE` | from §3 | from §3 (after increase) |
| `TEXTRACT_MODE` | `sync` | `sync` (async only if §11 is done) |
| `TEXTRACT_SNS_TOPIC_ARN` / `TEXTRACT_SNS_ROLE_ARN` / `TEXTRACT_DONE_QUEUE_URL` | — | only for async |
| `PHI_MODE` | `false` (synthetic only) | `true` (boot refuses unless `PHI_BAA_CONFIRMED=true` and `AI_OPTOUT_CONFIRMED=true`) |

## 13. Sign-off checklist

- [ ] BAA accepted (§1), evidence recorded
- [ ] AI services opt-out effective (§2)
- [ ] Region supports Forms/Tables/Queries/Layout/AnalyzeID/AnalyzeExpense (§3)
- [ ] KMS key + rotation (§4)
- [ ] Bucket: public access blocked, SSE-KMS + bucket key, versioning, TLS-only policy, lifecycle (§5)
- [ ] Task role least privilege + dev SSO permission set (§6)
- [ ] VPC endpoints for S3 + Textract (+ KMS/logs/STS/ECR) (§7)
- [ ] RDS encryption + SSL; Valkey TLS + AUTH + `noeviction` (§8)
- [ ] CloudTrail S3 data events, Textract alarms, Budget, Cost Anomaly Detection, quota review (§9)
- [ ] First synthetic trial + fixture recorded (§10)
- [ ] (optional) Async SNS/SQS/service role (§11)
