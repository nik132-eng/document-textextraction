import { Global, Module } from '@nestjs/common';
import { TextractClient } from '@aws-sdk/client-textract';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { EXTRACTION_ENGINES, type ExtractionEngine } from './engine.port';
import { EngineRegistry } from './engine-registry';
import { FakeEngine } from './fake/fake.engine';
import { MeibelClient } from './meibel/meibel.client';
import { MeibelEngine } from './meibel/meibel.engine';
import { TextractEngine } from './textract/textract.engine';
import { VlmRunClient } from './vlmrun/vlmrun.client';
import { VlmRunEngine } from './vlmrun/vlmrun.engine';

/**
 * The only place that knows which adapters exist. ENGINES_ENABLED decides which are built;
 * boot validation (app-config.ts) already guaranteed their credentials are present.
 */
export function buildEngines(cfg: AppConfig, fetchFn: typeof fetch = fetch): ExtractionEngine[] {
  const environment = cfg.nodeEnv === 'production' ? 'prod' : 'dev';
  const engines: ExtractionEngine[] = [];
  for (const name of cfg.engines.enabled) {
    switch (name) {
      case 'fake':
        engines.push(new FakeEngine());
        break;
      case 'textract':
        engines.push(
          new TextractEngine(
            new TextractClient({
              region: cfg.aws.region,
              maxAttempts: cfg.aws.textractMaxAttempts,
              retryMode: 'adaptive',
            }),
          ),
        );
        break;
      case 'vlmrun': {
        const v = cfg.vlmrun;
        const client = new VlmRunClient(
          { apiKey: v.apiKey!, baseUrl: v.baseUrl, model: v.model, detail: v.detail, environment },
          { engine: 'vlmrun', fetchFn, timeoutMs: 60_000, maxAttempts: 4 },
        );
        engines.push(
          new VlmRunEngine(client, {
            model: v.model,
            pollMs: v.pollMs,
            timeoutMs: v.timeoutMs,
            confidenceMap: v.confidenceMap,
          }),
        );
        break;
      }
      case 'meibel': {
        const m = cfg.meibel;
        const client = new MeibelClient(
          { apiKey: m.apiKey!, baseUrl: m.baseUrl },
          { engine: 'meibel', fetchFn, timeoutMs: 60_000, maxAttempts: 4 },
        );
        engines.push(
          new MeibelEngine(client, {
            pollMs: m.pollMs,
            timeoutMs: m.timeoutMs,
            defaultFieldConfidence: m.defaultFieldConfidence,
          }),
        );
        break;
      }
    }
  }
  return engines;
}

@Global()
@Module({
  providers: [
    {
      provide: EXTRACTION_ENGINES,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => buildEngines(cfg),
    },
    EngineRegistry,
  ],
  exports: [EngineRegistry],
})
export class EnginesModule {}
