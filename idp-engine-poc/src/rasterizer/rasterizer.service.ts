import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { createCanvas } from '@napi-rs/canvas';
import sharp from 'sharp';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import type { SupportedMime } from '../common/util';

export interface RasterPage {
  pageNumber: number;
  png: Buffer;
  width: number;
  height: number;
}

// Textract sync limits (00 §4): <= 10 MB per request, <= 10,000 px per side.
const MAX_PAGE_BYTES = 9.5 * 1024 * 1024;
const MAX_SIDE_PX = 10_000;
const MAX_PAGES = 200;

/**
 * File -> one PNG per page. PDFs render with pdfjs-dist + @napi-rs/canvas (no poppler),
 * images and multi-page TIFFs go through sharp. Page PNGs feed Textract (one sync call per page)
 * and the page preview endpoint. Schema engines (VLM Run, Meibel) receive the original file.
 */
@Injectable()
export class RasterizerService {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  async rasterize(bytes: Buffer, mime: SupportedMime): Promise<RasterPage[]> {
    const pngs =
      mime === 'application/pdf' ? await this.renderPdf(bytes) : await this.splitImage(bytes);
    const pages: RasterPage[] = [];
    for (const [i, png] of pngs.entries()) {
      const fitted = await fitForTextract(png);
      const meta = await sharp(fitted).metadata();
      pages.push({
        pageNumber: i + 1,
        png: fitted,
        width: meta.width ?? 0,
        height: meta.height ?? 0,
      });
    }
    return pages;
  }

  private async renderPdf(bytes: Buffer): Promise<Buffer[]> {
    // pdfjs-dist is ESM-only; module=nodenext keeps this a real dynamic import in CJS output.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const require = createRequire(__filename);
    const fontsDir =
      join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + sep;
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      standardFontDataUrl: fontsDir,
      disableFontFace: true,
      verbosity: 0,
    }).promise;
    try {
      if (doc.numPages > MAX_PAGES) throw new Error('RASTER_TOO_MANY_PAGES');
      const scale = this.cfg.upload.rasterDpi / 72;
      const out: Buffer[] = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const viewport = page.getViewport({ scale });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const params = { canvasContext: ctx, canvas, viewport };
        await page.render(params as unknown as Parameters<typeof page.render>[0]).promise;
        out.push(canvas.toBuffer('image/png'));
        page.cleanup();
      }
      return out;
    } finally {
      await doc.destroy();
    }
  }

  private async splitImage(bytes: Buffer): Promise<Buffer[]> {
    const meta = await sharp(bytes).metadata();
    const count = Math.min(meta.pages ?? 1, MAX_PAGES);
    const out: Buffer[] = [];
    for (let page = 0; page < count; page++) {
      // rotate() applies EXIF orientation from phone photos.
      out.push(await sharp(bytes, { page }).rotate().png().toBuffer());
    }
    return out;
  }
}

async function fitForTextract(png: Buffer): Promise<Buffer> {
  let current = png;
  const meta = await sharp(current).metadata();
  const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
  if (longest > MAX_SIDE_PX) {
    current = await sharp(current)
      .resize({ width: MAX_SIDE_PX, height: MAX_SIDE_PX, fit: 'inside' })
      .png()
      .toBuffer();
  }
  let width = (await sharp(current).metadata()).width ?? 0;
  while (current.length > MAX_PAGE_BYTES && width > 600) {
    width = Math.floor(width * 0.8);
    current = await sharp(current).resize({ width }).png({ compressionLevel: 9 }).toBuffer();
  }
  return current;
}
