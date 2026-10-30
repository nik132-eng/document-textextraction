import { describe, expect, it } from 'vitest';
import { FakeEngine } from '../engines/fake/fake.engine';
import { BOOKING_SHEET, CMS1500 } from '../forms/definitions';
import { buildJsonSchema } from '../forms/json-schema.builder';
import { toRows } from './extraction.runner';

describe('toRows', () => {
  const run = async (form = CMS1500) =>
    toRows(
      form,
      await new FakeEngine().extract({
        tenantId: 't',
        documentId: 'd',
        form,
        schema: buildJsonSchema(form).schema,
        document: { bytes: Buffer.alloc(0), mimeType: 'application/pdf', pageCount: 1 },
        pages: [],
      }),
      't',
      'e',
      80,
    );

  it('emits scalar, group and other rows with source, group path, row index and canonical keys', async () => {
    const rows = await run();
    const line = rows.find((r) => r.path === 'serviceLines[1].cptHcpcs')!;
    expect(line).toMatchObject({
      source: 'group',
      groupPath: 'serviceLines',
      rowIndex: 1,
      canonicalKey: 'line.cpt_hcpcs',
      valueType: 'code',
    });
    const other = rows.find((r) => r.path === 'otherFields[0]')!;
    expect(other).toMatchObject({
      source: 'other',
      rowIndex: 0,
      label: 'SYNTHETIC EXTRA LABEL',
      canonicalKey: null,
    });
    expect(other.flags).toContain('unmapped');
    expect(rows.filter((r) => r.source === 'field')).toHaveLength(CMS1500.fields.length);
  });

  it('drops paths the form does not define (an engine cannot inject fields)', async () => {
    const rows = toRows(
      BOOKING_SHEET,
      {
        fields: [
          {
            path: 'evil.injected',
            value: 'x',
            confidence: 99,
            confidenceSource: 'numeric',
            page: 1,
            bbox: null,
          },
        ],
        raw: {},
      },
      't',
      'e',
      80,
    );
    expect(rows).toEqual([]);
  });
});
