# 08 — Integration Scan Super-Prompt

Use this prompt to point an AI coding agent at **any** host project. The agent reads this plan, scans the host codebase, and produces a concrete, evidence-backed answer to three questions: **where** the IDP feature fits, **how** it should connect (standalone service or embedded module), and **what** to build on the host side.

## How to use

1. Open the **host project** in your agent (Claude Code, Cursor, Copilot Chat, Windsurf…), with this plan folder accessible (copy it into the host repo under `docs/idp-plan/`, or give the agent the absolute path).
2. Paste everything inside the `PROMPT` block below as one message. Fill in the three `<<…>>` values first.
3. The agent works **read-only** and writes one file: `docs/idp-integration/INTEGRATION-REPORT.md` in the host repo.
4. Review the report and answer its open questions.
5. To **build** it, use [`09-host-implementation-prompt.md`](09-host-implementation-prompt.md). It runs this scan as its first step, so you do not need to run 08 separately unless you only want a fit check.

---

## PROMPT

````text
You are a senior integration architect. Your job: decide WHERE and HOW to fit an
existing, fully planned product — an Intelligent Document Processing (IDP) service
built on Amazon Textract — into the host project open in this workspace, and produce
a precise integration report plus a host-side implementation task list.

──────────────────────────────── INPUTS ────────────────────────────────
IDP_PLAN_DIR   = <<absolute or repo-relative path to the plan folder, e.g. docs/idp-plan/>>
HOST_REPO_ROOT = <<path to the host project root, usually "." >>
BUSINESS_GOAL  = <<one or two sentences: what the host wants from document extraction,
                   e.g. "prefill new-patient and insurance screens from uploaded packets,
                   and attach extracted claim lines to billing bundles">>

──────────────────────────────── HARD RULES ────────────────────────────────
1. READ-ONLY. Do not modify, create, or delete any file except the single output report
   (and its folder): HOST_REPO_ROOT/docs/idp-integration/INTEGRATION-REPORT.md
2. No installs, no migrations, no network calls, no cloud CLI calls, no running the app.
   You may run read-only shell commands (ls, find, grep/rg, cat, git log/status, package
   manager "list/why" commands that do not modify lockfiles).
3. Evidence for every claim. Every finding about the host cites `path:line` (or a path
   plus the symbol name). If you could not verify something, write "UNVERIFIED" and say
   what you looked for.
4. Never copy secrets, credentials, connection strings, or any real patient/customer data
   into the report. Refer to env var NAMES only. If you see PHI or secrets in the repo,
   list the file path under "Risks" without quoting the content.
5. Do not invent host APIs, DTO fields, tables, or routes. If the host has no matching
   concept, say so and propose one as a NEW host-side item.
6. Respect the IDP product boundaries (from the plan): the IDP core never writes to host
   tables, holds no host names, owns its own database/schema, and integrates only via
   REST + outbox events (Mode A) or the IdpModule dynamic module + ports (Mode B).
   Anything host-specific goes in HOST code or in a port adapter — never in IDP core.
7. Be decisive. Where there is a choice, give ONE recommendation with the reason, then
   list the alternative in one line.

──────────────────────────────── STEP 1 — LEARN THE PRODUCT ────────────────────────────────
Read these files from IDP_PLAN_DIR fully, in this order, before touching the host repo:
  00-overview.md            (decisions D1–D12, architecture, constraints, §8 plug-and-play: Mode A/B, ports)
  05-pipeline-and-api.md    (REST API §11, events §10, autofill/profiles/apply §9, env §12)
  02-data-model.md          (IDP-owned tables, DocumentLink, ApplyEvent, OutboxEvent, storage keys)
  03-form-definition-dsl.md (forms, canonical dictionary §3, how new forms are added §9)
  01-aws-setup.md           (AWS prerequisites: BAA, AI opt-out, KMS, S3, IAM, VPC endpoints)
  04-textract-layer.md, 06-phases-and-tasks.md, 07-testing-and-eval.md (skim; needed for task mapping)

Write for yourself (not the report) a short "product contract" summary:
  - the 6 ports and their defaults (AuthPort, EventSinkPort, TargetProfilePort,
    DocTypeLabelsPort, PayerDirectoryPort, StoragePort)
  - the REST endpoints the host will call, and the events it will receive
  - the canonical keys list (03 §3) — you will map host fields onto these
  - the global constraints (00 §4) that could conflict with a host (Node ≥24, NestJS 12,
    Prisma 7.10, Postgres ≥16, Zod 4, AWS SDK v3, poppler-utils, Redis/Valkey for queues)

──────────────────────────────── STEP 2 — SCAN THE HOST ────────────────────────────────
Scan HOST_REPO_ROOT systematically. For each area, record findings with evidence.
Skip node_modules, dist, build, .next, vendor, coverage, generated clients.

