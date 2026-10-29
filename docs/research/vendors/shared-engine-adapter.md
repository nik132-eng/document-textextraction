# Shared Design — Plugging a Schema-First Engine (VLM Run or Meibel) into the IDP

**Status:** proposed (decision D14 below is not yet accepted).
**Read first:** [`00-overview.md`](../../superpowers/plans/2026-10-28-textract-idp/00-overview.md) (D1, D4, §9), [`03`](../../superpowers/plans/2026-10-28-textract-idp/03-form-definition-dsl.md) §1, [`04`](../../superpowers/plans/2026-10-28-textract-idp/04-textract-layer.md) §5–6.
**Used by:** [`vlm-run/implementation-plan.md`](vlm-run/implementation-plan.md), [`meibel/implementation-plan.md`](meibel/implementation-plan.md).

Both vendors are **schema-first**. You send a page or file plus a JSON Schema, and they return filled JSON with per-field location and some form of confidence. Textract is **evidence-first**: it returns OCR blocks, and our resolvers find the fields. The IDP was designed for this from day one (D4: an engine-neutral Evidence model). A new engine therefore needs:
- one adapter folder,
- a small DSL extension,
- one new Evidence item type,
- one new call table.

No pipeline, API or flattener changes are needed.

---

## 1. Decision to add (D14, proposed)

> **D14 — Multi-engine.** Textract stays the default engine (D1). A form definition may name a **schema engine** (`vlmrun` | `meibel`) as its primary engine. Any field may name one as an **overlay**, a second opinion called only when the primary value is missing or low-confidence. Engines are enabled per environment, and in `PHI_MODE` each one needs its own confirmed BAA.

D1 changes from "Textract is the only engine in v1" to "Textract is the default engine". Everything else in `00` §4 and §9.1 still holds, including D8 (never invent data), which §6 below enforces for generative engines.

## 2. Three ways to use a schema engine (pick per form, in this order of safety)

| Mode | What happens | When | Cost impact |
|---|---|---|---|
| **M1 Overlay** | Textract runs as today. Only the fields flagged `low_confidence`/`not_found`/`unreadable` on a page are re-asked to the schema engine. Its answer is stored as a second candidate, and the reviewer sees both | Handwritten or faxed booking sheets, CMS-1500 Box 24 on bad scans | Small: only flagged pages |
| **M2 Primary engine per form** | `engine: { api: 'Schema', provider }` in the definition. Textract is not called for extraction on that form | Layouts that vary a lot (booking sheets, intake, referrals), where cue/region definitions are hard to maintain | Replaces the Textract cost for that form |
| **M3 Classifier fallback** | Pages scoring between 0.2 and `minScore` are sent to the engine with a fixed label set (`ClassifierFallback` port, `05` §3.3) | Mixed packets where cue scoring is weak | One cheap call per ambiguous page |

**Default recommendation:** M1 first, then M2 for one form after the bake-off (§8) shows it beats Textract on that form. M3 only if classification accuracy stays below 98%.

## 3. DSL extension (`03` §1)

```ts
export type SchemaProvider = 'vlmrun' | 'meibel';

// FormDefinition.engine gains one member
engine:
  | { api: 'AnalyzeDocument'; features: AnalyzeFeature[] }
  | { api: 'AnalyzeID' } | { api: 'AnalyzeExpense' }
  | { api: 'Schema'; provider: SchemaProvider;
      options?: { model?: string; detail?: 'lo' | 'hi' | 'auto'; guidance?: string; rootName?: string } };

// FieldSource gains two members
  | { kind: 'schemaField'; path?: string }                            // default path = FieldDef.path
  | { kind: 'overlay'; provider: SchemaProvider; path?: string; when?: ('low_confidence'|'not_found'|'unreadable')[] }

// GroupSource gains one member
  | { kind: 'schemaArray'; path?: string }                            // default path = GroupDef.path
```

**Validator additions (`03` §2):**

| Check | Code |
|---|---|
| `schemaField`/`schemaArray` used and `engine.api !== 'Schema'` | `DEF_API` |
| `overlay` provider not enabled in env | `DEF_ENGINE_DISABLED` (warning in dev, error in `PHI_MODE`) |
| The generated JSON Schema exceeds the provider's documented limits (§4) | `DEF_SCHEMA_LIMIT` |

The **form stays data**: no provider code inside `src/forms/definitions/**`.

## 4. JSON Schema builder (`src/engines/schema/json-schema.builder.ts`)

