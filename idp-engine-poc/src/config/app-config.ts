import Joi from 'joi';
import { ENGINE_NAMES, type EngineName } from '../engines/engine.port';

export const APP_CONFIG = Symbol('APP_CONFIG');

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  appRole: 'api' | 'worker' | 'all';
  pipelineMode: 'sync' | 'queue';
  logLevel: string;
  databaseUrl: string;
  redisUrl: string;
  workerConcurrency: number;
  phiMode: boolean;
  storage: {
    driver: 'local' | 's3';
    dir: string;
    prefix: string;
    bucket?: string;
    kmsKeyId?: string;
  };
  upload: { maxBytes: number; rasterDpi: number };
  engines: { enabled: EngineName[]; default: EngineName; defaultMinConfidence: number };
  aws: { region: string; textractMaxAttempts: number };
  vlmrun: {
    apiKey?: string;
    baseUrl: string;
    model: string;
    detail: 'lo' | 'hi' | 'auto';
    pollMs: number;
    timeoutMs: number;
    confidenceMap: Record<string, number>;
    baaConfirmed: boolean;
  };
  meibel: {
    apiKey?: string;
    baseUrl: string;
    pollMs: number;
    timeoutMs: number;
    defaultFieldConfidence?: number;
    baaConfirmed: boolean;
  };
}

const engineList = new RegExp(`^(${ENGINE_NAMES.join('|')})(,(${ENGINE_NAMES.join('|')}))*$`);
const enabled = (name: EngineName) => Joi.string().pattern(new RegExp(`(^|,)${name}(,|$)`));
const optional = () => Joi.string().empty('');

export const envSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3000),
  APP_ROLE: Joi.string().valid('api', 'worker', 'all').default('all'),
  PIPELINE_MODE: Joi.string().valid('sync', 'queue').default('sync'),
  LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug', 'trace').default('info'),
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgresql', 'postgres'] })
    .required(),
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .when('PIPELINE_MODE', { is: 'queue', then: Joi.required(), otherwise: Joi.optional() })
    .default('redis://localhost:6379'),
  WORKER_CONCURRENCY: Joi.number().integer().min(1).max(32).default(2),
  PHI_MODE: Joi.boolean().default(false),

  STORAGE_DRIVER: Joi.string().valid('local', 's3').default('local'),
  STORAGE_DIR: Joi.string().default('./.data'),
  STORAGE_PREFIX: Joi.string().allow('').default('idp-poc/'),
  S3_BUCKET: optional().when('STORAGE_DRIVER', { is: 's3', then: Joi.required() }),
  S3_KMS_KEY_ID: optional(),

  MAX_UPLOAD_MB: Joi.number().min(1).max(100).default(25),
  RASTER_DPI: Joi.number().integer().min(100).max(300).default(200),

  ENGINES_ENABLED: Joi.string().pattern(engineList).default('fake'),
  ENGINE_DEFAULT: Joi.string()
    .valid(...ENGINE_NAMES)
    .default('fake'),
  DEFAULT_MIN_CONFIDENCE: Joi.number().min(0).max(100).default(80),

  AWS_REGION: Joi.string().when('ENGINES_ENABLED', {
    is: enabled('textract'),
    then: Joi.required(),
    otherwise: Joi.optional().default('us-east-1'),
  }),
  TEXTRACT_MAX_ATTEMPTS: Joi.number().integer().min(1).max(10).default(6),

  VLMRUN_API_KEY: optional().when('ENGINES_ENABLED', {
    is: enabled('vlmrun'),
    then: Joi.string().min(8).required(),
  }),
  VLMRUN_BASE_URL: Joi.string().uri().default('https://api.vlm.run'),
  VLMRUN_MODEL: Joi.string().default('vlm-1'),
  VLMRUN_DETAIL: Joi.string().valid('lo', 'hi', 'auto').default('hi'),
  VLMRUN_POLL_MS: Joi.number().integer().min(250).default(2000),
  VLMRUN_TIMEOUT_MS: Joi.number().integer().min(5000).default(120000),
  VLMRUN_CONFIDENCE_MAP: Joi.string().default('{"high":95,"medium":75,"low":40}'),
  VLMRUN_BAA_CONFIRMED: Joi.boolean().default(false),

  MEIBEL_API_KEY: optional().when('ENGINES_ENABLED', {
    is: enabled('meibel'),
    then: Joi.string().min(8).required(),
  }),
  MEIBEL_BASE_URL: Joi.string().uri().default('https://api.meibel.ai/v2'),
  MEIBEL_POLL_MS: Joi.number().integer().min(250).default(2000),
  MEIBEL_TIMEOUT_MS: Joi.number().integer().min(5000).default(300000),
  MEIBEL_DEFAULT_FIELD_CONFIDENCE: Joi.number().min(0).max(100).empty(''),
  MEIBEL_BAA_CONFIRMED: Joi.boolean().default(false),
})
  .custom((env: Record<string, unknown>) => {
    const list = String(env.ENGINES_ENABLED).split(',');
    if (!list.includes(String(env.ENGINE_DEFAULT))) {
      throw new Error('ENGINE_DEFAULT must be one of ENGINES_ENABLED');
    }
    try {
      const map = JSON.parse(String(env.VLMRUN_CONFIDENCE_MAP)) as unknown;
      if (typeof map !== 'object' || map === null) throw new Error();
    } catch {
      throw new Error('VLMRUN_CONFIDENCE_MAP must be a JSON object like {"high":95}');
    }
    // PHI gates (00 §9.1 invariant 8, shared-engine-adapter §1 / S8): refuse to boot rather than leak.
    if (env.PHI_MODE === true) {
      if (list.includes('fake')) throw new Error('PHI_MODE=true cannot enable the fake engine');
      if (list.includes('vlmrun') && env.VLMRUN_BAA_CONFIRMED !== true) {
        throw new Error('PHI_MODE=true with vlmrun requires VLMRUN_BAA_CONFIRMED=true');
      }
      if (list.includes('meibel') && env.MEIBEL_BAA_CONFIRMED !== true) {
        throw new Error('PHI_MODE=true with meibel requires MEIBEL_BAA_CONFIRMED=true');
      }
      if (env.STORAGE_DRIVER !== 's3') throw new Error('PHI_MODE=true requires STORAGE_DRIVER=s3');
    }
    return env;
  })
  .unknown(true);

