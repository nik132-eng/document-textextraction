import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { Queue, UnrecoverableError, Worker, type ConnectionOptions } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { EngineError } from '../engines/engine.port';
import { ExtractionRunner } from './extraction.runner';

export const EXTRACTION_QUEUE = 'idp-extraction';

/**
 * PIPELINE_MODE=sync  -> run inline in the request (dev, tests, demos).
 * PIPELINE_MODE=queue -> BullMQ on Redis. APP_ROLE=api only enqueues; worker/all also consume.
 * The job id is the extraction id, so a double dispatch is a no-op.
 */
@Injectable()
export class ExtractionDispatcher implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ExtractionDispatcher.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly runner: ExtractionRunner,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  onModuleInit(): void {
    if (this.cfg.pipelineMode !== 'queue') return;
    const connection = redisConnection(this.cfg.redisUrl);
    this.queue = new Queue(EXTRACTION_QUEUE, { connection });
    if (this.cfg.appRole === 'api') return;
    this.worker = new Worker(
      EXTRACTION_QUEUE,
      async (job) => {
        try {
          await this.runner.run((job.data as { extractionId: string }).extractionId);
        } catch (e) {
          // Config/validation errors will not fix themselves: don't burn retries (or vendor money).
          if (e instanceof EngineError && !e.retryable) throw new UnrecoverableError(e.code);
          throw e;
        }
      },
      { connection, concurrency: this.cfg.workerConcurrency },
    );
    this.worker.on('failed', (job, err) =>
      this.logger.warn({
        msg: 'queue.job_failed',
        jobId: job?.id,
        attempts: job?.attemptsMade,
        code: err.message,
      }),
    );
    this.logger.log({
      msg: 'queue.worker_started',
      queue: EXTRACTION_QUEUE,
      concurrency: this.cfg.workerConcurrency,
    });
  }

  /** Sync mode: resolves after the run (failure is recorded on the row, not thrown). */
  async dispatch(extractionId: string): Promise<void> {
    if (this.queue) {
      await this.queue.add(
        'extract',
        { extractionId },
        {
          jobId: extractionId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: 1_000,
          removeOnFail: 5_000,
        },
      );
      return;
    }
    await this.runner.run(extractionId).catch(() => undefined);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}

export function redisConnection(url: string): ConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null, // required by BullMQ workers
  };
}