`buildJsonSchema(def: FormDefinition): { schema: JSONSchema7; schemaHash: string }`. It is the schema-engine equivalent of the queries builder (`04` §8).

Rules:
- **Ask for text as printed, not normalized.** Leaves are `{ type: ['string','null'] }`, except checkboxes (`boolean | null`) and checkbox groups (`enum` of option values, plus null). Normalization stays in our code (D7), so engines are comparable and fixtures stay stable.
- **Nested objects follow native paths:** `box2.last` → `{ box2: { last } }`. Groups → `array` of objects with the column paths.
- `description` = the field `label` plus a one-line hint (`"as printed; null if blank"`). There are no examples with values, so no PHI goes into prompts.
- `required` lists every property (with nulls allowed), so engines return explicit nulls instead of omitting keys.
- `schemaHash = sha256(canonical JSON of the schema + provider + options)`. It feeds the call `requestHash`, so a schema change means a billed re-run (like a query change), and an unchanged schema means a free remap.

## 5. Evidence extension (`04` §5)

```ts
export interface EvSchemaField {
  path: string;                       // native path, with [i] for array rows: 'box24[2].cptHcpcs'
  value: string | boolean | null;
  confidence: number | null;          // 0..100 after provider mapping; null = provider gave none
  confidenceSource: 'numeric' | 'band' | 'judged' | 'none';
  page: number | null;                // DOCUMENT page number
  bbox: BBox | null;                  // normalized 0..1, top-left origin (same as Textract)
  groundingText?: string;             // text the engine says it read at bbox (if provided)
}
export interface Evidence {
  engine: 'textract' | 'vlmrun' | 'meibel';
  pages: EvidencePage[];              // vendor OCR lines/tables when the provider returns them; may be empty
  schemaFields?: EvSchemaField[];
  overlays?: Record<SchemaProvider, EvSchemaField[]>;   // M1 second opinions
  idFields?: EvIdField[]; expense?: {...};
}
```

**Resolvers:**
- `schemaField`: look up `schemaFields` by path. Value `null` means blank. The confidence threshold rules in `04` §6.1 apply unchanged.
- `schemaArray`: collect `path[i].*` rows, then `dropEmptyRows`.
- `overlay`: runs only after the primary resolution, and only if the primary result has one of the `when` flags. The overlay value is stored as a **candidate**. It does not replace the primary value unless the primary is `null`. Either way, the field keeps a review flag (`overlay_suggested`). The reviewer picks.

## 6. Hallucination guard (keeps D8 for generative engines)

Generative engines can return a plausible value that is not on the page. Three checks run in `FinalizerService` for any value whose source is `schemaField` or `overlay`:

1. **Ungrounded:** a non-null value with `bbox === null` or `page === null` → flag `ungrounded` → `NEEDS_REVIEW`.
2. **OCR cross-check (default on in `PHI_MODE`):** take the OCR words inside `bbox`, from the Textract `DetectDocumentText` lines already bought for classification ($0.0015/page) or from the vendor's own OCR. If `normalizeLabel(value)` is not a fuzzy match (`matchScore` ≥ 0.8) of those words → flag `ocr_mismatch`. Checkbox values skip this check.
3. **No confidence:** `confidenceSource === 'none'` → treated as below threshold → `low_confidence`.

The new flags `ungrounded`, `ocr_mismatch` and `overlay_suggested` join the review flag set in `05` §7 step 5 and §9.1. This is an additive change to the flag vocabulary, so it needs a **minor** version bump of the events and fields contract.

## 7. Calls, storage, cost (`02` additive)

A new immutable table, `EngineCall`. It is additive, so `TextractCall` is untouched:

```prisma
model EngineCall {
  id           String   @id @default(uuid()) @db.Uuid
  tenantId     String
  documentId   String   @db.Uuid
  segmentId    String?  @db.Uuid
  provider     String                     // 'vlmrun' | 'meibel'
  api          String                     // 'document.generate' | 'systemone' | 'deep-transform' | 'parse'
  externalId   String?                    // vendor prediction / job id
  requestHash  String                     // sha256(provider|api|schemaHash|options|page sha256s)
  schemaHash   String?
  pageNumbers  Int[]
  status       String                     // SUBMITTED | SUCCEEDED | FAILED
  responseKey  String?                    // t/{t}/d/{d}/engine/{provider}/{id}.json.gz
  costUsd      Decimal? @db.Decimal(10,5) // ACTUAL cost from the vendor response when given
  estCostUsd   Decimal? @db.Decimal(10,5)
  latencyMs    Int?
  modelVersion String?
  error        String?                    // error code only, never content
  createdAt    DateTime @default(now())
  @@unique([tenantId, requestHash, status])   // the reuse rule from 04 §1, per provider
  @@index([documentId])
}
```

