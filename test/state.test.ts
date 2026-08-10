import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/core/state.js';

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'derp-')), 'state.json');
}

describe('StateStore', () => {
  it('round-trips slot state with bigints across reload', async () => {
    const path = tmpFile();
    const s = new StateStore(path);
    await s.upsertSlot('pitboys', 742n, 3n, { phase: 'GRINDING', ticks: 13786224n, startTime: 1786361207n });

    const again = new StateStore(path);
    await again.load();
    const rec = again.getSlot('pitboys', 742n, 3n);
    expect(rec?.phase).toBe('GRINDING');
    expect(rec?.ticks).toBe(13786224n);
    expect(rec?.startTime).toBe(1786361207n);
  });

  it('merges patches instead of overwriting the record', async () => {
    const path = tmpFile();
    const s = new StateStore(path);
    await s.upsertSlot('broker', 1n, 0n, { phase: 'GRINDING', ticks: 100n });
    await s.upsertSlot('broker', 1n, 0n, { phase: 'PRINTED', lastReward: 44n * 10n ** 18n });
    const rec = s.getSlot('broker', 1n, 0n);
    expect(rec?.phase).toBe('PRINTED');
    expect(rec?.ticks).toBe(100n); // preserved from first patch
    expect(rec?.lastReward).toBe(44n * 10n ** 18n);
  });

  it('serializes bigints in a tagged, machine-readable form', async () => {
    const path = tmpFile();
    const s = new StateStore(path);
    await s.upsertSlot('pitboys', 9n, 1n, { phase: 'WAITING', ticks: 5n });
    const raw = readFileSync(path, 'utf8');
    expect(raw).toContain('$bigint');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('returns undefined for an unknown slot', () => {
    const s = new StateStore(tmpFile());
    expect(s.getSlot('pitboys', 1n, 1n)).toBeUndefined();
  });
});
