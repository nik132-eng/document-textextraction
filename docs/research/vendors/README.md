# Extraction Engine Research — VLM Run and Meibel

Alternatives and additions to Amazon Textract for the IDP: staff upload patient documents, we store them, extract the fields, and prefill host screens after human review.

| File | What it is |
|---|---|
| [`comparison.md`](comparison.md) | **Start here.** Textract vs VLM Run vs Meibel: capabilities, compliance, cost, per-form recommendation, decision gates |
| [`shared-engine-adapter.md`](shared-engine-adapter.md) | How any schema-first engine plugs into the IDP (decision D14 proposed, DSL + Evidence extensions, hallucination guard, `EngineCall`, bake-off, shared tasks S1–S8) |
| [`vlm-run/research.md`](vlm-run/research.md) | VLM Run: APIs, domains, grounding/confidence, pricing, BAA, risks, vendor questions |
| [`vlm-run/implementation-plan.md`](vlm-run/implementation-plan.md) | Tasks V0–V8 (prereqs, client, engine, evidence, M2, M1 overlay, fixtures, bake-off, webhook/ops) |
| [`meibel/research.md`](meibel/research.md) | Meibel: parse, deep transform, confidence scoring, pricing, deployment, compliance gaps, vendor questions |
| [`meibel/implementation-plan.md`](meibel/implementation-plan.md) | Tasks MB0–MB7 (gated on a BAA or BYOC) |

**Recommendation:** Textract stays the default. Add VLM Run next (overlay first, then primary for variable layouts after the bake-off). Park Meibel until a BAA or BYOC is confirmed and agents or Q&A are wanted.

**To build:** run [`09-host-implementation-prompt.md`](../../superpowers/plans/2026-10-28-textract-idp/09-host-implementation-prompt.md) in the host project, with `REQUIREMENT` naming the task ids from these plans.
