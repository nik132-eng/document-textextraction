import { capturesOther, OTHER_FIELDS_PATH, type FormDefinition } from '../../forms/form-definition';
import type { EngineRequest, EngineResult, ExtractionEngine } from '../engine.port';
import { walkSchemaResult } from '../schema-result';

/**
 * No-network engine. Lets the whole pipeline (upload -> convert -> classify -> extract -> flags ->
 * compare) run without credentials, and backs the e2e tests. It fills the form's JSON shape with
 * obviously synthetic values (2 rows per group, 2 "other" values) and runs it through the same
 * walker the real schema engines use. Boot refuses it when PHI_MODE=true.
 */
export class FakeEngine implements ExtractionEngine {
  readonly name = 'fake' as const;

  extract(req: EngineRequest): Promise<EngineResult> {
    const data = syntheticResult(req.form);
    let i = 0;
    const fields = walkSchemaResult(req.form, data, () => {
      const n = i++;
      return {
        // Every 4th value is deliberately low-confidence so review flags are visible.
        confidence: n % 4 === 3 ? 55 : 92,
        confidenceSource: 'numeric',
        page: 1,
        bbox: { left: 0.1, top: Math.min(0.03 + (n % 30) * 0.03, 0.95), width: 0.4, height: 0.025 },
      };
    });
    return Promise.resolve({
      fields,
      raw: { engine: 'fake', data },
      estCostUsd: 0,
      modelVersion: 'fake-1',
    });
  }
}

function syntheticResult(form: FormDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const set = (obj: Record<string, unknown>, path: string, v: unknown) => {
    const segs = path.split('.');
    let cur = obj;
    for (const s of segs.slice(0, -1)) cur = (cur[s] ??= {}) as Record<string, unknown>;
    cur[segs.at(-1)!] = v;
  };
  for (const f of form.fields)
    set(out, f.path, f.type === 'checkbox' ? false : `SYNTHETIC ${f.label.toUpperCase()}`);
  for (const g of form.groups ?? []) {
    set(
      out,
      g.path,
      [1, 2].map((row) => {
        const r: Record<string, unknown> = {};
        for (const c of g.columns)
          set(r, c.path, c.type === 'checkbox' ? false : `SYNTH ${row} ${c.label.toUpperCase()}`);
        return r;
      }),
    );
  }
  if (capturesOther(form)) {
    out[OTHER_FIELDS_PATH] = [
      { label: 'SYNTHETIC EXTRA LABEL', value: 'SYNTHETIC EXTRA VALUE' },
      { label: 'SYNTHETIC REFERENCE', value: 'ZZ-0000' },
    ];
  }
  return out;
}
