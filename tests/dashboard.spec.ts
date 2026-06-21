import { test, expect } from '@playwright/test';

const SESSION_ID = '2f2154bd-6041-46fc-8011-b15efd91b1db';

// ============================================================
// Overview page
// ============================================================
test.describe('Overview page', () => {
  test('loads and shows page title', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.page-title')).toHaveText('Coding-agent flight recorder');
  });

  test('renders drilldown tiles', async ({ page }) => {
    await page.goto('/');
    const tiles = page.locator('.drill-tile');
    const count = await tiles.count();
    expect(count).toBeGreaterThanOrEqual(4);
  });

  test('sparkline stat cards show non-zero values', async ({ page }) => {
    await page.goto('/');
    const values = page.locator('.card.stat .stat-value');
    const count = await values.count();
    expect(count).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < count; i++) {
      const text = await values.nth(i).textContent();
      expect(text!.length).toBeGreaterThan(0);
    }
  });

  test('shows evidence map', async ({ page }) => {
    await page.goto('/');
    const text = await page.locator('.page').textContent();
    expect(text).toContain('Evidence map');
  });

  test('shows recent sessions in collapsible', async ({ page }) => {
    await page.goto('/');
    // Collapsible starts closed; verify it exists
    await expect(page.locator('text=Recent sessions')).toBeVisible();
  });

  test('shows model distribution section', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('text=Model distribution')).toBeVisible();
  });

  test('shows agents section', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h3.card-title:has-text("Agents")')).toBeVisible();
  });

  test('session links accessible after expanding collapsible', async ({ page }) => {
    await page.goto('/');
    // Click the collapsible toggle to expand it
    const toggle = page.locator('.drill-toggle:has-text("Recent sessions")');
    await toggle.click();
    await page.waitForTimeout(200);
    const firstLink = page.locator('table.tbl tbody tr a').first();
    const href = await firstLink.getAttribute('href');
    expect(href).toMatch(/^\/sessions\//);
  });

  test('"All sessions" button links to /sessions', async ({ page }) => {
    await page.goto('/');
    const btn = page.locator('a:has-text("All sessions")');
    await expect(btn.first()).toHaveAttribute('href', '/sessions');
  });

  test('shows both claude-code and codex agents', async ({ page }) => {
    await page.goto('/');
    const text = await page.locator('.page').textContent();
    expect(text).toContain('claude-code');
    expect(text).toContain('codex');
  });
});

// ============================================================
// Sessions list page
// ============================================================
test.describe('Sessions list page', () => {
  test('loads and shows page title', async ({ page }) => {
    await page.goto('/sessions');
    await expect(page.locator('.page-title')).toHaveText('Sessions');
  });

  test('shows summary stat cards', async ({ page }) => {
    await page.goto('/sessions');
    const cards = page.locator('.grid.g-4 .card.stat');
    await expect(cards).toHaveCount(4);
  });

  test('shows agent filter chips', async ({ page }) => {
    await page.goto('/sessions');
    const chips = page.locator('.tag-mono:has-text("claude-code")');
    expect(await chips.count()).toBeGreaterThan(0);
  });

  test('renders sessions table with headers', async ({ page }) => {
    await page.goto('/sessions');
    const headers = page.locator('table.tbl thead th');
    const count = await headers.count();
    expect(count).toBeGreaterThanOrEqual(8);
  });

  test('sessions table has clickable rows', async ({ page }) => {
    await page.goto('/sessions');
    const rows = page.locator('table.tbl tbody tr.clickable');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
  });

  test('each row has agent and model tags', async ({ page }) => {
    await page.goto('/sessions');
    const agentTags = page.locator('table.tbl tbody .tag-mono');
    expect(await agentTags.count()).toBeGreaterThan(0);
    const modelTags = page.locator('table.tbl tbody .tag-model');
    expect(await modelTags.count()).toBeGreaterThan(0);
  });

  test('shows session count in pagination', async ({ page }) => {
    await page.goto('/sessions');
    const info = page.locator('.info');
    const text = await info.textContent();
    expect(text).toMatch(/\d+/);
  });

  test('session link navigates to detail page', async ({ page }) => {
    await page.goto('/sessions');
    const firstLink = page.locator('table.tbl tbody tr a').first();
    await firstLink.click();
    await expect(page).toHaveURL(/\/sessions\/.+/);
    await expect(page.locator('.page-title')).toBeVisible();
  });

  test('shows codex sessions', async ({ page }) => {
    await page.goto('/sessions');
    const text = await page.locator('.page').textContent();
    expect(text).toContain('codex');
  });
});

