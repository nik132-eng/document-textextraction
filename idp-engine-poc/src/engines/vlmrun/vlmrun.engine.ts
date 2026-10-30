import { extensionFor, type SupportedMime } from '../../common/util';
import { pollUntil } from '../http';
import {
  EngineError,
  type EngineRequest,
  type EngineResult,
  type ExtractionEngine,
} from '../engine.port';
import type { VlmPrediction, VlmRunClient } from './vlmrun.client';
import { mapVlmRunResponse } from './vlmrun.mapper';

export interface VlmRunEngineOptions {
  model: string;
  pollMs: number;
  timeoutMs: number;
  confidenceMap: Record<string, number>;
  sleep?: (ms: number) => Promise<void>;
}

const TERMINAL = new Set(['completed', 'failed']);

/**
 * VLM Run adapter (schema-first). Upload original -> generate(json_schema) -> poll -> map -> delete file.
 * One call per document in the POC (no segmentation yet). Polling is the source of truth;
 * webhooks (V8) are an optional later speed-up.
 */
export class VlmRunEngine implements ExtractionEngine {
  readonly name = 'vlmrun' as const;

  constructor(
    private readonly client: VlmRunClient,
    private readonly opts: VlmRunEngineOptions,
  ) {}

  async extract(req: EngineRequest): Promise<EngineResult> {
    const ext = extensionFor(req.document.mimeType as SupportedMime);
    // Neutral file name: original names can contain patient names.
    const { fileId } = await this.client.uploadFile(
      req.document.bytes,
      `document.${ext}`,
      req.document.mimeType,
    );
    try {
      let prediction: VlmPrediction = await this.client.generate({
        fileId,
        jsonSchema: req.schema,
      });
      if (!TERMINAL.has(prediction.status)) {
        const id = prediction.id;
        prediction = await pollUntil(
          'vlmrun',
          () => this.client.getPrediction(id),
          (p) => TERMINAL.has(p.status),
          { intervalMs: this.opts.pollMs, timeoutMs: this.opts.timeoutMs, sleep: this.opts.sleep },
        );
      }
      if (prediction.status !== 'completed') {
        throw new EngineError('vlmrun', 'PREDICTION_FAILED', false);
      }
      return {
        fields: mapVlmRunResponse(req.form, prediction.response, this.opts.confidenceMap),
        raw: prediction,
        externalId: prediction.id,
        costUsd: prediction.usage?.cost_dollars,
        modelVersion: `${this.opts.model}${prediction.fallback ? ':fallback' : ''}`,
        warnings: prediction.fallback ? ['engine_fallback'] : [],
      };
    } finally {
      // Remove the vendor-side copy even on failure. A failed delete must not fail the extraction.
      await this.client.deleteFile(fileId).catch(() => undefined);
    }
  }
}
