import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';

const SRC = process.argv[2];
const OUT = process.argv[3];
// Boxes in native pixels [x, y, w, h] — repo-name column rows.
const BOXES = JSON.parse(process.argv[4]);
const W = Number(process.argv[5]), H = Number(process.argv[6]);

const b64 = readFileSync(SRC).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
await page.setViewportSize({ width: 400, height: 300 });

const dataUrl = await page.evaluate(async ({ b64, W, H, BOXES }) => {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, W, H);
  for (const [x, y, w, h] of BOXES) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.filter = 'blur(11px)';
    ctx.drawImage(img, 0, 0, W, H);
    ctx.restore();
  }
  return c.toDataURL('image/png');
}, { b64, W, H, BOXES });

writeFileSync(OUT, Buffer.from(dataUrl.split(',')[1], 'base64'));
await browser.close();
console.log('wrote', OUT);