// ============================================================
// Session detail page
// ============================================================
test.describe('Session detail page', () => {
  test('loads with valid session ID', async ({ page }) => {
    await page.goto(`/sessions/${SESSION_ID}`);
    await expect(page.locator('.page-title')).toBeVisible();
  });

  test('shows session ID in header', async ({ page }) => {
    await page.goto(`/sessions/${SESSION_ID}`);
    const title = page.locator('.page-title');
    const text = await title.textContent();
    expect(text).toContain(SESSION_ID.slice(0, 8));
  });

  test('renders 6 KPI stat cards', async ({ page }) => {
    await page.goto(`/sessions/${SESSION_ID}`);
    const stats = page.locator('.grid .card.stat');
    await expect(stats).toHaveCount(6);
  });

  test('shows forensic timeline with events', async ({ page }) => {
    await page.goto(`/sessions/${SESSION_ID}`);
    await expect(page.locator('text=Forensic timeline')).toBeVisible();
    const nodes = page.locator('.chain-node');
    expect(await nodes.count()).toBeGreaterThan(0);
  });

  test('timeline has user and assistant messages', async ({ page }) => {
    await page.goto(`/sessions/${SESSION_ID}`);
    await expect(page.locator('.chain-k:has-text("User prompt")').first()).toBeVisible();
    await expect(page.locator('.chain-k:has-text("Assistant response")').first()).toBeVisible();
  });

  test('shows tool calls in timeline', async ({ page }) => {
    await page.goto(`/sessions/${SESSION_ID}`);
    const toolNodes = page.locator('.chain-node.accent');
    expect(await toolNodes.count()).toBeGreaterThan(0);
  });

  test('shows token breakdown bar', async ({ page }) => {
    await page.goto(`/sessions/${SESSION_ID}`);
    await expect(page.locator('text=Token breakdown')).toBeVisible();
    await expect(page.locator('.tokbar')).toBeVisible();
  });

  test('shows models used card', async ({ page }) => {
    await page.goto(`/sessions/${SESSION_ID}`);
    await expect(page.locator('text=Models used')).toBeVisible();
  });

  test('shows tool usage by category card', async ({ page }) => {
    await page.goto(`/sessions/${SESSION_ID}`);
    await expect(page.locator('text=Tool usage by category')).toBeVisible();
  });

  test('shows context sources card', async ({ page }) => {
    await page.goto(`/sessions/${SESSION_ID}`);
    await expect(page.locator('text=Context sources')).toBeVisible();
  });

  test('shows session info card', async ({ page }) => {
    await page.goto(`/sessions/${SESSION_ID}`);
    await expect(page.locator('text=Session info')).toBeVisible();
  });

  test('shows tool calls table', async ({ page }) => {
    await page.goto(`/sessions/${SESSION_ID}`);
    const toolTable = page.locator('text=Tool calls').first();
    await expect(toolTable).toBeVisible();
  });

  test('back link navigates to sessions list', async ({ page }) => {
    await page.goto(`/sessions/${SESSION_ID}`);
    const backLink = page.locator('a:has-text("All sessions")');
    await expect(backLink).toHaveAttribute('href', '/sessions');
  });

  test('shows not-found message for invalid session ID', async ({ page }) => {
    await page.goto('/sessions/nonexistent-id-12345');
    await expect(page.getByRole('heading', { name: 'Session not found' })).toBeVisible();
  });
});

