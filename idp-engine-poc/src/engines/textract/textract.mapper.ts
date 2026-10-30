import type { Block, BoundingBox } from '@aws-sdk/client-textract';
import { normalizeLabel } from '../../common/util';
import {
  capturesOther,
  groupCellPath,
  otherPath,
  textractSource,
  type FieldDef,
  type FormDefinition,
  type GroupDef,
} from '../../forms/form-definition';
import { fieldsInFormOrder, type BBox, type EngineField } from '../engine.port';

export interface TextractPage {
  pageNumber: number;
  /** Blocks of every call made for this page (query batches are merged). */
  blocks: Block[];
  requestIds?: string[];
  modelVersion?: string;
}

const MIN_KEY_SCORE = 0.8;

/**
 * Textract blocks -> EngineField[] (pure; unit-tested on hand-built blocks).
 *  - query fields:  QUERY (Alias = path) -> best QUERY_RESULT across pages
 *  - key fields:    FORMS KEY matched to label/keyAliases, one key per field (greedy by score)
 *  - groups:        TABLE whose header cells match the group's column aliases -> rows
 *  - otherFields:   every FORMS key/value not claimed above ("capture any value")
 */
export function mapTextractPages(form: FormDefinition, pages: TextractPage[]): EngineField[] {
  const best = new Map<string, EngineField>();
  const offer = (f: EngineField) => {
    const cur = best.get(f.path);
    if (
      !cur ||
      (cur.value === null && f.value !== null) ||
      (f.value !== null && (f.confidence ?? 0) > (cur.confidence ?? 0))
    ) {
      best.set(f.path, f);
    }
  };
  const groupRows = new Map<string, EngineField[][]>();
  const others: EngineField[] = [];
  const keyFields = form.fields.filter((f) => textractSource(f) === 'key');

  for (const page of pages) {
    const g = graph(page.blocks);

    for (const q of page.blocks) {
      if (q.BlockType !== 'QUERY' || !q.Query?.Alias) continue;
      const answer = g
        .rel(q, 'ANSWER')
        .filter((a) => a.BlockType === 'QUERY_RESULT')
        .sort((a, b) => (b.Confidence ?? 0) - (a.Confidence ?? 0))[0];
      if (!answer) continue;
      offer(
        textField(
          q.Query.Alias,
          answer.Text ?? '',
          answer.Confidence,
          page.pageNumber,
          answer.Geometry?.BoundingBox,
        ),
      );
    }

    const kvs = keyValues(page.blocks, g);
    const claimed = new Set<string>();
    for (const { field, kv } of assignKeys(keyFields, kvs)) {
      claimed.add(kv.keyId);
      if (field.type === 'checkbox') {
        if (!kv.selection) continue;
        offer({
          path: field.path,
          value: kv.selection.status === 'SELECTED',
          confidence: Math.min(kv.keyConfidence, kv.selection.confidence),
          confidenceSource: 'numeric',
          page: page.pageNumber,
          bbox: kv.selection.bbox,
        });
      } else {
        offer(
          textField(
            field.path,
            kv.valueText,
            Math.min(kv.keyConfidence, kv.valueConfidence),
            page.pageNumber,
            kv.valueBox,
            kv.valueBBox,
          ),
        );
      }
    }

    for (const group of form.groups ?? []) {
      const rows = tableRows(group, page.blocks, g, page.pageNumber);
      if (rows.length) groupRows.set(group.path, [...(groupRows.get(group.path) ?? []), ...rows]);
    }

    if (capturesOther(form)) {
      for (const kv of kvs) {
        if (claimed.has(kv.keyId) || !kv.keyText) continue;
        const value = kv.selection
          ? kv.selection.status === 'SELECTED'
          : kv.valueText.trim() || null;
        others.push({
          path: '',
          label: kv.keyText,
          value,
          confidence:
            value === null
              ? null
              : Math.min(kv.keyConfidence, kv.selection?.confidence ?? kv.valueConfidence),
          confidenceSource: value === null ? 'none' : 'numeric',
          page: page.pageNumber,
          bbox: kv.selection?.bbox ?? kv.valueBBox,
        });
      }
    }
  }

  const out = fieldsInFormOrder(form, best);
  for (const group of form.groups ?? []) {
    const rows = (groupRows.get(group.path) ?? []).slice(0, group.maxRows);
    rows.forEach((cells, i) =>
      out.push(
        ...cells.map((c, j) => ({ ...c, path: groupCellPath(group, i, group.columns[j]!) })),
      ),
    );
  }
  others.forEach((o, i) => out.push({ ...o, path: otherPath(i) }));
  return out;
}

