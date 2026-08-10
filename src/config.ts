import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import type { MineKey } from './chain/registry.js';
import { OFFICIAL_RPC } from './chain/registry.js';

export type WalletMode = 'shadow' | 'direct';

export interface TargetConfig {
  mine: MineKey;
  /** Token id as a decimal string (JSON-safe). */
  tokenId: string;
  /** Slots to mine on this token (0-15). */
  slots: number[];
}

export interface Config {
  version: 1;
  rpcUrls: string[];
  walletMode: WalletMode;
  /** Path to the encrypted hot-key keystore. */
  keystorePath: string;
  targets: TargetConfig[];
  /** Free re-clock to chase the certified tip when orphaned. */
  chaseTip: boolean;
  /** Inclusion buffer past the earliest legal submit second. */
  preBufferSeconds: number;
  /** Watcher/receipt poll interval in ms. */
  pollMs: number;
  /** Optional webhook for print/alert notifications. */
  webhookUrl?: string;
}

/** The config home, overridable via DERPMINER_HOME (used heavily in tests). */
export function configHome(): string {
  return process.env.DERPMINER_HOME ?? join(homedir(), '.derpminer');
}

export function configPath(): string {
  return join(configHome(), 'config.json');
}

export function statePath(): string {
  return join(configHome(), 'state.json');
}

export function defaultConfig(): Config {
  return {
    version: 1,
    rpcUrls: [OFFICIAL_RPC],
    walletMode: 'shadow',
    keystorePath: join(configHome(), 'keystore.json'),
    targets: [],
    chaseTip: false,
    preBufferSeconds: 3,
    pollMs: 3000,
  };
}

export function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) return defaultConfig();
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Config;
  if (raw.version !== 1) throw new Error(`unknown config version ${raw.version}`);
  return { ...defaultConfig(), ...raw };
}

export function saveConfig(config: Config): void {
  const path = configPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
}
