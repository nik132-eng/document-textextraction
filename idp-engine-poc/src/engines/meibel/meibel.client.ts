import { EngineError } from '../engine.port';
import { blobOf, requestJson, type HttpDeps } from '../http';

export interface MeibelClientConfig {
  apiKey: string;
  /** Includes the version, e.g. https://api.meibel.ai/v2 (or the BYOC data-plane URL). */
  baseUrl: string;
}

export type MeibelStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface MeibelTransformStatus {
  status: MeibelStatus;
  aeq?: number;
  metrics?: Record<string, unknown>;
  artifacts?: string[];
}

/**
 * Only document parse/transform endpoints. Datasources, Recall, ingest and agents would create
 * extra PHI copies, so the client refuses any other path (meibel/implementation-plan MB1).
 */
export const MEIBEL_ALLOWED_PATHS = [
  /^\/documents\/deep-transform(\/|$)/,
  /^\/documents\/parse(\/|$)/,
];

/**
 * Transport only. Endpoints per meibel/research.md §2:
 *   POST /documents/deep-transform (multipart: file, schema, root_name, guidance, max_pages)
 *   GET  /documents/deep-transform/{job_id}
 *   GET  /documents/deep-transform/{job_id}/artifact/{output.json|provenance.json}
 */
export class MeibelClient {
  constructor(
    private readonly cfg: MeibelClientConfig,
    private readonly http: HttpDeps,
  ) {}

  async submitTransform(i: {
    file: Buffer;
    filename: string;
    mimeType: string;
    schema: object;
    rootName: string;
    guidance?: string;
    maxPages?: number;
  }): Promise<{ jobId: string }> {
    const form = new FormData();
    form.append('file', blobOf(i.file, i.mimeType), i.filename);
    form.append('schema', JSON.stringify(i.schema));
    form.append('root_name', i.rootName);
    if (i.guidance) form.append('guidance', i.guidance);
    if (i.maxPages) form.append('max_pages', String(i.maxPages));
    // Field name of the job id is UNVERIFIED; accept the likely spellings.
    const res = await this.call<{ job_id?: string; jobId?: string; id?: string }>(
      '/documents/deep-transform',
      { method: 'POST', body: form },
    );
    const jobId = res.job_id ?? res.jobId ?? res.id;
    if (!jobId) throw new EngineError('meibel', 'NO_JOB_ID', false);
    return { jobId };
  }

  getTransform(jobId: string): Promise<MeibelTransformStatus> {
    return this.call(`/documents/deep-transform/${encodeURIComponent(jobId)}`, { method: 'GET' });
  }

  downloadArtifact(jobId: string, name: 'output.json' | 'provenance.json'): Promise<unknown> {
    return this.call(`/documents/deep-transform/${encodeURIComponent(jobId)}/artifact/${name}`, {
      method: 'GET',
    });
  }

  private call<T>(path: string, init: RequestInit): Promise<T> {
    if (!MEIBEL_ALLOWED_PATHS.some((re) => re.test(path))) {
      throw new EngineError('meibel', 'PATH_NOT_ALLOWED', false);
    }
    return requestJson<T>(this.http, `${this.cfg.baseUrl}${path}`, {
      ...init,
      headers: { 'Meibel-API-Key': this.cfg.apiKey, accept: 'application/json' },
    });
  }
}
