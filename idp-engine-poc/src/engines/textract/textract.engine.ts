import {
  AnalyzeDocumentCommand,
  type AnalyzeDocumentCommandOutput,
  type FeatureType,
  TextractClient,
} from '@aws-sdk/client-textract';
import { queryTextFor } from '../../forms/form-definition';
import {
  EngineError,
  type EngineRequest,
  type EngineResult,
  type ExtractionEngine,
} from '../engine.port';
import { mapTextractPages, type TextractPage } from './textract.mapper';

// US list prices per page (plan 04 §9). Estimates only; reconcile against the AWS invoice.
const PRICE = { FORMS: 0.05, QUERIES: 0.015 } as const;

const RETRYABLE = new Set([
  'ThrottlingException',
  'ProvisionedThroughputExceededException',
  'InternalServerError',
  'LimitExceededException',
  'TimeoutError',
]);

/**
 * Amazon Textract adapter (evidence-first). One synchronous AnalyzeDocument call per page PNG.
 * Credentials come from the AWS default provider chain (SSO profile locally, task role in AWS).
 */
export class TextractEngine implements ExtractionEngine {
  readonly name = 'textract' as const;

  constructor(private readonly client: TextractClient) {}

  async extract(req: EngineRequest): Promise<EngineResult> {
    const queries = req.form.fields
      .filter((f) => f.type !== 'checkbox')
      .map((f) => ({ Text: queryTextFor(f), Alias: f.path }));
    const features: FeatureType[] = [];
    if (queries.length) features.push('QUERIES');
    if (req.form.fields.some((f) => f.type === 'checkbox')) features.push('FORMS');

    const pages: TextractPage[] = [];
    for (const page of req.pages) {
      const res = await this.send(
        new AnalyzeDocumentCommand({
          Document: { Bytes: page.bytes },
          FeatureTypes: features,
          ...(queries.length ? { QueriesConfig: { Queries: queries } } : {}),
        }),
      );
      pages.push({
        pageNumber: page.pageNumber,
        blocks: res.Blocks ?? [],
        requestId: res.$metadata?.requestId,
        modelVersion: res.AnalyzeDocumentModelVersion,
      });
    }

    const perPage = features.reduce((sum, f) => sum + (PRICE[f as keyof typeof PRICE] ?? 0), 0);
    return {
      fields: mapTextractPages(req.form, pages),
      raw: { api: 'AnalyzeDocument', features, pages },
      externalId: pages[0]?.requestId,
      estCostUsd: Math.round(pages.length * perPage * 100_000) / 100_000,
      modelVersion: pages[0]?.modelVersion,
    };
  }

  private async send(cmd: AnalyzeDocumentCommand): Promise<AnalyzeDocumentCommandOutput> {
    try {
      return await this.client.send(cmd);
    } catch (e) {
      const name = e instanceof Error ? e.name : 'Unknown';
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      throw new EngineError('textract', name, RETRYABLE.has(name), status);
    }
  }
}
