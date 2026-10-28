# 06 — Phases and Tasks (P0–P9)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Each task follows TDD: write the failing test → run it (fails) → implement → run it (passes) → commit. Read `00-overview.md` §4 *Global Constraints* first. Every task implicitly includes them.

Conventions used below:
- Test commands: `npx jest <path>` (unit), `npm run test:e2e -- <path>` (e2e).
- Commits use Conventional Commits and end with the attribution line from the repo's contributing guide.
- "Interfaces" lists what a task **produces** for later tasks (exact names). Do not rename them.

---

## P0 — Foundation

### Task 0.1: Repository and Nest skeleton

**Files:** Create `package.json`, `tsconfig.json`, `tsconfig.build.json`, `nest-cli.json`, `jest.config.ts`, `jest.e2e.config.ts`, `.gitignore`, `.nvmrc` (`24`), `docker-compose.yml`, `docker/Dockerfile`, `src/main.ts`, `src/app.module.ts`, `README.md`.

- [ ] **Step 1:** `git init` (the folder is not a repo yet). Move the three existing research docs into `docs/research/` and commit them as `docs: import research and workflow docs`.
- [ ] **Step 2:** Scaffold with `npx @nestjs/cli@12 new . --package-manager npm --skip-git --strict`. If the CLI scaffolds Vitest instead of Jest, keep Jest per Global Constraints: remove Vitest, then `npm i -D jest @swc/jest @swc/core @types/jest supertest @types/supertest`.
- [ ] **Step 3:** `tsconfig.json`: add `"noUncheckedIndexedAccess": true`, `"strict": true`. Keep whatever `module`/`moduleResolution` the CLI emits (record it in README; Task 0.3 depends on it).
- [ ] **Step 4:** `docker-compose.yml`:
  ```yaml
  services:
    postgres:
      image: postgres:17
      environment: { POSTGRES_USER: idp, POSTGRES_PASSWORD: idp, POSTGRES_DB: idp }
      ports: ["5432:5432"]
    valkey:
      image: valkey/valkey:8
      command: ["valkey-server", "--maxmemory-policy", "noeviction"]
      ports: ["6379:6379"]
  ```
- [ ] **Step 5:** `docker/Dockerfile`: multi-stage `node:24-bookworm-slim`; runtime stage `apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/*`; non-root user; `CMD ["node","dist/main.js"]`.
- [ ] **Step 6:** Run `npm run build && npx jest`. Expected: the default app spec passes.
- [ ] **Step 7:** Commit `chore: scaffold nest 12 service`.

### Task 0.2: Env config with Zod (fail fast)

**Files:** Create `src/config/env.schema.ts`, `src/config/config.module.ts`, `src/config/env.schema.spec.ts`.
**Interfaces — Produces:** `class AppConfig` (injectable; the typed parsed env from `05` §12), `parseEnv(raw: NodeJS.ProcessEnv): AppConfig`.

- [ ] **Step 1: Failing tests**
  ```ts
  import { parseEnv } from './env.schema';
  const base = { DATABASE_URL: 'postgresql://idp:idp@localhost:5432/idp', AWS_REGION: 'us-east-1' };
  it('applies defaults', () => {
    const c = parseEnv(base);
    expect(c.PIPELINE_MODE).toBe('sync'); expect(c.RASTER_DPI).toBe(200); expect(c.DEFAULT_MIN_CONFIDENCE).toBe(80);
  });
  it('requires REDIS_URL in queue mode', () => {
    expect(() => parseEnv({ ...base, PIPELINE_MODE: 'queue' })).toThrow(/REDIS_URL/);
  });
  it('requires s3 + confirmations when PHI_MODE', () => {
    expect(() => parseEnv({ ...base, PHI_MODE: 'true' })).toThrow(/STORAGE_DRIVER|PHI_BAA_CONFIRMED/);
  });
  it('coerces numbers and booleans', () => {
    expect(parseEnv({ ...base, MAX_PAGES: '10', GENERIC_WITH_TABLES: 'true' })).toMatchObject({ MAX_PAGES: 10, GENERIC_WITH_TABLES: true });
  });
  ```
- [ ] **Step 2:** Run `npx jest src/config` → FAIL (module missing).
- [ ] **Step 3:** Implement with `z.object({...})` + `z.coerce.number()` + a boolean helper `z.enum(['true','false']).transform(v => v==='true')` + `superRefine` for the cross-field rules in `05` §12. `ConfigModule` provides `AppConfig` by `useFactory: () => parseEnv(process.env)`. **Throw at boot.** Do not log the env values.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(config): zod env schema with cross-field rules`.

### Task 0.3: Prisma 7 schema, first migration, PrismaService

**Files:** Create `prisma.config.ts`, `prisma/schema.prisma` (exactly `02-data-model.md` §3), `prisma/migrations/<ts>_init/migration.sql` (+ §4 SQL), `src/prisma/prisma.module.ts`, `src/prisma/prisma.service.ts`, `test/e2e/prisma.e2e-spec.ts`.
**Interfaces — Produces:** `PrismaService` (extends generated `PrismaClient`), generated client at `src/generated/prisma/client`.

- [ ] **Step 1:** `npm i -E prisma@7.10.1 -D && npm i -E @prisma/client@7.10.1 @prisma/adapter-pg@7.10.1 pg dotenv`.
- [ ] **Step 2:** Write `prisma.config.ts` and `schema.prisma` from `02` §2–3. Add `src/generated/` to `.gitignore`. Add the script `"postinstall": "prisma generate"`.
- [ ] **Step 3:** `docker compose up -d postgres && npx prisma migrate dev --create-only --name init`. Append the §4 SQL to the generated `migration.sql`, then `npx prisma migrate dev`.
- [ ] **Step 4:** `npm run build`. **If tsc fails on generated imports**, switch `importFileExtension` between `""` and `"js"` (see `02` §2 note), regenerate, rebuild. Record the working value in README.
- [ ] **Step 5: Failing e2e test**
  ```ts
  it('enforces one current extraction per segment', async () => {
    const { segment } = await seedSegment(prisma);            // helper creates Document + Segment
    await prisma.extraction.create({ data: extractionData(segment.id) });
    await expect(prisma.extraction.create({ data: extractionData(segment.id) })).rejects.toThrow();
  });
  it('dedupes documents per tenant by sha256', async () => {
    await prisma.document.create({ data: doc('t1', 'a'.repeat(64)) });
    await expect(prisma.document.create({ data: doc('t1', 'a'.repeat(64)) })).rejects.toThrow();
    await expect(prisma.document.create({ data: doc('t2', 'a'.repeat(64)) })).resolves.toBeTruthy();
  });
  ```
- [ ] **Step 6:** Run `npm run test:e2e -- prisma` → PASS (the first run proves the migration and partial index).
- [ ] **Step 7:** Commit `feat(db): prisma 7 schema and init migration`.

### Task 0.4: Storage port (local driver)

**Files:** Create `src/storage/storage.port.ts`, `src/storage/local.storage.ts`, `src/storage/storage.module.ts`, `src/common/util/paths.ts`, `src/storage/local.storage.spec.ts`.
**Interfaces — Produces:**
```ts
export interface PutOptions { contentType: string; contentEncoding?: 'gzip' }
export interface StoragePort {
  put(key: string, body: Buffer, opts: PutOptions): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  presignGet(key: string, ttlSeconds: number): Promise<string | null>;   // null for local
  textractInput(key: string): Promise<{ bytes?: Uint8Array; s3?: { bucket: string; key: string } }>;
}
export const STORAGE = Symbol('STORAGE');
export const keys = { original, page, textract };  // 02 §6
```

- [ ] **Step 1: Failing tests:** put/get round-trip; `exists` false → true; a key containing `..` or a leading `/` throws `InvalidStorageKey`; `textractInput` returns `{ bytes }`; `keys.page('t1','d1',3)` === `'t/t1/d/d1/pages/0003.png'`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (resolve under `STORAGE_LOCAL_DIR`, assert the resolved path starts with the root). **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(storage): storage port and local driver`.

