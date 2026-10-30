import { describe, expect, it, vi } from 'vitest';
import { INSURANCE_CARD, PATIENT_INTAKE } from '../../forms/definitions';
import { buildJsonSchema } from '../../forms/json-schema.builder';
import type { EngineRequest } from '../engine.port';
import type { FetchFn } from '../http';
import { VlmRunClient } from './vlmrun.client';
import { VlmRunEngine } from './vlmrun.engine';
import { mapVlmRunResponse } from './vlmrun.mapper';

const MAP = { high: 95, medium: 75, low: 40 };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function client(fetchFn: FetchFn) {
  return new VlmRunClient(
    {
      apiKey: 'test-key-123',
      baseUrl: 'https://api.vlm.run',
      model: 'vlm-1',
      detail: 'hi',
      environment: 'dev',
    },
    { engine: 'vlmrun', fetchFn, timeoutMs: 1000, maxAttempts: 3, sleep: async () => undefined },
  );
}

describe('VlmRunClient', () => {
  it('always sends allow_logging/training/retention=false, grounding, confidence, temperature 0, pinned model', () => {
    const body = client(vi.fn()).generateBody({ fileId: 'f1', jsonSchema: {} });
    expect(body.metadata).toMatchObject({
      allow_logging: false,
      allow_training: false,
      allow_retention: false,
    });
    expect(body.config).toMatchObject({
      grounding: true,
      confidence: true,
      temperature: 0,
      detail: 'hi',
    });
    expect(body).toMatchObject({ model: 'vlm-1', batch: true, file_id: 'f1' });
  });

  it('sends the bearer key and retries 429 honouring Retry-After', async () => {
    const fetchFn = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(json({}, 429, { 'retry-after': '1' }))
      .mockResolvedValueOnce(json({ id: 'p1', status: 'pending' }));
    const res = await client(fetchFn).generate({ fileId: 'f1', jsonSchema: {} });
    expect(res.id).toBe('p1');
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const init = fetchFn.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key-123');
  });

  it('401 is a non-retryable config error and never includes the body', async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(json({ detail: 'patient JANE' }, 401));
    const err = await client(fetchFn)
      .getPrediction('p1')
      .catch((e: Error) => e);
    expect(err).toMatchObject({ code: 'AUTH_CONFIG', retryable: false });
    expect(String(err)).not.toContain('JANE');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('mapVlmRunResponse (assumed shape, see mapper header)', () => {
  it('maps sibling *_metadata: band confidence, 0-based page -> 1-based, xywh -> bbox', () => {
    const response = {
      member: {
        id: 'ZZX123',
        id_metadata: {
          confidence: 'hi',
          bboxes: [{ content: 'ZZX123', xywh: [0.1, 0.2, 0.3, 0.05], page: 0 }],
        },
      },
      payer: { name: null, id: '00000' },
    };
    const fields = mapVlmRunResponse(INSURANCE_CARD, response, MAP);
    const id = fields.find((f) => f.path === 'member.id')!;
    expect(id).toMatchObject({
      value: 'ZZX123',
      confidence: 95,
      confidenceSource: 'band',
      page: 1,
      groundingText: 'ZZX123',
    });
    expect(id.bbox!.left).toBeCloseTo(0.1);
    expect(id.bbox!.width).toBeCloseTo(0.3);
    expect(fields.find((f) => f.path === 'payer.name')).toMatchObject({
      value: null,
      confidence: null,
    });
    // Value without metadata -> no bbox, no confidence (the guard flags it ungrounded + low_confidence).
    expect(fields.find((f) => f.path === 'payer.id')).toMatchObject({
      value: '00000',
      bbox: null,
      confidence: null,
    });
    expect(fields).toHaveLength(INSURANCE_CARD.fields.length);
  });

  it('accepts root _metadata keyed by path, unions multiple boxes and clamps to 0..1', () => {
    const response = {
      member: { name: 'JANE SAMPLE' },
      _metadata: {
        'member.name': {
          confidence: 'medium',
          bboxes: [
            { xywh: [0.1, 0.1, 0.2, 0.05], page: 1 },
            { xywh: [0.1, 0.16, 1.2, 0.05], page: 1 },
          ],
        },
      },
    };
    const f = mapVlmRunResponse(INSURANCE_CARD, response, MAP).find(
      (x) => x.path === 'member.name',
    )!;
    expect(f).toMatchObject({ confidence: 75, page: 2 });
    expect(f.bbox!.left + f.bbox!.width).toBeLessThanOrEqual(1);
    expect(f.bbox!.top).toBeCloseTo(0.1);
  });

  it('keeps booleans for checkboxes', () => {
    const fields = mapVlmRunResponse(
      PATIENT_INTAKE,
      { insurance: { subscriberIsPatient: true } },
      MAP,
    );
    expect(fields.find((f) => f.path === 'insurance.subscriberIsPatient')!.value).toBe(true);
  });
});

describe('VlmRunEngine', () => {
  const req: EngineRequest = {
    tenantId: 't1',
    documentId: 'd1',
    form: INSURANCE_CARD,
    schema: buildJsonSchema(INSURANCE_CARD).schema,
    document: { bytes: Buffer.from('%PDF-1.4'), mimeType: 'application/pdf', pageCount: 1 },
    pages: [],
  };

  it('upload -> generate -> poll -> map -> delete file, with actual cost and fallback warning', async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn<FetchFn>(async (url, init) => {
      const u = String(url);
      calls.push(`${init?.method} ${u.replace('https://api.vlm.run', '')}`);
      if (u.endsWith('/v1/files')) return json({ id: 'file-1' });
      if (u.endsWith('/v1/document/generate')) return json({ id: 'pred-1', status: 'enqueued' });
      if (u.endsWith('/v1/predictions/pred-1')) {
        return json({
          id: 'pred-1',
          status: 'completed',
          fallback: true,
          response: { member: { id: 'ZZX1' } },
          usage: { cost_dollars: 0.012 },
        });
      }
      return new Response(null, { status: 204 });
    });
    const engine = new VlmRunEngine(client(fetchFn), {
      model: 'vlm-1',
      pollMs: 1,
      timeoutMs: 1000,
      confidenceMap: MAP,
      sleep: async () => undefined,
    });
    const result = await engine.extract(req);
    expect(calls).toEqual([
      'POST /v1/files',
      'POST /v1/document/generate',
      'GET /v1/predictions/pred-1',
      'DELETE /v1/files/file-1',
    ]);
    expect(result).toMatchObject({
      costUsd: 0.012,
      externalId: 'pred-1',
      modelVersion: 'vlm-1:fallback',
      warnings: ['engine_fallback'],
    });
  });

  it('deletes the remote file even when the prediction fails', async () => {
    const fetchFn = vi.fn<FetchFn>(async (url) => {
      const u = String(url);
      if (u.endsWith('/v1/files')) return json({ id: 'file-1' });
      if (u.endsWith('/v1/document/generate')) return json({ id: 'pred-1', status: 'failed' });
      return new Response(null, { status: 204 });
    });
    const engine = new VlmRunEngine(client(fetchFn), {
      model: 'vlm-1',
      pollMs: 1,
      timeoutMs: 1000,
      confidenceMap: MAP,
    });
    await expect(engine.extract(req)).rejects.toMatchObject({ code: 'PREDICTION_FAILED' });
    expect(
      fetchFn.mock.calls.some(
        ([u, i]) => String(u).endsWith('/v1/files/file-1') && i?.method === 'DELETE',
      ),
    ).toBe(true);
  });
});
