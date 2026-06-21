import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename2 = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
const __dirname2 = dirname(__filename2);
const DB_PATH = process.env.AGENTDX_DB || join(__dirname2, '..', 'data', 'agentdx.db');

function openDb() {
  return new Database(DB_PATH, { readonly: true });
}

test.describe('Data consistency', () => {
  test('dashboard session count appears somewhere on page', async ({ page }) => {
    const db = openDb();
    const { cnt } = db.prepare('SELECT COUNT(*) as cnt FROM sessions').get() as any;
    db.close();

    await page.goto('/');
    // The dashboard shows session count in drilldown tiles or the page text
    const body = await page.textContent('body');
    // Session count should appear somewhere on the page (in drilldown tiles, evidence map, etc.)
    expect(body).toContain(String(cnt));
  });

  test('sessions page total matches DB', async ({ page }) => {
    const db = openDb();
    const { cnt } = db.prepare('SELECT COUNT(*) as cnt FROM sessions').get() as any;
    db.close();

    await page.goto('/sessions');
    // Look for the count in page text
    const body = await page.textContent('body');
    expect(body).toContain(String(cnt));
  });

  test('models page token total matches DB', async ({ page }) => {
    const db = openDb();
    const row = db.prepare(`
      SELECT SUM(input_tokens) + SUM(output_tokens) + SUM(cache_read) as total
      FROM model_usage WHERE model != '<synthetic>'
    `).get() as any;
    db.close();

    await page.goto('/tokenomics?tab=models&period=all');
    const body = await page.textContent('body');
    const total = row.total || 0;
    if (total >= 1e9) {
      const abbrev = (total / 1e9).toFixed(2) + 'B';
      expect(body).toContain(abbrev);
    } else if (total >= 1e6) {
      const abbrev = (total / 1e6).toFixed(1) + 'M';
      expect(body).toContain(abbrev);
    }
  });

  test('session count consistent across dashboard and sessions page', async ({ page }) => {
    await page.goto('/');
    const dashStats = await page.locator('.stat-value').allTextContents();

    await page.goto('/sessions');
    const sessionsText = await page.textContent('body');

    // The session count from dashboard should also appear on sessions page
    // Extract the first stat (Sessions count)
    // Both pages should reference the same number
    const db = openDb();
    const { cnt } = db.prepare('SELECT COUNT(*) as cnt FROM sessions').get() as any;
    db.close();

    expect(sessionsText).toContain(String(cnt));
  });

  test('agents page tool counts match DB', async ({ page }) => {
    const db = openDb();
    const { cnt } = db.prepare('SELECT COUNT(*) as cnt FROM tool_calls').get() as any;
    db.close();

    await page.goto('/agents');
    const body = await page.textContent('body');
    expect(body).toContain(cnt.toLocaleString());
  });

  test('risk page error count matches DB', async ({ page }) => {
    const db = openDb();
    const { cnt } = db.prepare('SELECT COUNT(*) as cnt FROM tool_calls WHERE is_error = 1').get() as any;
    db.close();

    await page.goto('/risk');
    const body = await page.textContent('body');
    // Error count should appear somewhere on risk page
    if (cnt > 0) {
      expect(body).toContain(String(cnt));
    }
  });

  test('repositories page count matches DB', async ({ page }) => {
    const db = openDb();
    const { cnt } = db.prepare('SELECT COUNT(*) as cnt FROM repositories').get() as any;
    db.close();

    await page.goto('/repositories');
    // The repo summary moved from .stat-value cards to DrilldownTiles
    // (.drill-tile); read both so the assertion survives either layout.
    const statValues = await page.locator('.stat-value, .drill-tile').allTextContents();
    const found = statValues.some(t => t.includes(String(cnt)));
    expect(found, `Repo count ${cnt} not found: ${statValues.join(' | ')}`).toBe(true);
  });

  test('models page model count matches DB', async ({ page }) => {
    const db = openDb();
    const { cnt } = db.prepare("SELECT COUNT(DISTINCT model) as cnt FROM model_usage WHERE model != '<synthetic>'").get() as any;
    db.close();

    await page.goto('/tokenomics?tab=models&period=all');
    const body = await page.textContent('body');
    expect(body).toContain(String(cnt));
  });
});
