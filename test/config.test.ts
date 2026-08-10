import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig, defaultConfig, configHome } from '../src/config.js';
import { OFFICIAL_RPC } from '../src/chain/registry.js';

let home: string;
const prev = process.env.DERPMINER_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'derp-cfg-'));
  process.env.DERPMINER_HOME = home;
});

afterEach(() => {
  if (prev === undefined) delete process.env.DERPMINER_HOME;
  else process.env.DERPMINER_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

describe('config', () => {
  it('defaults to the official RPC, shadow mode, and pitboys-ready empty targets', () => {
    const c = defaultConfig();
    expect(c.rpcUrls).toContain(OFFICIAL_RPC);
    expect(c.walletMode).toBe('shadow');
    expect(c.targets).toEqual([]);
    expect(c.chaseTip).toBe(false);
  });

  it('returns defaults when no config file exists', () => {
    expect(loadConfig().walletMode).toBe('shadow');
  });

  it('round-trips a saved config', () => {
    const c = defaultConfig();
    c.rpcUrls = [OFFICIAL_RPC, 'https://my.alchemy.example/v2/key'];
    c.targets = [{ mine: 'pitboys', tokenId: '742', slots: [0, 3, 7] }];
    c.chaseTip = true;
    saveConfig(c);

    const loaded = loadConfig();
    expect(loaded.rpcUrls).toHaveLength(2);
    expect(loaded.targets[0]).toEqual({ mine: 'pitboys', tokenId: '742', slots: [0, 3, 7] });
    expect(loaded.chaseTip).toBe(true);
  });

  it('honors DERPMINER_HOME for the config location', () => {
    expect(configHome()).toBe(home);
  });

  it('fills missing fields from defaults on load (forward-compatible)', () => {
    saveConfig({ ...defaultConfig(), pollMs: 5000 });
    const loaded = loadConfig();
    expect(loaded.pollMs).toBe(5000);
    expect(loaded.preBufferSeconds).toBe(3); // from defaults
  });
});
