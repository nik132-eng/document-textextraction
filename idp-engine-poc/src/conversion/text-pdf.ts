import { normalizeSymbols } from './docx-text';

/**
 * Text lines -> a real PDF (Helvetica, WinAnsi, US Letter) with word wrap and pagination.
 * Used for DOCX uploads. The PDF has a text layer, so classification works
 * without OCR, and it rasterizes like any other PDF for Textract.
 */
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 50;
const FONT_SIZE = 10;
const LEADING = 13;
const MAX_CHARS = 100; // ~Helvetica 10pt across 512pt
const LINES_PER_PAGE = Math.floor((PAGE_H - 2 * MARGIN) / LEADING);

export function linesToPdf(lines: string[]): Buffer {
  const wrapped = lines.flatMap((l) => wrap(toWinAnsi(l.replace(/\t/g, '    '))));
  const pages: string[][] = [];
  for (let i = 0; i < wrapped.length; i += LINES_PER_PAGE) {
    pages.push(wrapped.slice(i, i + LINES_PER_PAGE));
  }
  if (pages.length === 0) pages.push(['']);
  return writePdf(pages);
}

function wrap(line: string): string[] {
  if (line.length <= MAX_CHARS) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > MAX_CHARS) {
    const cut = rest.lastIndexOf(' ', MAX_CHARS);
    const at = cut > MAX_CHARS * 0.5 ? cut : MAX_CHARS;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  out.push(rest);
  return out;
}

/** Keep what Helvetica/WinAnsi can draw; map common Unicode punctuation; drop the rest. */
function toWinAnsi(s: string): string {
  return normalizeSymbols(s)
    .replace(/[‘’‚]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/\u00a0/g, ' ')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
}

function writePdf(pages: string[][]): Buffer {
  const objs: string[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  pages.forEach((lines, i) => {
    const id = 4 + i * 2;
    const ops = lines.map((l) => `(${escape(l)}) Tj T*`).join('\n');
    const stream = `BT\n/F1 ${FONT_SIZE} Tf\n${LEADING} TL\n${MARGIN} ${PAGE_H - MARGIN} Td\n${ops}\nET`;
    objs[id] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`;
    objs[id + 1] =
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(out, 'latin1');
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