### Task 0.5: Tenancy guard, safe logger, health

**Files:** Create `src/common/tenancy/tenant.guard.ts`, `src/common/tenancy/tenant.decorator.ts`, `src/common/logging/safe-logger.ts`, `src/health/health.controller.ts`, specs for each.
**Interfaces — Produces:** `@TenantId()` param decorator → `string`; `SafeLogger` implementing Nest `LoggerService` with `log(msg: string, ctx?: SafeCtx)` where `SafeCtx = { tenantId?, documentId?, segmentId?, extractionId?, stage?, durationMs?, awsRequestId?, code?, count?, api? }`.

- [ ] **Step 1: Failing tests:**
  - guard: a missing `x-tenant-id` → 401; `../x` → 400; `tenant_1` → attaches `req.tenantId`. *(Auth placeholder: `// SPEC-QUESTION: replace header with host JWT claim in P9`.)*
  - logger: `log('x', { tenantId:'t', patientName:'DOE' } as any)` writes JSON **without** `patientName`.
  - health: `GET /health` → 200 `{status:'ok'}`; `/health/ready` checks DB with `SELECT 1`.
- [ ] **Step 2–4:** fail → implement (`@nestjs/terminus` for ready) → pass.
- [ ] **Step 5:** Commit `feat(core): tenant guard, PHI-safe logger, health`.

### Task 0.6: `IdpModule` dynamic module, ports and host-name guard

**Files:** Create `src/idp.module.ts`, `src/index.ts`, `src/ports/{auth,event-sink,target-profile,doc-type-labels,payer-directory}.port.ts`, `src/idp-options.ts`, `scripts/check-host-names.ts`, specs. Modify `src/app.module.ts` to import `IdpModule.forRoot(optionsFromEnv())`, and the tenant guard from Task 0.5 to delegate to `AuthPort`.
**Interfaces — Produces:**
```ts
export interface IdpOptions {
  database: { url: string };
  storage: { driver: 'local' | 's3'; dir?: string; bucket?: string; kmsKeyId?: string; prefix?: string };
  textract: { region: string; tps: { analyze: number; detect: number; id: number; expense: number } };
  pipeline: { mode: 'sync' | 'queue'; redisUrl?: string };
  http: { enabled: boolean; routePrefix?: string };
  ports?: Partial<{ auth: Type<AuthPort>; eventSink: Type<EventSinkPort>; targetProfiles: TargetProfile[];
                    docTypeLabels: string[]; payerDirectory: Type<PayerDirectoryPort> }>;
  forms?: { extra?: FormDefinition[] };
}
export interface AuthPort { resolve(req: unknown): Promise<{ tenantId: string; userId: string | null }> }
export interface EventSinkPort { deliver(event: { id: string; type: string; tenantId: string; payload: object }): Promise<void> }
export interface PayerDirectoryPort { match(tenantId: string, printedName: string): Promise<{ payerId: string } | null> }
export const IDP_OPTIONS = Symbol('IDP_OPTIONS'); // plus AUTH_PORT, EVENT_SINK, ... tokens
export class IdpModule { static forRoot(o: IdpOptions): DynamicModule; static forRootAsync(o: { useFactory; inject? }): DynamicModule }
```
- [ ] **Step 1: Failing tests:** `IdpModule.forRoot` with no `ports` resolves the default adapters; a custom `AuthPort` passed in is used by the guard; `http.enabled=false` registers no controllers; `scripts/check-host-names.ts` exits 1 when `src/` contains a name from `HOST_NAME_DENYLIST` (test with a temp file).
- [ ] **Steps 2–4:** fail → implement → pass.
- [ ] **Step 5:** Add `npm run check:host-names` to CI. Commit `feat(core): embeddable IdpModule with host ports`.

**P0 acceptance:** `npm run start` boots; `GET /health/ready` is 200 with compose up; a missing `DATABASE_URL` exits non-zero with a Zod message; `npx jest` is green.

---

## P1 — Ingest and rasterize

### Task 1.1: Magic-byte detection and hashing

**Files:** Create `src/common/util/magic-bytes.ts`, `src/common/util/hash.ts`, specs.
**Interfaces — Produces:** `detectMime(buf: Buffer): 'application/pdf'|'image/png'|'image/jpeg'|'image/tiff'|null`; `sha256(buf: Buffer | string): string`.

- [ ] **Step 1: Failing test**
  ```ts
  it.each([
    ['%PDF-1.7', 'application/pdf'],
    ['\x89PNG\r\n\x1a\n', 'image/png'],
    ['\xff\xd8\xff\xe0', 'image/jpeg'],
    ['II*\x00', 'image/tiff'], ['MM\x00*', 'image/tiff'],
    ['\x00\x00\x00\x18ftypheic', null], ['hello', null],
  ])('%j → %s', (head, mime) => expect(detectMime(Buffer.from(head, 'latin1'))).toBe(mime));
  ```
- [ ] **Steps 2–4:** fail → implement → pass. **Step 5:** commit `feat(ingest): magic bytes + sha256`.

### Task 1.2: Rasterizer

**Files:** Create `src/pipeline/rasterizer.service.ts`, `src/pipeline/rasterizer.service.spec.ts`, `test/assets/{three-pages.pdf, two-pages.tif, rotated.jpg, small.png, encrypted.pdf}` (generated synthetic assets; a script `test/assets/make-assets.ts` creates them with sharp and `pdfunite`/`qpdf` if needed, or commit tiny ones).
**Interfaces — Consumes:** `StoragePort`, `PrismaService`, `AppConfig`. **Produces:** `RasterizerService.run(documentId: string): Promise<void>`; `rasterize(buf: Buffer, mime: string, opts): Promise<RasterPage[]>` where `RasterPage = { pageNumber: number; png: Buffer; ext: 'png'|'jpg'; widthPx: number; heightPx: number; dpi: number }`.

