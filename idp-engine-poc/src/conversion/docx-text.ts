import { readZipEntry } from './zip';

/**
 * DOCX -> text lines in reading order, in pure JS.
 * Paragraphs become lines; table rows become "cell | cell | cell"; tabs and breaks are kept;
 * checkbox symbols and Word content-control checkboxes become [X] / [ ].
 * Layout (positions, fonts) is lost. That is fine for label/value forms and tables.
 */
export function docxToLines(docx: Buffer): string[] {
  const xml = readZipEntry(docx, 'word/document.xml');
  if (!xml) throw new Error('DOCX_NO_DOCUMENT_XML');
  const body = xml.toString('utf8');
  const lines: string[] = [];
  const blockRe = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\/>|<w:p[ >][\s\S]*?<\/w:p>/g;
  for (const m of body.matchAll(blockRe)) {
    const block = m[0];
    if (block.startsWith('<w:tbl>')) {
      for (const row of block.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) ?? []) {
        const cells = (row.match(/<w:tc[ >][\s\S]*?<\/w:tc>/g) ?? []).map((c) =>
          (c.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []).map(paragraphText).join(' ').trim(),
        );
        if (cells.some((c) => c !== '')) lines.push(cells.join(' | '));
      }
      lines.push('');
    } else {
      lines.push(...paragraphText(block).split('\n'));
    }
  }
  // Collapse runs of blank lines.
  return lines.filter((l, i) => l.trim() !== '' || (i > 0 && lines[i - 1]!.trim() !== ''));
}

function paragraphText(p: string): string {
  let out = '';
  const tokenRe =
    /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>|<w14:checked w14:val="(\w+)"\/>|<w:sym [^>]*w:char="(\w+)"[^>]*\/>/g;
  for (const t of p.matchAll(tokenRe)) {
    if (t[1] !== undefined) out += decodeXml(t[1]);
    else if (t[0] === '<w:tab/>') out += '\t';
    else if (t[0] === '<w:br/>' || t[0] === '<w:cr/>') out += '\n';
    else if (t[2] !== undefined) out += t[2] === '1' || t[2] === 'true' ? '[X] ' : '[ ] ';
    else if (t[3] !== undefined) out += /^(F0FE|F078|2612|2611)$/i.test(t[3]) ? '[X]' : '[ ]';
  }
  return normalizeSymbols(out);
}

const decodeXml = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');

export const normalizeSymbols = (s: string): string =>
  s.replace(/[☒☑✔✓✗✘]/g, '[X]').replace(/[☐□]/g, '[ ]');
