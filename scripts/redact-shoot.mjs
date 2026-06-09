import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3002';
const OUT = '/Users/navdeepsharma/Documents/code/agentsdx/docs/screenshots/clean';
import { mkdirSync } from 'fs';
mkdirSync(OUT, { recursive: true });

const REPO_NAMES = [
  'agentsdx','Purple-Architecture.wiki','followers.fyi','fyi-backend','mcp',
  'local-assistant','web','AgentsDX','question_detection','HPI-alerts',
  'data_cloud_core.schema_registry','letssee','portfolios.api','quorum','toolkit',
  'f54035ff-0928-46e3-b5be-df77addd8659',
];

const routes = [
  { path: '/', file: 'overview.png' },
  { path: '/repositories', file: 'repositories.png' },
  { path: '/oversight', file: 'oversight.png' },
  { path: '/models', file: 'models.png' },
];

async function redact(page, names) {
  await page.evaluate((names) => {
    const set = new Set(names);
    const blur = (el, px) => { el.style.filter = `blur(${px}px)`; };
    // Repo / file names are rendered in mono spans; numbers won't match a name
    // and only path-like strings contain a slash.
    document.querySelectorAll('.mono').forEach((el) => {
      const t = (el.textContent || '').trim();
      if (set.has(t) || t.includes('/') || t.includes('\\')) blur(el, 6);
    });
    // Oversight repo tabs + repositories repo rows use fw6 labels.
    document.querySelectorAll('.fw6, .f13, .tag-mono').forEach((el) => {
      const t = (el.textContent || '').trim();
      if (set.has(t)) blur(el, 6);
    });
    // Treemap cell labels are file basenames.
    document.querySelectorAll('.tm-label, .tm-value').forEach((el) => blur(el, 5));
  }, names);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'dark' });
const page = await ctx.newPage();
for (const r of routes) {
  await page.goto(BASE + r.path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1300);
  await redact(page, REPO_NAMES);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${OUT}/${r.file}`, fullPage: true });
  console.log('shot', r.file);
}
await browser.close();
