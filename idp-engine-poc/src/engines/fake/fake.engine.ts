import type { EngineRequest, EngineResult, ExtractionEngine } from '../engine.port';

/**
 * No-network engine. Lets the whole pipeline (upload -> raster -> extract -> flags -> compare)
 * run without any credentials, and backs the e2e test. Values are obviously synthetic.
 * Boot refuses it when PHI_MODE=true.
 */
export class FakeEngine implements ExtractionEngine {
  readonly name = 'fake' as const;

  extract(req: EngineRequest): Promise<EngineResult> {
    const fields = req.form.fields.map((f, i) => ({
      path: f.path,
      value: f.type === 'checkbox' ? false : `SYNTHETIC ${f.label.toUpperCase()}`,
      // Every 4th field is deliberately low-confidence so the review flags are visible.
      confidence: i % 4 === 3 ? 55 : 92,
      confidenceSource: 'numeric' as const,
      page: 1,
      bbox: { left: 0.1, top: Math.min(0.05 + i * 0.06, 0.95), width: 0.4, height: 0.03 },
    }));
    return Promise.resolve({
      fields,
      raw: { engine: 'fake', fieldCount: fields.length },
      estCostUsd: 0,
      modelVersion: 'fake-1',
    });
  }
}
