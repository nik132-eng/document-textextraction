import {
  AnalyzeDocumentCommand,
  type AnalyzeDocumentCommandOutput,
  DetectDocumentTextCommand,
  type FeatureType,
  TextractClient,
} from '@aws-sdk/client-textract';
import {
  capturesOther,
  queryTextFor,
  textractSource,
  type FormDefinition,
} from '../../forms/form-definition';
import {
  EngineError,
  type EngineRequest,
  type EngineResult,
  type ExtractionEngine,
} from '../engine.port';
import { mapTextractPages, type TextractPage } from './textract.mapper';

// US list prices per page per call (plan 04 §9). Estimates only; reconcile against the AWS invoice.
const PRICE: Record<string, number> = {
  FORMS: 0.05,
  TABLES: 0.015,
  QUERIES: 0.015,
  DETECT: 0.0015,
};
/** Textract sync AnalyzeDocument accepts at most 15 queries per call (00 §4). */
export const QUERIES_PER_CALL = 15;

const RETRYABLE = new Set([
  'ThrottlingException',
  'ProvisionedThroughputExceededException',
  'InternalServerError',
  'LimitExceededException',
  'TimeoutError',
]);

export interface TextractPlan {
  /** Features of the first call per page; later calls are QUERIES-only batches. */
  features: FeatureType[];
  queryBatches: { Text: string; Alias: string }[][];
}

/** Which Textract features and query batches a form needs. Pure, so cost is predictable. */
export function planTextract(form: FormDefinition): TextractPlan {
  const queries = form.fields
    .filter((f) => textractSource(f) === 'query')
    .map((f) => ({ Text: queryTextFor(f), Alias: f.path }));
  const queryBatches: TextractPlan['queryBatches'] = [];
  for (let i = 0; i < queries.length; i += QUERIES_PER_CALL)
    queryBatches.push(queries.slice(i, i + QUERIES_PER_CALL));
  const features: FeatureType[] = [];
  if (queryBatches.length) features.push('QUERIES');
  if (form.fields.some((f) => textractSource(f) === 'key') || capturesOther(form))
    features.push('FORMS');
  if (form.groups?.length) features.push('TABLES');
  return { features, queryBatches };
}

/** Estimated USD per page for a plan. */
export function costPerPage(plan: TextractPlan): number {
  const first = plan.features.reduce((s, f) => s + (PRICE[f] ?? 0), 0);
  return first + Math.max(0, plan.queryBatches.length - 1) * PRICE.QUERIES!;
}

/**
 * Amazon Textract adapter (evidence-first). Per page: one AnalyzeDocument call with
 * FORMS/TABLES + the first 15 queries, then one QUERIES-only call per further batch of 15.
 * Credentials come from the AWS default provider chain (SSO profile locally, task role in AWS).
 */
export class TextractEngine implements ExtractionEngine {
  readonly name = 'textract' as const;

  constructor(private readonly client: TextractClient) {}

  async extract(req: EngineRequest): Promise<EngineResult> {
    const plan = planTextract(req.form);
    const pages: TextractPage[] = [];
    for (const page of req.pages) {
      const calls: { features: FeatureType[]; queries?: TextractPlan['queryBatches'][number] }[] =
        [];
      if (plan.features.length)
        calls.push({ features: plan.features, queries: plan.queryBatches[0] });
      for (const batch of plan.queryBatches.slice(1))
        calls.push({ features: ['QUERIES'], queries: batch });

      const blocks = [];
      const requestIds: string[] = [];
      let modelVersion: string | undefined;
      for (const call of calls) {
        const res = await this.send(
          new AnalyzeDocumentCommand({
            Document: { Bytes: page.bytes },
            FeatureTypes: call.features,
            ...(call.queries?.length ? { QueriesConfig: { Queries: call.queries } } : {}),
          }),
        );
        blocks.push(...(res.Blocks ?? []));
        if (res.$metadata?.requestId) requestIds.push(res.$metadata.requestId);
        modelVersion ??= res.AnalyzeDocumentModelVersion;
      }
      pages.push({ pageNumber: page.pageNumber, blocks, requestIds, modelVersion });
    }

    return {
      fields: mapTextractPages(req.form, pages),
      raw: { api: 'AnalyzeDocument', plan, pages },
      externalId: pages[0]?.requestIds?.[0],
      estCostUsd: Math.round(pages.length * costPerPage(plan) * 100_000) / 100_000,
      modelVersion: pages[0]?.modelVersion,
    };
  }

  /** Plain OCR for classification of scanned pages (CLASSIFY_OCR=textract). $0.0015/page. */
  async detectText(png: Buffer): Promise<string> {
    try {
      const res = await this.client.send(
        new DetectDocumentTextCommand({ Document: { Bytes: png } }),
      );
      return (res.Blocks ?? [])
        .filter((b) => b.BlockType === 'LINE')
        .map((b) => b.Text ?? '')
        .join('\n');
    } catch (e) {
      throw toEngineError(e);
    }
  }

  private async send(cmd: AnalyzeDocumentCommand): Promise<AnalyzeDocumentCommandOutput> {
    try {
      return await this.client.send(cmd);
    } catch (e) {
      throw toEngineError(e);
    }
  }
}

function toEngineError(e: unknown): EngineError {
  const name = e instanceof Error ? e.name : 'Unknown';
  const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return new EngineError('textract', name, RETRYABLE.has(name), status);
}
