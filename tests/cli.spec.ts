import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';

const ROOT = '/Users/navdeepsharma/Documents/code/agentsdx';
const BIN = `node --import tsx ${join(ROOT, 'bin/agentdx.mjs')}`;
const DB_PATH = join(ROOT, 'data', 'agentdx.db');

function run(cmd: string): string {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf-8', timeout: 60000 });
}

test.describe('CLI: agentdx', () => {
  test('--version returns 0.1.0', () => {
    const out = run(`${BIN} --version`);
    expect(out.trim()).toBe('0.1.0');
  });

  test('--help lists commands', () => {
    const out = run(`${BIN} --help`);
    expect(out).toContain('collect');
    expect(out).toContain('serve');
    expect(out).toContain('status');
  });

  test('collect --help shows options including codex-dir', () => {
    const out = run(`${BIN} collect --help`);
    expect(out).toContain('--claude-dir');
    expect(out).toContain('--codex-dir');
    expect(out).toContain('--db');
  });

  test('status shows database info', () => {
    const out = run(`${BIN} status`);
    expect(out).toContain('Sessions:');
    expect(out).toContain('Messages:');
    expect(out).toContain('Tool calls:');
    expect(out).toContain('Repos:');
    expect(out).toContain('Models:');
  });

  test('status with missing DB shows warning', () => {
    const out = run(`${BIN} status --db /nonexistent/path.db`);
    expect(out).toContain('No database found');
  });

  test('collect with bad claude dir shows zero sessions for those sources', () => {
    const out = run(`${BIN} collect --claude-dir /nonexistent --codex-dir /nonexistent`);
    // Even with bad dirs, the collector runs (it may find other sources like cursor/aider/cline)
    // but the claude-code and codex sources should produce 0 sessions
    expect(out).toContain('0 sessions');
  });

  test('collect populates DB with real sessions', () => {
    const out = run(`${BIN} collect`);
    expect(out).toContain('claude-code');
    expect(out).toMatch(/\d+ sessions/);
    expect(out).toMatch(/\d+ messages/);
    expect(out).toMatch(/\d+ tool calls/);
  });

  test('collect includes codex source', () => {
    const out = run(`${BIN} collect`);
    expect(out).toContain('codex');
  });

  test('incremental collect processes fewer sessions', () => {
    run(`${BIN} collect`);
    const out = run(`${BIN} collect`);
    expect(out).toContain('claude-code');
    const match = out.match(/(\d+) sessions/);
    expect(match).toBeTruthy();
    const count = parseInt(match![1]);
    expect(count).toBeLessThanOrEqual(5);
  });

  test('status after collect shows non-zero counts', () => {
    const out = run(`${BIN} status`);
    const sessMatch = out.match(/Sessions:\s+(\d+)/);
    expect(sessMatch).toBeTruthy();
    expect(parseInt(sessMatch![1])).toBeGreaterThan(0);

    const msgMatch = out.match(/Messages:\s+(\d+)/);
    expect(parseInt(msgMatch![1])).toBeGreaterThan(0);
  });

  test('status shows gpt-5.5 from codex', () => {
    const out = run(`${BIN} status`);
    expect(out).toContain('gpt-5.5');
  });

  test('collect to custom DB path works', () => {
    const tmpDb = join(ROOT, 'data', 'test-custom.db');
    try {
      const out = run(`${BIN} collect --db ${tmpDb}`);
      expect(out).toContain('claude-code');
      expect(existsSync(tmpDb)).toBe(true);

      const statusOut = run(`${BIN} status --db ${tmpDb}`);
      expect(statusOut).toContain('Sessions:');
    } finally {
      if (existsSync(tmpDb)) unlinkSync(tmpDb);
    }
  });
});
