# IDP — Status and What Is Left

**Last updated:** 2026-10-29
**Repo role:** plan only. No code is written here. The build happens in the host ("main") project through [`09-host-implementation-prompt.md`](09-host-implementation-prompt.md).

## Done

- [x] Research and workflow: `idp-workflow.md`, `document-extraction-system-spec-1.md`, the NestJS multi-form research note (repo root)
- [x] Technical plan `00`–`08`: decisions, AWS reference, data model, form DSL, Textract layer, pipeline + API, phases P0–P9, testing + eval, integration scan prompt
- [x] Host adaptation rules (`00` §9, decision D13). Build-in-host notes in `06`
- [x] One-shot host implementation prompt (`09`)
- [x] Guided AWS walkthrough (`01a`)
- [x] Vendor research: VLM Run and Meibel, with a comparison, a shared engine adapter and implementation plans ([`docs/research/vendors/`](../../../research/vendors/README.md))
- [x] Engine POC (2026-10-30), in [`idp-engine-poc/`](../../../../idp-engine-poc/README.md) at the repo root (Node 22, Nest 11, Prisma 7.4, BullMQ): one `ExtractionEngine` seam with Textract, VLM Run, Meibel and fake adapters chosen by env, plus a per-document compare endpoint. This is evidence for Q15. Vendor response shapes are still UNVERIFIED until the first synthetic run (POC `docs/MANUAL-SETUP.md` §4)

## Left to do — before or alongside the build (not coding)

### 1. Decisions (answer these; each one blocks the item in the last column)

