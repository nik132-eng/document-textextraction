import { sleep as realSleep } from '../common/util';
import { EngineError, type EngineName } from './engine.port';

export type FetchFn = typeof fetch;

export interface HttpDeps {
  engine: EngineName;
  fetchFn: FetchFn;
  /** Per-request timeout. */
  timeoutMs: number;
  maxAttempts: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * fetch + timeout + retry on 429/5xx/network, honouring Retry-After.
 * Never reads the error body into the error: vendor error bodies can echo document content.
 */
export async function requestJson<T>(deps: HttpDeps, url: string, init: RequestInit): Promise<T> {
  const sleep = deps.sleep ?? realSleep;
  let last: EngineError | undefined;
  for (let attempt = 1; attempt <= deps.maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await deps.fetchFn(url, { ...init, signal: AbortSignal.timeout(deps.timeoutMs) });
    } catch (e) {
      const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      last = new EngineError(deps.engine, timeout ? 'HTTP_TIMEOUT' : 'NETWORK', true);
      if (attempt < deps.maxAttempts) await sleep(backoff(attempt));
      continue;
    }
    if (res.ok) {
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new EngineError(deps.engine, 'BAD_JSON', false, res.status);
      }
    }
    await res.body?.cancel().catch(() => undefined);
    last = classify(deps.engine, res);
    if (!last.retryable || attempt === deps.maxAttempts) throw last;
    await sleep(last.retryAfterMs ?? backoff(attempt));
  }
  throw last ?? new EngineError(deps.engine, 'NETWORK', true);
}

export function classify(engine: EngineName, res: Response): EngineError {
  const s = res.status;
  if (s === 429) return new EngineError(engine, 'RATE_LIMITED', true, s, retryAfter(res));
  if (s >= 500) return new EngineError(engine, 'VENDOR_UNAVAILABLE', true, s, retryAfter(res));
  if (s === 401 || s === 403) return new EngineError(engine, 'AUTH_CONFIG', false, s);
  if (s === 404) return new EngineError(engine, 'NOT_FOUND', false, s);
  if (s === 413) return new EngineError(engine, 'PAYLOAD_TOO_LARGE', false, s);
  return new EngineError(engine, 'BAD_REQUEST', false, s);
}

function retryAfter(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.min(secs * 1000, 60_000);
  const at = Date.parse(h);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.min(at - Date.now(), 60_000));
}

const backoff = (attempt: number) => Math.min(500 * 2 ** (attempt - 1), 8000);

/** Polls until `done` or timeout. Timeout is retryable: the vendor job may still finish. */
export async function pollUntil<T>(
  engine: EngineName,
  fn: () => Promise<T>,
  done: (t: T) => boolean,
  opts: { intervalMs: number; timeoutMs: number; sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  const sleep = opts.sleep ?? realSleep;
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const value = await fn();
    if (done(value)) return value;
    if (Date.now() + opts.intervalMs > deadline)
      throw new EngineError(engine, 'ENGINE_TIMEOUT', true);
    await sleep(opts.intervalMs);
  }
}

/** Node 22 Blob wants an ArrayBuffer-backed view; Buffer may be pooled, so copy. */
export const blobOf = (bytes: Buffer, type: string): Blob =>
  new Blob([new Uint8Array(bytes)], { type });

export const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