- [ ] **Step 1: Failing tests** (pure `rasterize` function):
  - the 3-page PDF → 3 pages, each width ≈ 8.5×200 = 1700 ±2 px;
  - the 2-page TIFF → 2 pages;
  - a JPEG with EXIF orientation 6 → output width < height (rotated);
  - a page > `MAX_IMAGE_LONG_SIDE` is downscaled;
  - an encrypted PDF throws `PdfEncryptedError`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement with `execFile('pdftoppm', ['-r', dpi, '-png', '-cropbox', inPath, outPrefix], { timeout: 60000 })` in an `fs.mkdtemp` dir; read files sorted numerically; sharp for the others; `pdfinfo` for encrypted/page-count checks. `run()` writes the pages to storage + `Page` rows + status `RASTERIZED`, and is a no-op if pages exist.
- [ ] **Step 4:** Run → PASS. **Step 5:** commit `feat(pipeline): rasterizer (pdftoppm + sharp)`.

### Task 1.3: Upload endpoint, dedupe, links, page image

**Files:** Create `src/ingest/ingest.service.ts`, `src/ingest/documents.controller.ts`, `src/ingest/dto.ts`, `src/pipeline/pipeline.service.ts` (sync: rasterize only for now), `test/e2e/ingest.e2e-spec.ts`.
**Interfaces — Produces:** `IngestService.ingest(tenantId, file: { buffer: Buffer; originalname: string }, opts: IngestOptions): Promise<{ document: Document; deduplicated: boolean }>`; `PipelineService.process(documentId: string): Promise<void>`; `IngestOptions = { source?, formTypeHint?, docTypeLabel?, links?: {entityType: string; entityId: string}[], force?: boolean, uploadedBy?: string }`.

- [ ] **Step 1: Failing e2e tests**
  - `POST /documents` with the 3-page PDF → 201, then `GET /documents/:id` shows `status: 'RASTERIZED'`, `pageCount: 3`, 3 pages;
  - the same file again → 200, `deduplicated: true`, same id; a new link added when `links` differs;
  - `.heic` bytes → 415 `UNSUPPORTED_FILE`;
  - a 26 MB file → 413;
  - `GET /documents/:id/pages/1/image` → 200 `image/png`;
  - a document from tenant A is not visible with tenant B's header → 404.
- [ ] **Steps 2–4:** fail → implement (multer `memoryStorage`, `ParseFilePipe` with a max size; the outbox row `document.received`) → pass.
- [ ] **Step 5:** commit `feat(ingest): upload, dedupe, links, page images`.

**P1 acceptance:** as in `00` §6.

---

## P2 — Textract layer

### Task 2.1: Evidence types, geometry and text utils

**Files:** Create `src/evidence/evidence.types.ts` (exactly `04` §5), `src/evidence/geometry.ts`, `src/common/util/text.ts`, specs.
**Interfaces — Produces:** the `Evidence*` types; `regionFromAnchor`, `center`, `containsCenter(box, item)`, `readingOrder<T extends {bbox}>(items: T[]): T[]`, `nearest`; `normalizeLabel(s)`, `matchScore(text, m: TextMatch): number`, `levenshtein(a,b)`, `slug(label)`.

- [ ] **Step 1: Failing tests**
  ```ts
  expect(normalizeLabel("1a. INSURED'S I.D. NUMBER")).toBe('1A INSUREDS I D NUMBER');
  expect(matchScore('HEALTH INSURANCE CLAIM F0RM', { anyOf: ['HEALTH INSURANCE CLAIM FORM'], fuzzy: 1 })).toBe(1);
  expect(matchScore('HEALTH INSURANCE', { anyOf: ['HEALTH INSURANCE CLAIM FORM'] })).toBe(0);
  expect(matchScore('M', { anyOf: ['M'], mode: 'equals' })).toBe(1);
  expect(matchScore('MEDICARE', { anyOf: ['M'], mode: 'equals' })).toBe(0);
  expect(matchScore('PAGE 2 OF 3', { anyOf: ['PAGE\\s*(\\d+)\\s*OF\\s*(\\d+)'], mode: 'regex' })).toBe(1);
  expect(regionFromAnchor({ left:.1, top:.2, width:.1, height:.01 }, { dx:0, dy:.01, width:.2, height:.02 }))
    .toEqual({ left:.1, top:.21, width:.2, height:.02 });
  // readingOrder: two words on one visual line (tops differ by < tolerance) sort left→right
  ```
- [ ] **Steps 2–4:** fail → implement → pass. **Step 5:** commit `feat(evidence): types, geometry, text matching`.

### Task 2.2: Blocks test builder

**Files:** Create `test/builders/blocks.builder.ts`, `test/builders/blocks.builder.spec.ts`.
**Interfaces — Produces:** `BlocksBuilder` with `line`, `word`, `key`, `value`, `selection`, `query`, `table`, `layout`, `build(): Block[]` (as in `07` §2.1).

- [ ] **Step 1:** Failing test: built blocks contain a `PAGE` block whose CHILD relationships include every LINE; a KEY's `VALUE` relationship points to the VALUE block; a QUERY has an `ANSWER` → QUERY_RESULT.
- [ ] **Steps 2–5:** fail → implement → pass → commit `test: textract blocks builder`.

### Task 2.3: BlockGraph and EvidenceBuilder (AnalyzeDocument + DetectDocumentText)

**Files:** Create `src/textract/block-graph.ts`, `src/textract/evidence.builder.ts`, specs.
**Interfaces — Produces:** `BlockGraph` (`04` §4); `EvidenceBuilder.fromAnalyzeDocument(blocks: Block[], documentPage: number): EvidencePage`; `.fromDetectText(blocks, documentPage): EvidencePage` (lines/words only); `.merge(pages: EvidencePage[]): Evidence`.

- [ ] **Step 1: Failing tests** (with BlocksBuilder):
  - a KV with value words → `keyValues[0]` `{ key.text:'1a. INSURED\'S I.D. NUMBER', value.text:'XYZ123456789', confidence: min(...) }`;
  - a KV whose value has a SELECTION_ELEMENT child → `value.selection === 'SELECTED'`, `value.text === ''`;
  - a table with a header row + a merged cell spanning 2 columns → both covered cells carry the text; `isHeader` set;
  - a query with no ANSWER → `answer: null`;
  - `documentPage=7` → every item's `page === 7`;
  - LINE word order is preserved; handwriting `TextType` is kept.
- [ ] **Steps 2–4:** fail → implement → pass. **Step 5:** commit `feat(textract): block graph and evidence builder`.

### Task 2.4: TextractClient, TPS limiter, error mapping