// ============================================================
// Models & Tokens page
// ============================================================
test.describe('Models & Tokens page', () => {
  test('loads and shows page title', async ({ page }) => {
    await page.goto('/tokenomics?tab=models&period=all');
    await expect(page.locator('.page-title')).toContainText('Tokenomics');
  });

  test('renders KPI stat cards', async ({ page }) => {
    await page.goto('/tokenomics?tab=models&period=all');
    const cards = page.locator('.card.stat');
    expect(await cards.count()).toBeGreaterThanOrEqual(4);
  });

  test('shows token composition bar', async ({ page }) => {
    await page.goto('/tokenomics?tab=models&period=all');
    await expect(page.locator('text=Token composition')).toBeVisible();
    await expect(page.locator('.tok-legend').first()).toBeVisible();
  });

  test('shows models table after expanding collapsible', async ({ page }) => {
    await page.goto('/tokenomics?tab=models&period=all');
    // Table is inside a Collapsible -- expand it first
    const toggle = page.locator('.drill-toggle:has-text("Model details")');
    await toggle.click();
    await page.waitForTimeout(200);
    const rows = page.locator('table.tbl tbody tr');
    expect(await rows.count()).toBeGreaterThan(0);
  });

  test('models table has tag-model badges after expanding', async ({ page }) => {
    await page.goto('/tokenomics?tab=models&period=all');
    const toggle = page.locator('.drill-toggle:has-text("Model details")');
    await toggle.click();
    await page.waitForTimeout(200);
    const tags = page.locator('table.tbl .tag-model');
    expect(await tags.count()).toBeGreaterThan(0);
  });

  test('shows gpt-5.5 from codex collection', async ({ page }) => {
    await page.goto('/tokenomics?tab=models&period=all');
    // gpt-5.5 is in the collapsed Model details table -- expand it
    const toggle = page.locator('.drill-toggle:has-text("Model details")');
    await toggle.click();
    await page.waitForTimeout(200);
    const text = await page.locator('.page').textContent();
    expect(text).toContain('gpt-5.5');
  });

  test('does not show synthetic model', async ({ page }) => {
    await page.goto('/tokenomics?tab=models&period=all');
    const text = await page.locator('.page').textContent();
    expect(text).not.toContain('<synthetic>');
  });
});

// ============================================================
// Tokenomics — Cost tab
// ============================================================
test.describe('Tokenomics cost tab', () => {
  test('cost tab shows spend by repository', async ({ page }) => {
    await page.goto('/tokenomics?tab=cost&period=all');
    await expect(page.locator('text=Spend by repository')).toBeVisible();
  });

  test('cost tab shows estimated spend KPI', async ({ page }) => {
    await page.goto('/tokenomics?tab=cost&period=all');
    await expect(page.locator('text=Estimated spend')).toBeVisible();
  });

  test('redirect from /finops lands on tokenomics cost tab', async ({ page }) => {
    await page.goto('/finops');
    await expect(page).toHaveURL(/\/tokenomics\?tab=cost/);
  });
});

// ============================================================
// Repositories page
// ============================================================
test.describe('Repositories page', () => {
  test('loads and shows page title', async ({ page }) => {
    await page.goto('/repositories');
    await expect(page.locator('.page-title')).toHaveText('Repositories');
  });

  test('renders summary stat cards', async ({ page }) => {
    await page.goto('/repositories');
    const cards = page.locator('.grid.g-4 .card.stat');
    await expect(cards).toHaveCount(4);
  });

  test('shows repositories table after expanding collapsible', async ({ page }) => {
    await page.goto('/repositories');
    const toggle = page.locator('.drill-toggle:has-text("Repository details")');
    await toggle.click();
    await page.waitForTimeout(200);
    const rows = page.locator('table.tbl tbody tr');
    expect(await rows.count()).toBeGreaterThan(0);
  });

  test('shows agent badges in table after expanding', async ({ page }) => {
    await page.goto('/repositories');
    const toggle = page.locator('.drill-toggle:has-text("Repository details")');
    await toggle.click();
    await page.waitForTimeout(200);
    const tags = page.locator('table.tbl .tag-mono');
    expect(await tags.count()).toBeGreaterThan(0);
  });

  test('shows repository paths in chart section', async ({ page }) => {
    await page.goto('/repositories');
    // Token usage chart section shows repo names + session counts
    const items = page.locator('.col-flex .f12.muted');
    expect(await items.count()).toBeGreaterThan(0);
  });
});

// ============================================================
// Agents & Skills page
// ============================================================
test.describe('Agents & Skills page', () => {
  test('loads and shows page title', async ({ page }) => {
    await page.goto('/agents');
    const title = page.locator('.page-title');
    const text = await title.textContent();
    expect(text).toContain('Agents');
  });

  test('shows agent overview bubble chart', async ({ page }) => {
    await page.goto('/agents');
    await expect(page.locator('.card-title:has-text("Agent overview")')).toBeVisible();
  });

  test('shows agents table with rows after expanding', async ({ page }) => {
    await page.goto('/agents');
    const toggle = page.locator('.drill-toggle:has-text("Agent details")');
    await toggle.click();
    await page.waitForTimeout(200);
    const rows = page.locator('table.tbl tbody tr');
    expect(await rows.count()).toBeGreaterThan(0);
  });

  test('shows both claude-code and codex agents', async ({ page }) => {
    await page.goto('/agents');
    const text = await page.locator('.page').textContent();
    expect(text).toContain('claude-code');
    expect(text).toContain('codex');
  });

  test('shows most used tools section', async ({ page }) => {
    await page.goto('/agents');
    await expect(page.locator('text=Most used tools')).toBeVisible();
    const meters = page.locator('.meter');
    expect(await meters.count()).toBeGreaterThan(0);
  });

  test('shows model badges per agent after expanding', async ({ page }) => {
    await page.goto('/agents');
    const toggle = page.locator('.drill-toggle:has-text("Agent details")');
    await toggle.click();
    await page.waitForTimeout(200);
    const tags = page.locator('table.tbl .tag-model');
    expect(await tags.count()).toBeGreaterThan(0);
  });
});

