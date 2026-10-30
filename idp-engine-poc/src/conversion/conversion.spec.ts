import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/app-config';
import { detectMime, MIME } from '../common/util';
import { RasterizerService } from '../rasterizer/rasterizer.service';
import { linesToPdf } from './text-pdf';
import { makeBookingSheetDocx, makeSyntheticCardPng } from '../testing/synthetic-docs';
import { writeZip } from '../testing/zip-writer';
import { ConverterService } from './converter.service';
import { docxToLines } from './docx-text';
import { listZip, readZipEntry } from './zip';

const raster = new RasterizerService({ upload: { rasterDpi: 72 } } as AppConfig);

describe('zip', () => {
  it('round-trips deflated entries', () => {
    const zip = writeZip({ 'a.txt': 'hello', 'dir/b.xml': '<x/>' });
    expect(listZip(zip).map((e) => e.name)).toEqual(['a.txt', 'dir/b.xml']);
    expect(readZipEntry(zip, 'dir/b.xml')!.toString()).toBe('<x/>');
    expect(readZipEntry(zip, 'missing')).toBeNull();
  });
});

describe('detectMime', () => {
  it('recognises PDF, images and DOCX; rejects ODT, legacy DOC, RTF and others', async () => {
    expect(detectMime(linesToPdf(['x']))).toBe(MIME.pdf);
    expect(detectMime(await makeSyntheticCardPng(['x']))).toBe(MIME.png);
    expect(
      detectMime(
        await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
          .jpeg()
          .toBuffer(),
      ),
    ).toBe(MIME.jpeg);
    expect(detectMime(makeBookingSheetDocx())).toBe(MIME.docx);
    expect(
      detectMime(
        writeZip({ mimetype: 'application/vnd.oasis.opendocument.text', 'content.xml': '<x/>' }),
      ),
    ).toBeNull();
    expect(
      detectMime(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])),
    ).toBeNull();
    expect(detectMime(Buffer.from('{\\rtf1\\ansi hello}'))).toBeNull();
    expect(detectMime(writeZip({ 'random.txt': 'x' }))).toBeNull();
    expect(detectMime(Buffer.from('plain text file'))).toBeNull();
  });
});

describe('docxToLines', () => {
  it('keeps paragraphs in order, flattens table rows with |, maps checkboxes', () => {
    const lines = docxToLines(makeBookingSheetDocx());
    expect(lines[0]).toContain('SURGERY BOOKING');
    expect(lines).toContain('Surgeon: DR JOHN SAMPLE     Surgeon NPI: 0000000007');
    expect(lines).toContain('CPT | Procedure | Side | Modifier');
    expect(lines).toContain('27447 | Total knee arthroplasty (synthetic) | Right | RT');
    expect(lines.find((l) => l.startsWith('Consent signed'))).toContain('[X]');
  });

  it('decodes XML entities', () => {
    const docx = writeZip({
      'word/document.xml':
        '<w:document><w:body><w:p><w:r><w:t>A &amp; B &lt;C&gt; &#x2013; ok</w:t></w:r></w:p></w:body></w:document>',
    });
    expect(docxToLines(docx)).toEqual(['A & B <C> – ok']);
  });
});

describe('linesToPdf', () => {
  it('writes a valid PDF with a text layer, wraps long lines and paginates', async () => {
    const lines = [
      'First line',
      'x'.repeat(250),
      ...Array.from({ length: 120 }, (_, i) => `Row ${i} – “quoted” ☒`),
    ];
    const pdf = linesToPdf(lines);
    const pages = await raster.rasterize(pdf, 'application/pdf');
    expect(pages.length).toBe(3);
    expect(pages[0]!.text).toContain('First line');
    expect(pages[0]!.text).toContain('"quoted" [X]');
  });
});

describe('ConverterService', () => {
  const converter = new ConverterService();

  it('passes PDFs and images through unchanged', async () => {
    const pdf = linesToPdf(['x']);
    expect(await converter.normalize(pdf, MIME.pdf)).toEqual({
      bytes: pdf,
      mimeType: MIME.pdf,
      conversion: 'none',
    });
  });

  it('DOCX -> text PDF that keeps the content (pure JS, no system dependency)', async () => {
    const out = await converter.normalize(makeBookingSheetDocx(), MIME.docx);
    expect(out).toMatchObject({ mimeType: MIME.pdf, conversion: 'docx-text' });
    const pages = await raster.rasterize(out.bytes, MIME.pdf);
    expect(pages.map((p) => p.text).join(' ')).toContain('27447');
  });
});