**Files:** Create `src/textract/textract.client.ts`, `src/textract/tps-limiter.ts`, `src/textract/textract.errors.ts`, specs (use `aws-sdk-client-mock` — **dependency budget exception, test-only; justification: the official-pattern SDK v3 mock**).
**Interfaces — Produces:** `TextractClient` (`04` §2) with `detectText`, `analyzeDocument`, `analyzeId`, `analyzeExpense`; `TextractError { api, name, httpStatus, retryable }`; `TpsLimiter.acquire(api)`.

- [ ] **Step 1: Failing tests:** a mocked `AnalyzeDocumentCommand` gets `FeatureTypes` and `QueriesConfig` exactly; no `QueriesConfig` when the queries array is empty; S3 input → `Document.S3Object`; `ThrottlingException` → `TextractError.retryable === true`; `InvalidParameterException` → false; the limiter with TPS 2 lets 2 calls through immediately and delays the 3rd ≥ ~500 ms (fake timers).
- [ ] **Steps 2–4:** fail → implement → pass. **Step 5:** commit `feat(textract): sdk client wrapper, limiter, errors`.

### Task 2.5: TextractCall repository, cost estimator, `getOrCall`

**Files:** Create `src/textract/cost.ts`, `src/textract/textract-call.repository.ts`, `src/textract/textract-gateway.service.ts`, specs + e2e.
**Interfaces — Produces:**
```ts
estimateCost(api: TextractApiName, features: string[], pages: number): number;
class TextractGateway {
  getOrCall(args: { tenantId: string; documentId: string; page: PageRow; api: 'DetectDocumentText'|'AnalyzeDocument'|'AnalyzeExpense';
                    features?: string[]; queries?: {Text:string;Alias:string}[]; force?: boolean }): Promise<{ call: TextractCallRow; response: any; reused: boolean }>;
  getOrCallId(args: { tenantId; documentId; pages: PageRow[]; force? }): Promise<{ call; response; reused }>;
  loadResponse(call: TextractCallRow): Promise<any>;
}
```
- [ ] **Step 1: Failing tests:** cost `AnalyzeDocument ['FORMS','TABLES','QUERIES'] × 1` = 0.070; the second `getOrCall` with identical args → `reused: true` and the client mock called once; `force:true` → called twice, two rows; the response is stored gzip at `keys.textract(...)` and `loadResponse` round-trips; the storage write happens before the DB insert (assert call order).
- [ ] **Steps 2–4:** fail → implement → pass. **Step 5:** commit `feat(textract): call persistence, idempotency, cost`.

### Task 2.6: Fixture recorder + FakeTextractClient

**Files:** Create `scripts/record-fixture.ts`, `src/textract/fake-textract.client.ts`, spec.
**Interfaces — Produces:** CLI `npm run record-fixture -- --form <ID> --case <case> --file <path> [--features ...] [--detect]`; `FakeTextractClient implements` the same public methods as `TextractClient`, constructed with `{ fixturesDir, form, case }`, with page lookup by page number.
- [ ] **Step 1:** Failing test: the fake returns `page-1.analyze.json` for page 1; a missing fixture throws `FixtureMissing` whose message contains `npm run record-fixture`.
- [ ] **Step 2–4:** fail → implement. The recorder rasterizes with `rasterize()`, calls the real `TextractClient` (refuses if `PHI_MODE=true`), and writes `page-N.detect.json`, `page-N.analyze.json`, `meta.json`.
- [ ] **Step 5:** **Manual (AWS):** run once for the CMS-1500 synthetic sample from `01` §10 and commit the fixture. Commit `feat(textract): fixture recorder and fake client`.
- [ ] **Step 6 (opt-in contract test):** `test/aws/textract.aws-spec.ts` (`RUN_AWS_TESTS=true`): DetectDocumentText on a synthetic page returns ≥1 LINE; AnalyzeDocument with 16 queries → `InvalidParameterException` (proves the limit); the parser builds Evidence from the live response.

**P2 acceptance:** the recorded CMS-1500 fixture → `Evidence` with >20 KV pairs, ≥1 table, ≥7 selections, query answers; unit suite green without AWS.

---

## P3 — Form DSL, registry, mapper, GENERIC end-to-end

### Task 3.1: DSL types, definition validator, canonical dictionary

**Files:** Create `src/forms/dsl/form-definition.types.ts` (`03` §1), `src/forms/dsl/form-definition.schema.ts`, `src/forms/dsl/canonical-keys.ts` (`03` §3), spec.
**Interfaces — Produces:** `validateDefinition(def: FormDefinition, ctx: { ruleNames: Set<string>; parserNames: Set<string> }): void` (throws `DefinitionError { code, formId, detail }`); `expandPaths(def): { path: string; type: ValueType; canonical?: string; kind: 'field'|'split'|'checkbox'|'column' }[]`.

- [ ] **Step 1: Failing tests** — one per row of `03` §2 (e.g. 16 query sources → `DEF_QUERY_LIMIT`; `canonical: 'patient.shoe_size'` → `DEF_CANONICAL`; a `table` source without `TABLES` → `DEF_FEATURE`; duplicate path via `split.into` → `DEF_PATH_DUP`), plus a valid minimal definition passes.
- [ ] **Steps 2–5:** fail → implement → pass → commit `feat(forms): definition DSL, validator, canonical dictionary`.

### Task 3.2: Value normalizers and split parsers

**Files:** Create `src/forms/normalize/value-normalizers.ts`, `src/forms/normalize/split-parsers.ts`, specs.
**Interfaces — Produces:** `normalizeValue(type: ValueType, raw: unknown, opts: { dateKind?, enumValues?, today: Date }): { value: unknown; error?: string }`; `SPLIT_PARSERS: Record<string, (raw: string) => Record<string, string | null>>`.

- [ ] **Step 1: Failing tests** — the full `03` §4.1 table, as `it.each`. Must include:
  ```ts
  ['date', '03 12 84', { dateKind: 'dob' }, '1984-03-12'],
  ['date', '09 01 26', { dateKind: 'service' }, '2026-09-01'],
  ['date', '13 45 99', {}, null /* error DATE_UNPARSEABLE */],
  ['money', '125 00', {}, 125.00], ['money', '$1,250.00', {}, 1250.00],
  ['code', ' e11.9 ', {}, { code: 'E11.9', codeNoDot: 'E119' }],   // when rule ICD10 is attached the caller passes icd:true
  ['code', '0450', {}, '0450'],
  ['phone', '(555) 123-4567', {}, '5551234567'],
  ['boolean', 'SELECTED', {}, true],
  ['enum', 'male', { enumValues: ['M','F'] }, null /* uncertain */],
  ```
  Split parsers: `personName('DOE, JANE A')` → `{last:'DOE', first:'JANE', middle:'A'}`; `personName('JANE A DOE')` → same; `cityStateZip('SPRINGFIELD IL 62704')`.
- [ ] **Steps 2–5:** fail → implement → pass → commit `feat(forms): value normalizers and split parsers`.

### Task 3.3: Resolvers