// ============================================================
// Sidebar navigation
// ============================================================
test.describe('Sidebar navigation', () => {
  test('sidebar is visible', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.sidebar')).toBeVisible();
  });

  test('shows AgentDX brand', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.brand-name')).toContainText('AgentDX');
  });

  test('has nav items', async ({ page }) => {
    await page.goto('/');
    const navItems = page.locator('.nav-item');
    expect(await navItems.count()).toBeGreaterThanOrEqual(4);
  });

  test('Overview nav item is active on homepage', async ({ page }) => {
    await page.goto('/');
    const overviewNav = page.locator('.nav-item.active');
    await expect(overviewNav).toContainText('Overview');
  });

  test('Sessions nav item is active on sessions page', async ({ page }) => {
    await page.goto('/sessions');
    const activeNav = page.locator('.nav-item.active');
    await expect(activeNav).toContainText('Sessions');
  });

  test('Models nav item is active on models page', async ({ page }) => {
    await page.goto('/tokenomics?tab=models&period=all');
    const activeNav = page.locator('.nav-item.active');
    await expect(activeNav).toContainText('Tokenomics');
  });

  test('clicking Sessions nav navigates', async ({ page }) => {
    await page.goto('/');
    await page.locator('.nav-item:has-text("Sessions")').click();
    await expect(page).toHaveURL(/\/sessions/);
  });
});

// ============================================================
// Theme toggle
// ============================================================
test.describe('Theme toggle', () => {
  test('theme toggle exists in topbar', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.theme-seg')).toBeVisible();
  });

  test('has 3 theme buttons (system, light, dark)', async ({ page }) => {
    await page.goto('/');
    const buttons = page.locator('.theme-seg button');
    await expect(buttons).toHaveCount(3);
  });

  test('clicking dark theme changes data-theme attribute', async ({ page }) => {
    await page.goto('/');
    const darkBtn = page.locator('.theme-seg button[title="Dark"]');
    await darkBtn.click();
    const theme = await page.locator('html').getAttribute('data-theme');
    expect(theme).toBe('dark');
  });

  test('clicking light theme changes data-theme attribute', async ({ page }) => {
    await page.goto('/');
    const lightBtn = page.locator('.theme-seg button[title="Light"]');
    await lightBtn.click();
    const theme = await page.locator('html').getAttribute('data-theme');
    expect(theme).toBe('light');
  });

  test('theme persists after navigation', async ({ page }) => {
    await page.goto('/');
    await page.locator('.theme-seg button[title="Dark"]').click();
    await page.goto('/sessions');
    const theme = await page.locator('html').getAttribute('data-theme');
    expect(theme).toBe('dark');
  });
});

// ============================================================
// CSS design system
// ============================================================
test.describe('Design system', () => {
  test('uses IBM Plex Sans font', async ({ page }) => {
    await page.goto('/');
    const fontFamily = await page.locator('body').evaluate(el => getComputedStyle(el).fontFamily);
    expect(fontFamily).toContain('IBM Plex Sans');
  });

  test('stat values use monospace font', async ({ page }) => {
    await page.goto('/');
    const fontFamily = await page.locator('.stat-value').first().evaluate(el => getComputedStyle(el).fontFamily);
    expect(fontFamily).toContain('IBM Plex Mono');
  });

  test('cards have correct border radius', async ({ page }) => {
    await page.goto('/');
    const radius = await page.locator('.card').first().evaluate(el => getComputedStyle(el).borderRadius);
    expect(radius).toBe('8px');
  });

  test('no console errors on overview', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.goto('/');
    await page.waitForTimeout(1000);
    const realErrors = errors.filter(e => !e.includes('hydration') && !e.includes('favicon') && !e.includes('Failed to load resource') && !e.includes('__import_unsupported'));
    expect(realErrors).toHaveLength(0);
  });

  test('no console errors on models page', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.goto('/tokenomics?tab=models&period=all');
    await page.waitForTimeout(1000);
    const realErrors = errors.filter(e => !e.includes('hydration') && !e.includes('favicon') && !e.includes('Failed to load resource') && !e.includes('__import_unsupported'));
    expect(realErrors).toHaveLength(0);
  });

  test('no console errors on agents page', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.goto('/agents');
    await page.waitForTimeout(1000);
    const realErrors = errors.filter(e => !e.includes('hydration') && !e.includes('favicon') && !e.includes('Failed to load resource') && !e.includes('__import_unsupported'));
    expect(realErrors).toHaveLength(0);
  });
});

