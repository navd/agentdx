import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = '/Users/navdeepsharma/Documents/code/agentsdx';
const BIN = `node --import tsx ${join(ROOT, 'bin/agentdx.mjs')}`;

function run(cmd: string): string {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf-8', timeout: 120000 });
}

function getPkg(): Record<string, any> {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
}

// ============================================================
// Build verification tests
// ============================================================
test.describe('Build verification', () => {
  test('tsc compiles without errors', () => {
    // npx tsc --noEmit should exit 0 if there are no type errors
    const out = run('npx tsc --noEmit 2>&1');
    // If tsc produces errors it will throw (non-zero exit code)
    // If we reach here, compilation succeeded
    expect(true).toBe(true);
  });

  test('package.json has required fields', () => {
    const pkg = getPkg();
    expect(pkg.name).toBe('agentdx');
    expect(pkg.version).toBeDefined();
    expect(typeof pkg.version).toBe('string');
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);

    expect(pkg.bin).toBeDefined();
    expect(pkg.bin.agentdx).toBe('./bin/agentdx.mjs');

    expect(pkg.files).toBeDefined();
    expect(Array.isArray(pkg.files)).toBe(true);
    expect(pkg.files.length).toBeGreaterThan(0);
  });

  test('bin/agentdx.mjs is syntactically valid', () => {
    // node --check validates syntax without executing
    run(`node --check ${join(ROOT, 'bin/agentdx.mjs')}`);
    // If we reach here, the file has valid syntax
    expect(true).toBe(true);
  });

  test('--version returns correct version from package.json', () => {
    const pkg = getPkg();
    const out = run(`${BIN} --version`);
    expect(out.trim()).toBe(pkg.version);
  });

  test('--help includes all commands', () => {
    const out = run(`${BIN} --help`);
    const expectedCommands = ['collect', 'serve', 'status', 'watch', 'telemetry', 'org'];
    for (const cmd of expectedCommands) {
      expect(out, `--help should mention "${cmd}" command`).toContain(cmd);
    }
  });
});
