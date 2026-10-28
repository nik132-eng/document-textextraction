# 04 — Textract Layer (client → Evidence → resolvers)

```
page PNG ──▶ TextractClient ──▶ raw response (S3 gzip + TextractCall row)
                                   │
                                   ▼
                          BlockGraph (index by Id, children, values)
                                   │
                                   ▼
                    Evidence (engine-neutral, per page)  ◀── AnalyzeID / AnalyzeExpense adapters
                                   │
                                   ▼
            Resolvers (query | key | region | checkbox | table | grid | layout | idField | expenseField)
                                   │
                                   ▼
                     MappedResult { native, provenance, meta, unmapped }
```

Only `src/textract/**` imports `@aws-sdk/client-textract`. Everything from Evidence onward is engine-neutral (D4).

---

## 1. Call strategy

| Situation | API | Features | Input |
|---|---|---|---|
| Classify a page (mixed packet, no hint) | `DetectDocumentText` | — | page PNG |
| Form with `engine.api = AnalyzeDocument` | `AnalyzeDocument` per page | `definition.engine.features` (+ `QUERIES` only if the definition has query sources) | page PNG + `QueriesConfig` |
| `US_ID` | `AnalyzeID` | — | `DocumentPages: [front, back?]` (≤2 pages, one call) |
| `INVOICE` | `AnalyzeExpense` per page | — | page PNG |
| GENERIC | `AnalyzeDocument` | `FORMS`, `LAYOUT` (+ `TABLES` if `GENERIC_WITH_TABLES=true`) | page PNG |

- **Input transport:** `Document: { S3Object: { Bucket, Name: pageKey } }` when `STORAGE_DRIVER=s3`, otherwise `Document: { Bytes }`. The page PNG is always ≤9.5 MB (enforced by the rasterizer).
- **Re-use the classify text:** `DetectDocumentText` is never repeated for extraction. AnalyzeDocument returns LINE/WORD blocks anyway.
- **Skip classification** when `formTypeHint` is set **and** `pageCount ≤ HINT_SINGLE_FORM_MAX_PAGES` (default 2), or when `SEGMENTATION_MODE=single`. This saves $0.0015/page (Workflow §9.2).
- **Idempotency:** before calling, compute `requestHash = sha256(api | features.sorted | queriesHash | page.sha256)`. If a `TextractCall` with the same `(tenantId, requestHash)` exists and `status=SUCCEEDED`, re-use its stored response (no AWS call, no bill), unless the caller passes `force=true` (reanalyze).

## 2. Client wrapper (`textract/textract.client.ts`)

```ts
import {
  TextractClient as Sdk, AnalyzeDocumentCommand, DetectDocumentTextCommand,
  AnalyzeIDCommand, AnalyzeExpenseCommand, FeatureType, Document as TxDocument,
} from '@aws-sdk/client-textract';

export interface TextractInput { bytes?: Uint8Array; s3?: { bucket: string; key: string } }

export interface TextractCallResult<T> {
  response: T;            // SDK response (Blocks / IdentityDocuments / ExpenseDocuments)
  awsRequestId?: string;
  latencyMs: number;
  modelVersion?: string;  // DetectDocumentTextModelVersion | AnalyzeDocumentModelVersion | AnalyzeIDModelVersion | ...
}

@Injectable()
export class TextractClient {
  private readonly sdk: Sdk;
  constructor(cfg: AppConfig, private readonly limiter: TpsLimiter) {
    this.sdk = new Sdk({
      region: cfg.AWS_REGION,
      maxAttempts: cfg.TEXTRACT_MAX_ATTEMPTS,     // default 6
      retryMode: 'adaptive',                       // client-side rate limiting on throttling
    });
  }

  detectText(input: TextractInput)                       { return this.run('DetectDocumentText', () => new DetectDocumentTextCommand({ Document: doc(input) })); }
  analyzeDocument(input: TextractInput, features: FeatureType[], queries?: { Text: string; Alias: string }[]) {
    return this.run('AnalyzeDocument', () => new AnalyzeDocumentCommand({
      Document: doc(input), FeatureTypes: features,
      ...(queries?.length ? { QueriesConfig: { Queries: queries } } : {}),
    }));
  }
  analyzeId(pages: TextractInput[])                      { return this.run('AnalyzeID', () => new AnalyzeIDCommand({ DocumentPages: pages.map(doc) })); }
  analyzeExpense(input: TextractInput)                   { return this.run('AnalyzeExpense', () => new AnalyzeExpenseCommand({ Document: doc(input) })); }

  private async run<T>(api: TextractApiName, cmd: () => any): Promise<TextractCallResult<T>> {
    await this.limiter.acquire(api);                     // token bucket per API (TEXTRACT_TPS_*)
    const started = Date.now();
    try {
      const res: any = await this.sdk.send(cmd());
      return { response: res, awsRequestId: res.$metadata?.requestId, latencyMs: Date.now() - started,
               modelVersion: res.AnalyzeDocumentModelVersion ?? res.DetectDocumentTextModelVersion
                          ?? res.AnalyzeIDModelVersion ?? res.AnalyzeExpenseModelVersion };
    } catch (e: any) {
      throw TextractError.from(api, e);                   // name, $metadata.httpStatusCode, retryable flag; never the document
    }
  }
}
const doc = (i: TextractInput): TxDocument =>
  i.s3 ? { S3Object: { Bucket: i.s3.bucket, Name: i.s3.key } } : { Bytes: i.bytes };
```