// ============================================================
// Sessions search & filter
// ============================================================
test.describe('Sessions search & filter', () => {
  test('search input is visible', async ({ page }) => {
    await page.goto('/sessions');
    const input = page.locator('input[placeholder*="Search"]');
    await expect(input).toBeVisible();
  });

  test('search filters sessions by text', async ({ page }) => {
    await page.goto('/sessions');
    const input = page.locator('input[placeholder*="Search"]');
    await input.fill('codex');
    await page.waitForTimeout(200);
    const rows = page.locator('table.tbl tbody tr');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
  });

  test('agent filter dropdown exists', async ({ page }) => {
    await page.goto('/sessions');
    const selects = page.locator('select');
    expect(await selects.count()).toBeGreaterThanOrEqual(3);
  });

  test('agent filter filters by agent', async ({ page }) => {
    await page.goto('/sessions');
    const agentSelect = page.locator('select').first();
    await agentSelect.selectOption('codex');
    await page.waitForTimeout(300);
    const countText = page.locator('text=/\\d+ of \\d+ sessions/');
    const text = await countText.textContent();
    expect(text).toContain('sessions');
  });

  test('clear filters button appears when filtered', async ({ page }) => {
    await page.goto('/sessions');
    const input = page.locator('input[placeholder*="Search"]');
    await input.fill('test');
    await expect(page.locator('button:has-text("Clear filters")')).toBeVisible();
  });

  test('pagination shows page numbers', async ({ page }) => {
    await page.goto('/sessions');
    const pageInfo = page.locator('.mono.muted:has-text("/")');
    await expect(pageInfo).toBeVisible();
  });
});

// ============================================================
// Overview chart & period selector
// ============================================================
test.describe('Overview chart & period', () => {
  test('shows activity trend chart', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('text=Activity trend')).toBeVisible();
  });

  test('period selector is visible', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(500);
    const seg = page.locator('.page-head-actions .segmented');
    await expect(seg).toBeVisible();
  });

  test('period selector has 5 options', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(500);
    const buttons = page.locator('.page-head-actions .segmented button');
    await expect(buttons).toHaveCount(5);
  });

  test('clicking 30d updates URL', async ({ page }) => {
    await page.goto('/');
    await page.locator('.segmented button:has-text("30d")').click();
    await page.waitForTimeout(500);
    expect(page.url()).toContain('period=30d');
  });
});

// ============================================================
// Rules & Policy page
// ============================================================
test.describe('Rules & Policy page', () => {
  test('loads and shows page title', async ({ page }) => {
    await page.goto('/rules');
    const title = page.locator('.page-title');
    const text = await title.textContent();
    expect(text).toContain('Rules');
  });

  test('renders drilldown tiles', async ({ page }) => {
    await page.goto('/rules');
    const tiles = page.locator('.drill-tile');
    expect(await tiles.count()).toBeGreaterThanOrEqual(4);
  });

  test('shows tool error analysis', async ({ page }) => {
    await page.goto('/rules');
    const text = await page.locator('.page').textContent();
    expect(text).toContain('Error-prone tools');
  });
});

// ============================================================
// Risk & Quality page
// ============================================================
test.describe('Risk & Quality page', () => {
  test('loads and shows page title', async ({ page }) => {
    await page.goto('/risk');
    const title = page.locator('.page-title');
    const text = await title.textContent();
    expect(text).toContain('Risk');
  });

  test('renders KPI stat cards', async ({ page }) => {
    await page.goto('/risk');
    const cards = page.locator('.card.stat');
    expect(await cards.count()).toBeGreaterThanOrEqual(4);
  });

  test('shows risk sessions collapsible', async ({ page }) => {
    await page.goto('/risk');
    await expect(page.locator('text=Risk sessions')).toBeVisible();
  });
});

