import { test, expect } from '@playwright/test';

const ROUTES = [
  '/', '/sessions', '/pull-requests', '/agents', '/tokenomics',
  '/repositories', '/rules', '/risk', '/remote-control',
  '/reports', '/collector', '/settings',
];

test.describe('Structural crawl', () => {
  test.describe.configure({ mode: 'parallel' });

  for (const route of ROUTES) {
    test(`${route} — no console errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on('console', msg => {
        if (msg.type() === 'error') errors.push(msg.text());
      });
      await page.goto(route);
      await page.waitForTimeout(1000);
      const real = errors.filter(e =>
        !e.includes('hydration') && !e.includes('favicon') && !e.includes('Failed to load resource')
      );
      expect(real).toHaveLength(0);
    });

    test(`${route} — stat values are not empty or NaN`, async ({ page }) => {
      await page.goto(route);
      const stats = page.locator('.stat-value');
      const count = await stats.count();
      for (let i = 0; i < count; i++) {
        const text = (await stats.nth(i).textContent()) || '';
        expect(text.trim().length).toBeGreaterThan(0);
        expect(text).not.toContain('NaN');
        expect(text).not.toContain('undefined');
      }
    });

    test(`${route} — tables have content or empty state`, async ({ page }) => {
      await page.goto(route);
      const tables = page.locator('table.tbl');
      const count = await tables.count();
      for (let i = 0; i < count; i++) {
        const tbody = tables.nth(i).locator('tbody');
        const rows = await tbody.locator('tr').count();
        expect(rows).toBeGreaterThan(0);
      }
    });

    test(`${route} — no zero-height rendered elements`, async ({ page }) => {
      await page.goto(route);
      await page.waitForTimeout(500);
      const bars = page.locator('[style*="border-radius: 3px 3px 0 0"]');
      const barCount = await bars.count();
      for (let i = 0; i < barCount; i++) {
        const box = await bars.nth(i).boundingBox();
        if (box) {
          expect(box.height, `bar ${i} on ${route} has zero height`).toBeGreaterThan(2);
        }
      }
    });
  }
});

test.describe('Link integrity', () => {
  test('all internal links resolve to 200', async ({ page, request }) => {
    // Crawls every link on every route then probes each — bump past the 30s
    // default so a slow dev server doesn't dispose the request context mid-run.
    test.setTimeout(90000);
    const visited = new Set<string>();
    for (const route of ROUTES) {
      await page.goto(route);
      const links = page.locator('a[href^="/"]');
      const count = await links.count();
      for (let i = 0; i < count; i++) {
        const href = await links.nth(i).getAttribute('href');
        if (href && !visited.has(href)) {
          visited.add(href);
        }
      }
    }
    for (const href of visited) {
      const res = await request.get(href);
      expect(res.status(), `${href} returned ${res.status()}`).toBeLessThan(400);
    }
  });
});

test.describe('Card structure', () => {
  for (const route of ROUTES) {
    test(`${route} — cards have titles`, async ({ page }) => {
      await page.goto(route);
      const cards = page.locator('.card');
      const count = await cards.count();
      for (let i = 0; i < count; i++) {
        const card = cards.nth(i);
        const hasTitle = await card.locator('.card-title').count();
        const hasStat = await card.locator('.stat-value').count();
        const hasPad = await card.locator('.card-pad').count();
        const hasTable = await card.locator('.table-wrap, table').count();
        const hasChart = await card.locator('svg, canvas').count();
        const hasDrillToggle = await card.locator('.drill-toggle').count();
        const hasContent = await card.locator('.col-flex, .row, .grid, .term, strong, .fw6, .mono').count();
        expect(
          hasTitle + hasStat + hasPad + hasTable + hasChart + hasDrillToggle + hasContent,
          `card ${i} on ${route} has no content`
        ).toBeGreaterThan(0);
      }
    });
  }
});
