import { extensionFor, type SupportedMime } from '../../common/util';
import type { FormDefinition } from '../../forms/form-definition';
import { pollUntil } from '../http';
import {
  EngineError,
  type EngineRequest,
  type EngineResult,
  type ExtractionEngine,
} from '../engine.port';
import type { MeibelClient, MeibelTransformStatus } from './meibel.client';
import { mapMeibelArtifacts } from './meibel.mapper';

export interface MeibelEngineOptions {
  pollMs: number;
  timeoutMs: number;
  defaultFieldConfidence?: number;
  sleep?: (ms: number) => Promise<void>;
}

// Meibel pricing page (research §4): advanced layout/OCR page + per extracted field. No actual cost in the API.
const PRICE_PER_PAGE = 0.04;
const PRICE_PER_FIELD = 0.0015;

/**
 * Meibel adapter (schema-first, deep transform, preview API).
 * Submit original + JSON Schema -> poll -> download output.json + provenance.json -> map.
 * No remote-delete endpoint is documented (research §6.5): retention relies on the contract / BYOC.
 */
export class MeibelEngine implements ExtractionEngine {
  readonly name = 'meibel' as const;

  constructor(
    private readonly client: MeibelClient,
    private readonly opts: MeibelEngineOptions,
  ) {}

  async extract(req: EngineRequest): Promise<EngineResult> {
    const rootName = req.form.id.toLowerCase();
    const ext = extensionFor(req.document.mimeType as SupportedMime);
    const { jobId } = await this.client.submitTransform({
      file: req.document.bytes,
      filename: `document.${ext}`,
      mimeType: req.document.mimeType,
      schema: req.schema,
      rootName,
      guidance: buildGuidance(req.form),
    });
    const status = await pollUntil<MeibelTransformStatus>(
      'meibel',
      () => this.client.getTransform(jobId),
      (s) => s.status === 'succeeded' || s.status === 'failed',
      { intervalMs: this.opts.pollMs, timeoutMs: this.opts.timeoutMs, sleep: this.opts.sleep },
    );
    if (status.status !== 'succeeded') throw new EngineError('meibel', 'TRANSFORM_FAILED', false);

    const [output, provenance] = await Promise.all([
      this.client.downloadArtifact(jobId, 'output.json'),
      this.client.downloadArtifact(jobId, 'provenance.json'),
    ]);
    const fields = mapMeibelArtifacts(req.form, output, provenance, {
      rootName,
      defaultFieldConfidence: this.opts.defaultFieldConfidence,
    });
    const est = req.document.pageCount * PRICE_PER_PAGE + req.form.fields.length * PRICE_PER_FIELD;
    return {
      fields,
      raw: { status, output, provenance },
      externalId: jobId,
      estCostUsd: Math.round(est * 100_000) / 100_000,
      modelVersion:
        status.aeq !== undefined ? `deep-transform:aeq=${status.aeq}` : 'deep-transform',
    };
  }
}

/** Instructions + labels only. Never example values (PHI-safety test covers this). */
export function buildGuidance(form: FormDefinition): string {
  return [
    `Extract the fields of a "${form.title}".`,
    'Return text exactly as printed. Use null when a field is blank.',
    'Do not infer or calculate values that are not printed on the page.',
    '',
    'Fields:',
    ...form.fields.map((f) => `- ${f.path}: ${f.label}`),
  ].join('\n');
}
