import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

export async function renderWebp(svg: string, width: number, height: number, output: URL) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const uri = await page.evaluate(async ({ svg, width, height }) => {
      const image = new Image();
      image.src = 'data:image/svg+xml,' + encodeURIComponent(svg);
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Expected a canvas 2D context');
      context.drawImage(image, 0, 0);
      return canvas.toDataURL('image/webp', 1);
    }, { svg, width, height });
    assert(uri.startsWith('data:image/webp;base64,'));
    const webp = Buffer.from(uri.split(',')[1], 'base64');
    assert(webp.byteLength <= 150_000, 'Plate exceeds 150 KB');
    writeFileSync(output, webp);
  } finally {
    await browser.close();
  }
}
