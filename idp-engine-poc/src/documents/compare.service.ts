import { Injectable, NotFoundException } from '@nestjs/common';
import { normalizeLabel } from '../common/util';
import { FormRegistry } from '../forms/form-registry';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Side-by-side view of the latest successful run per engine for one document: the POC's
 * "bake-off" (shared-engine-adapter §8) on a single file. The full eval runs on a golden set.
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

    const rows = form.fields.map((def) => {
      const byEngine: Record<
        string,
        { value: unknown; confidence: number | null; flags: string[] }
      > = {};
      for (const engine of engines) {
        const f = latest.get(engine)!.fields.find((x) => x.path === def.path);
        byEngine[engine] = {
          value: f?.value ?? null,
          confidence: f?.confidence ?? null,
          flags: f?.flags ?? [],
        };
      }
      const values = Object.values(byEngine)
        .map((v) => v.value)
        .filter((v) => v !== null)
        .map((v) => (typeof v === 'string' ? normalizeLabel(v) : String(v)));
      return {
        path: def.path,
        label: def.label,
        canonicalKey: def.canonicalKey ?? null,
        byEngine,
        agree: values.length === engines.length && new Set(values).size <= 1,
      };
    });

    const totals = engines.map((engine) => {
      const run = latest.get(engine)!;
      return {
        engine,
        extractionId: run.id,
        filled: run.fields.filter((f) => f.value !== null).length,
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
