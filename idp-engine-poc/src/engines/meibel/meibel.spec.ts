import { describe, expect, it, vi } from 'vitest';
import { INSURANCE_CARD } from '../../forms/definitions';
import { buildJsonSchema } from '../../forms/json-schema.builder';
import type { FetchFn } from '../http';
import { MEIBEL_ALLOWED_PATHS, MeibelClient } from './meibel.client';
import { buildGuidance, MeibelEngine } from './meibel.engine';
import { mapMeibelArtifacts, toBBox } from './meibel.mapper';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const client = (fetchFn: FetchFn) =>
  new MeibelClient(
    { apiKey: 'meibel-key-123', baseUrl: 'https://api.meibel.ai/v2' },
    { engine: 'meibel', fetchFn, timeoutMs: 1000, maxAttempts: 2, sleep: async () => undefined },
  );

describe('MeibelClient', () => {
  it('uses the Meibel-API-Key header (never Authorization) and multipart fields', async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(json({ job_id: 'job-1' }));
    const res = await client(fetchFn).submitTransform({
      file: Buffer.from('%PDF'),
      filename: 'document.pdf',
      mimeType: 'application/pdf',
      schema: { type: 'object' },
      rootName: 'insurance_card',
      guidance: 'g',
    });
    expect(res.jobId).toBe('job-1');
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe('https://api.meibel.ai/v2/documents/deep-transform');
    const headers = init!.headers as Record<string, string>;
    expect(headers['Meibel-API-Key']).toBe('meibel-key-123');
    expect(headers.authorization).toBeUndefined();
    const form = init!.body as FormData;
    expect(form.get('schema')).toBe('{"type":"object"}');
    expect(form.get('root_name')).toBe('insurance_card');
    expect(form.get('file')).toBeInstanceOf(Blob);
  });

  it('URL allowlist: only document parse/transform endpoints, never datasources/ingest/agents', () => {
    const allowed = (p: string) => MEIBEL_ALLOWED_PATHS.some((re) => re.test(p));
    expect(allowed('/documents/deep-transform/abc/artifact/output.json')).toBe(true);
    expect(allowed('/documents/parse')).toBe(true);
    for (const p of [
      '/datasources',
      '/ingest',
      '/agents/run',
      '/sessions',
      '/documents/deep-transformX',
    ]) {
      expect(allowed(p)).toBe(false);
    }
  });
});

describe('mapMeibelArtifacts (assumed shape, see mapper header)', () => {
  it('unwraps root_name, reads provenance by path, converts pixel boxes, 0-based page', () => {
    const output = {
      insurance_card: { member: { id: 'ZZX123', name: null }, payer: { name: 'SYNTH PLAN' } },
    };
    const provenance = {
      'insurance_card.member.id': {
        page_number: 0,
        bbox: [100, 200, 400, 250],
        image_size: { width: 1000, height: 1000 },
        aeq: 0.93,
      },
    };
    const fields = mapMeibelArtifacts(INSURANCE_CARD, output, provenance, {
      rootName: 'insurance_card',
    });
    const id = fields.find((f) => f.path === 'member.id')!;
    expect(id).toMatchObject({ value: 'ZZX123', page: 1, confidenceSource: 'numeric' });
    expect(id.confidence).toBeCloseTo(93);
    expect(id.bbox).toEqual({
      left: 0.1,
      top: 0.2,
      width: 0.30000000000000004,
      height: 0.04999999999999999,
    });
    expect(fields.find((f) => f.path === 'member.name')!.value).toBeNull();
    // Present value without provenance -> ungrounded (bbox null) and no confidence.
    expect(fields.find((f) => f.path === 'payer.name')).toMatchObject({
      value: 'SYNTH PLAN',
      bbox: null,
      confidence: null,
      confidenceSource: 'none',
    });
  });

  it('PDF points with bottom-left origin are flipped to top-left', () => {
    const b = toBBox({
      bbox: [61.2, 712.8, 306, 752.4],
      origin: 'bottom-left',
      page_size: { width: 612, height: 792 },
    })!;
    expect(b.left).toBeCloseTo(0.1);
    expect(b.top).toBeCloseTo(0.05);
    expect(b.width).toBeCloseTo(0.4);
    expect(b.height).toBeCloseTo(0.05);
  });

  it('uses MEIBEL_DEFAULT_FIELD_CONFIDENCE as judged when no per-field score exists', () => {
    const fields = mapMeibelArtifacts(
      INSURANCE_CARD,
      { member: { id: 'X1' } },
      {},
      { rootName: 'insurance_card', defaultFieldConfidence: 70 },
    );
    expect(fields.find((f) => f.path === 'member.id')).toMatchObject({
      confidence: 70,
      confidenceSource: 'judged',
    });
  });
});

describe('MeibelEngine', () => {
  it('submit -> poll -> download both artifacts -> map, with estimated cost', async () => {
    let polls = 0;
    const fetchFn = vi.fn<FetchFn>(async (url) => {
      const u = String(url);
      if (u.endsWith('/documents/deep-transform')) return json({ job_id: 'job-1' });
      if (u.endsWith('/deep-transform/job-1'))
        return json({ status: polls++ === 0 ? 'running' : 'succeeded', aeq: 0.9 });
      if (u.endsWith('/artifact/output.json'))
        return json({ insurance_card: { member: { id: 'ZZX1' } } });
      if (u.endsWith('/artifact/provenance.json'))
        return json({
          fields: [
            { path: 'member.id', page: 0, bbox: { left: 0.1, top: 0.1, width: 0.2, height: 0.05 } },
          ],
        });
      return json({}, 404);
    });
    const engine = new MeibelEngine(client(fetchFn), {
      pollMs: 1,
      timeoutMs: 1000,
      sleep: async () => undefined,
    });
    const result = await engine.extract({
      tenantId: 't1',
      documentId: 'd1',
      form: INSURANCE_CARD,
      schema: buildJsonSchema(INSURANCE_CARD).schema,
      document: { bytes: Buffer.from('%PDF'), mimeType: 'application/pdf', pageCount: 1 },
      pages: [],
    });
    expect(result.externalId).toBe('job-1');
    expect(result.estCostUsd).toBeCloseTo(0.04 + 10 * 0.0015);
    expect(result.fields.find((f) => f.path === 'member.id')).toMatchObject({
      value: 'ZZX1',
      page: 1,
    });
  });

  it('guidance has labels and rules but no digits (no example values -> no PHI)', () => {
    const g = buildGuidance(INSURANCE_CARD);
    expect(g).toContain('Member ID');
    expect(g).toContain('null when a field is blank');
    expect(g).not.toMatch(/\d/);
  });
});
