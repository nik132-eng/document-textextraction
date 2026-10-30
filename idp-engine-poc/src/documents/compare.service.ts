import { Injectable, NotFoundException } from '@nestjs/common';
import { normalizeLabel } from '../common/util';
import { FormRegistry } from '../forms/form-registry';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Side-by-side view of the latest successful run per engine for one document: the POC's
 * "bake-off" (shared-engine-adapter §8) on a single file. Rows = form fields, then every group
 * cell any engine found. otherFields are compared by printed label (engines number them differently).
 */
@Injectable()
export class CompareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly forms: FormRegistry,
  ) {}

  async compare(tenantId: string, documentId: string, formType?: string) {
    const doc = await this.prisma.document.findFirst({ where: { id: documentId, tenantId } });
    if (!doc) throw new NotFoundException({ code: 'DOCUMENT_NOT_FOUND' });
    const form = this.forms.get(formType ?? doc.formType);
    const runs = await this.prisma.extraction.findMany({
      where: { tenantId, documentId, formType: form.id, status: 'SUCCEEDED' },
      orderBy: { createdAt: 'desc' },
      include: { fields: true },
    });
    const latest = new Map<string, (typeof runs)[number]>();
    for (const r of runs) if (!latest.has(r.engine)) latest.set(r.engine, r);
    const engines = [...latest.keys()].sort();

    type Cell = { value: unknown; confidence: number | null; flags: string[] };
    const keyOf = (f: { source: string; path: string; label: string }) =>
      f.source === 'other' ? `other:${normalizeLabel(f.label)}` : f.path;
    const rowsByKey = new Map<
      string,
      {
        key: string;
        label: string;
        source: string;
        canonicalKey: string | null;
        byEngine: Record<string, Cell>;
      }
    >();
    for (const def of form.fields) {
      rowsByKey.set(def.path, {
        key: def.path,
        label: def.label,
        source: 'field',
        canonicalKey: def.canonicalKey ?? null,
        byEngine: {},
      });
    }
    for (const engine of engines) {
      for (const f of latest.get(engine)!.fields) {
        const key = keyOf(f);
        if (!rowsByKey.has(key)) {
          rowsByKey.set(key, {
            key,
            label: f.label,
            source: f.source,
            canonicalKey: f.canonicalKey,
            byEngine: {},
          });
        }
        rowsByKey.get(key)!.byEngine[engine] ??= {
          value: f.value ?? null,
          confidence: f.confidence,
          flags: f.flags,
        };
      }
    }

    const rows = [...rowsByKey.values()].map((r) => {
      for (const e of engines) r.byEngine[e] ??= { value: null, confidence: null, flags: [] };
      const values = Object.values(r.byEngine)
        .map((v) => v.value)
        .filter((v) => v !== null)
        .map((v) => (typeof v === 'string' ? normalizeLabel(v) : String(v)));
      return { ...r, agree: values.length === engines.length && new Set(values).size <= 1 };
    });

    const totals = engines.map((engine) => {
      const run = latest.get(engine)!;
      return {
        engine,
        extractionId: run.id,
        filled: run.fields.filter((f) => f.value !== null && f.source === 'field').length,
        groupRows: new Set(
          run.fields.filter((f) => f.source === 'group').map((f) => `${f.groupPath}:${f.rowIndex}`),
        ).size,
        otherValues: run.fields.filter((f) => f.source === 'other').length,
        flagged: run.fields.filter((f) => f.flags.length > 0).length,
        costUsd: run.costUsd === null ? null : Number(run.costUsd),
        estCostUsd: run.estCostUsd === null ? null : Number(run.estCostUsd),
        latencyMs: run.latencyMs,
      };
    });

    return {
      documentId,
      formType: form.id,
      engines,
      totals,
      agreement: rows.filter((r) => r.agree).length,
      rows,
    };
  }
}