**Error classification (`TextractError`)**

| AWS exception | Retryable | Pipeline action |
|---|---|---|
| `ThrottlingException`, `ProvisionedThroughputExceededException`, `InternalServerError`, network/timeout | yes. The SDK adaptive retry handles it, then the BullMQ job retry with backoff (P8) | segment stays `EXTRACTING` until attempts run out, then `FAILED` |
| `LimitExceededException` (async concurrency) | yes, delayed | re-enqueue with delay |
| `InvalidParameterException` (e.g. too many queries), `UnsupportedDocumentException`, `BadDocumentException`, `DocumentTooLargeException` | no | segment `FAILED`, `error` = exception name |
| `AccessDeniedException`, `InvalidS3ObjectException` | no — config bug | segment `FAILED` + alarm metric `idp_config_error` |
| `HumanLoopQuotaExceededException` | n/a (A2I not used) | — |

**TPS limiter:** a token bucket per API, sized from `TEXTRACT_TPS_<API>` (start at 80% of the account quota). In queue mode, the BullMQ worker `limiter` covers process-level smoothing, and the token bucket guards concurrency inside one process. With multiple worker tasks, divide the TPS by `WORKER_REPLICAS`, or use the Redis-backed BullMQ limiter, which is global. P8 picks the BullMQ global limiter.

## 3. Persistence of calls (`textract-call.repository.ts`)

```ts
export interface RecordedCall {
  id: string; api: TextractApiName; features: string[]; pageNumbers: number[];
  queriesHash?: string; requestHash: string; pagesBilled: number; estCostUsd: number;
  awsRequestId?: string; modelVersion?: string; latencyMs: number; responseKey: string; responseBytes: number;
}
// write: gzip(JSON.stringify(response)) → storage.put(keys.textract(...), { contentType: 'application/json', contentEncoding: 'gzip' })
//        then prisma.textractCall.create(...)
// read : storage.get(responseKey) → gunzip → JSON.parse
```

The response is written to storage **before** the DB row, so a row never points to a missing object. Orphaned objects from crashes are harmless and are cleaned by the retention job.

## 4. Block graph (`textract/block-graph.ts`)

Textract returns a flat `Block[]`. The graph indexes it once:

```ts
import { Block } from '@aws-sdk/client-textract';

export class BlockGraph {
  readonly byId = new Map<string, Block>();
  constructor(readonly blocks: Block[]) { for (const b of blocks) if (b.Id) this.byId.set(b.Id, b); }

  rel(b: Block, type: 'CHILD' | 'VALUE' | 'ANSWER' | 'TABLE_TITLE' | 'TABLE_FOOTER' | 'MERGED_CELL'): Block[] {
    return (b.Relationships ?? []).filter(r => r.Type === type)
      .flatMap(r => r.Ids ?? []).map(id => this.byId.get(id)).filter((x): x is Block => !!x);
  }

  /** Text of a block from its WORD children; SELECTION_ELEMENT children become a selection, not text. */
  textOf(b: Block): { text: string; confidence: number; selection?: 'SELECTED' | 'NOT_SELECTED' } {
    const kids = this.rel(b, 'CHILD');
    const words = kids.filter(k => k.BlockType === 'WORD');
    const sel = kids.find(k => k.BlockType === 'SELECTION_ELEMENT');
    const conf = Math.min(...[b, ...words].map(x => x.Confidence ?? 100));
    return { text: words.map(w => w.Text ?? '').join(' ').trim(), confidence: conf,
             selection: sel?.SelectionStatus as any };
  }

  ofType(t: Block['BlockType']) { return this.blocks.filter(b => b.BlockType === t); }
}
```