A. Stack and shape
   - Languages, frameworks, versions (package.json / lockfile / pyproject / go.mod / pom /
     *.csproj). Monorepo? (nx, turbo, pnpm/yarn workspaces, lerna). List apps/packages.
   - Backend framework: NestJS (version?), Express/Fastify, Next.js API routes, Django,
     Spring, .NET, other. Frontend framework and where its app lives.
   - Node version (.nvmrc, engines, Dockerfile base image), TypeScript strictness.
   - Test runner(s), lint, CI pipeline files, Docker/compose, IaC (CDK/Terraform/CFN/
     Serverless/Helm), deploy target (ECS, EKS, Lambda, VM).

B. Data and persistence
   - DB engines and ORMs (Prisma version?, TypeORM, Sequelize, MikroORM, Knex, raw SQL).
   - Migration tool and folder. Multi-tenancy model (tenantId column, schema-per-tenant,
     DB-per-tenant, RLS) — cite where tenant scoping is enforced.
   - Entities that IDP output will feed. Search for: patient, member, subscriber,
     insurance, coverage, policy, payer, carrier, claim, bundle, encounter, visit, case,
     booking, surgery, appointment, provider, npi, facility, document, attachment, file,
     upload. For each: table/entity file, key fields, and the DTO used to create/update it.

C. Existing document / file handling (the most likely insertion points)
   - Upload endpoints (multer, busboy, presigned PUT, FilePond/uppy on frontend).
   - Storage (S3 client usage, bucket env names, key layout, KMS, local disk).
   - Existing "documents" lists/tabs, attachment models, PDF viewers, OCR or parsing code,
     any previous extraction attempt (tesseract, pdf-parse, LLM calls) — these may be
     replaced or wrapped.
   - Frontend screens where prefill would be valuable: new/edit patient, insurance,
     claim/bundle creation, intake, scheduling/booking. Cite component files and the form
     state library (react-hook-form, formik, redux, signals…).

D. Cross-cutting
   - AuthN/AuthZ: JWT/OIDC provider, guard/middleware files, how userId and tenantId are
     obtained per request, roles/permissions relevant to "review" and "apply".
   - Events/async: queues (BullMQ, SQS, SNS, Kafka, RabbitMQ, EventBridge), event bus,
     webhooks, cron. Redis presence and config.
   - Config: env loading/validation approach, secrets source (Secrets Manager, SSM, Vault).
   - Logging/observability: logger lib, PII redaction, metrics, tracing.
   - AWS footprint: account/region hints, SDK version (v2 `aws-sdk` vs v3 `@aws-sdk/*`),
     existing IAM/task-role definitions in IaC, VPC endpoints.
   - Compliance signals: HIPAA/BAA notes, PHI handling docs, audit tables, data retention.

E. Domain vocabulary
   - How the host names document kinds (e.g. "Booking sheet", "Facility claim",
     "Physician claim", "Anesthesia claim", "Letter", "Other") — these become the
     DocTypeLabelsPort list. Cite enums/constants/UI option lists.

──────────────────────────────── STEP 3 — DECIDE THE FIT ────────────────────────────────
3.1 Integration mode — choose ONE using these rules, and justify with evidence:
   - Mode B (embed IdpModule) only if ALL hold: backend is NestJS with a major version
     compatible with 12 (or a clean upgrade path), Node ≥24 is acceptable, the host can
     give IDP its own Postgres database/schema, and the team wants a single deployable.
   - Otherwise Mode A (standalone IDP service + REST + events). Mode A is also preferred
     when the host is not Node/NestJS, uses an incompatible Nest/Node/Prisma major, has
     strict deploy separation, or needs IDP to scale independently.
   - Note any version conflicts (Nest, Node, Prisma, Zod, AWS SDK v2) and how the chosen
     mode avoids or resolves them.

3.2 Insertion points — for each, give: host file(s), what changes on the host side,
    which IDP endpoint/event/service it uses, and the user-visible behaviour.
   - Capture: every place a user uploads a document → POST /documents (with links,
     source, formTypeHint/docTypeLabel when the UI already knows the type).
   - Status/listing: documents tab/list → GET /documents?link=… + events.
   - Review: where staff will review flagged fields (existing screen to extend, or new).
   - Prefill/preview: each target screen → GET /segments/:id/preview/:profile
     (prefill EMPTY inputs only; never overwrite typed values without asking).
   - Apply: host saves through its OWN existing APIs, then POST /segments/:id/apply-events.
   - Downstream: anything that should react to segment.approved / segment.applied.

3.3 Port adapters — for each of the 6 ports: keep default or write a host adapter?
    If an adapter: file location in the host, the host symbols it wraps, and its config.

3.4 Target profiles (field mapping) — for each host DTO that will be prefilled
    (e.g. CreatePatientDto, UpdateInsuranceDto, ClaimBundle draft):
    produce a table: host DTO field | type | canonical key (03 §3) | transform | notes.
    Mark host fields with NO canonical key as "GAP" and propose either a new canonical
    key (core change, needs review) or leaving it manual. Mark canonical keys the host
    cannot store as "UNUSED".

