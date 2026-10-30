import {
  AnalyzeDocumentCommand,
  type Block,
  DetectDocumentTextCommand,
  TextractClient,
} from '@aws-sdk/client-textract';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it } from 'vitest';
import {
  BOOKING_SHEET,
  CMS1500,
  GENERIC,
  INSURANCE_CARD,
  PATIENT_INTAKE,
  UB04,
} from '../../forms/definitions';
import { buildJsonSchema } from '../../forms/json-schema.builder';
import { EngineError, type EngineRequest } from '../engine.port';
import { costPerPage, planTextract, QUERIES_PER_CALL, TextractEngine } from './textract.engine';
import { labelScore, mapTextractPages } from './textract.mapper';

/** Builds Textract Block graphs by hand (plan 07: BlocksBuilder). */
class Blocks {
  readonly list: Block[] = [];
  private n = 0;
  private id = (p: string) => `${p}${++this.n}`;
  private geo = () => ({
    BoundingBox: { Left: 0.1, Top: (this.n % 40) * 0.02, Width: 0.2, Height: 0.02 },
  });

  private words(text: string): string[] {
    return text
      .split(' ')
      .filter(Boolean)
      .map((t) => {
        const id = this.id('w');
        this.list.push({ Id: id, BlockType: 'WORD', Text: t, Confidence: 99 });
        return id;
      });
  }

  query(alias: string, answer: string | null, confidence = 95): this {
    const qid = this.id('q');
    const rid = this.id('r');
    this.list.push({
      Id: qid,
      BlockType: 'QUERY',
      Query: { Text: alias, Alias: alias },
      Relationships: answer === null ? [] : [{ Type: 'ANSWER', Ids: [rid] }],
    });
    if (answer !== null)
      this.list.push({
        Id: rid,
        BlockType: 'QUERY_RESULT',
        Text: answer,
        Confidence: confidence,
        Geometry: this.geo(),
      });
    return this;
  }

  kv(key: string, value: string, opts: { selected?: boolean; confidence?: number } = {}): this {
    const kid = this.id('k');
    const vid = this.id('v');
    const valueChildren =
      opts.selected === undefined ? this.words(value) : [this.selection(opts.selected)];
    this.list.push(
      {
        Id: kid,
        BlockType: 'KEY_VALUE_SET',
        EntityTypes: ['KEY'],
        Confidence: opts.confidence ?? 90,
        Relationships: [
          { Type: 'VALUE', Ids: [vid] },
          { Type: 'CHILD', Ids: this.words(key) },
        ],
      },
      {
        Id: vid,
        BlockType: 'KEY_VALUE_SET',
        EntityTypes: ['VALUE'],
        Confidence: opts.confidence ?? 90,
        Geometry: this.geo(),
        Relationships: [{ Type: 'CHILD', Ids: valueChildren }],
      },
    );
    return this;
  }

  private selection(selected: boolean): string {
    const id = this.id('s');
    this.list.push({
      Id: id,
      BlockType: 'SELECTION_ELEMENT',
      SelectionStatus: selected ? 'SELECTED' : 'NOT_SELECTED',
      Confidence: 97,
      Geometry: this.geo(),
    });
    return id;
  }

  table(header: string[], rows: string[][]): this {
    const cells: string[] = [];
    [header, ...rows].forEach((row, r) =>
      row.forEach((text, c) => {
        const id = this.id('c');
        cells.push(id);
        this.list.push({
          Id: id,
          BlockType: 'CELL',
          RowIndex: r + 1,
          ColumnIndex: c + 1,
          Confidence: 93,
          Geometry: this.geo(),
          ...(r === 0 ? { EntityTypes: ['COLUMN_HEADER'] } : {}),
          Relationships: text ? [{ Type: 'CHILD', Ids: this.words(text) }] : [],
        });
      }),
    );
    this.list.push({
      Id: this.id('t'),
      BlockType: 'TABLE',
      Relationships: [{ Type: 'CHILD', Ids: cells }],
    });
    return this;
  }
}

const value = (fields: { path: string; value: unknown }[], path: string) =>
  fields.find((f) => f.path === path)?.value;

describe('labelScore', () => {
  it('exact > all tokens > partial; box numbers and punctuation ignored', () => {
    expect(labelScore("INSURED'S I.D. NUMBER", "1a. INSURED'S I.D. NUMBER")).toBeGreaterThan(0.95);
    expect(labelScore('SEX', 'SEX')).toBe(2);
    expect(labelScore('SEX', 'SEX')).toBeGreaterThan(labelScore('SEX', 'PATIENT SEX AND DOB'));
    expect(labelScore('PATIENT NAME', 'INSURED NAME')).toBeLessThan(0.8);
  });
});

