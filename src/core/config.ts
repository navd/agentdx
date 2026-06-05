import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';

export interface Config {
  claudeDir: string;
  codexDir: string;
  dbPath: string;
  port: number;
}

export interface UserConfig {
  notice_shown?: boolean;
  theme?: 'system' | 'dark' | 'light';
  default_period?: '7d' | '30d' | '90d' | 'all';
  collection_interval?: number;
  auto_collect?: boolean;
}

const USER_CONFIG_DIR = join(homedir(), '.agentdx');
const USER_CONFIG_PATH = join(USER_CONFIG_DIR, 'config.json');

export function getUserConfig(): UserConfig {
  try {
    if (existsSync(USER_CONFIG_PATH)) {
      return JSON.parse(readFileSync(USER_CONFIG_PATH, 'utf8'));
    }
  } catch {
    // corrupted config, treat as default
  }
  return {};
}

export function setUserConfig(updates: Partial<UserConfig>): void {
  if (!existsSync(USER_CONFIG_DIR)) {
    mkdirSync(USER_CONFIG_DIR, { recursive: true });
  }
  const current = getUserConfig();
  const merged = { ...current, ...updates };

  // Remove keys explicitly set to null or undefined
  for (const key of Object.keys(updates) as Array<keyof UserConfig>) {
    if (updates[key] === null || updates[key] === undefined) {
      delete merged[key];
    }
  }

  writeFileSync(USER_CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
}

export function resolveConfig(overrides: Partial<Config> = {}): Config {
  const home = homedir();
  const claudeDir = overrides.claudeDir ?? join(home, '.claude');
  const codexDir = overrides.codexDir ?? join(home, '.codex');
  const dbPath = overrides.dbPath ?? join(process.cwd(), 'data', 'agentdx.db');
  const port = overrides.port ?? 3001;

  return { claudeDir, codexDir, dbPath, port };
}

export function checkSources(config: Config): { claude: boolean; codex: boolean; cursor: boolean } {
  const home = homedir();
  return {
    claude: existsSync(join(config.claudeDir, 'projects')),
    codex: existsSync(config.codexDir),
    cursor: existsSync(join(home, '.cursor', 'projects')),
  };
}