**Files:** Create `src/forms/resolvers/{query,key,region,checkbox,checkbox-group,layout,table,grid,id-field,expense-field,expense-line-items,key-repeat}.resolver.ts`, `src/forms/resolvers/index.ts`, specs (BlocksBuilder → EvidenceBuilder → resolver).
**Interfaces — Produces:** `Resolved` (`04` §6); `resolveField(src: FieldSource, ev: Evidence, pages: number[], claimed: Set<string>): Resolved | null`; `resolveCheckboxGroup(def: CheckboxGroupDef, ev, pages, claimed): { value: string | string[] | null; multi: boolean; prov: Provenance }`; `resolveGroup(def: GroupDef, ev, pages, claimed): { rows: Record<string, Resolved | null>[] }`.

- [ ] **Step 1: Failing tests** — one `describe` per resolver, covering the algorithm rows in `04` §6, plus:
  - `key` prefers a higher-score match over higher confidence; an empty value → `null`, not missing;
  - `region` ignores words whose center is outside the box;
  - `checkboxGroup` with 2 SELECTED → highest confidence + `multi: true`; the scope excludes an `M` outside the region;
  - `table` picks the table matching `headerMatch` among two tables; `dropEmptyRows`;
  - `grid` produces 6 rows and drops empty ones;
  - every resolver adds its evidence ids to `claimed`.
- [ ] **Steps 2–5:** fail → implement → pass → commit `feat(forms): evidence resolvers`.

### Task 3.4: Rule library

**Files:** Create `src/forms/rules/rule-library.ts`, `src/forms/rules/run-rules.ts`, specs.
**Interfaces — Produces:** `FIELD_RULES: Record<string, FieldRule>`, `FORM_CHECKS: Record<string, FormCheck>`, `runRules(def, normalized): ValidationIssue[]`, `ValidationIssue = { path: string; code: string; message: string; severity: 'error'|'warning' }`, `getAll(obj, pattern: string): { path: string; value: unknown }[]` (expands `[*]`).

