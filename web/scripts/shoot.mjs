// Screenshot every dashboard page + scan for visual defects.
// Usage: node scripts/shoot.mjs [baseUrl] [sessionId]
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const base = process.argv[2] || 'http://localhost:3002';
const sid = process.argv[3] || '';
const theme = process.argv[4] || 'light'; // 'light' | 'dark'
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', theme === 'dark' ? 'shots-dark' : 'shots');
mkdirSync(outDir, { recursive: true });

const routes = [
  ['overview', '/'],
  ['insights', '/insights'],
  ['sessions', '/sessions'],
  ['session-detail', sid ? `/sessions/${sid}` : null],
  ['pull-requests', '/pull-requests'],
  ['agents', '/agents'],
  ['models', '/models'],
  ['repositories', '/repositories'],
  ['rules', '/rules'],
  ['risk', '/risk'],
  ['remote-control', '/remote-control'],
  ['reports', '/reports'],
  ['collector', '/collector'],
  ['settings', '/settings'],
].filter(([, p]) => p);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
await page.addInitScript((t) => { try { localStorage.setItem('adx-theme', t); } catch {} }, theme);
const defects = [];

// Catch the replacement char (mojibake), console errors, zero-height cards.
const replacementChar = '�';

for (const [name, path] of routes) {
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  const status = (await page.goto(base + path, { waitUntil: 'networkidle', timeout: 30000 }))?.status();
  await page.waitForTimeout(400);
  const file = join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });

  const bodyText = await page.evaluate(() => document.body.innerText);
  const issues = [];
  if (status !== 200) issues.push(`HTTP ${status}`);
  if (bodyText.includes(replacementChar)) issues.push('mojibake � in text');
  // zero-height rendered cards (chart failed to draw)
  const zeroCards = await page.$$eval('.card', (els) =>
    els.filter((e) => e.getBoundingClientRect().height < 8).length);
  if (zeroCards) issues.push(`${zeroCards} zero-height card(s)`);
  if (/something went wrong|failed to render|Application error/i.test(bodyText)) issues.push('error boundary tripped');
  if (consoleErrors.length) issues.push(`${consoleErrors.length} console error(s): ${consoleErrors[0].slice(0, 80)}`);

  page.removeAllListeners('console');
  const tag = issues.length ? '✗ ' + issues.join('; ') : 'ok';
  console.log(`${issues.length ? 'FAIL' : 'PASS'}  ${name.padEnd(16)} ${path.padEnd(28)} ${tag}`);
  if (issues.length) defects.push({ name, path, issues });
}

await browser.close();
console.log(`\nshots → ${outDir}`);
if (defects.length) { console.log(`${defects.length} page(s) with defects`); process.exit(1); }
console.log('all clean');
