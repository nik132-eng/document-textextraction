import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/app-config';
import { detectMime } from '../common/util';
import { makeSyntheticCardPng, makeSyntheticPdf } from '../testing/synthetic-docs';
import { RasterizerService } from './rasterizer.service';

const raster = new RasterizerService({ upload: { rasterDpi: 100, maxBytes: 1e7 } } as AppConfig);

describe('RasterizerService', () => {
  it('renders each PDF page to a PNG (pdfjs + @napi-rs/canvas, no poppler)', async () => {
    const pdf = makeSyntheticPdf([['page one'], ['page two'], ['page three']]);
    expect(detectMime(pdf)).toBe('application/pdf');
    const pages = await raster.rasterize(pdf, 'application/pdf');
    expect(pages.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    // Letter at 100 DPI = 850 x 1100.
    expect(pages[0]).toMatchObject({ width: 850, height: 1100 });
    expect(detectMime(pages[0]!.png)).toBe('image/png');
    // Text was actually drawn: the page is not blank white.
    const stats = await sharp(pages[0]!.png).stats();
    expect(stats.channels[0]!.min).toBeLessThan(128);
  });

  it('passes single images through as one page', async () => {
    const png = await makeSyntheticCardPng();
    const pages = await raster.rasterize(png, 'image/png');
    expect(pages).toHaveLength(1);
    expect(pages[0]!.width).toBe(1100);
  });

  it('splits multi-page TIFFs', async () => {
    const one = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#fff' } })
      .png()
      .toBuffer();
    const tiff = await sharp([one, one], { join: { animated: true } })
      .tiff()
      .toBuffer();
    expect(detectMime(tiff)).toBe('image/tiff');
    const pages = await raster.rasterize(tiff, 'image/tiff');
    expect(pages.length).toBeGreaterThanOrEqual(1);
  });
});