interface Graph {
  rel: (b: Block, type: string) => Block[];
  words: (b: Block) => string;
}

function graph(blocks: Block[]): Graph {
  const byId = new Map(blocks.filter((b) => b.Id).map((b) => [b.Id!, b]));
  const rel = (b: Block, type: string) =>
    (b.Relationships ?? [])
      .filter((r) => r.Type === type)
      .flatMap((r) => r.Ids ?? [])
      .map((id) => byId.get(id))
      .filter((x): x is Block => !!x);
  const words = (b: Block) =>
    rel(b, 'CHILD')
      .filter((c) => c.BlockType === 'WORD')
      .map((w) => w.Text ?? '')
      .join(' ')
      .trim();
  return { rel, words };
}

interface KeyValue {
  keyId: string;
  keyText: string;
  keyConfidence: number;
  valueText: string;
  valueConfidence: number;
  valueBBox: BBox | null;
  valueBox?: BoundingBox;
  selection?: { status: string; confidence: number; bbox: BBox | null };
}

function keyValues(blocks: Block[], g: Graph): KeyValue[] {
  const out: KeyValue[] = [];
  for (const key of blocks) {
    if (key.BlockType !== 'KEY_VALUE_SET' || !key.EntityTypes?.includes('KEY') || !key.Id) continue;
    const value = g.rel(key, 'VALUE')[0];
    const sel = value && g.rel(value, 'CHILD').find((c) => c.BlockType === 'SELECTION_ELEMENT');
    out.push({
      keyId: key.Id,
      keyText: g.words(key),
      keyConfidence: key.Confidence ?? 100,
      valueText: value ? g.words(value) : '',
      valueConfidence: value?.Confidence ?? key.Confidence ?? 100,
      valueBBox: toBBox(value?.Geometry?.BoundingBox),
      ...(sel
        ? {
            selection: {
              status: sel.SelectionStatus ?? 'NOT_SELECTED',
              confidence: sel.Confidence ?? 100,
              bbox: toBBox(sel.Geometry?.BoundingBox),
            },
          }
        : {}),
    });
  }
  return out;
}

