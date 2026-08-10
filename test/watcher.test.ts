import { describe, it, expect } from 'vitest';
import { Watcher } from '../src/core/watcher.js';
import type { Mine } from '../src/mines/mine.js';

function scriptedMine(snaps: Array<{ t: bigint; c: bigint; i: bigint }>): Mine {
  let n = 0;
  const cur = () => snaps[Math.min(n, snaps.length - 1)];
  return {
    tickerCount: async () => cur().t,
    certifiedCount: async () => cur().c,
    theIndex: async () => {
      const v = cur().i;
      n++; // advance after the last read of a snapshot
      return v;
    },
  } as unknown as Mine;
}

describe('Watcher', () => {
  it('emits ticker and certified when counts rise', async () => {
    const mine = scriptedMine([
      { t: 100n, c: 10n, i: 90n },
      { t: 101n, c: 10n, i: 90n }, // ticker rose
      { t: 101n, c: 11n, i: 90n }, // certified rose
    ]);
    const w = new Watcher({ mine });
    const events: string[] = [];
    w.on('ticker', () => events.push('ticker'));
    w.on('certified', () => events.push('certified'));

    await w.pollOnce(); // baseline
    await w.pollOnce(); // ticker rose
    await w.pollOnce(); // certified rose
    expect(events).toEqual(['ticker', 'certified']);
  });

  it('emits index when the emission Index changes', async () => {
    const mine = scriptedMine([
      { t: 1n, c: 1n, i: 90n },
      { t: 1n, c: 1n, i: 60n },
    ]);
    const w = new Watcher({ mine });
    let indexChanged = false;
    w.on('index', () => (indexChanged = true));
    await w.pollOnce();
    await w.pollOnce();
    expect(indexChanged).toBe(true);
  });

  it('exposes the latest snapshot', async () => {
    const mine = scriptedMine([{ t: 5n, c: 2n, i: 42n }]);
    const w = new Watcher({ mine });
    await w.pollOnce();
    expect(w.snapshot()).toEqual({ tickerCount: 5n, certifiedCount: 2n, index: 42n });
  });
});