`Extraction.textractCallIds` stays. Add `engineCallIds String[]`. Remap reuses stored engine responses exactly like Textract ones.

## 8. The bake-off (decides M2) — extends `07`

`npm run eval -- --form <ID> --engine textract|vlmrun|meibel [--live]` runs the same golden set and `expected.json` through each engine. It adds these columns to the `07` §4 report:

| Metric | Gate to adopt an engine for a form (M2) |
|---|---|
| Critical-field exact match | ≥ Textract's plus 2 points, **or** equal at lower cost |
| **Accepted-but-wrong** (critical) | ≤ 1% (same safety gate as `07` §4.3) |
| `ungrounded` + `ocr_mismatch` rate | ≤ 2% of non-null values |
| Review rate | not worse than Textract by more than 5 points |
| Cost per page (actual `costUsd`) | reported. Must fit the budget in `idp-workflow.md` §9 |
| p95 latency | ≤ 60 s per page in sync mode |

Synthetic data only, until the vendor BAA is signed (see each vendor's §0).

## 9. Code layout (standalone defaults; map through `00` §9.2 in a host)

```
src/engines/
  engine.port.ts                  # SchemaEnginePort { submit, poll, fetch, toEvidence, deleteRemote }
  engine-call.repository.ts       # EngineCall + raw response storage (write storage before DB, like 04 §3)
  engine-gateway.service.ts       # getOrCall with requestHash reuse; budget guard
  schema/json-schema.builder.ts
  schema/schema-field.resolver.ts, schema-array.resolver.ts, overlay.resolver.ts
  guard/hallucination.guard.ts    # §6
  vlmrun/**                       # see vlm-run/implementation-plan.md
  meibel/**                       # see meibel/implementation-plan.md
```

```ts
export interface SchemaEnginePort {
  readonly provider: SchemaProvider;
  submit(i: { tenantId: string; pages: { pageNumber: number; bytes: Buffer; mime: string }[];
              schema: JSONSchema7; options: Record<string, unknown> }): Promise<{ externalId: string }>;
  poll(externalId: string): Promise<{ status: 'pending' | 'succeeded' | 'failed'; error?: string }>;
  fetch(externalId: string): Promise<{ raw: unknown; costUsd?: number; modelVersion?: string }>;
  toEvidence(raw: unknown, pageNumbers: number[]): Evidence;          // pure; unit-tested on fixtures
  deleteRemote(externalId: string): Promise<void>;                     // remove vendor-side copies
}
```

## 10. Shared tasks (do these once, before either vendor plan)

| Id | Task | Produces | Depends on |
|---|---|---|---|
| S1 | DSL types + validator for `Schema` engine, `schemaField`, `schemaArray`, `overlay` | updated `form-definition.types.ts`, validator cases from §3 | P3 Task 3.1 |
| S2 | JSON Schema builder + `schemaHash` | `buildJsonSchema` with tests: paths → nesting, checkbox → boolean, group → array, every key required + nullable, hash stable under key order | S1 |
| S3 | Evidence `EvSchemaField` + 3 resolvers | resolver tests on hand-built `EvSchemaField[]` | P3 Task 3.3 |
| S4 | `EngineCall` table + migration + repository + gateway (`getOrCall`, reuse, budget guard `ENGINE_MAX_USD_PER_DOC`) | e2e: same request twice → one vendor call | P2 Task 2.5 |
| S5 | Hallucination guard + the new flags in finalizer and review | tests: null bbox → `ungrounded`; mismatch → `ocr_mismatch`; review clears them | P3 Task 3.6, P7 Task 7.1 |
| S6 | Extractor routing: `engine.api === 'Schema'` → `EngineGateway`; overlay pass after mapping | e2e with a fake engine: M1 and M2 paths | S1–S5 |
| S7 | Eval `--engine` flag + extra metrics (§8) | baseline report per engine | P4 Task 4.4 |
| S8 | Env + boot rules: `ENGINE_<P>_ENABLED`, `ENGINE_<P>_BAA_CONFIRMED`. `PHI_MODE=true` and an enabled engine without BAA → boot refuses | `05` §12 cross-field rules | P0 Task 0.2 |

Each task follows the TDD discipline of `06`. In a host build, everything goes through `00` §9 and the host's `ADAPTATION.md`.