describe('mapTextractPages', () => {
  it('query fields: best answer across pages, explicit nulls for unanswered, form order first', () => {
    const fields = mapTextractPages(INSURANCE_CARD, [
      {
        pageNumber: 1,
        blocks: new Blocks().query('member.id', 'ZZX1', 60).query('payer.name', '').list,
      },
      { pageNumber: 2, blocks: new Blocks().query('member.id', 'ZZX123', 95).list },
    ]);
    expect(fields.slice(0, INSURANCE_CARD.fields.length).map((f) => f.path)).toEqual(
      INSURANCE_CARD.fields.map((f) => f.path),
    );
    expect(fields.find((f) => f.path === 'member.id')).toMatchObject({
      value: 'ZZX123',
      page: 2,
      confidence: 95,
    });
    expect(fields.find((f) => f.path === 'payer.name')).toMatchObject({
      value: null,
      confidence: null,
    });
  });

  it('CMS-1500: key fields by printed box caption, one key per field, Box 24 table rows, unclaimed keys -> otherFields', () => {
    const page = new Blocks()
      .kv("1a. INSURED'S I.D. NUMBER (For Program in Item 1)", 'ZZX123456789', { confidence: 96 })
      .kv("2. PATIENT'S NAME (Last Name, First Name, Middle Initial)", 'SAMPLE, JANE, Q')
      .kv("4. INSURED'S NAME (Last Name, First Name, Middle Initial)", 'SAMPLE, JANE, Q')
      .kv('28. TOTAL CHARGE', '$175.00')
      .kv('SIGNED', 'SIGNATURE ON FILE')
      .table(
        [
          'DATE(S) OF SERVICE FROM',
          'TO',
          'PLACE OF SERVICE',
          'EMG',
          'CPT/HCPCS',
          'MODIFIER',
          'DIAGNOSIS POINTER',
          '$ CHARGES',
          'DAYS OR UNITS',
          'RENDERING PROVIDER ID. # NPI',
        ],
        [
          ['01 05 26', '01 05 26', '11', '', '99213', '25', 'A', '150 00', '1', '0000000002'],
          ['', '', '', '', '', '', '', '', '', ''],
          ['01 05 26', '01 05 26', '11', '', '36415', '', 'B', '25 00', '1', '0000000002'],
        ],
      );
    const fields = mapTextractPages(CMS1500, [{ pageNumber: 1, blocks: page.list }]);

    expect(fields.find((f) => f.path === 'insured.id')).toMatchObject({
      value: 'ZZX123456789',
      confidence: 96,
      page: 1,
    });
    expect(value(fields, 'patient.name')).toBe('SAMPLE, JANE, Q');
    expect(value(fields, 'insured.name')).toBe('SAMPLE, JANE, Q');
    expect(value(fields, 'totalCharge')).toBe('$175.00');

    // Box 24: blank row dropped, numbering stays dense.
    expect(value(fields, 'serviceLines[0].cptHcpcs')).toBe('99213');
    expect(value(fields, 'serviceLines[0].dateTo')).toBe('01 05 26');
    expect(value(fields, 'serviceLines[0].charges')).toBe('150 00');
    expect(value(fields, 'serviceLines[1].cptHcpcs')).toBe('36415');
    expect(value(fields, 'serviceLines[1].modifier')).toBeNull();
    expect(fields.some((f) => f.path.startsWith('serviceLines[2]'))).toBe(false);

    const other = fields.filter((f) => f.path.startsWith('otherFields'));
    expect(other).toEqual([
      expect.objectContaining({
        path: 'otherFields[0]',
        label: 'SIGNED',
        value: 'SIGNATURE ON FILE',
      }),
    ]);
  });

  it('UB-04 revenue lines from a table; booking sheet checkbox from a selection element', () => {
    const ub = new Blocks().kv('4 TYPE OF BILL', '0111').table(
      [
        '42 REV. CD.',
        '43 DESCRIPTION',
        '44 HCPCS / RATE / HIPPS CODE',
        '45 SERV. DATE',
        '46 SERV. UNITS',
        '47 TOTAL CHARGES',
        '48 NON-COVERED CHARGES',
      ],
      [
        ['0110', 'ROOM-BOARD/PVT', '', '010526', '3', '3000 00', ''],
        ['0300', 'LABORATORY', '80053', '010626', '1', '85 00', ''],
      ],
    );
    const ubFields = mapTextractPages(UB04, [{ pageNumber: 1, blocks: ub.list }]);
    expect(value(ubFields, 'typeOfBill')).toBe('0111');
    expect(value(ubFields, 'revenueLines[1].hcpcsRate')).toBe('80053');
    expect(value(ubFields, 'revenueLines[0].units')).toBe('3');

    const booking = new Blocks()
      .kv('Latex allergy:', '', { selected: true })
      .kv('Surgeon:', 'DR JOHN SAMPLE')
      .kv('Surgery date:', '02/14/2026');
    const bFields = mapTextractPages(BOOKING_SHEET, [{ pageNumber: 1, blocks: booking.list }]);
    expect(value(bFields, 'latexAllergy')).toBe(true);
    expect(value(bFields, 'surgeon.name')).toBe('DR JOHN SAMPLE');
    expect(value(bFields, 'procedure.date')).toBe('02/14/2026');
  });

  it('a table whose headers do not match the group is ignored', () => {
    const fields = mapTextractPages(CMS1500, [
      { pageNumber: 1, blocks: new Blocks().table(['FOO', 'BAR'], [['1', '2']]).list },
    ]);
    expect(fields.some((f) => f.path.startsWith('serviceLines'))).toBe(false);
  });

  it('GENERIC: every key/value becomes an otherFields entry', () => {
    const fields = mapTextractPages(GENERIC, [
      {
        pageNumber: 1,
        blocks: new Blocks().kv('Reference number:', 'ZZREF-0001').kv('Account:', 'ZZACCT-0002')
          .list,
      },
    ]);
    expect(fields.map((f) => [f.path, f.label, f.value])).toEqual([
      ['otherFields[0]', 'Reference number:', 'ZZREF-0001'],
      ['otherFields[1]', 'Account:', 'ZZACCT-0002'],
    ]);
  });
});

