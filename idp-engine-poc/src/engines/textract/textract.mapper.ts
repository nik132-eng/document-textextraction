import type { Block, BoundingBox } from '@aws-sdk/client-textract';
import { normalizeLabel } from '../../common/util';
import type { FieldDef, FormDefinition } from '../../forms/form-definition';
import { fieldsInFormOrder, type BBox, type EngineField } from '../engine.port';

export interface TextractPage {
  pageNumber: number;
  blocks: Block[];
  requestId?: string;
  modelVersion?: string;
}

/**
 * Textract blocks -> EngineField[] (pure; unit-tested on hand-built blocks).
 * - Text fields: QUERY (Alias = field path) -> highest-confidence QUERY_RESULT across all pages.
 * - Checkbox fields: FORMS KEY whose text matches the label/keyAliases -> SELECTION_ELEMENT status.
 */
export function mapTextractPages(form: FormDefinition, pages: TextractPage[]): EngineField[] {
  const best = new Map<string, EngineField>();
  const offer = (f: EngineField) => {
    const cur = best.get(f.path);
    if (!cur || (f.confidence ?? 0) > (cur.confidence ?? 0)) best.set(f.path, f);
  };
  const checkboxes = form.fields.filter((f) => f.type === 'checkbox');

  for (const page of pages) {
    const byId = new Map(page.blocks.filter((b) => b.Id).map((b) => [b.Id!, b]));
    const rel = (b: Block, type: string) =>
      (b.Relationships ?? [])
        .filter((r) => r.Type === type)
        .flatMap((r) => r.Ids ?? [])
        .map((id) => byId.get(id))
        .filter((x): x is Block => !!x);

    for (const q of page.blocks) {
      if (q.BlockType !== 'QUERY' || !q.Query?.Alias) continue;
      const answer = rel(q, 'ANSWER')
        .filter((a) => a.BlockType === 'QUERY_RESULT')
        .sort((a, b) => (b.Confidence ?? 0) - (a.Confidence ?? 0))[0];
      if (!answer) continue;
      const text = answer.Text?.trim() ?? '';
      offer({
        path: q.Query.Alias,
        value: text === '' ? null : text,
        confidence: answer.Confidence ?? null,
        confidenceSource: answer.Confidence === undefined ? 'none' : 'numeric',
        page: page.pageNumber,
        bbox: toBBox(answer.Geometry?.BoundingBox),
        groundingText: text || undefined,
      });
    }

    if (checkboxes.length === 0) continue;
    const keys = page.blocks.filter(
      (b) => b.BlockType === 'KEY_VALUE_SET' && b.EntityTypes?.includes('KEY'),
    );
    for (const field of checkboxes) {
      const match = bestKey(field, keys, (k) => wordsOf(k, rel));
      if (!match) continue;
      const valueBlock = rel(match, 'VALUE')[0];
      const selection =
        valueBlock && rel(valueBlock, 'CHILD').find((c) => c.BlockType === 'SELECTION_ELEMENT');
      if (!selection) continue;
      offer({
        path: field.path,
        value: selection.SelectionStatus === 'SELECTED',
        confidence: Math.min(match.Confidence ?? 100, selection.Confidence ?? 100),
        confidenceSource: 'numeric',
        page: page.pageNumber,
        bbox: toBBox(selection.Geometry?.BoundingBox),
      });
    }
  }
  return fieldsInFormOrder(form, best);
}

function wordsOf(b: Block, rel: (b: Block, t: string) => Block[]): string {
  return rel(b, 'CHILD')
    .filter((c) => c.BlockType === 'WORD')
    .map((w) => w.Text ?? '')
    .join(' ');
}

/** Picks the KEY whose text best matches the field's label or aliases (token overlap >= 0.8). */
function bestKey(field: FieldDef, keys: Block[], textOf: (b: Block) => string): Block | undefined {
  const targets = (field.keyAliases ?? [field.label]).map(normalizeLabel);
  let best: { block: Block; score: number } | undefined;
  for (const key of keys) {
    const keyText = normalizeLabel(textOf(key));
    const score = Math.max(...targets.map((t) => tokenScore(t, keyText)));
    if (score >= 0.8 && (!best || score > best.score)) best = { block: key, score };
  }
  return best?.block;
}

export function tokenScore(target: string, text: string): number {
  const want = target.split(' ').filter(Boolean);
  if (want.length === 0) return 0;
  const have = new Set(text.split(' '));
  return want.filter((t) => have.has(t)).length / want.length;
}

function toBBox(b: BoundingBox | undefined): BBox | null {
  if (!b || b.Left === undefined || b.Top === undefined) return null;
  return { left: b.Left, top: b.Top, width: b.Width ?? 0, height: b.Height ?? 0 };
}
