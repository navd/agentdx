import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const ROOT = '/Users/navdeepsharma/Documents/code/agentsdx';

/**
 * Run a TypeScript snippet that imports from src/core/config.ts using tsx,
 * with HOME overridden so getUserConfig/setUserConfig use a temp directory.
 */
function runConfigScript(tmpHome: string, script: string): string {
  // Write the script to a temp file so we can run it with tsx
  const scriptPath = join(tmpHome, '_test_script.ts');
  writeFileSync(scriptPath, script, 'utf-8');
  return execSync(`node --import tsx ${scriptPath}`, {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env, HOME: tmpHome },
  });
}

// ============================================================
// Config system tests
// ============================================================
test.describe('Config system', () => {
  let tmpHome: string;

  test.beforeEach(() => {
    // Create a unique temp directory for each test so they don't interfere
    tmpHome = join(tmpdir(), `agentdx-test-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpHome, { recursive: true });
  });

  test.afterEach(() => {
    // Clean up temp directory
    if (tmpHome && existsSync(tmpHome)) {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('getUserConfig returns empty object for new install', () => {
    const out = runConfigScript(tmpHome, `
      import { getUserConfig } from '${ROOT}/src/core/config.js';
      const cfg = getUserConfig();
      console.log(JSON.stringify(cfg));
    `);
    const result = JSON.parse(out.trim());
    expect(result).toEqual({});
  });

  test('setUserConfig writes and reads back correctly', () => {
    const out = runConfigScript(tmpHome, `
      import { getUserConfig, setUserConfig } from '${ROOT}/src/core/config.js';
      setUserConfig({ theme: 'dark', auto_collect: true });
      const cfg = getUserConfig();
      console.log(JSON.stringify(cfg));
    `);
    const result = JSON.parse(out.trim());
    expect(result.theme).toBe('dark');
    expect(result.auto_collect).toBe(true);
  });

  test('setUserConfig with null value removes the key', () => {
    const out = runConfigScript(tmpHome, `
      import { getUserConfig, setUserConfig } from '${ROOT}/src/core/config.js';
      setUserConfig({ theme: 'dark', default_period: '30d' });
      // Now remove 'theme' by setting it to null
      setUserConfig({ theme: null } as any);
      const cfg = getUserConfig();
      console.log(JSON.stringify(cfg));
    `);
    const result = JSON.parse(out.trim());
    expect(result.theme).toBeUndefined();
    expect(result.default_period).toBe('30d');
  });

  test('org config roundtrip: set org, read org, remove org', () => {
    const out = runConfigScript(tmpHome, `
      import { getUserConfig, setUserConfig } from '${ROOT}/src/core/config.js';

      // Set org
      setUserConfig({
        org: {
          id: 'test-org-id',
          slug: 'test-org',
          name: 'Test Organization',
          member_token: 'tok_test_123',
          joined_at: 1700000000000,
        },
      });
      const cfg1 = getUserConfig();
      const step1 = { hasOrg: !!cfg1.org, name: cfg1.org?.name, slug: cfg1.org?.slug };

      // Remove org (set to undefined — same as leaveOrg does)
      setUserConfig({ org: undefined } as any);
      const cfg2 = getUserConfig();
      const step2 = { hasOrg: !!cfg2.org };

      console.log(JSON.stringify({ step1, step2 }));
    `);
    const result = JSON.parse(out.trim());
    expect(result.step1.hasOrg).toBe(true);
    expect(result.step1.name).toBe('Test Organization');
    expect(result.step1.slug).toBe('test-org');
    expect(result.step2.hasOrg).toBe(false);
  });
});