## 5. Evidence model (`evidence/evidence.types.ts`)

```ts
export interface BBox { left: number; top: number; width: number; height: number } // normalized 0..1
export interface Located { page: number; bbox: BBox; confidence: number }          // confidence 0..100

export interface EvLine extends Located { text: string; words: EvWord[] }
export interface EvWord extends Located { text: string; textType?: 'PRINTED' | 'HANDWRITING' }
export interface EvSelection extends Located { status: 'SELECTED' | 'NOT_SELECTED' }
export interface EvKeyValue {
  page: number;
  key: { text: string; bbox: BBox; confidence: number };
  value: { text: string; bbox: BBox | null; confidence: number; selection?: 'SELECTED' | 'NOT_SELECTED' };
}
export interface EvTableCell { row: number; col: number; rowSpan: number; colSpan: number; text: string;
  confidence: number; bbox: BBox; isHeader: boolean; selection?: 'SELECTED' | 'NOT_SELECTED' }
export interface EvTable extends Located { title?: string; cells: EvTableCell[]; rows: number; cols: number }
export interface EvQuery { alias: string; text: string; answer: string | null; confidence: number; page: number; bbox: BBox | null }
export interface EvLayout extends Located { type: string; text: string }
export interface EvIdField { type: string; value: string | null; normalized?: string; confidence: number }
export interface EvExpenseField { type: string; label?: string; value: string | null; confidence: number; page: number; bbox: BBox | null }
export interface EvExpenseLineItem { fields: EvExpenseField[] }

export interface EvidencePage {
  page: number;                  // document page number (not Textract's 1)
  lines: EvLine[]; words: EvWord[]; selections: EvSelection[];
  keyValues: EvKeyValue[]; tables: EvTable[]; queries: EvQuery[]; layout: EvLayout[];
}
export interface Evidence {
  engine: 'textract';
  pages: EvidencePage[];
  idFields?: EvIdField[];                                   // AnalyzeID
  expense?: { summary: EvExpenseField[]; lineItems: EvExpenseLineItem[] };   // AnalyzeExpense
}
```

### 5.1 Builder rules (`evidence.builder.ts`)

- **Page number remap:** sync calls are single-page, so Textract `Page` is always 1. The builder sets `page = documentPageNumber` from the call's `pageNumbers[0]`.
- **Lines and words:** `LINE` blocks with their `CHILD` `WORD`s. Keep `TextType` (PRINTED/HANDWRITING) on words. Handwriting fields get a confidence penalty only if `HANDWRITING_CONFIDENCE_PENALTY` > 0 (default 0; spec-1 open decision 4).
- **Key/values:** `KEY_VALUE_SET` blocks with `EntityTypes` containing `KEY` → `rel(key,'VALUE')[0]` is the value block. Key text = `textOf(key)`. Value = `textOf(value)` (may carry `selection`). Confidence = `min(key.Confidence, value.Confidence, word confidences)`.
- **Tables:** `TABLE` → `CHILD` `CELL`s (`RowIndex`, `ColumnIndex`, `RowSpan`, `ColumnSpan`, `EntityTypes` contains `COLUMN_HEADER` → `isHeader`). `MERGED_CELL` children are expanded so that every covered (row, col) carries the merged text. `TABLE_TITLE` → `title`. Cells containing a `SELECTION_ELEMENT` carry `selection`.
- **Queries:** `QUERY` blocks (`Query.Alias`, `Query.Text`) → `rel(q,'ANSWER')` → `QUERY_RESULT` (`Text`, `Confidence`, `Geometry`). No answer → `answer: null`. Multiple answers → the highest confidence.
- **Selections:** every `SELECTION_ELEMENT` block, including those inside KVs and cells. These feed the `checkbox` resolvers.
- **Layout:** `LAYOUT_*` blocks; text = the concatenated child `LINE` texts.
- **AnalyzeID:** `IdentityDocuments[].IdentityDocumentFields[]` → `{ type: Type.Text, value: ValueDetection.Text, normalized: ValueDetection.NormalizedValue?.Value, confidence: ValueDetection.Confidence }`. Also build `pages[]` from `IdentityDocuments[].Blocks` (LINE/WORD) so `layout` and `region` sources still work.
- **AnalyzeExpense:** `ExpenseDocuments[].SummaryFields[]` → `{ type: Type.Text, label: LabelDetection?.Text, value: ValueDetection?.Text, confidence: min(Type, Value), bbox }`. `LineItemGroups[].LineItems[].LineItemExpenseFields[]` → line items. Fields with `Type.Text === 'OTHER'` keep their `label` and become `_unmapped` rows (Workflow §3.3: "unknown keys become OTHER"). `ExpenseDocuments[].Blocks` → pages.

