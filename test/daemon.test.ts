import { describe, it, expect } from 'vitest';
import { startDaemon } from '../src/daemon.js';
import { defaultConfig } from '../src/config.js';
import { generatePrivateKey } from 'viem/accounts';

describe('startDaemon guard', () => {
  it('refuses to start with no targets configured', async () => {
    const config = defaultConfig();
    config.targets = [];
    await expect(startDaemon(config, generatePrivateKey())).rejects.toThrow(/no targets/);
  });
});