// ============================================================
// Collector page
// ============================================================
test.describe('Collector page', () => {
  test('loads and shows page title', async ({ page }) => {
    await page.goto('/collector');
    const title = page.locator('.page-title');
    const text = await title.textContent();
    expect(text).toContain('Collector');
  });

  test('shows data source status', async ({ page }) => {
    await page.goto('/collector');
    const text = await page.locator('.page').textContent();
    expect(text).toContain('.claude');
    expect(text).toContain('.codex');
  });

  test('shows collection runs', async ({ page }) => {
    await page.goto('/collector');
    const text = await page.locator('.page').textContent();
    expect(text).toContain('collect');
  });
});

// ============================================================
// Settings page
// ============================================================
test.describe('Settings page', () => {
  test('loads and shows page title', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('.page-title')).toContainText('Settings');
  });

  test('shows data sources section', async ({ page }) => {
    await page.goto('/settings');
    const text = await page.locator('.page').textContent();
    expect(text).toContain('.claude');
  });

  test('shows database info', async ({ page }) => {
    await page.goto('/settings');
    const text = await page.locator('.page').textContent();
    expect(text).toContain('sessions');
  });
});

// ============================================================
// Session detail timeline filter
// ============================================================
test.describe('Session detail timeline filter', () => {
  test('shows event type filter dropdown', async ({ page }) => {
    await page.goto(`/sessions/${SESSION_ID}`);
    const select = page.locator('.card-head select');
    await expect(select).toBeVisible();
  });

  test('filter dropdown has options', async ({ page }) => {
    await page.goto(`/sessions/${SESSION_ID}`);
    const options = page.locator('.card-head select option');
    expect(await options.count()).toBeGreaterThanOrEqual(3);
  });

  test('shows tool usage by category card', async ({ page }) => {
    await page.goto(`/sessions/${SESSION_ID}`);
    await expect(page.locator('text=Tool usage by category')).toBeVisible();
  });
});

// ============================================================
// Reports page
// ============================================================
test.describe('Reports page', () => {
  test('loads and shows page title', async ({ page }) => {
    await page.goto('/reports');
    await expect(page.locator('.page-title')).toContainText('Reports');
  });

  test('shows report template cards', async ({ page }) => {
    await page.goto('/reports');
    const cards = page.locator('.card');
    expect(await cards.count()).toBeGreaterThanOrEqual(4);
  });

  test('shows summary statistics', async ({ page }) => {
    await page.goto('/reports');
    const text = await page.locator('.page').textContent();
    expect(text).toContain('sessions');
  });
});

