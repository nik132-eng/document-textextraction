import { describe, expect, it } from 'vitest';
import { buildEngines } from '../engines/engines.module';
import { loadAppConfig } from './app-config';

const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };

describe('env validation (fail fast at boot)', () => {
  it('defaults to the fake engine only', () => {
    const cfg = loadAppConfig(base);
    expect(cfg.engines).toMatchObject({ enabled: ['fake'], default: 'fake' });
    expect(buildEngines(cfg).map((e) => e.name)).toEqual(['fake']);
  });

  it('builds exactly the engines listed in ENGINES_ENABLED', () => {
    const cfg = loadAppConfig({
      ...base,
      ENGINES_ENABLED: 'textract,vlmrun,meibel',
      ENGINE_DEFAULT: 'textract',
      AWS_REGION: 'us-east-1',
      VLMRUN_API_KEY: 'vlm-key-12345',
      MEIBEL_API_KEY: 'meibel-key-12345',
    });
    expect(buildEngines(cfg).map((e) => e.name)).toEqual(['textract', 'vlmrun', 'meibel']);
  });

  it('an enabled vendor engine without its key refuses to boot', () => {
    expect(() =>
      loadAppConfig({ ...base, ENGINES_ENABLED: 'vlmrun', ENGINE_DEFAULT: 'vlmrun' }),
    ).toThrow(/VLMRUN_API_KEY/);
    expect(() =>
      loadAppConfig({ ...base, ENGINES_ENABLED: 'meibel', ENGINE_DEFAULT: 'meibel' }),
    ).toThrow(/MEIBEL_API_KEY/);
    expect(() =>
      loadAppConfig({ ...base, ENGINES_ENABLED: 'textract', ENGINE_DEFAULT: 'textract' }),
    ).toThrow(/AWS_REGION/);
  });

  it('ENGINE_DEFAULT must be enabled', () => {
    expect(() => loadAppConfig({ ...base, ENGINE_DEFAULT: 'textract' })).toThrow(/ENGINE_DEFAULT/);
  });

  it('PHI_MODE gates: no fake engine, vendor BAA confirmed, S3 storage', () => {
    expect(() => loadAppConfig({ ...base, PHI_MODE: 'true' })).toThrow(/fake/);
    const vendor = {
      ...base,
      PHI_MODE: 'true',
      ENGINES_ENABLED: 'vlmrun',
      ENGINE_DEFAULT: 'vlmrun',
      VLMRUN_API_KEY: 'vlm-key-12345',
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'b',
    };
    expect(() => loadAppConfig(vendor)).toThrow(/VLMRUN_BAA_CONFIRMED/);
    expect(() => loadAppConfig({ ...vendor, VLMRUN_BAA_CONFIRMED: 'true' })).not.toThrow();
    expect(() =>
      loadAppConfig({ ...vendor, VLMRUN_BAA_CONFIRMED: 'true', STORAGE_DRIVER: 'local' }),
    ).toThrow(/STORAGE_DRIVER/);
  });
});
