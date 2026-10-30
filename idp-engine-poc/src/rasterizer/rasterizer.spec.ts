import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/app-config';
import { detectMime } from '../common/util';
import { linesToPdf } from '../conversion/text-pdf';
import { makeSyntheticCardPng } from '../testing/synthetic-docs';
import { RasterizerService } from './rasterizer.service';

const raster = new RasterizerService({ upload: { rasterDpi: 100, maxBytes: 1e7 } } as AppConfig);

describe('RasterizerService', () => {
  it('renders each PDF page to a PNG and returns its text layer (pdfjs + @napi-rs/canvas)', async () => {
    const pdf = linesToPdf(Array.from({ length: 110 }, (_, i) => `line ${i}`));
    const pages = await raster.rasterize(pdf, 'application/pdf');
    expect(pages.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    // Letter at 100 DPI = 850 x 1100.
    expect(pages[0]).toMatchObject({ width: 850, height: 1100 });
    expect(pages[0]!.text).toContain('line 0');
    expect(pages[2]!.text).toContain('line 109');
    expect(detectMime(pages[0]!.png)).toBe('image/png');
    const stats = await sharp(pages[0]!.png).stats();
    expect(stats.channels[0]!.min).toBeLessThan(128); // text was drawn
  });

  it('images become one page with no text layer', async () => {
    const pages = await raster.rasterize(await makeSyntheticCardPng(), 'image/png');
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ width: 1100, text: '' });
  });

  it('splits multi-page TIFFs', async () => {
    const one = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#fff' } })
      .png()
      .toBuffer();
    const tiff = await sharp([one, one], { join: { animated: true } })
      .tiff()
      .toBuffer();
    expect(detectMime(tiff)).toBe('image/tiff');
    expect((await raster.rasterize(tiff, 'image/tiff')).length).toBeGreaterThanOrEqual(1);
  });
});