3.5 Forms in scope — which IDP forms matter for BUSINESS_GOAL (CMS1500, UB04,
    BOOKING_SHEET, INSURANCE_CARD, US_ID, INVOICE, GENERIC) and whether the host needs
    any NEW form definition (name it, list fields, cite evidence such as sample templates
    or document types in the host). New forms must follow 03 §9 — no core changes.

3.6 Infrastructure fit — map 01-aws-setup.md to the host's actual AWS setup:
    which steps are already satisfied (cite IaC), which are new, and where the new IaC
    should live in the host repo. Same region/account as the host bucket?

3.7 Data and tenancy — how host tenantId/userId map to IDP tenantId/reviewer/appliedBy;
    how DocumentLink entityType/entityId map to host entities (e.g. patient:<uuid>).

3.8 Risks and conflicts — version conflicts, missing BAA/opt-out evidence, PHI in logs,
    shared-bucket key collisions (use STORAGE_PREFIX), auth gaps, places where the host
    silently writes extracted data (forbidden: apply must be human).

──────────────────────────────── STEP 4 — WRITE THE REPORT ────────────────────────────────
Write HOST_REPO_ROOT/docs/idp-integration/INTEGRATION-REPORT.md with EXACTLY these sections:

# IDP Integration Report — <host project name>
Date · Plan version (folder name) · Host commit (git rev-parse --short HEAD) · Scanned paths

## 1. Executive summary
5–8 bullets: recommended mode, top insertion points, biggest risks, effort estimate
(S/M/L per workstream), and the first thing to do.

## 2. Host snapshot
Table: area | finding | evidence (path:line). Covers stack, versions, DB/ORM, tenancy,
auth, storage, queues, AWS, frontend, CI/deploy, compliance signals.

## 3. Recommended integration mode
Decision, reasons with evidence, rejected alternative in one line, version-conflict notes.

## 4. Insertion points
Table: # | user flow | host files | IDP endpoint/event/service | host-side change | UX rule.
Include a mermaid sequenceDiagram for the main flow (upload → extract → review → prefill → apply).

## 5. Port adapters
Table: port | default or adapter | host file to create | wraps (host symbols) | config/env.

## 6. Target profiles (field mappings)
One table per host DTO (see 3.4). Then a "Gaps" list and an "Unused canonical keys" list.

## 7. Forms in scope
Table: form id | used for | priority (P1/P2/P3) | needs new definition? | evidence.

## 8. Infrastructure and AWS
Checklist mapped to 01-aws-setup.md sections: already done (evidence) / to do (where).
Env vars the host must provide (names only), and where they are configured.

## 9. Data, tenancy and identity mapping
tenantId, userId, DocumentLink entityType values, docTypeLabel list (DocTypeLabelsPort).

## 10. Risks, conflicts, compliance
Table: risk | severity (high/med/low) | evidence | mitigation.

## 11. Host-side implementation plan
Ordered tasks the HOST team implements, aligned with IDP phases in 06-phases-and-tasks.md
(state which IDP phase must be complete before each host task can start). Each task:
  - title, files to create/modify (exact host paths), interfaces used (exact IDP endpoint
    or exported symbol), acceptance test (concrete), dependency on IDP phase.
Group as: H0 prerequisites (AWS/compliance) · H1 capture · H2 status/list ·
H3 review UI · H4 prefill/profiles · H5 apply + events · H6 rollout/monitoring.
Do not include IDP-core tasks here — reference them by IDP task id (e.g. "needs IDP P7 Task 7.3").

## 12. Changes requested to the IDP plan (if any)
Only items the host truly needs that the plan does not cover (e.g. a new canonical key,
a new port, a new event type). For each: why, evidence, proposed minimal change, and
confirmation that it keeps the core host-agnostic. If none, write "None".

## 13. Open questions
Numbered, each with who should answer (product, security/compliance, ops, host team)
and what decision it blocks.

## 14. Evidence index
List of every file you read, with one-line purpose.

──────────────────────────────── QUALITY BAR ────────────────────────────────
Before finishing, self-check and fix:
- Every host claim has evidence or is marked UNVERIFIED.
- Every profile mapping uses a canonical key that exists in 03 §3 (or is listed as a GAP).
- Every insertion point names a real host file and a real IDP endpoint from 05 §11.
- No secrets, no PHI, no real names/values copied.
- No proposal writes host data automatically from extraction (apply is human-only).
- No host-specific names or logic placed inside the IDP core.
- Section 11 tasks are concrete enough that an engineer new to the host can start
  without asking where files are.

When done, reply with: the report path, the recommended mode in one line, the top 3
insertion points, and the open questions that block starting.
````

---

## Variants

- **Quick fit check (15 minutes):** add to the end of the prompt: `Limit to sections 1, 3, 4, 10, 13. Skip profiles and the task plan.`
- **Multiple hosts:** run the prompt once per host repo, then ask the agent to diff the reports and list any requested plan changes (section 12) that more than one host needs. Those are candidates for the IDP core.
- **Non-Node host (Python, Java, .NET):** the rules already force Mode A. Additionally ask: `Generate a typed REST client outline for the host language from 05 §11 and the event payloads from 05 §10, placed in section 11 H1.`
