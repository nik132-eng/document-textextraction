# 01a — AWS Setup Walkthrough (where to go, what to click, how to check)

This is the **guided** version of [`01-aws-setup.md`](01-aws-setup.md). This file gives the order, where each step happens and how to check it worked. `01` keeps the exact JSON policies and CLI commands. Each step below links to them.

There are two tracks. **Do Track 1 now.** Track 2 waits until real patient documents are about to flow.

| Track | Goal | Data allowed | Time | Needed before |
|---|---|---|---|---|
| **1 — Dev** | Developers can call Textract from a laptop. Fixtures can be recorded. | **Synthetic only** | ~1 hour | P2 Task 2.6 (recording fixtures). P0–P1 need no AWS at all. |
| **2 — Staging / Prod** | The service runs in AWS with real PHI | Real, after sign-off | 1–3 days, plus quota and compliance lead time | First real document (P9) |

**Before you start, you need:**
- an AWS login that can administer the account the host project already uses (the account that holds its S3 bucket). Ask the account owner if you are not sure which one it is.
- AWS CLI v2 on your machine: `brew install awscli`, then check with `aws --version` (should show `aws-cli/2.x`).
- `poppler` for page images: `brew install poppler` (check with `pdftoppm -v`).

---

## Track 1 — Dev (synthetic data)

### Step 1 — Pick the region

- **Where:** S3 console → open the host project's existing bucket → **Properties** → *AWS Region*. Or read `AWS_REGION` in the host's env config.
- **Rule:** use the **same region** as that bucket for everything (01 intro).
- **Write down:** `AWS_REGION=________` (e.g. `us-east-1`).

### Step 2 — Check that Textract has every feature we use in that region

- **Where:** top-right region picker → your region → search bar "Textract" → **Amazon Textract** → **Try Amazon Textract**.
- **Check:** in **Analyze Document**, the options **Forms, Tables, Queries, Layout** are all there. The **Analyze ID** and **Analyze Expense** demos load.
- **Try it:** upload a **synthetic** page (a blank CMS-1500 from nucc.org filled with fake data). Look at the Forms, Tables and Queries tabs. This is also how definition authors learn what Textract calls each label (03 §6).
- If a feature is missing, stop. Choose another region together with the bucket owner. Details: 01 §3.

### Step 3 — Read the Textract quotas

- **Where:** console search "Service Quotas" → **AWS services** → **Amazon Textract**.
- **Write down** the *Applied quota value* (transactions per second) for: `AnalyzeDocument`, `DetectDocumentText`, `AnalyzeID`, `AnalyzeExpense`.
- These become `TEXTRACT_TPS_ANALYZE / _DETECT / _ID / _EXPENSE` in env. Dev can keep the defaults.

### Step 4 — Give developers access without access keys (IAM Identity Center)

**Where:** console search "IAM Identity Center".

1. If it is not enabled, choose **Enable**. If the console offers **Enable with AWS Organizations**, take it, because assigning permission sets to an account needs the organization instance. If the account belongs to a company organization, ask its admin to do this step in the management account.
2. **Users → Add user**: your developer email → the user gets an invitation email to set a password and MFA.
3. **Permission sets → Create permission set → Custom permission set → Inline policy**. Paste:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Sid": "TextractSyncDev", "Effect": "Allow",
         "Action": ["textract:DetectDocumentText", "textract:AnalyzeDocument",
                    "textract:AnalyzeID", "textract:AnalyzeExpense"],
         "Resource": "*" }
     ]
   }
   ```
   Name it `IdpDeveloper`, session duration 8 h. This is all dev needs: the app runs with `STORAGE_DRIVER=local` and sends page bytes to Textract directly, so no bucket is required. (If you later want to test the S3 path, add the `DocumentsRW` and `Kms` statements from 01 §6.1, scoped to a dev bucket.)
4. **AWS accounts** → tick the account → **Assign users or groups** → pick the user → pick `IdpDeveloper` → **Submit**.
5. **Write down** the **AWS access portal URL** (Settings → *Identity source*, or the dashboard). It looks like `https://d-xxxxxxxxxx.awsapps.com/start`.

> Not allowed to use Identity Center? Ask the account admin. Do **not** create an IAM user with long-lived keys, and never put keys in `.env` (00 §4).

### Step 5 — Connect your laptop

```bash
aws configure sso
#  SSO session name:        idp
#  SSO start URL:           <portal URL from step 4.5>
#  SSO region:              <the region where Identity Center is enabled>
#  SSO registration scopes: (press Enter)
#  → the browser opens, you approve, then pick the account and the IdpDeveloper role
#  CLI default region:      <AWS_REGION from step 1>
#  CLI profile name:        idp-dev

aws sso login --profile idp-dev            # run again whenever the session expires
aws sts get-caller-identity --profile idp-dev
```
**Check:** the last command prints your account id and an ARN that contains `AWSReservedSSO_IdpDeveloper`.

### Step 6 — Smoke-test Textract from the CLI (synthetic page)

```bash
pdftoppm -r 150 -jpeg -f 1 -l 1 cms1500-fake.pdf page        # → page-1.jpg
printf '{"Bytes":"%s"}' "$(base64 -i page-1.jpg)" > doc.json
aws textract detect-document-text --document file://doc.json \
  --profile idp-dev --region "$AWS_REGION" \
  --query 'Blocks[?BlockType==`LINE`].Text | [0:10]'
```
**Check:** you see the first 10 printed lines of the form, such as `HEALTH INSURANCE CLAIM FORM`. Common errors:

| Error | Meaning | Fix |
|---|---|---|
| `AccessDeniedException` | The permission set is not assigned, or you used the wrong profile | Step 4.4, `--profile idp-dev` |
| `The SSO session ... has expired` | Login timed out | `aws sso login --profile idp-dev` |
| `UnsupportedDocumentException` | Wrong format or a corrupt file | JPEG/PNG/PDF/TIFF only (HEIC is not supported, D11) |
| `InvalidParameterException` with queries | More than 15 queries on a sync call | Limit from 00 §4 |
| `ProvisionedThroughputExceededException` / `ThrottlingException` | Over the TPS quota | Slow down. Raise the quota for prod (Track 2) |

### Step 7 — Cost guardrail (5 minutes)

- **Where:** console search "Budgets" → **Create budget** → *Customize* → **Cost budget** → monthly, e.g. **$25** for dev → **Filters**: *Service* = **Amazon Textract** → alerts at 50 / 80 / 100 % to the team email.
- Rough cost: about $0.07 per page with forms + tables + queries, and $0.0015 per page for detect only (04 §9). A dev month of fixture recording is a few dollars.

### Step 8 — Hand the values to the developer `.env`

```bash
AWS_REGION=<step 1>
AWS_PROFILE=idp-dev                 # the SDK picks the SSO profile up from here
STORAGE_DRIVER=local
TEXTRACT_TPS_ANALYZE=<step 3>  TEXTRACT_TPS_DETECT=<step 3>  TEXTRACT_TPS_ID=<step 3>  TEXTRACT_TPS_EXPENSE=<step 3>
PHI_MODE=false                      # synthetic only
```
In a host build, put these where the host keeps its env config (recorded in the host's `docs/idp/ADAPTATION.md`).

**Track 1 done when:** step 5 and step 6 checks pass, the budget exists, and the values are in the developer env. Tick it in [`STATUS.md`](STATUS.md).

---

## Track 2 — Staging / Prod (before any real document)

Do these **in order**. Steps 1–2 are compliance gates: until they are done, only synthetic data may be sent, even in staging. Write each step as **IaC** in the place where the host already keeps its infrastructure (its CDK/Terraform/CloudFormation folder, following its conventions). If the host has no IaC, use `infra/idp/` in the host repo. Use the console only to look around and to verify.

| # | What | Where (console) | Exact config | Verify | Owner |
|---|---|---|---|---|---|
| 1 | BAA covers the account | **AWS Artifact** → Agreements | 01 §1 | Status *Accepted*. Evidence in `docs/compliance/aws-baa.md` | Compliance |
| 2 | Opt out of AI-service content use | **AWS Organizations** → Policies → *AI services opt-out policies* | 01 §2 (policy JSON) | Effective policy on the account = `optOut`. No organization → support case id recorded | Account admin |
| 3 | KMS key + rotation | **KMS** → Customer managed keys | 01 §4 | Alias `alias/idp-<env>`, rotation on | Ops |
| 4 | S3: reuse the host bucket under a prefix, **or** a new bucket | **S3** | 01 §5 (block public, SSE-KMS + bucket key, versioning, TLS-only policy, lifecycle) | `aws s3api get-bucket-encryption` shows `aws:kms` | Ops |
| 5 | Task role, least privilege | **IAM** → Roles | 01 §6.1 (policy + trust) | IAM Policy Simulator: the 4 Textract actions plus S3 `t/*` are allowed, everything else denied | Ops |
| 6 | Private network path | **VPC** → Endpoints | 01 §7 (S3 gateway, Textract interface with private DNS, + kms/logs/sts/ecr if there is no NAT) | From a task: `nslookup textract.<region>.amazonaws.com` resolves to a private IP | Ops |
| 7 | Database + Redis/Valkey | **RDS**, **ElastiCache** | 01 §8 (encryption, `rds.force_ssl=1`, `noeviction`) | Connect with TLS. Parameter group shows `noeviction` | Ops |
| 8 | Secrets | **Secrets Manager** | `DATABASE_URL`, `REDIS_URL`, webhook secret, injected as task secrets | Not in the image or the repo | Ops |
| 9 | Audit + alarms + cost | **CloudTrail**, **CloudWatch**, **Budgets**, **Cost Anomaly Detection** | 01 §9 | S3 data events on. Textract throttle and error alarms exist. Budget alerts at 50/80/100 % | Ops |
| 10 | Quota increase | **Service Quotas** → Textract → *Request increase* (use the Textract quota calculator) | 01 §9.5 | Request approved before go-live | Ops |
| 11 | (optional) Async Textract | **SNS** / **SQS** / **IAM** | 01 §11 (topic name must start with `AmazonTextract`) | Only if `TEXTRACT_MODE=async` | Ops |
| 12 | Turn on PHI mode | the host's deploy config | `PHI_MODE=true`, `PHI_BAA_CONFIRMED=true`, `AI_OPTOUT_CONFIRMED=true`, `STORAGE_DRIVER=s3`, `AUTH_MODE=jwt` (05 §12) | The app refuses to boot if any of these is missing | Dev + Compliance |

Then complete the sign-off checklist in 01 §13.

### Shared bucket or new bucket?

- **Reuse the host bucket** when the host already stores these documents in S3 under a BAA. Set `STORAGE_PREFIX=idp/` and scope the task-role policy to `arn:aws:s3:::<bucket>/idp/t/*`. The host bucket must already meet step 4. If it does not, fix the bucket first.
- **New bucket** when the host bucket's encryption, versioning or policy can't be changed, or when the IDP should be separated for audit. That is the 01 §5 path.
