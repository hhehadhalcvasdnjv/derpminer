import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hex } from 'viem';
import { ShiftEngine, type ShiftEngineDeps, type ChainClock, type ShiftSubmitter } from '../src/core/shiftEngine.js';
import type { Mine, ShiftState } from '../src/mines/mine.js';
import { StateStore } from '../src/core/state.js';

const SEED1 = ('0x' + '11'.repeat(32)) as Hex;
const SEED2 = ('0x' + '22'.repeat(32)) as Hex;
const PREV = ('0x' + 'ab'.repeat(32)) as Hex;

function shift(partial: Partial<ShiftState>): ShiftState {
  return {
    worker: '0x000000000000000000000000000000000000dEaD',
    startTime: 1000n,
    tickBudget: 0n,
    voided: false,
    expired: false,
    grindSeed: SEED1,
    tickerExpired: false,
    expiryTickerCount: 0n,
    printsRemaining: 100n,
    empty: false,
    ...partial,
  };
}

const EMPTY = shift({ empty: true, worker: '0x0000000000000000000000000000000000000000', grindSeed: ('0x' + '00'.repeat(32)) as Hex });

interface FakeMineOpts {
  shiftScript: ShiftState[];
  anchorScript?: Array<{ certifiedAnchor: bigint; orphaned: boolean }>;
}

function fakeMine(opts: FakeMineOpts): { mine: Mine; shiftCalls: number } {
  const box = { shiftCalls: 0, anchorCalls: 0 };
  const mine = {
    address: '0x6FeD5aE5d486A59081FDC040179CEBDA4be80511' as Hex,
    maxTicksPerSecond: async () => 20000n,
    graceSeconds: async () => 150n,
    slotProofHash: async () => PREV,
    shiftOf: async () => {
      const i = Math.min(box.shiftCalls, opts.shiftScript.length - 1);
      box.shiftCalls++;
      return opts.shiftScript[i];
    },
    shiftAnchor: async () => {
      const script = opts.anchorScript ?? [{ certifiedAnchor: 0n, orphaned: false }];
      const i = Math.min(box.anchorCalls, script.length - 1);
      box.anchorCalls++;
      return script[i];
    },
  } as unknown as Mine;
  return { mine, get shiftCalls() { return box.shiftCalls; } };
}

function fakeClock(): ChainClock {
  let now = 1000n;
  return {
    chainNow: async () => now,
    sleepUntilChain: async (target) => {
      if (target > now) now = target; // jump the fake clock forward instantly
    },
  };
}

function fakeSubmitter(events: string[], reward = 44n * 10n ** 18n): ShiftSubmitter & { clockOuts: bigint[] } {
  const clockOuts: bigint[] = [];
  return {
    clockOuts,
    clockIn: async () => {
      events.push('submit:clockIn');
    },
    clockOut: async (_t, _s, ticks) => {
      clockOuts.push(ticks);
      return { reward };
    },
  };
}

function tmpState(): StateStore {
  return new StateStore(join(mkdtempSync(join(tmpdir(), 'derp-')), 'state.json'));
}

function baseDeps(mine: Mine, events: string[], sub: ShiftSubmitter, extra?: Partial<ShiftEngineDeps>): ShiftEngineDeps {
  return {
    mine,
    submitter: sub,
    grind: async () => ({ ticks: 13786224n, hash: ('0x' + '00'.repeat(29) + '5d3129') as Hex }),
    clock: fakeClock(),
    state: tmpState(),
    preBufferSeconds: 3n,
    ...extra,
  };
}

function recordPhases(eng: ShiftEngine, events: string[]): void {
  for (const ev of ['clockIn', 'grind', 'wait', 'clockOut', 'reclock:free', 'printed']) {
    eng.on(ev, () => events.push(ev));
  }
}

describe('ShiftEngine happy path', () => {
  it('clocks in, grinds, waits, then clocks out in order', async () => {
    const events: string[] = [];
    const { mine } = fakeMine({
      shiftScript: [EMPTY, shift({ grindSeed: SEED1 }), shift({ grindSeed: SEED1 })],
    });
    const sub = fakeSubmitter(events);
    const eng = new ShiftEngine('pitboys', 742n, 3n, baseDeps(mine, events, sub));
    recordPhases(eng, events);
    const { reward } = await eng.runCycle();

    expect(events).toEqual(['clockIn', 'submit:clockIn', 'grind', 'wait', 'clockOut', 'printed']);
    expect(sub.clockOuts).toEqual([13786224n]);
    expect(reward).toBe(44n * 10n ** 18n);
  });

  it('resumes a healthy live shift without clocking in', async () => {
    const events: string[] = [];
    const { mine } = fakeMine({ shiftScript: [shift({ grindSeed: SEED1 }), shift({ grindSeed: SEED1 })] });
    const sub = fakeSubmitter(events);
    const eng = new ShiftEngine('pitboys', 742n, 3n, baseDeps(mine, events, sub));
    recordPhases(eng, events);
    await eng.runCycle();
    expect(events).toEqual(['grind', 'wait', 'clockOut', 'printed']); // no clockIn
  });
});

