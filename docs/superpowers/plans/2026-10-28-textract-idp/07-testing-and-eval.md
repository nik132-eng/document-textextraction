# 07 — Testing and Evaluation

## 1. Test layers

| Layer | Runs | Uses AWS? | What it proves |
|---|---|---|---|
| Unit (`*.spec.ts` next to code) | every commit | no | pure functions: normalizers, rules, matchScore, geometry, segmenter, scorer, flattener, resolvers on tiny hand-built block graphs |
| Fixture integration (`test/fixtures/**`) | every commit | no — **replays recorded JSON** | real Textract output → Evidence → mapping → expected native JSON per definition |
| E2E (`test/e2e/*.e2e-spec.ts`) | every commit | no — `FakeTextractClient` | HTTP upload → DB rows → API reads, on Postgres via docker-compose |
| AWS contract (`test/aws/*.aws-spec.ts`) | manual / nightly, `RUN_AWS_TESTS=true` | yes, synthetic data only | IAM, region features, query limits, and that the SDK response shape still matches the parser |
| Eval (`npm run eval`) | on demand + before changing defaults | replay by default; `--live` re-records | accuracy, review rate, cost per form |

## 2. Fixtures

```
test/fixtures/textract/<FORM_ID>/<case>/
  page-1.detect.json        # DetectDocumentText response (classifier input)
  page-1.analyze.json       # AnalyzeDocument / AnalyzeExpense response
  id.analyze.json           # AnalyzeID response (US_ID cases)
  meta.json                 # { features, queriesHash, recordedAt, region, modelVersion, source: 'synthetic' }
```

- Recorded by `scripts/record-fixture.ts` (P2) from synthetic PDFs. The script refuses to run when `PHI_MODE=true`, and writes `meta.source='synthetic'`.
- **When a definition's queries change**, `queriesHash` in `meta.json` no longer matches and the fixture test fails with "re-record fixture". Re-record with the script. That is billed, about $0.07/page.
- `FakeTextractClient` resolves calls by `(page sha256 | fixture path, api, features)` and throws `FixtureMissing` with the exact `record-fixture` command to run.

### 2.1 Hand-built block graphs (`test/builders/blocks.builder.ts`)

These cover resolver unit tests without big JSON:

```ts
const b = new BlocksBuilder();
const key = b.key('1a. INSURED\'S I.D. NUMBER', { left: .55, top: .12 });
b.value(key, 'XYZ123456789', { left: .55, top: .135 }, { confidence: 97 });
b.selection('SELECTED', { left: .10, top: .08 });
b.line('MEDICARE', { left: .115, top: .079 });
b.query('BOX1A', "What is the insured's ID number?", 'XYZ123456789', 99);
b.table({ title: 'DATE(S) OF SERVICE', header: ['FROM', 'TO', 'CPT/HCPCS', 'CHARGES'], rows: [['09 01 26', '09 01 26', '99213', '125 00']] });
const blocks = b.build();   // valid Block[] with ids + relationships + geometry
```

## 3. Golden dataset

```
test-data/<FORM_ID>/case-NNN/
  input.pdf | input.png | input.tif
  expected.json     # normalized native shape (no _unmapped), produced by hand or by approved review
  notes.md          # typed / handwritten / fax / photo / skewed, quality notes
```

| Form | Minimum for POC | Mix |
|---|---|---|
| CMS1500 | 20 | 10 typed, 4 handwritten, 4 faxed (200 DPI, noise), 2 multi-claim PDFs |
| UB04 | 20 | incl. 3 two-page claims (PAGE 1 OF 2) |
| BOOKING_SHEET | 20 | ≥3 different layouts |
| INSURANCE_CARD | 10 | front/back, ≥5 payers |
| US_ID | 5 | synthetic sample licenses only (AWS/state published samples) |
| INVOICE | 5 | |
| GENERIC | 10 | letters, referral, EOB |
| Mixed packets | 5 | booking + HCFA + UB-04 + card in one PDF (classification and segmentation test) |

**Synthetic only** until `PHI_MODE` prerequisites are met. Later, reviewed real documents can become a private gold set stored in the PHI bucket, never in git.

## 4. Metrics (`scripts/eval.ts`)

Compare the `normalized` output to `expected.json` per native path (spec-1 §17.4, adapted to Textract):

| Metric | Definition |
|---|---|
| Field exact match | equal normalized / expected non-null |
| Hallucination rate | value returned where expected is null / expected-null fields |
| Miss rate | null returned where expected has a value / expected non-null fields |
| Checkbox accuracy | correct boolean/enum / checkbox fields |
| Line-item accuracy | rows fully correct / expected rows (rows aligned by index) |
| Critical-field accuracy | subset flagged `critical: true` in eval config: patient name, DOB, insured ID, NPIs, codes, charges |
| **Accepted-but-wrong rate** | wrong values **without** any review flag / all values. The key safety metric: it must stay ≤1% on critical fields |
| **Review rate** | fields with flags / all fields; segments `NEEDS_REVIEW` / all |
| Classification accuracy | correct formType per page; segmentation exact-match per packet |
| Cost | Σ estCostUsd per form and per packet |
| Latency | p50 / p95 per stage |

### 4.1 Threshold tuning

`npm run eval -- --form CMS1500 --sweep-confidence 50..95:5` prints, per threshold, the accepted-but-wrong rate and the review rate. Set `defaults.minConfidence`, or a per-field `minConfidence`, at the lowest value meeting accepted-but-wrong ≤1% on critical fields. Record the choice in the definition's version notes.

### 4.2 Report

`reports/eval-<date>-<form>.md`: a summary table, per-field accuracy sorted worst-first, the confusion matrix for classification, the top 20 mismatches (path, expected vs got; **synthetic data only**, so values may be printed), and a cost table.

### 4.3 POC targets (adjust after the first run)

- Typed CMS-1500 critical fields ≥ 95% exact; accepted-but-wrong ≤ 1%; checkbox ≥ 97%.
- UB-04 revenue lines ≥ 90% fully-correct rows.
- Classification ≥ 98% per page on mixed packets.
- Handwritten/fax reported separately (no target in POC).

### 4.4 Promotion report

`npm run eval -- --promotion-report --tenant <id> --since 30d` (reads the DB, not the golden set) lists the most frequent `generic:*` patterns by tenant and source, as candidates for new form definitions (`03` §9 step 1). It prints labels and counts only, never values.

## 5. Test conventions

- Jest with `@swc/jest`. `testRegex` `.*\.spec\.ts$` for unit, `.e2e-spec.ts` for e2e (separate config, `--runInBand`).
- E2E DB: `docker compose up -d postgres`. Each e2e file creates a schema `test_<random>` via `DATABASE_URL?schema=…`, runs `prisma migrate deploy`, and drops it after.
- No snapshot tests for mapped JSON. Assert explicit expected objects (they are the contract).
- A test helper `expectNoPhiInLogs(fn)` captures logger output during `fn` and asserts that no value from the fixture's expected.json appears (used from P3 on, enforced repo-wide in P9).
