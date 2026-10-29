# 09 — Host Implementation Prompt (one prompt, build in the host's style)

Paste this into an AI coding agent (Claude Code, Cursor, Codex, Copilot…) that has the **host ("main") project** open. The agent learns the plan, scans the host, writes a conventions map, stops once for your approval, and then builds the requested scope task by task **in the host's own coding style**.

## How to use

1. **Make the plan reachable.** Use one of these:
   - give the agent the absolute path of this plan repo (best, because the relative links keep working), or
   - copy this **whole repo** into the host as `docs/idp-plan/` with the same structure, so `idp-workflow.md` and the spec sit next to `docs/superpowers/...`.
2. Make sure the host working tree is clean (`git status`).
3. Fill in the four `<<…>>` inputs at the top of the PROMPT block and paste the whole block as one message.
4. At the checkpoint, read `docs/idp/ADAPTATION.md` in the host and reply `approved` (or give corrections).
5. Rerun the same prompt with a new `REQUIREMENT` to continue to later phases. The agent resumes from `docs/idp/PROGRESS.md`.

Superpowers skills are used when the agent has them. Without them, the same discipline is spelled out inline.

---

## PROMPT

````text
You are implementing a fully planned feature — an Intelligent Document Processing (IDP)
module built on Amazon Textract — INSIDE the host project open in this workspace.
The plan says WHAT to build. The host codebase decides HOW it looks. Do not invent
personal patterns: every structural choice must copy something that already exists in
the host, with evidence.

──────────────────────────────── INPUTS ────────────────────────────────
IDP_PLAN_DIR  = <<path to docs/superpowers/plans/2026-10-28-textract-idp in the plan repo>>
REQUIREMENT   = <<what to deliver now. Examples:
                  "P0–P3: module skeleton, upload, Textract layer, GENERIC extraction end to end"
                  "P4+P7 subset: CMS-1500 + prefill New Patient screen from default.patient profile"
                  "everything up to P8 for CMS1500, UB04, INSURANCE_CARD">>
MODE          = <<auto | inline-module | standalone-service>>   (auto = decide per 08 §3.1;
                  inline-module = 00 §8.2 "Mode B-inline")
CHECKPOINT    = <<yes | no>>   (yes = stop after Phase C and wait for approval. Default yes.)

──────────────────────────────── HARD RULES ────────────────────────────────
1. Plan = WHAT, host = HOW. Follow IDP_PLAN_DIR/00-overview.md §9 exactly:
   §9.1 product invariants are never broken; §9.2 implementation choices are the host's;
   §9.3 resolves conflicts. Re-read §9 before every phase.
2. Evidence for every adopted convention: at least 2 existing host examples, cited as
   path:line. No evidence → do not adopt it, use the plan default, and say so.
3. Never upgrade host framework/runtime/ORM majors. Never add a dependency that is not
   approved in ADAPTATION.md.
4. Change host code only inside the IDP module folder and at the insertion points
   approved in ADAPTATION.md. No drive-by refactors, renames or formatting of other files.
5. Never call AWS, never run cloud CLIs, never use real patient data. Tests replay
   recorded fixtures. Live tests run only when the user explicitly enables RUN_AWS_TESTS.
6. Never write secrets, keys or connection strings into files. Env var NAMES only.
7. Never log extracted values, document text, file names or images (PHI).
8. Never write host domain entities (patient, insurance, claim…) from extraction. Apply
   is human-only and done by the host's own services (00 D9).
9. Work on a new branch named in the host's branch style. Never commit to the default branch.
10. Do not claim something works without running the host's verification commands and
    showing their output.

──────────────────────────────── PHASE A — LEARN THE PLAN ────────────────────────────────
Read fully, in this order: 00-overview.md (all, especially §4, §8, §9), 02-data-model.md,
03-form-definition-dsl.md, 04-textract-layer.md, 05-pipeline-and-api.md,
06-phases-and-tasks.md, 07-testing-and-eval.md, 08-integration-scan-prompt.md,
STATUS.md. Skim 01-aws-setup.md / 01a-aws-walkthrough.md (you will only reference them).
Then map REQUIREMENT to plan tasks: list the exact 06 task ids in scope, their phase order,
and the tasks they depend on. Dependencies that are not done must be pulled in, or the
requirement must be reported as blocked.