/** Used by ConfigModule.forRoot({ validate }) so a bad env fails at boot. */
export function validateEnv(raw: Record<string, unknown>): Record<string, unknown> {
  const { value, error } = envSchema.validate(raw, { abortEarly: false, convert: true });
  if (error) throw new Error(`Invalid environment: ${error.message}`);
  return value as Record<string, unknown>;
}

export function loadAppConfig(raw: Record<string, unknown>): AppConfig {
  const e = validateEnv(raw);
  const s = (k: string) => e[k] as string;
  const n = (k: string) => e[k] as number;
  const b = (k: string) => e[k] as boolean;
  const opt = <T>(k: string) => (e[k] === undefined ? undefined : (e[k] as T));
  return {
    nodeEnv: s('NODE_ENV') as AppConfig['nodeEnv'],
    port: n('PORT'),
    appRole: s('APP_ROLE') as AppConfig['appRole'],
    pipelineMode: s('PIPELINE_MODE') as AppConfig['pipelineMode'],
    logLevel: s('LOG_LEVEL'),
    databaseUrl: s('DATABASE_URL'),
    redisUrl: s('REDIS_URL'),
    workerConcurrency: n('WORKER_CONCURRENCY'),
    phiMode: b('PHI_MODE'),
    storage: {
      driver: s('STORAGE_DRIVER') as AppConfig['storage']['driver'],
      dir: s('STORAGE_DIR'),
      prefix: s('STORAGE_PREFIX'),
      bucket: opt('S3_BUCKET'),
      kmsKeyId: opt('S3_KMS_KEY_ID'),
    },
    upload: { maxBytes: n('MAX_UPLOAD_MB') * 1024 * 1024, rasterDpi: n('RASTER_DPI') },
    engines: {
      enabled: s('ENGINES_ENABLED').split(',') as EngineName[],
      default: s('ENGINE_DEFAULT') as EngineName,
      defaultMinConfidence: n('DEFAULT_MIN_CONFIDENCE'),
    },
    aws: { region: s('AWS_REGION'), textractMaxAttempts: n('TEXTRACT_MAX_ATTEMPTS') },
    vlmrun: {
      apiKey: opt('VLMRUN_API_KEY'),
      baseUrl: s('VLMRUN_BASE_URL').replace(/\/+$/, ''),
      model: s('VLMRUN_MODEL'),
      detail: s('VLMRUN_DETAIL') as AppConfig['vlmrun']['detail'],
      pollMs: n('VLMRUN_POLL_MS'),
      timeoutMs: n('VLMRUN_TIMEOUT_MS'),
      confidenceMap: JSON.parse(s('VLMRUN_CONFIDENCE_MAP')) as Record<string, number>,
      baaConfirmed: b('VLMRUN_BAA_CONFIRMED'),
    },
    meibel: {
      apiKey: opt('MEIBEL_API_KEY'),
      baseUrl: s('MEIBEL_BASE_URL').replace(/\/+$/, ''),
      pollMs: n('MEIBEL_POLL_MS'),
      timeoutMs: n('MEIBEL_TIMEOUT_MS'),
      defaultFieldConfidence: opt('MEIBEL_DEFAULT_FIELD_CONFIDENCE'),
      baaConfirmed: b('MEIBEL_BAA_CONFIRMED'),
    },
  };
}