// ============================================================
// Models provider cards + local vs cloud
// ============================================================
test.describe('Models enhanced features', () => {
  test('shows provider cards', async ({ page }) => {
    await page.goto('/tokenomics?tab=models&period=all');
    const text = await page.locator('.page').textContent();
    expect(text).toMatch(/BYOK|Local/);
  });

  test('shows BYOK or Local mode badges', async ({ page }) => {
    await page.goto('/tokenomics?tab=models&period=all');
    const text = await page.locator('.page').textContent();
    expect(text).toMatch(/BYOK|Local/);
  });

  test('has tokbar elements', async ({ page }) => {
    await page.goto('/tokenomics?tab=models&period=all');
    const tokbars = page.locator('.tok-legend');
    expect(await tokbars.count()).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// Agents skills table
// ============================================================
test.describe('Agents skills table', () => {
  test('shows skills/tools table with kind badges', async ({ page }) => {
    await page.goto('/agents');
    const text = await page.locator('.page').textContent();
    expect(text).toContain('Skills');
  });

  test('shows tool kind labels', async ({ page }) => {
    await page.goto('/agents');
    const text = await page.locator('.page').textContent();
    expect(text).toMatch(/file|shell|agent|web|other/i);
  });
});

// === Dashboard enhancements ===

test.describe('Dashboard transparency strip', () => {
  test('shows live-dot indicator', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.live-dot').first()).toBeVisible();
  });

  test('shows collector status text', async ({ page }) => {
    await page.goto('/');
    const text = await page.locator('.page').textContent();
    expect(text).toContain('Collector');
  });
});

test.describe('Dashboard evidence map', () => {
  test('shows evidence map card', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('text=Evidence map')).toBeVisible();
  });

  test('shows risk signal', async ({ page }) => {
    await page.goto('/');
    const text = await page.locator('.page').textContent();
    expect(text).toContain('Risk');
  });
});

// === Sessions table routing + risk columns ===

test.describe('Sessions table enhancements', () => {
  test('shows routing column', async ({ page }) => {
    await page.goto('/sessions');
    await expect(page.locator('th:text("Routing")')).toBeVisible();
  });

  test('shows risk column', async ({ page }) => {
    await page.goto('/sessions');
    await expect(page.locator('th:text("Risk")')).toBeVisible();
  });

  test('shows routing values (Cloud/Local)', async ({ page }) => {
    await page.goto('/sessions');
    const text = await page.locator('table.tbl').textContent();
    expect(text).toMatch(/Cloud|Local/);
  });
});

// === Session detail enhancements ===

test.describe('Session detail enhancements', () => {
  test('shows agent icon tile', async ({ page }) => {
    await page.goto('/sessions');
    const firstLink = page.locator('table.tbl tbody tr a').first();
    await firstLink.click();
    await expect(page.locator('.agent-icon-tile')).toBeVisible();
  });

  test('shows status badge', async ({ page }) => {
    await page.goto('/sessions');
    const firstLink = page.locator('table.tbl tbody tr a').first();
    await firstLink.click();
    await expect(page.locator('[class^="st-"]').first()).toBeVisible();
  });

  test('shows skills used card', async ({ page }) => {
    await page.goto('/sessions');
    const firstLink = page.locator('table.tbl tbody tr a').first();
    await firstLink.click();
    await expect(page.locator('text=Skills used')).toBeVisible();
  });
});

// === Agents matrix ===

test.describe('Agent x Skill matrix', () => {
  test('shows matrix card', async ({ page }) => {
    await page.goto('/agents');
    await expect(page.locator('text=Agent × Skill matrix')).toBeVisible();
  });
});

// === Models mode badges ===

test.describe('Models mode badges', () => {
  test('shows mode badges on provider cards', async ({ page }) => {
    await page.goto('/tokenomics?tab=models&period=all');
    const text = await page.locator('.page').textContent();
    expect(text).toMatch(/BYOK|Local/);
  });
});

// === Rules prevented damage ===

test.describe('Rules prevented damage', () => {
  test('shows prevented damage card', async ({ page }) => {
    await page.goto('/rules');
    await expect(page.locator('text=Prevented damage')).toBeVisible();
  });

  test('shows drilldown tiles with stat values', async ({ page }) => {
    await page.goto('/rules');
    const tiles = page.locator('.drill-tile');
    expect(await tiles.count()).toBeGreaterThanOrEqual(6);
  });

  test('shows policy event log', async ({ page }) => {
    await page.goto('/rules');
    await expect(page.locator('text=Policy event log')).toBeVisible();
  });
});

// === Risk findings ===

test.describe('Risk findings', () => {
  test('shows findings by category', async ({ page }) => {
    await page.goto('/risk');
    await expect(page.locator('text=Findings by category')).toBeVisible();
  });

  test('shows open findings table', async ({ page }) => {
    await page.goto('/risk');
    await expect(page.locator('text=Open findings')).toBeVisible();
  });
});

// === Reports builder ===

test.describe('Reports builder preview', () => {
  test('shows audience badges', async ({ page }) => {
    await page.goto('/reports');
    const text = await page.locator('.page').textContent();
    expect(text).toMatch(/CTO|CFO|Security|Engineering/);
  });

  test('shows report builder panel', async ({ page }) => {
    await page.goto('/reports');
    await expect(page.locator('text=Methodology')).toBeVisible();
  });
});

// === Collector enhancements ===

test.describe('Collector enhancements', () => {
  test('shows live indicator', async ({ page }) => {
    await page.goto('/collector');
    await expect(page.locator('.live-dot')).toBeVisible();
  });

  test('shows doctor card', async ({ page }) => {
    await page.goto('/collector');
    await expect(page.locator('.card-title:has-text("Doctor")')).toBeVisible();
  });

  test('shows capture mode selector', async ({ page }) => {
    await page.goto('/collector');
    await expect(page.locator('text=Capture mode')).toBeVisible();
  });

  test('shows install steps', async ({ page }) => {
    await page.goto('/collector');
    await expect(page.locator('.card-title:has-text("Install")')).toBeVisible();
  });

  test('shows what is captured', async ({ page }) => {
    await page.goto('/collector');
    await expect(page.locator('text=What is captured')).toBeVisible();
  });

  test('shows data controls', async ({ page }) => {
    await page.goto('/collector');
    await expect(page.locator('text=Local data controls')).toBeVisible();
  });
});

// === Settings enhancements ===

test.describe('Settings enhancements', () => {
  test('shows settings nav with Data Sources section', async ({ page }) => {
    await page.goto('/settings');
    // SettingsNav uses buttons, not anchor links
    await expect(page.locator('button:has-text("Data Sources")')).toBeVisible();
  });

  test('shows display settings', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('.card-title:has-text("Display")')).toBeVisible();
  });

  test('shows collection settings', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('.card-title:has-text("Collection")').first()).toBeVisible();
  });

  test('shows Organization section', async ({ page }) => {
    await page.goto('/settings');
    const text = await page.locator('.page').textContent();
    expect(text).toContain('Organization');
  });
});