──────────────────────────────── PHASE B — SCAN THE HOST (read-only) ────────────────────────────────
B1. Run the full scan in 08-integration-scan-prompt.md STEP 2 and STEP 3, with
    BUSINESS_GOAL = REQUIREMENT. Write its report to docs/idp/INTEGRATION-REPORT.md
    (08's required section layout).
B2. Conventions scan. Read, if present: CLAUDE.md, AGENTS.md, .cursor/rules, CONTRIBUTING*,
    README*, .editorconfig, lint/format configs, tsconfig*, test configs, PR template,
    CI files, and `git log -30 --format='%s'`. Then find the closest existing feature
    module (similar size: controller + service + persistence + tests) and read it fully
    as the TEMPLATE MODULE. For every row in 00 §9.2, record the host equivalent with
    ≥2 path:line examples.
B3. Commands: record the host's exact commands for install, build, typecheck, lint,
    unit test (single file and all), e2e/integration test, migration create/apply,
    and local infra (docker compose…).

──────────────────────────────── PHASE C — ADAPTATION MAP + CHECKPOINT ────────────────────────────────
Write docs/idp/ADAPTATION.md in the host with EXACTLY these sections:
  1. Scope — REQUIREMENT, the 06 task ids in scope (in order), the ones out of scope.
  2. Mode — inline-module or standalone-service, with reasons (cite 08 report §3).
  3. Template module — path, and why it was chosen.
  4. Conventions map — table: concern | plan default | host convention | evidence (≥2
     path:line) | notes. Cover every 00 §9.2 row plus naming (files, classes, DB tables
     and columns), DI and module wiring, error envelope, config, logging, tests.
  5. Path map — for every file in the in-scope 06 tasks: plan path → host path.
  6. Data model translation — every 02 entity → host ORM model/table name, schema or
     prefix choice, and how each 02 §4 SQL item (partial unique index etc.) is expressed
     in the host migration tool.
  7. Commands — from B3.
  8. Invariant adaptations — every place where a host pattern had to be wrapped to keep
     a 00 §9.1 invariant, and how.
  9. New dependencies — name, version, reason. (Empty if none.)
 10. Insertion points — the host files outside the module that will change, from the 08
     report §4, limited to the scope.
 11. Open questions / SPEC-QUESTIONs — each with who should answer it and what it blocks.
Create docs/idp/PROGRESS.md: one checkbox per in-scope task id, all unchecked.

If CHECKPOINT = yes: STOP here. Reply with a summary (mode, template module, top 5
convention decisions, new dependencies, open questions) and wait for "approved" or
corrections. Apply corrections to ADAPTATION.md before continuing.

──────────────────────────────── PHASE D — BUILD ────────────────────────────────
D0. Create the branch. If docs/idp/PROGRESS.md already has ticked tasks, resume from the
    first unticked one (verify the ticked ones still pass first).
D1. Execution skill: if superpowers skills are available, use
    superpowers:subagent-driven-development (when subagents are available) or
    superpowers:executing-plans, with superpowers:test-driven-development per task.
    Treat 06 (translated through ADAPTATION.md) as the plan. Pass every subagent the
    ADAPTATION.md path, the TEMPLATE MODULE path, the task text, and 00 §9.
D2. For each task, in order:
    a. Re-read the task in 06 and the plan sections it references.
    b. Write the failing tests first (the task's cases, in the host test style). Run them
       and confirm they fail for the right reason.
    c. Implement, copying the TEMPLATE MODULE's structure and idioms. Keep the plan's
       interface names and shapes ("Produces") so later tasks fit.
    d. Run the task's tests, then the host's typecheck + lint + affected test suites.
       All green, or stop.
    e. Commit in the host's commit style. Tick the task in PROGRESS.md (same commit).
D3. At the end of each phase, run that phase's acceptance check from 06 / 00 §6 and record
    the result (commands + outcome) in PROGRESS.md.
D4. AWS-dependent steps (e.g. 06 Task 2.6 Step 5, recording fixtures): do NOT run them.
    Add them to PROGRESS.md under "Manual steps for a human" with the exact command and a
    link to 01a-aws-walkthrough.md. Continue with tasks that do not need them. Use
    BlocksBuilder-built graphs until real fixtures exist.

STOP and ask (do not guess) when: a task cannot be done without breaking a 00 §9.1
invariant; a needed host pattern is missing and the plan default would clash with host
style; a dependency not in ADAPTATION.md is needed; a test fails twice for an unclear
reason; adding a form seems to need pipeline changes (03 §9 says that is a DSL gap).

──────────────────────────────── PHASE E — FINISH ────────────────────────────────
1. Run the full host verification (build, typecheck, lint, all tests). Show the output.
   (superpowers:verification-before-completion)
2. Self-review against: 00 §9.1 invariants, the conventions map, no PHI in logs, no host
   writes, no AWS calls in tests, no unapproved dependencies, no changes outside the
   approved insertion points. (superpowers:requesting-code-review if available)
3. Update PROGRESS.md and ADAPTATION.md §11 (open questions).
4. Use superpowers:finishing-a-development-branch to offer: open a PR (description in the
   host's PR template), keep the branch, or merge locally. Do not push without consent.
5. Reply with: the branch name, tasks done and verified, acceptance results per phase,
   manual AWS steps waiting for a human, open questions, and the suggested next
   REQUIREMENT.
````

---

## Example REQUIREMENT values (recommended order)

| Run | REQUIREMENT | Needs from AWS (01a) |
|---|---|---|
| 1 | `P0–P1: IDP module skeleton with ports, data model + migration, storage adapter over the host S3 service, upload + dedupe + rasterize + page image` | nothing |
| 2 | `P2–P3: Textract layer, Evidence, DSL, resolvers, mapper, GENERIC end to end (fixtures from BlocksBuilder until real ones are recorded)` | dev track to record fixtures (can come later) |
| 3 | `P4 + P5: CMS-1500 definition, eval script, classification and segmentation` | dev track + CMS-1500 synthetic fixtures |
| 4 | `P7: review, autofill, host target profiles for <host DTOs>, outbox events, apply events, plus host insertion points (upload button, Documents tab, New Patient prefill)` | nothing new |
| 5 | `P6: <forms you need>` | fixtures per form |
| 6 | `P8–P9: queue, reprocess, S3/KMS, RLS, retention, observability, deploy` | prod track |

## Why this works across projects

- The **plan** is stack-neutral where it matters (contracts, data semantics, invariants) and specific only as a default.
- The **conventions map** forces the agent to prove each pattern from host code before using it, so the output reads like the host team wrote it.
- **PROGRESS.md** makes the build resumable across sessions and agents. The **checkpoint** catches a wrong mode or template choice before any code is written.
