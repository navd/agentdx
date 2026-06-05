import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface UserConfig {
  theme?: 'system' | 'dark' | 'light';
  default_period?: '30d' | '90d' | 'qtd' | 'ytd' | 'all';
  page_size?: number;
  collection_interval?: number;
  auto_collect?: boolean;
}

const CONFIG_PATH = join(homedir(), '.agentdx', 'config.json');

const DEFAULTS: Required<UserConfig> = {
  theme: 'system',
  default_period: 'all',
  page_size: 25,
  collection_interval: 5,
  auto_collect: false,
};

/** Read the user config from ~/.agentdx/config.json, merged over defaults. */
export function readUserConfig(): UserConfig & typeof DEFAULTS {
  let raw: UserConfig = {};
  try {
    if (existsSync(CONFIG_PATH)) {
      raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch {
    // corrupt config → defaults
  }
  return { ...DEFAULTS, ...raw };
}