// ============================================================
// API route status codes
// ============================================================
test.describe('API routes', () => {
  test('POST /api/settings returns 200 with valid body', async ({ request }) => {
    const res = await request.post('/api/settings', {
      data: { theme: 'dark' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('POST /api/settings accepts allowed keys only', async ({ request }) => {
    const res = await request.post('/api/settings', {
      data: { theme: 'light', default_period: '30d', collection_interval: 10 },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});

// ============================================================
// Stolen from Codex: Command Palette, Pull Requests, Redaction Tester
// ============================================================
test.describe('Command palette', () => {
  test('palette opens and shows navigation items', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
    await page.evaluate(() => (window as any).__openCommandPalette?.());
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible({ timeout: 3000 });
  });

  test('palette filters results by search query', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
    await page.evaluate(() => (window as any).__openCommandPalette?.());
    const input = page.getByRole('dialog', { name: 'Command palette' }).locator('input');
    await input.fill('risk');
    await expect(page.getByRole('dialog', { name: 'Command palette' }).getByText('Risk & Policy').first()).toBeVisible();
  });

  test('palette closes on Escape', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
    await page.evaluate(() => (window as any).__openCommandPalette?.());
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible({ timeout: 3000 });
    // Focus the input inside the dialog first so keyboard events are handled
    await dialog.locator('input').focus();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible({ timeout: 3000 });
  });
});

test.describe('Pull Requests page', () => {
  test('renders pull requests page with title', async ({ page }) => {
    await page.goto('/pull-requests');
    await expect(page.locator('.page-title:has-text("Pull Requests")')).toBeVisible();
  });

  test('shows KPI strip with PR stats', async ({ page }) => {
    await page.goto('/pull-requests');
    // Uses DrilldownTiles with labels: PRs detected, Push sessions, Branches, Repositories
    await expect(page.locator('text=PRs detected')).toBeVisible();
    await expect(page.locator('text=Push sessions')).toBeVisible();
    await expect(page.locator('.drill-label:has-text("Branches")')).toBeVisible();
    await expect(page.locator('.drill-label:has-text("Repositories")')).toBeVisible();
  });

  test('shows evidence breakdown card', async ({ page }) => {
    await page.goto('/pull-requests');
    await expect(page.locator('text=Evidence breakdown')).toBeVisible();
  });

  test('sidebar has Pull Requests nav item', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.nav-item:has-text("Pull Requests")')).toBeVisible();
  });
});

test.describe('Redaction tester', () => {
  test('collector page has redaction tester card', async ({ page }) => {
    await page.goto('/collector');
    // Redaction tester is at the bottom; scroll to make sure it's loaded
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
    await expect(page.locator('text=Redaction tester')).toBeVisible();
  });

  test('redaction tester processes text', async ({ page }) => {
    await page.goto('/collector');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
    const textarea = page.locator('textarea').last();
    await textarea.fill('sk-test-secret-value and dev@example.com');
    await page.getByRole('button', { name: 'Test redaction' }).click();
    await expect(page.getByText('[REDACTED:api-key]')).toBeVisible();
    await expect(page.getByText('[REDACTED:email]')).toBeVisible();
  });

  test('redaction tester clear button works', async ({ page }) => {
    await page.goto('/collector');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
    const textarea = page.locator('textarea').last();
    await textarea.fill('test value');
    await page.locator('button:has-text("Clear")').last().click();
    await page.waitForTimeout(200);
    await expect(textarea).toHaveValue('');
  });
});