/** Greedy one-to-one assignment: highest score first, then the more specific (shorter) key. */
function assignKeys(fields: FieldDef[], kvs: KeyValue[]): { field: FieldDef; kv: KeyValue }[] {
  const candidates: { field: FieldDef; kv: KeyValue; score: number }[] = [];
  for (const field of fields) {
    const aliases = field.keyAliases ?? [field.label];
    for (const kv of kvs) {
      const score = Math.max(...aliases.map((a) => labelScore(a, kv.keyText)));
      if (score >= MIN_KEY_SCORE) candidates.push({ field, kv, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.kv.keyText.length - b.kv.keyText.length);
  const usedFields = new Set<string>();
  const usedKeys = new Set<string>();
  const out: { field: FieldDef; kv: KeyValue }[] = [];
  for (const c of candidates) {
    if (usedFields.has(c.field.path) || usedKeys.has(c.kv.keyId)) continue;
    usedFields.add(c.field.path);
    usedKeys.add(c.kv.keyId);
    out.push(c);
  }
  return out;
}

/**
 * 0..2. Exact normalized equality = 2; otherwise the share of alias tokens present in the text,
 * minus a small penalty per extra token so "SEX" prefers a key "SEX" over "PATIENT SEX AND DOB".
 */
export function labelScore(alias: string, text: string): number {
  const a = normalizeLabel(alias);
  const t = normalizeLabel(text);
  if (!a || !t) return 0;
  if (a === t) return 2;
  const want = a.split(' ');
  const have = t.split(' ');
  const set = new Set(have);
  const share = want.filter((w) => set.has(w)).length / want.length;
  return share - 0.01 * Math.max(0, have.length - want.length);
}

interface Cell {
  row: number;
  col: number;
  text: string;
  confidence: number;
  bbox: BBox | null;
  header: boolean;
}

function tableRows(
  group: GroupDef,
  blocks: Block[],
  g: Graph,
  pageNumber: number,
): EngineField[][] {
  let bestTable:
    | { cells: Cell[]; mapping: Map<number, number>; headerRows: Set<number> }
    | undefined;
  for (const table of blocks.filter((b) => b.BlockType === 'TABLE')) {
    const cells: Cell[] = g
      .rel(table, 'CHILD')
      .filter((c) => c.BlockType === 'CELL')
      .map((c) => ({
        row: c.RowIndex ?? 0,
        col: c.ColumnIndex ?? 0,
        text: g.words(c),
        confidence: c.Confidence ?? 100,
        bbox: toBBox(c.Geometry?.BoundingBox),
        header: c.EntityTypes?.includes('COLUMN_HEADER') ?? false,
      }));
    const headerRows = new Set(cells.filter((c) => c.header).map((c) => c.row));
    if (headerRows.size === 0) headerRows.add(1);
    const headerText = new Map<number, string>();
    for (const c of cells.filter((x) => headerRows.has(x.row))) {
      headerText.set(c.col, `${headerText.get(c.col) ?? ''} ${c.text}`.trim());
    }
    // group column index -> table column; greedy one-to-one by score.
    const cand: { gi: number; col: number; score: number }[] = [];
    group.columns.forEach((gc, gi) => {
      for (const [col, text] of headerText) {
        const score = Math.max(...(gc.keyAliases ?? [gc.label]).map((a) => labelScore(a, text)));
        if (score >= MIN_KEY_SCORE) cand.push({ gi, col, score });
      }
    });
    cand.sort((a, b) => b.score - a.score);
    const mapping = new Map<number, number>();
    const usedCols = new Set<number>();
    for (const c of cand) {
      if (mapping.has(c.gi) || usedCols.has(c.col)) continue;
      mapping.set(c.gi, c.col);
      usedCols.add(c.col);
    }
    const needed = group.minHeaderMatches ?? Math.min(2, group.columns.length);
    if (mapping.size >= needed && (!bestTable || mapping.size > bestTable.mapping.size)) {
      bestTable = { cells, mapping, headerRows };
    }
  }
  if (!bestTable) return [];

  const lastHeader = Math.max(...bestTable.headerRows);
  const dataRows = [...new Set(bestTable.cells.map((c) => c.row))]
    .filter((r) => r > lastHeader)
    .sort((a, b) => a - b);
  const rows: EngineField[][] = [];
  for (const r of dataRows) {
    const cells = group.columns.map((gc, gi) => {
      const col = bestTable!.mapping.get(gi);
      const cell =
        col === undefined ? undefined : bestTable!.cells.find((c) => c.row === r && c.col === col);
      const text = cell?.text.trim() ?? '';
      return {
        path: gc.path,
        value: text === '' ? null : text,
        confidence: text === '' ? null : (cell?.confidence ?? null),
        confidenceSource: (text === '' ? 'none' : 'numeric') as EngineField['confidenceSource'],
        page: pageNumber,
        bbox: cell?.bbox ?? null,
      };
    });
    if (cells.some((c) => c.value !== null)) rows.push(cells);
  }
  return rows;
}

function textField(
  path: string,
  text: string,
  confidence: number | undefined,
  page: number,
  box?: BoundingBox,
  bbox?: BBox | null,
): EngineField {
  const t = text.trim();
  return {
    path,
    value: t === '' ? null : t,
    confidence: t === '' ? null : (confidence ?? null),
    confidenceSource: t === '' || confidence === undefined ? 'none' : 'numeric',
    page,
    bbox: bbox ?? toBBox(box),
    ...(t ? { groundingText: t } : {}),
  };
}

function toBBox(b: BoundingBox | undefined): BBox | null {
  if (!b || b.Left === undefined || b.Top === undefined) return null;
  return { left: b.Left, top: b.Top, width: b.Width ?? 0, height: b.Height ?? 0 };
}