describe('planTextract', () => {
  it('batches queries by 15 and picks FORMS/TABLES only when needed', () => {
    const cms = planTextract(CMS1500);
    const queryCount = cms.queryBatches.flat().length;
    expect(queryCount).toBeGreaterThan(QUERIES_PER_CALL);
    expect(cms.queryBatches.every((b) => b.length <= QUERIES_PER_CALL)).toBe(true);
    expect(cms.features).toEqual(['QUERIES', 'FORMS', 'TABLES']);
    expect(planTextract(GENERIC)).toEqual({ features: ['FORMS'], queryBatches: [] });
    expect(planTextract({ ...INSURANCE_CARD, captureOther: false }).features).toEqual(['QUERIES']);
    // One FORMS+TABLES+QUERIES call + one extra QUERIES batch per page.
    expect(costPerPage(cms)).toBeCloseTo(
      0.05 + 0.015 + 0.015 + 0.015 * (cms.queryBatches.length - 1),
    );
  });
});

describe('TextractEngine', () => {
  const request = (form = CMS1500, pages = 2): EngineRequest => ({
    tenantId: 't1',
    documentId: 'd1',
    form,
    schema: buildJsonSchema(form).schema,
    document: { bytes: Buffer.from('x'), mimeType: 'application/pdf', pageCount: pages },
    pages: Array.from({ length: pages }, (_, i) => ({
      pageNumber: i + 1,
      bytes: Buffer.from(`p${i}`),
    })),
  });

  it('per page: first call with all features + 15 queries, then QUERIES-only calls for further batches', async () => {
    const sdk = mockClient(TextractClient);
    sdk.on(AnalyzeDocumentCommand).resolves({
      Blocks: new Blocks().query('billing.npi', '0000000004').list,
      AnalyzeDocumentModelVersion: '1.0',
    });
    const result = await new TextractEngine(sdk as unknown as TextractClient).extract(request());

    const plan = planTextract(CMS1500);
    const calls = sdk.commandCalls(AnalyzeDocumentCommand);
    expect(calls).toHaveLength(2 * plan.queryBatches.length);
    const first = calls[0]!.args[0].input;
    expect(first.FeatureTypes).toEqual(['QUERIES', 'FORMS', 'TABLES']);
    expect(first.QueriesConfig!.Queries).toHaveLength(QUERIES_PER_CALL);
    expect(calls[1]!.args[0].input.FeatureTypes).toEqual(['QUERIES']);
    expect(result.fields.find((f) => f.path === 'billing.npi')!.value).toBe('0000000004');
    expect(result.estCostUsd).toBeCloseTo(2 * costPerPage(plan));
  });

  it('PATIENT_INTAKE: QUERIES + FORMS (checkbox and otherFields)', async () => {
    const sdk = mockClient(TextractClient);
    sdk.on(AnalyzeDocumentCommand).resolves({ Blocks: [] });
    await new TextractEngine(sdk as unknown as TextractClient).extract(request(PATIENT_INTAKE, 1));
    expect(sdk.commandCalls(AnalyzeDocumentCommand)[0]!.args[0].input.FeatureTypes).toEqual([
      'QUERIES',
      'FORMS',
    ]);
  });

  it('detectText returns LINE text for classification OCR', async () => {
    const sdk = mockClient(TextractClient);
    sdk.on(DetectDocumentTextCommand).resolves({
      Blocks: [
        { BlockType: 'LINE', Text: 'HEALTH INSURANCE CLAIM FORM' },
        { BlockType: 'WORD', Text: 'x' },
      ],
    });
    expect(
      await new TextractEngine(sdk as unknown as TextractClient).detectText(Buffer.from('png')),
    ).toBe('HEALTH INSURANCE CLAIM FORM');
  });

  it('classifies throttling as retryable and bad documents as not', async () => {
    const throttle = Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
    const bad = Object.assign(new Error('bad'), { name: 'UnsupportedDocumentException' });
    const sdk = mockClient(TextractClient);
    sdk.on(AnalyzeDocumentCommand).rejectsOnce(throttle).rejectsOnce(bad);
    const engine = new TextractEngine(sdk as unknown as TextractClient);
    await expect(engine.extract(request(GENERIC, 1))).rejects.toMatchObject({
      code: 'ThrottlingException',
      retryable: true,
    });
    await expect(engine.extract(request(GENERIC, 1))).rejects.toSatisfy(
      (e: unknown) => e instanceof EngineError && !e.retryable,
    );
  });
});
