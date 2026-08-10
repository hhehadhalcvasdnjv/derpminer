import { describe, it, expect, vi } from 'vitest';
import type { PublicClient } from 'viem';
import { PoolChainClock, Wake } from '../src/core/chainClock.js';

/** A fake pool whose block timestamp advances by `stepSec` on each read. */
function advancingReader(startSec: bigint, stepSec: bigint) {
  let t = startSec;
  const read = <T>(fn: (c: PublicClient) => Promise<T>): Promise<T> => {
    const client = {
      getBlock: async () => {
        const cur = t;
        t += stepSec;
        return { timestamp: cur };
      },
    } as unknown as PublicClient;
    return fn(client);
  };
  return { read };
}

describe('PoolChainClock', () => {
  it('reads chain time from the latest block', async () => {
    const clock = new PoolChainClock({ read: advancingReader(1000n, 0n).read, sleep: async () => {} });
    expect(await clock.chainNow()).toBe(1000n);
  });

  it('returns immediately when the target is already past', async () => {
    const sleep = vi.fn(async () => {});
    const clock = new PoolChainClock({ read: advancingReader(2000n, 0n).read, sleep });
    await clock.sleepUntilChain(1000n);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('naps until chain time reaches the target', async () => {
    const sleep = vi.fn(async () => {});
    // Chain time starts at 1000 and advances 5s per read.
    const clock = new PoolChainClock({ read: advancingReader(1000n, 5n).read, sleep, recheckMs: 1000 });
    await clock.sleepUntilChain(1012n); // needs a few reads to get there
    expect(sleep).toHaveBeenCalled();
  });

  it('wakes early when the signal fires', async () => {
    const wake = new Wake();
    let sleeps = 0;
    const clock = new PoolChainClock({
      read: advancingReader(1000n, 0n).read, // never reaches a far target
      sleep: async () => {
        sleeps++;
        if (sleeps === 2) wake.fire(); // fire mid-wait
      },
      recheckMs: 10,
    });
    await clock.sleepUntilChain(9_999_999n, wake); // far future; only the wake ends it
    expect(sleeps).toBeGreaterThanOrEqual(2);
  });
});

describe('Wake', () => {
  it('invokes callbacks registered before firing', () => {
    const wake = new Wake();
    let fired = false;
    wake.onWake(() => (fired = true));
    wake.fire();
    expect(fired).toBe(true);
    expect(wake.woken).toBe(true);
  });

  it('invokes a callback registered after firing immediately', () => {
    const wake = new Wake();
    wake.fire();
    let fired = false;
    wake.onWake(() => (fired = true));
    expect(fired).toBe(true);
  });
});