- [ ] **Step 1: Failing tests:** NPI `1234567893` valid and `1234567890` invalid; ICD10 `E11.9` ok, `U07.1` produces a warning (spec-1's regex excludes the U range; this is a known false positive, so add a `// SPEC-QUESTION:` about allowing `U0[0-9]`); CPT `99213` ok, `9921` fails; `SUM_EQUALS` 100+25 vs 125.00 → no issue, vs 130 → warning on `box28`; skipped when any item is null; `POINTER_REFS` `'AB'` with `codes.B=null` → warning; `MAX_ROWS` 7 rows → error.
- [ ] **Steps 2–5:** fail → implement → pass → commit `feat(forms): rule library`.

### Task 3.5: Registry, MappingService, Flattener

**Files:** Create `src/forms/registry/form-registry.ts`, `src/pipeline/mapping.service.ts`, `src/forms/flatten/flattener.ts`, `src/forms/definitions/generic.form.ts`, `src/forms/definitions/index.ts`, specs.
**Interfaces — Produces:**
```ts
class FormRegistry { get(id: string): FormDefinition /* falls back to GENERIC */; all(): FormDefinition[];
  index(id: string): { byPattern: Map<string, { canonical?: string; type: ValueType; groupName?: string; label: string }> } }
const MAPPER_VERSION = '1';
class MappingService { map(def: FormDefinition, ev: Evidence, pages: number[]): MappedResult }   // 05 §6
function flatten(def: FormDefinition, idx: RegistryIndex, normalized: any, mapped: MappedResult, issues: ValidationIssue[]): FieldRow[]
```
GENERIC definition: `engine: AnalyzeDocument ['FORMS','LAYOUT']`, `fields: [ documentTitle (layout LAYOUT_TITLE) ]`, `captureUnmapped: true`, `segmentation: consecutive`, `classifier: { cues: [], minScore: 1 }`.

- [ ] **Step 1: Failing tests:**
  - the registry validates all definitions at construction (a bad one throws);
  - mapping GENERIC on the recorded CMS-1500 fixture → `_unmapped.length > 20`, each with a label and confidence;
  - flatten emits null leaves; `box24[1].cptHcpcs` → pattern `box24[*].cptHcpcs`, `groupIndex 1`, `groupName 'service_line'`;
  - `_unmapped` rows → `generic:<slug>`, `canonicalKey null`;
  - a low-confidence value → flag `low_confidence`;
  - `expectNoPhiInLogs` around `map()`.
- [ ] **Steps 2–5:** fail → implement → pass → commit `feat(forms): registry, mapper, flattener, GENERIC`.

### Task 3.6: Extractor + Finalizer + fields API (GENERIC end-to-end)

**Files:** Create `src/pipeline/extractor.service.ts`, `src/pipeline/finalizer.service.ts`, `src/review/fields.controller.ts` (GET part), `src/ingest/segments.controller.ts` (`GET …/segments/:segId/data`). Modify `pipeline.service.ts` (rasterize → single GENERIC segment for every document in this phase → extract → finalize). Add `test/e2e/generic.e2e-spec.ts` (FakeTextractClient).
**Interfaces — Produces:** `ExtractorService.run(segmentId, { force?, mode? })`; `FinalizerService.run(segmentId, mapped, callIds, mode)`; `GET /documents/:id/fields`.

- [ ] **Step 1: Failing e2e:** upload a fixture-backed PNG → document `PROCESSED`, 1 segment `NEEDS_REVIEW` (GENERIC), `GET /fields` returns rows with `label`, `confidence`, `bbox`, `page`; the Extraction has `pagesBilled 1`, `estCostUsd 0.05`; reprocessing with `mode=remap` makes **zero** new TextractCalls and a new current Extraction, with the old one `isCurrent=false`.
- [ ] **Steps 2–5:** fail → implement (transaction per `05` §7) → pass → commit `feat(pipeline): extract + finalize, GENERIC end-to-end`.

**P3 acceptance:** any supported upload produces field rows; nothing crashes on unknown forms; remap is free.

---

## P4 — CMS-1500

### Task 4.1: Region tuning tool

**Files:** Create `scripts/tune-regions.ts`.
**Produces:** `npm run tune-regions -- --form CMS1500 --case case-001` writes `tmp/tune/<case>-page-1.png` with anchors (blue), region/grid/scope boxes (red) and resolved values (green text) drawn via sharp SVG overlay. Synthetic only.
- [ ] Steps: implement → run it on case-001 → visually confirm → commit `chore: region tuning overlay tool`.

### Task 4.2: Full CMS-1500 definition

**Files:** Create `src/forms/definitions/cms1500.form.ts`, `test/fixtures/textract/CMS1500/case-00{1..5}/**` (recorded), `test-data/CMS1500/case-00{1..5}/expected.json`, `src/forms/definitions/cms1500.form.spec.ts`.
**Interfaces — Consumes:** DSL, resolvers, rules. **Produces:** `cms1500: FormDefinition` covering **every** native key in spec-1 §8.1 (carrier, boxes 1–33 incl. 9a–d, 10a–d, 11a–d, 17a/b, 21 A–L, 22, 24 rows with all 14 columns, 25 type, 32a/b, 33a/b).

**Query budget (15):** BOX1A, BOX2, BOX3_DOB, BOX4, BOX11, BOX17B, BOX21_A, BOX23, BOX25, BOX26, BOX28, BOX29, BOX32A, BOX33A, BOX33_NAME. Everything else uses key/region/checkbox/grid sources.

**Checkbox groups:** 1 (insurance type), 3 sex, 6 relationship, 10a/10b/10c (YES/NO each as a group with values `true`/`false` via `enum` → `boolean` normalization), 11a sex, 11d, 20, 25 SSN/EIN, 27.

- [ ] **Step 1: Failing test** — a generic fixture test runner (written once, reused by every form):
  ```ts
  describe.each(casesFor('CMS1500'))('CMS1500 %s', (c) => {
    it('maps to expected', async () => {
      const ev = await evidenceFromFixtures(c);                       // fixtures → Evidence
      const mapped = mapping.map(cms1500, ev, c.pages);
      const normalized = normalizeAll(cms1500, mapped.native);
      expect(stripUnmapped(normalized)).toEqual(c.expected);          // exact
    });
  });
  ```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Write the definition. Use the console view and fixture JSON to pick key texts. Tune regions with Task 4.1.
- [ ] **Step 4:** Iterate until ≥4/5 cases pass exactly. Record remaining diffs in `test-data/CMS1500/KNOWN_GAPS.md`. Never loosen `expected.json` to pass.
- [ ] **Step 5:** commit `feat(forms): CMS-1500 definition`.

### Task 4.3: Subtype + subject hints

**Files:** Modify `finalizer.service.ts`; create `src/forms/subtypes.ts` + spec.
**Produces:** `resolveSubtype(def, normalized, hint?): { subtype: string | null; docTypeLabel: string | null }`, `pickSubjectHints(def, normalized)`.
- [ ] Tests: CPT `00142` → `ANESTHESIA`/`ANESTHESIA_CLAIM`; hint `ANESTHESIA_CLAIM` → the same; otherwise `PHYSICIAN_CLAIM`. Implement → pass → commit.

### Task 4.4: Eval script

**Files:** Create `scripts/eval.ts`, `scripts/eval/compare.ts`, `scripts/eval/report.ts`, spec for `compare.ts`.
**Produces:** `npm run eval -- --form <ID> [--live] [--sweep-confidence a..b:step] [--promotion-report]` → `reports/eval-<date>-<form>.md` with the `07` §4 metrics.
- [ ] Tests for `compare()`: exact, miss, hallucination, row alignment, checkbox counting, accepted-but-wrong (uses flags). Implement → run on CMS1500 → commit the report as a baseline → commit `feat(eval): golden-set evaluation`.

**P4 acceptance:** the golden CMS-1500 set runs through eval; NPI/ICD/total rules produce the expected issues; the baseline report is committed.

---

## P5 — Classification and segmentation

### Task 5.1: Page scorer

**Files:** Create `src/pipeline/scoring.ts` + spec.
**Produces:** `scorePage(lines: EvLine[], defs: FormDefinition[], hint?: string, boost?: number): PageClass` with `PageClass = { formType: string; score: number; evidence: { matchedCues: {cue: string; weight: number}[]; runnerUp?: { formType: string; score: number } }; pageOf?: [number, number] }`.
- [ ] **Step 1: Failing tests:** the CMS-1500 detect fixture → `CMS1500` score ≥ 0.6; a UB-04 detect fixture → `UB04`; a letter → `GENERIC`; a negative cue (`UB-04` text on a CMS-like page) lowers the score; a `top` region cue ignored when the line is at `top: 0.5`; the hint boost flips a near-tie; `pageOf` is parsed from `PAGE 2 OF 3`.
- [ ] Steps 2–5 → commit `feat(classify): cue scoring`.

### Task 5.2: Segmenter

**Files:** Create `src/pipeline/segmenter.ts` + spec.
**Produces:** `segment(pages: (PageClass & { page: number; lines: EvLine[] })[], defs: Map<string, FormDefinition>): SegmentDraft[]` where `SegmentDraft = { formType: string; pageStart: number; pageEnd: number; score: number }`. Lines are needed for continuation cues.
- [ ] **Step 1: Failing tests (table-driven):**
  ```ts
  ['CMS1500','CMS1500','UB04(1/2)','UB04(2/2)','GENERIC'] → [CMS1500 1-1, CMS1500 2-2, UB04 3-4, GENERIC 5-5]
  ['BOOKING_SHEET','GENERIC+continuationCue','CMS1500'] → [BOOKING 1-2, CMS1500 3-3]
  ['INSURANCE_CARD','INSURANCE_CARD','INSURANCE_CARD'] → [CARD 1-2, CARD 3-3]   // maxPages 2
  ['UB04(1/2)','UB04(1/2)'] → two segments (a new claim restarts at 1)
  ```
- [ ] Steps 2–5 → commit `feat(classify): segmenter`.

### Task 5.3: ClassifierService + pipeline wiring

**Files:** Create `src/pipeline/classifier.service.ts`. Modify `pipeline.service.ts` (rasterize → classify → per-segment extract → finalize). Add `test/e2e/mixed-packet.e2e-spec.ts`.
**Produces:** `ClassifierService.run(documentId)` (bypass rules `05` §3.1, DetectDocumentText through `TextractGateway`, Page classification columns, Segment rows).
- [ ] **Step 1: Failing e2e:** a mixed fixture packet (2× CMS1500 + 1 UB04 single page + 1 letter) → 4 segments with the right types; the hint `CMS1500` on a 1-page upload → 0 DetectDocumentText calls.
- [ ] Steps 2–5 → commit `feat(classify): classifier service and pipeline wiring`.

**P5 acceptance:** mixed PDF → 4 correct segments; classification accuracy is in the eval report.

---

## P6 — More forms

Each task below follows the **same five steps** as Task 4.2: (1) record ≥5 synthetic fixtures + `expected.json`; (2) write the fixture-runner test (`describe.each(casesFor('<ID>'))`); (3) write the definition; (4) iterate to ≥4/5 exact; (5) run eval, commit the report + definition. No pipeline code changes are allowed. If one seems needed, stop and raise it, because it signals a DSL gap that belongs in a separate, reviewed task.

### Task 6.1: UB-04 (`ub04.form.ts`)
- Engine `AnalyzeDocument ['FORMS','TABLES','QUERIES']`. Segmentation `pageOfTotal` with regex `PAGE\s*(\d+)\s*OF\s*(\d+)`.
- Fields per spec-1 §8.2 (FL1–FL81, reserved FLs captured as strings). Revenue lines `fl42_48` group (`name: 'revenue_line'`, `maxRows: 22`) from `table` → `grid` sources; `line23` fields (page, of, creationDate, totalCharges, nonCoveredTotal).
- Queries (15): FL3A, FL4, FL5, FL6_FROM, FL6_THROUGH, FL8B, FL10, FL12, FL56, FL60_A, FL62_A, FL67, FL76_NPI, LINE23_TOTAL, FL50_A.
- Multi-page: the mapper merges the group rows across the segment's pages in order. Header fields come from page 1 unless null.
- Checks: `MAX_ROWS` (22 per page → expressed as `maxRows: 22 × pages`, rule param `perPage: true`), `SUM_EQUALS` lines vs `line23.totalCharges`, `REV_CODE` on `fl42`, `NPI` on FL56/76/77.

### Task 6.2: Booking sheet (`booking-sheet.form.ts`)
- Engine `['FORMS','TABLES','LAYOUT']`. Segmentation `consecutive` with continuation cues.
- Fields per spec-1 §8.3 using `key` sources with broad `anyOf` synonyms (`['PATIENT NAME','PT NAME','NAME OF PATIENT']`), `layout` fallbacks, groups `procedures` (keyRepeat / table), `diagnoses`, `insurance`.
- `captureUnmapped` stays on, which gives spec-1's `additionalFields` for free (stored as `generic:*` rows).
- Cues: `BOOKING SHEET`, `SURGERY SCHEDULING`, `SURGICAL BOOKING`, `PROCEDURE DATE`, `SURGEON`. `minScore` 0.35.

### Task 6.3: Insurance card (`insurance-card.form.ts`)
- Engine `['FORMS','QUERIES']`. Queries: MEMBER_ID, GROUP_NUMBER, MEMBER_NAME, PAYER_NAME, PAYER_ID, RX_BIN, RX_PCN, RX_GRP, COPAY_PCP, CUSTOMER_SERVICE_PHONE.
- Canonical: `insured.id`, `insured.group_number`, `insured.name.*` (split), `payer.name`, `payer.id`, `plan.rx_bin`, `plan.rx_pcn`, `payer.phone`.
- Cues: `MEMBER ID`, `GROUP`, `RXBIN`, `RXPCN`, `SUBSCRIBER`, `COPAY`, and the image aspect ratio hint (card ≈ 1.586). `// SPEC-QUESTION: aspect-ratio cue needs Page width/height in scorer input`.

### Task 6.4: US driver license / passport (`us-id.form.ts`)
- Engine `{ api: 'AnalyzeID' }`. Segmentation `consecutive`, `maxPages: 2` (front + back in one call). Requires `TextractGateway.getOrCallId` (P2.5).
- Fields via `idField`: FIRST_NAME, LAST_NAME, MIDDLE_NAME, DATE_OF_BIRTH (`dateKind: 'dob'`), DOCUMENT_NUMBER, EXPIRATION_DATE, ADDRESS, CITY_IN_ADDRESS, STATE_IN_ADDRESS, ZIP_CODE_IN_ADDRESS, STATE_NAME, ID_TYPE.
- Canonical: `patient.name.*`, `patient.dob`, `patient.address.*`, `id.document_number`, `id.expiration_date`, `id.issuing_state`.
- Cues: `DRIVER LICENSE`, `DRIVER'S LICENSE`, `USA`, `DLN`, `CLASS`, `PASSPORT`, `EXP`.

### Task 6.5: Invoice (`invoice.form.ts`)
- Engine `{ api: 'AnalyzeExpense' }`. Fields via `expenseField`: VENDOR_NAME, INVOICE_RECEIPT_ID, INVOICE_RECEIPT_DATE, TOTAL, AMOUNT_DUE, SUBTOTAL, TAX. Group `items` from `expenseLineItems` (ITEM, QUANTITY, UNIT_PRICE, PRICE).
- `OTHER` summary fields → `_unmapped` (kept).
- Cues: `INVOICE`, `AMOUNT DUE`, `BILL TO`, `REMIT TO`, `RECEIPT`.

### Task 6.6: Evidence builder for AnalyzeID and AnalyzeExpense

**This task comes before 6.4/6.5** (it is shared code, not form code). **Files:** modify `src/textract/evidence.builder.ts` (+ `fromAnalyzeId`, `fromAnalyzeExpense`), `src/pipeline/extractor.service.ts` (route by `engine.api`), specs with recorded fixtures.
- [ ] Tests per `04` §5.1 bullets for ID/Expense; the extractor makes exactly 1 AnalyzeID call for a 2-page US_ID segment.
- [ ] Commit `feat(textract): AnalyzeID and AnalyzeExpense evidence`.

**P6 acceptance:** each form passes its eval at the POC target, or has a documented gap; a mixed packet with all 7 types segments correctly.

---

## P7 — Review, autofill, profiles, integration

### Task 7.1: Field review + segment approve/reject
**Files:** `src/review/review.service.ts`, `src/review/fields.controller.ts` (PATCH, confirm), `src/review/segments.controller.ts` (approve/reject/PATCH formType), e2e.
**Produces:** endpoints in `05` §9.1; `FieldReviewEvent` rows; outbox `segment.approved` / `segment.rejected`.
- [ ] Tests: editing a date to `'1984-03-12'` stores the normalized value and clears `low_confidence`; an invalid NPI edit keeps `validation_error`; approve with open flags → 409; `force` → 200 and logged; the history has 2 events after edit + confirm. Commit.

### Task 7.2: Autofill
**Files:** `src/autofill/autofill.service.ts` (raw SQL via `prisma.$queryRaw` with `Prisma.sql` parameters only), `src/autofill/autofill.controller.ts`, e2e.
- [ ] Tests: a reviewed value beats a newer unreviewed one; `link=patient:123` scope; match by DOB + last name; nulls skipped; diagnosis codes returned as an ordered array; a cross-tenant query returns nothing. Commit.

### Task 7.3: Target profiles + preview
**Files:** `src/autofill/profiles/{default-patient,default-insurance,default-bundle}.profile.ts`, `src/autofill/profile.types.ts`, `src/autofill/preview.service.ts`, e2e.
**Produces:** `TargetProfile` type (`05` §9.3), `GET /segments/:id/preview/:profile`. Boot validation: every profile key exists in `CANONICAL_KEYS`.
- [ ] Tests: the CMS-1500 fixture segment → `default.patient` returns `firstName`, `lastName`, `dateOfBirth` with fieldIds; `gender` mapped `M→MALE`; unknown profile → 404. Commit. `// SPEC-QUESTION` on host DTO names stays until confirmed.

### Task 7.4: Outbox publisher + apply events
**Files:** `src/integration/outbox.service.ts`, `src/integration/outbox.publisher.ts` (`log` + `webhook` drivers), `src/integration/apply-events.controller.ts`, specs.
- [ ] Tests: the publisher marks `publishedAt`; a webhook 500 → `attempts++` with backoff; the HMAC header verifies with the secret; payloads contain no field values (assert keys ⊆ allowlist); `POST apply-events` stores an `ApplyEvent` and emits `segment.applied`. Commit.

### Task 7.5: Documents list + OpenAPI
**Files:** `GET /documents?link=&status=` in `documents.controller.ts`; OpenAPI generation (choose `@nestjs/swagger` with justification, or a hand-written yaml).
- [ ] Tests: list filtering + paging. Commit.

**P7 acceptance:** the reviewed value wins in autofill; the profile preview returns host-shaped JSON; each event is published exactly once in the happy path.

---

## P8 — Queue, throughput, reprocess

### Task 8.1: BullMQ flows
**Files:** `src/pipeline/queue/queues.ts`, `src/pipeline/queue/processors/{rasterize,classify,extract,finalize-document}.processor.ts`, modify `pipeline.service.ts` and `main.ts` (`APP_ROLE`).
**Design:** queue `idp-document` (rasterize → classify), then a `FlowProducer` flow: parent `finalize-document` with children `extract` per segment. `jobId` = `${stage}:${id}` (dedupe). Attempts 5, exponential backoff 2 s base. `removeOnComplete: 1000`.
- [ ] Tests (e2e with valkey): upload → 202 → poll `GET /documents/:id` until `PROCESSED`; killing the worker mid-extract and restarting completes without duplicate TextractCalls (requestHash reuse). Commit.

### Task 8.2: Global Textract rate limiting
- Separate queue `idp-textract-<api>` per API, with BullMQ `limiter: { max: TPS, duration: 1000 }` (global across workers). The extractor enqueues page calls and awaits job completion (`waitUntilFinished` with `QueueEvents`).
- [ ] Tests: with TPS=2 and 6 page jobs, the completion timestamps span ≥ 2 s. Commit.

### Task 8.3: Reprocess API + remap script
**Files:** `POST /documents/:id/reprocess`, `scripts/remap.ts`.
- [ ] Tests: `remap` → 0 TextractCalls, a new Extraction with `mode='remap'`; `reanalyze` without `confirm` → 400 with `estimatedCostUsd`; with `confirm` → new calls (`force`). The remap script supports `--form-type`, `--to`, `--since`, `--dry-run`. Commit.

### Task 8.4 (optional): Async Textract path
Only if `01` §11 is done. `TextractAsyncGateway` with `StartDocumentAnalysis` on the **original PDF** (≤3,000 pages, 30 queries per page, `QueriesConfig.Queries[].Pages` per segment page range), an SQS consumer for completion, and paginated `GetDocumentAnalysis` → split blocks by `Page` → the same EvidenceBuilder. Feature flag `TEXTRACT_MODE=async`. Tests with mocked SNS/SQS messages.

**P8 acceptance:** upload returns 202; the worker processes it; remap creates a new Extraction with zero Textract calls.

---

## P9 — Production hardening

### Task 9.1: S3 storage driver
`src/storage/s3.storage.ts`: `PutObject` with `ServerSideEncryption: 'aws:kms'`, `SSEKMSKeyId`, `ContentType`, `ContentEncoding`; `presignGet` via `@aws-sdk/s3-request-presigner`; `textractInput` → `{ s3: { bucket, key } }`. Tests with `aws-sdk-client-mock`; an opt-in AWS contract test.

### Task 9.2: PHI mode enforcement + log scan
- Boot refusal per `05` §12. A global test `test/phi-log-scan.e2e-spec.ts` runs every fixture through the pipeline with logs captured and asserts that no value from any `expected.json` (strings ≥4 chars) appears in the logs or error messages.
- A lint rule (ESLint `no-restricted-syntax`) bans `console.*` in `src/`.

### Task 9.3: Tenancy hardening (Postgres RLS)
- Migration: `ALTER TABLE … ENABLE ROW LEVEL SECURITY` + policy `tenantId = current_setting('app.tenant_id')` on all tenant tables. A Prisma client extension wraps each request in `$transaction([SET LOCAL app.tenant_id = $1, …])`. The migration role bypasses RLS.
- Test: a raw query without the setting returns 0 rows.

### Task 9.4: Retention job
- Worker cron (BullMQ repeatable, daily): delete page images for documents whose segments are all `APPROVED`/`REJECTED` older than `PAGE_IMAGE_RETENTION_DAYS`; set `Page.imagesDeletedAt`. Tests with a fake clock.

### Task 9.5: Auth integration
- Replace the `x-tenant-id` header with host-platform JWT (OIDC) verification (JWKS URL env, `tenantId` + `sub` claims → `reviewer`/`appliedBy`). `// SPEC-QUESTION:` claim names are configurable (`AUTH_TENANT_CLAIM`, `AUTH_USER_CLAIM`).

### Task 9.6: Observability + deploy
- EMF metrics (`05` §13), CloudWatch dashboards and alarms from `01` §9, ECS task definitions for the `api` and `worker` roles, a one-off migration task, a runbook `docs/runbooks/idp.md` (deploy, rollback, reprocess, quota-throttling response, re-record fixtures).

### Task 9.7: "New form" CI guard
- A CI job: when the PR has label `new-form`, fail if the changed files fall outside `src/forms/definitions/**`, `test/fixtures/**`, `test-data/**`, `reports/**`.

### Task 9.8 (option): DB-stored definitions
- `DbFormRegistry` loads `FormDefinitionRecord` rows with `status='active'`, validates with the same validator, and merges over the code definitions (DB wins on the same id when the version is newer). Admin endpoints `POST /admin/forms` (draft), `POST /admin/forms/:id/:version/activate` (runs the fixture test suite for that form in-process before activating). Enable only after the DSL has been stable for ≥2 new forms.

### Task 9.9 (option): Classifier fallback and vision overlay
- `ClassifierFallback` implementation using Bedrock (text-only, PHI-approved model, under the BAA) for pages scored between 0.2 and `minScore`.
- `EvidenceEngine` overlay: a Bedrock vision model producing values for low-confidence fields only (Workflow §8.1 "later overlay if booking-sheet handwriting is weak"). It plugs into the resolver chain as a new source kind `{ kind: 'overlay', engine: 'bedrock' }`, so definitions opt in per field.

### Task 9.10: Package as a product (Docker image + npm module)
- Build two artifacts from one source: (a) the Docker image (Mode A), (b) the npm package `@your-org/idp` (Mode B) with `exports` limited to `dist/index.js`, Prisma migrations shipped under `migrations/`, and a `idp migrate` bin that runs `prisma migrate deploy` with the package's schema.
- `examples/embedded-host/`: a minimal NestJS app that imports `IdpModule.forRootAsync`, with a custom `AuthPort` and `TargetProfile`. CI boots it and runs one upload e2e against the fake Textract client.
- `CHANGELOG.md` + semantic-release (or manual tags). Contract tests on the REST/OpenAPI and event schemas block breaking changes without a major bump.

**P9 acceptance:** the log scan finds no PHI; RLS blocks cross-tenant reads; the deploy runbook has been executed in staging; the `01` §13 sign-off checklist is complete.