### 5.2 Geometry helpers (`evidence/geometry.ts`)

- `center(b)`, `contains(box, point)`, `intersectionOverArea(a, b)`.
- `regionFromAnchor(anchor: BBox, r: RegionBox): BBox` = `{ left: anchor.left + r.dx, top: anchor.top + r.dy, width: r.width, height: r.height }`.
- `readingOrder(items)`: sort by `top` bucketed into lines (tolerance 0.4 × median word height), then `left`.
- `nearest(target, candidates, maxDistance)`: Euclidean distance between centers. Default `maxDistance = 0.04` (≈4% of page).

## 6. Resolvers (`src/forms/resolvers/*.resolver.ts`)

Common contract:

```ts
export interface Resolved {
  value: string | boolean | null;            // raw text (or selection boolean)
  confidence: number;                         // 0..100
  page: number | null;
  bbox: BBox | null;
  source: FieldSource['kind'] | 'table' | 'grid' | 'generic';
  label?: string;                             // printed key / query text actually matched
  claimed?: string[];                         // ids of evidence items consumed (to exclude from _unmapped)
}
export type Resolver<S> = (src: S, ev: Evidence, scopePages: number[]) => Resolved | null;
```

Each resolver returns `null` when it finds nothing, so the next source is tried. A field with all sources null → value `null`, provenance `{ source: null }`, flag `not_found` **only if** `required`. Otherwise it is a plain null (blank).

| Resolver | Algorithm |
|---|---|
| `query` | Find `EvQuery` with `alias`. `answer === null` → `null` (blank). Otherwise value = answer, confidence = query result confidence. |
| `key` | Score every `EvKeyValue.key.text` with `matchScore(key, textMatch)` (§7). Take the highest score ≥ 0.8. On ties, take the higher confidence, then the top-most. If `valuePart: 'selection'` → value = `selection === 'SELECTED'`. Empty value text → `null` (blank, not missing). |
| `region` | Find anchor `EvLine`s matching `anchor` (best score; on a tie, the first in reading order). Box = `regionFromAnchor`. Collect `EvWord`s whose **center** lies inside. Value = words in reading order joined by `join` (default `' '`). Confidence = min word confidence. Empty → `null`. |
| `checkbox` | Find label word/line. Candidate selections = `EvSelection`s within `maxDistance`, preferring the one to the **left** on the same row (form convention), else nearest. Value = `status === 'SELECTED'`. |
| `checkboxGroup` | Restrict to `scope` region if given. For each option, find its label inside the scope and its nearest selection (as above, with each selection assigned to at most one option, nearest first). Selected options: 0 → `null`; 1 → that value; >1 → if `multiple`, an array; else the highest-confidence option + flag `multi_selected` + `meta.uncertain`. |
| `layout` | Filter `EvLayout` by `blockType` and optional `match`. With `capture` (regex with one group) → the first capture. Else the full text. |
| `table` (group) | Pick the table whose header cells match ≥ `headerMatch` column `header`s (and `titleMatch` if given). Map header col index → column path. Rows = non-header rows. Cell text → column raw value. Row confidence = per-cell. |
| `grid` (group) | Anchor → for row `i` in `0..rows-1`, row box top = `anchor.top + firstRowDy + i*rowHeight`. For each column with `x:[l,r]`, cell box = `{left:l, top:rowTop, width:r-l, height:rowHeight}`, words inside → text. Used for CMS-1500 Box 24 when Textract's table detection is poor. |
| `idField` | `EvIdField` with `type` (e.g. `FIRST_NAME`, `LAST_NAME`, `DATE_OF_BIRTH`, `DOCUMENT_NUMBER`, `EXPIRATION_DATE`, `STATE_NAME`, `ADDRESS`, `ID_TYPE`). Prefer `normalized` for dates. |
| `expenseField` | `EvExpenseField` with `type` (e.g. `VENDOR_NAME`, `INVOICE_RECEIPT_ID`, `INVOICE_RECEIPT_DATE`, `TOTAL`, `AMOUNT_DUE`). |
| `expenseLineItems` (group) | Each `EvExpenseLineItem` → row. Column `expenseType` picks the field. |
| `keyRepeat` (group) | All KVs whose key matches `key` (e.g. `PROCEDURE \d+`), ordered by reading order → rows. |

