import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'screenshots');
const BASE = process.env.BASE || 'http://localhost:3002';
const pages = [
  { path: '/', file: 'overview.png', fullPage: true, redactRepos: true },
  { path: '/insights', file: 'insights.png', fullPage: true },
  { path: '/models', file: 'models.png', fullPage: true },
  { path: '/agents', file: 'agents.png', fullPage: false },
];

// Blur any element that could carry a real project/repo name. Keep bars/numbers.
async function redact(page) {
  await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.card'));
    for (const card of cards) {
      const sub = card.querySelector('.card-sub');
      if (sub && /ranked by token usage/i.test(sub.textContent || '')) {
        card.querySelectorAll('.mono.fw6.f13').forEach((el) => {
          el.style.filter = 'blur(5px)';
        });
      }
    }
  });
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2, colorScheme: 'dark' });
const page = await ctx.newPage();
for (const p of pages) {
  await page.goto(BASE + p.path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  if (p.redactRepos) await redact(page);
  await page.screenshot({ path: join(OUT, p.file), fullPage: p.fullPage });
  console.log('shot', p.file);
}
await browser.close();