| # | Question | Who answers | Blocks |
|---|---|---|---|
| Q1 | Which repo is the "main" host project, and is it inline module or standalone service? (`09` MODE; `08` §3.1 rules) | You / host team | Running `09` |
| Q2 | First-release scope: which forms (CMS1500, UB04, BOOKING_SHEET, INSURANCE_CARD, US_ID, INVOICE) and which screens get prefill | Product | `09` REQUIREMENT for run 3+ |
| Q3 | AWS region and account (same as the host bucket) | Ops | AWS Track 1 |
| Q4 | Reuse the host S3 bucket with `STORAGE_PREFIX`, or a new bucket (`01a` Track 2) | Ops + compliance | P9 Task 9.1 |
| Q5 | Retention periods for originals, page images and Textract JSON (`02` §7; spec-1 open decision 5) | Compliance | P9 Task 9.4 |
| Q6 | Auth: JWT/OIDC issuer, JWKS URL, tenant and user claim names (`06` Task 9.5) | Host team | P9 Task 9.5 (dev uses the header or a host-guard adapter) |
| Q7 | Host DTO field names for the patient, insurance and bundle profiles (`05` §9.3) | Host team (the `09` scan proposes them) | P7 Task 7.3 |
| Q8 | Host document-type label list (`DocTypeLabelsPort`); the workflow lists Booking sheet / Facility / Physician / Anesthesia claim / Letter / Other | Host team | P4 Task 4.3, P7 |
| Q9 | ICD-10: allow the `U` codes (e.g. `U07.1`) in the validator? (`06` Task 3.4) | Product / coding expert | P4 |
| Q10 | Insurance card aspect-ratio cue: pass page width/height to the scorer? (`06` Task 6.3) | Tech lead | P6 Task 6.3 |
| Q11 | OpenAPI: `@nestjs/swagger` or a hand-written yaml (or whatever the host uses) (`05` §11) | Host team | P7 Task 7.5 |
| Q12 | IaC tool and location (the host's CDK/Terraform folder, or `infra/idp/`) | Ops | Track 2 |
| Q13 | Real package scope instead of `@your-org/idp`; the `HOST_NAME_DENYLIST` values | Tech lead | P0 Task 0.6, P9 Task 9.10 |
| Q14 | Textract bundled pricing for FORMS+TABLES+QUERIES: confirm against the first invoice (`04` §9) | Ops / finance | Cost report accuracy only |
| Q15 | Accept D14 (multi-engine: Textract default + schema engines)? ([shared adapter](../../../research/vendors/shared-engine-adapter.md) §1) | Tech lead + product | Shared tasks S1–S8 |
| Q16 | VLM Run: go to Pro ($799/mo) and sign the BAA? Send the vendor questions ([research §8](../../../research/vendors/vlm-run/research.md)) | Product + compliance | VLM Run with real PHI (V0) |
| Q17 | Meibel: send the vendor questions ([research §8](../../../research/vendors/meibel/research.md)). Pursue only if a BAA/BYOC is available and agents/Q&A are wanted | Product + compliance | Meibel plan (MB0) |

### 2. AWS (see [`01a`](01a-aws-walkthrough.md))

- [ ] **Track 1 — Dev** (needed before fixtures are recorded in P2; P0–P1 need nothing)
  - [ ] Region picked; Textract features confirmed (01a steps 1–2)
  - [ ] Quotas written down (step 3)
  - [ ] Identity Center user + `IdpDeveloper` permission set (step 4)
  - [ ] `aws configure sso` + `get-caller-identity` OK (step 5)
  - [ ] CLI smoke test returns lines (step 6)
  - [ ] Dev budget for Textract (step 7)
  - [ ] Values in the developer env (step 8)
- [ ] **Track 2 — Staging/Prod** (before the first real document)
  - [ ] BAA confirmed and recorded (gate)
  - [ ] AI services opt-out effective (gate)
  - [ ] KMS, S3, task role, VPC endpoints, RDS/Valkey, Secrets, CloudTrail/alarms/budget/anomaly, quota increase
  - [ ] `01` §13 sign-off checklist complete

### 3. Test data (synthetic only — see `07` §3)

- [ ] Blank templates collected: CMS-1500 (NUCC), UB-04, one or more booking-sheet layouts used by the host's customers (with names and values replaced), sample insurance cards, AWS/state sample driver licenses, sample invoices
- [ ] Filled with **fake** data; count per form as in `07` §3 (POC minimum: CMS1500 20, UB04 20, BOOKING 20, CARD 10, ID 5, INVOICE 5, GENERIC 10, mixed packets 5)
- [ ] `expected.json` written by hand per case (the contract; never loosened to make a test pass)
- [ ] Fixtures recorded with `npm run record-fixture` (or the host's equivalent) once Track 1 is done. About $0.07 per page

### 4. Host preparation

- [ ] Make this plan reachable from the host (absolute path, or copy the whole repo into `docs/idp-plan/`, see `09` "How to use")
- [ ] Host working tree clean; the host team agrees on the branch name
- [ ] Run `09` with run 1 from its table; review `docs/idp/ADAPTATION.md` at the checkpoint
- [ ] Answer the open questions the `09` scan raises (they also go in the host's `docs/idp/ADAPTATION.md` §11)

## Build progress (done in the host; tracked in the host's `docs/idp/PROGRESS.md`)

| Phase | Status | Needs AWS? | Notes |
|---|---|---|---|
| P0 Foundation | not started | no | |
| P1 Ingest + rasterize | not started | no | needs `poppler` locally and in the image |
| P2 Textract layer | not started | Track 1 for recording only | unit tests use BlocksBuilder until fixtures exist |
| P3 DSL + GENERIC | not started | no (fixtures) | |
| P4 CMS-1500 | not started | fixtures | needs Q9 |
| P5 Classify + segment | not started | fixtures | |
| P6 More forms | not started | fixtures per form | needs Q2, Q10 |
| P7 Review/autofill/integration | not started | no | needs Q7, Q8, Q11 |
| P8 Queue + reprocess | not started | no | |
| P9 Hardening + deploy | not started | Track 2 | needs Q4, Q5, Q6, Q12, Q13 |

Update this table when a host run finishes (copy from the host's `PROGRESS.md`).
