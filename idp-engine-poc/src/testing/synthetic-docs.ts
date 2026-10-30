import sharp from 'sharp';

/**
 * Synthetic documents only (plan 00 §4: no real patient data until BAA + AI opt-out are confirmed).
 * Every value is obviously fake: "SAMPLE" names, 555 phone numbers, ZZ-prefixed ids.
 */
export const SYNTHETIC_CARD_LINES = [
  'SYNTHETIC HEALTH PLAN',
  'PPO Gold (SAMPLE)',
  'Member: JANE Q SAMPLE',
  'Member ID: ZZX123456789',
  'Group: 99999',
  'RxBIN: 000000   RxPCN: SYNTH',
  'Payer ID: 00000',
  'Office visit copay: $25',
  'Customer service: 1-800-555-0199',
];

export const SYNTHETIC_INTAKE_LINES = [
  'PATIENT REGISTRATION (SYNTHETIC SAMPLE)',
  'Last name: SAMPLE        First name: JANE',
  'Date of birth: 01/02/1980     Sex: F',
  'Phone: (555) 010-0100',
  'Street address: 123 EXAMPLE ST',
  'City: SPRINGFIELD   State: ZZ   ZIP code: 00000',
  'Primary insurance: SYNTHETIC HEALTH PLAN',
  'Policy / member ID: ZZX123456789     Group number: 99999',
  'Subscriber is patient:  [X] Self   [ ] Spouse   [ ] Child',
];

/** A card-sized PNG rendered from SVG text with sharp. */
export function makeSyntheticCardPng(lines = SYNTHETIC_CARD_LINES): Promise<Buffer> {
  const text = lines
    .map(
      (l, i) =>
        `<text x="40" y="${70 + i * 58}" font-family="Helvetica, Arial, sans-serif" font-size="36" fill="#000">${xml(l)}</text>`,
    )
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="${110 + lines.length * 58}"><rect width="100%" height="100%" fill="#fff"/>${text}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** A minimal valid PDF (Helvetica text, one page per entry) with a correct xref table. */
export function makeSyntheticPdf(pages: string[][] = [SYNTHETIC_INTAKE_LINES]): Buffer {
  const objs: string[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((lines, i) => {
    const pageId = 4 + i * 2;
    const stream = [
      'BT',
      '/F1 13 Tf',
      '18 TL',
      '60 740 Td',
      ...lines.map((l) => `(${pdfText(l)}) Tj T* T*`),
      'ET',
    ].join('\n');
    objs[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objs[pageId + 1] =
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

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pdfText = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
