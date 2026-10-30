import { AnalyzeDocumentCommand, type Block, TextractClient } from '@aws-sdk/client-textract';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it } from 'vitest';
import { INSURANCE_CARD, PATIENT_INTAKE } from '../../forms/definitions';
import { buildJsonSchema } from '../../forms/json-schema.builder';
import { EngineError, type EngineRequest } from '../engine.port';
import { TextractEngine } from './textract.engine';
import { mapTextractPages } from './textract.mapper';

const geo = (left: number, top: number) => ({
  BoundingBox: { Left: left, Top: top, Width: 0.2, Height: 0.03 },
});

function queryBlocks(alias: string, text: string | null, confidence: number, idx: number): Block[] {
  const q: Block = {
    Id: `q${idx}`,
    BlockType: 'QUERY',
    Query: { Text: alias, Alias: alias },
    Relationships: text === null ? [] : [{ Type: 'ANSWER', Ids: [`r${idx}`] }],
  };
  if (text === null) return [q];
  return [
    q,
    {
      Id: `r${idx}`,
      BlockType: 'QUERY_RESULT',
      Text: text,
      Confidence: confidence,
      Geometry: geo(0.1, 0.1 * idx),
    },
  ];
}

function checkboxBlocks(keyText: string, selected: boolean): Block[] {
  return [
    {
      Id: 'k1',
      BlockType: 'KEY_VALUE_SET',
      EntityTypes: ['KEY'],
      Confidence: 88,
      Relationships: [
        { Type: 'VALUE', Ids: ['v1'] },
        { Type: 'CHILD', Ids: ['w1'] },
      ],
    },
    { Id: 'w1', BlockType: 'WORD', Text: keyText },
    {
      Id: 'v1',
      BlockType: 'KEY_VALUE_SET',
      EntityTypes: ['VALUE'],
      Relationships: [{ Type: 'CHILD', Ids: ['s1'] }],
    },
    {
      Id: 's1',
      BlockType: 'SELECTION_ELEMENT',
      SelectionStatus: selected ? 'SELECTED' : 'NOT_SELECTED',
      Confidence: 97,
      Geometry: geo(0.5, 0.8),
    },
  ];
}

describe('mapTextractPages', () => {
  it('maps query answers to fields, in form order, with bbox and page', () => {
    const fields = mapTextractPages(INSURANCE_CARD, [
      {
        pageNumber: 1,
        blocks: [
          ...queryBlocks('member.id', 'ZZX123', 97.5, 1),
          ...queryBlocks('payer.name', 'SYNTH PLAN', 91, 2),
        ],
      },
    ]);
    expect(fields.map((f) => f.path)).toEqual(INSURANCE_CARD.fields.map((f) => f.path));
    const id = fields.find((f) => f.path === 'member.id')!;
    expect(id).toMatchObject({
      value: 'ZZX123',
      confidence: 97.5,
      confidenceSource: 'numeric',
      page: 1,
    });
    expect(id.bbox).toEqual({ left: 0.1, top: 0.1, width: 0.2, height: 0.03 });
  });

  it('missing answers become explicit nulls (blank, never guessed)', () => {
    const fields = mapTextractPages(INSURANCE_CARD, [
      { pageNumber: 1, blocks: queryBlocks('member.id', null, 0, 1) },
    ]);
    expect(fields.find((f) => f.path === 'member.id')).toMatchObject({
      value: null,
      confidence: null,
      bbox: null,
    });
  });

  it('keeps the highest-confidence answer across pages and reports that page', () => {
    const fields = mapTextractPages(INSURANCE_CARD, [
      { pageNumber: 1, blocks: queryBlocks('member.id', 'ZZX1', 60, 1) },
      { pageNumber: 2, blocks: queryBlocks('member.id', 'ZZX123', 95, 1) },
    ]);
    expect(fields.find((f) => f.path === 'member.id')).toMatchObject({ value: 'ZZX123', page: 2 });
  });

  it('reads checkboxes from FORMS selection elements via keyAliases', () => {
    const fields = mapTextractPages(PATIENT_INTAKE, [
      { pageNumber: 1, blocks: checkboxBlocks('Self', true) },
    ]);
    expect(fields.find((f) => f.path === 'insurance.subscriberIsPatient')).toMatchObject({
      value: true,
      confidence: 88,
      page: 1,
    });
  });
});

describe('TextractEngine', () => {
  const request = (form = INSURANCE_CARD, pages = 2): EngineRequest => ({
    tenantId: 't1',
    documentId: 'd1',
    form,
    schema: buildJsonSchema(form).schema,
    document: { bytes: Buffer.from('x'), mimeType: 'image/png', pageCount: pages },
    pages: Array.from({ length: pages }, (_, i) => ({
      pageNumber: i + 1,
      bytes: Buffer.from(`p${i}`),
    })),
  });

  it('one AnalyzeDocument call per page with QueriesConfig aliased by field path', async () => {
    const sdk = mockClient(TextractClient);
    sdk
      .on(AnalyzeDocumentCommand)
      .resolves({
        Blocks: queryBlocks('member.id', 'ZZX123', 99, 1),
        AnalyzeDocumentModelVersion: '1.0',
      });
    const result = await new TextractEngine(sdk as unknown as TextractClient).extract(request());

    const calls = sdk.commandCalls(AnalyzeDocumentCommand);
    expect(calls).toHaveLength(2);
    const input = calls[0]!.args[0].input;
    expect(input.FeatureTypes).toEqual(['QUERIES']);
    expect(input.QueriesConfig!.Queries).toHaveLength(INSURANCE_CARD.fields.length);
    expect(input.QueriesConfig!.Queries![0]).toEqual({
      Alias: 'payer.name',
      Text: 'What is the insurance company or health plan name?',
    });
    expect(result.estCostUsd).toBeCloseTo(0.03);
    expect(result.fields.find((f) => f.path === 'member.id')!.value).toBe('ZZX123');
  });

  it('adds FORMS when the form has checkboxes', async () => {
    const sdk = mockClient(TextractClient);
    sdk.on(AnalyzeDocumentCommand).resolves({ Blocks: [] });
    await new TextractEngine(sdk as unknown as TextractClient).extract(request(PATIENT_INTAKE, 1));
    expect(sdk.commandCalls(AnalyzeDocumentCommand)[0]!.args[0].input.FeatureTypes).toEqual([
      'QUERIES',
      'FORMS',
    ]);
  });

  it('classifies throttling as retryable and bad documents as not', async () => {
    const throttle = Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
    const bad = Object.assign(new Error('bad'), { name: 'UnsupportedDocumentException' });
    const sdk = mockClient(TextractClient);
    sdk.on(AnalyzeDocumentCommand).rejectsOnce(throttle).rejectsOnce(bad);
    const engine = new TextractEngine(sdk as unknown as TextractClient);
    await expect(engine.extract(request(INSURANCE_CARD, 1))).rejects.toMatchObject({
      code: 'ThrottlingException',
      retryable: true,
    });
    await expect(engine.extract(request(INSURANCE_CARD, 1))).rejects.toBeInstanceOf(EngineError);
  });
});