### 6.1 Confidence → flags

```
threshold = field.minConfidence ?? group/column min ?? definition.defaults.minConfidence ?? env DEFAULT_MIN_CONFIDENCE (80)
if value != null and confidence < threshold → flags += 'low_confidence', meta.uncertain += path
```

Textract confidence is a better-calibrated signal than LLM self-reports, but it is still not a probability of correctness. The eval (`07`) tunes per-form thresholds from the golden set: choose the lowest threshold that keeps the "accepted but wrong" rate ≤1% on critical fields.

### 6.2 Unmapped capture

After all fields, groups and checkbox groups resolve, every evidence item not in any `claimed` set becomes an `_unmapped` row:

- KV pairs → `{ kind: 'kv', label: key.text, value: value.text | selection, ... }`
- tables not used by a group → one row per cell `{ kind: 'table', label: '<title|table N> r{row} c{col} <header>' }`
- LINEs not inside any claimed bbox and not part of a KV/table (GENERIC and `LAYOUT_TEXT` only) → `{ kind: 'line' }`

These flatten to `nativePattern = 'generic:' + slug(label)`, `canonicalKey = null`, `source = 'generic'`.

## 7. Text matching (`common/util/text.ts`)

```ts
export const normalizeLabel = (s: string) =>
  s.toUpperCase().replace(/[’']/g, '').replace(/[^A-Z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');

/** 0..1 score. Exact/contains = 1. Fuzzy token match scales by matched tokens. */
export function matchScore(text: string, m: TextMatch): number { /* … see P3 Task 2 tests … */ }
```

- `equals`: normalized equality.
- `startsWith` / `contains`: substring on normalized strings. With `fuzzy > 0`, each pattern token must match a text token with Levenshtein ≤ `fuzzy` (tokens ≥5 chars only; shorter tokens must be exact) → score = matched tokens / pattern tokens.
- `regex`: `new RegExp(pattern, 'i')` on the **un-normalized** text.

Box-number prefixes such as `1a.` normalize to `1A`, so `anyOf: ['1A INSURED']` matches `"1a. INSURED'S I.D. NUMBER"`.

## 8. Queries builder (`queries.builder.ts`)

```ts
export function buildQueries(def: FormDefinition): { Text: string; Alias: string }[] {
  const qs = def.fields.flatMap(f => f.sources.filter(s => s.kind === 'query')) as { alias: string; text: string }[];
  const uniq = [...new Map(qs.map(q => [q.alias, q])).values()];
  if (uniq.length > 15) throw new Error(`DEF_QUERY_LIMIT ${def.id}`);   // also enforced at boot
  return uniq.map(q => ({ Text: q.text, Alias: q.alias }));
}
export const queriesHash = (q: object[]) => sha256(JSON.stringify(q));
```

Query `Pages` is not set (sync calls are one page).

## 9. Cost estimator (`textract/cost.ts`)

The prices come from Workflow doc §9.1 (US list, first tier, checked 2026-10-27). They are **configurable** through `TEXTRACT_PRICE_OVERRIDES` JSON, because AWS prices change.

```ts
export const PRICE_USD_PER_PAGE = {
  DetectDocumentText: 0.0015,
  AnalyzeExpense: 0.010,
  AnalyzeID: 0.025,
  AnalyzeDocument: (f: string[]) => {
    const s = new Set(f);
    // Forms+Tables+Queries 0.070; Forms+Tables 0.065; Forms 0.050; Tables 0.015; Queries 0.015; Layout +0 when with Tables, else +0.004
    let p = 0;
    if (s.has('FORMS') && s.has('TABLES')) p = 0.065;
    else if (s.has('FORMS')) p = 0.050;
    else if (s.has('TABLES')) p = 0.015;
    if (s.has('QUERIES')) p += s.has('FORMS') && s.has('TABLES') ? 0.005 : 0.015; // SPEC-QUESTION: confirm bundle pricing on first invoice
    if (s.has('LAYOUT') && !s.has('TABLES')) p += 0.004;                          // Workflow §9.1 caveat
    return p;
  },
} as const;
```

`estCostUsd` is stored per `TextractCall` and summed onto `Extraction`. `GET /documents/:id` returns the document total. The eval report prints cost per form. Reconcile against the first AWS invoice and adjust the overrides.