describe('ShiftEngine stale handling', () => {
  it('free re-clocks a ticker-stale shift, then clocks out the fresh one', async () => {
    const events: string[] = [];
    const { mine } = fakeMine({
      shiftScript: [
        EMPTY, // prepare #1 -> clockIn
        shift({ grindSeed: SEED1 }), // after clockIn: healthy S1
        shift({ tickerExpired: true, grindSeed: SEED1 }), // pre-submit check: stale
        shift({ tickerExpired: true, grindSeed: SEED1 }), // prepare #2 sees dead -> clockIn
        shift({ grindSeed: SEED2 }), // after re-clock: healthy S2
        shift({ grindSeed: SEED2 }), // pre-submit: healthy
      ],
    });
    const sub = fakeSubmitter(events);
    const eng = new ShiftEngine('pitboys', 742n, 3n, baseDeps(mine, events, sub));
    recordPhases(eng, events);
    await eng.runCycle();

    expect(events).toContain('reclock:free');
    expect(events.filter((e) => e === 'clockIn')).toHaveLength(2); // initial + re-clock
    expect(events[events.length - 1]).toBe('printed');
    expect(sub.clockOuts).toEqual([13786224n]); // clocked out exactly once, on the fresh shift
  });

  it('detects a changed grind seed as a stale signal', async () => {
    const events: string[] = [];
    const { mine } = fakeMine({
      shiftScript: [
        shift({ grindSeed: SEED1 }), // resume healthy S1
        shift({ grindSeed: SEED2 }), // pre-submit: seed changed under us -> re-clock
        shift({ grindSeed: SEED2 }), // prepare #2: healthy S2 (not dead) -> resume
        shift({ grindSeed: SEED2 }), // pre-submit: healthy S2
      ],
    });
    const sub = fakeSubmitter(events);
    const eng = new ShiftEngine('pitboys', 742n, 3n, baseDeps(mine, events, sub));
    recordPhases(eng, events);
    await eng.runCycle();
    expect(events).toContain('reclock:free');
    expect(sub.clockOuts).toEqual([13786224n]);
  });
});

describe('ShiftEngine orphan tip-chase', () => {
  it('force re-clocks an orphaned shift when chaseTip is on', async () => {
    const events: string[] = [];
    const { mine } = fakeMine({
      shiftScript: [
        shift({ grindSeed: SEED1 }), // resume healthy S1
        shift({ grindSeed: SEED1 }), // pre-submit: healthy, same seed
        shift({ grindSeed: SEED1 }), // prepare #2 (forced): still shows old shift
        shift({ grindSeed: SEED2 }), // after forced clockIn: healthy S2
        shift({ grindSeed: SEED2 }), // pre-submit: healthy S2
      ],
      anchorScript: [
        { certifiedAnchor: 5n, orphaned: true }, // first check: orphaned -> chase
        { certifiedAnchor: 9n, orphaned: false }, // after re-clock: fresh tip
      ],
    });
    const sub = fakeSubmitter(events);
    const eng = new ShiftEngine('pitboys', 742n, 3n, baseDeps(mine, events, sub, { chaseTip: true }));
    recordPhases(eng, events);
    await eng.runCycle();

    expect(events).toContain('reclock:free');
    expect(events.filter((e) => e === 'clockIn')).toHaveLength(1); // the forced re-clock
    expect(sub.clockOuts).toEqual([13786224n]);
  });

  it('does not chase orphans when chaseTip is off', async () => {
    const events: string[] = [];
    const { mine } = fakeMine({
      shiftScript: [shift({ grindSeed: SEED1 }), shift({ grindSeed: SEED1 })],
      anchorScript: [{ certifiedAnchor: 5n, orphaned: true }],
    });
    const sub = fakeSubmitter(events);
    const eng = new ShiftEngine('pitboys', 742n, 3n, baseDeps(mine, events, sub, { chaseTip: false }));
    recordPhases(eng, events);
    await eng.runCycle();
    expect(events).not.toContain('reclock:free');
    expect(sub.clockOuts).toEqual([13786224n]); // clocked out despite orphan (still pays)
  });
});
