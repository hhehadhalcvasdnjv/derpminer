import { describe, it, expect } from 'vitest';
import type { Hex } from 'viem';
import { quoteSlot, rewardAt, expectedReward, type RewardParams } from '../src/economics.js';
import type { Mine } from '../src/mines/mine.js';

const CALLER = '0x00000000000000000000000000000000000000AA' as Hex;

const LIVE: RewardParams = {
  index: 90n,
  minPrint: 44n * 10n ** 18n,
  maxPrint: 4444n * 10n ** 18n,
  halvingTicks: 560_000n,
  tierBps: 10_000n,
};

describe('rewardAt (matches on-chain previewPrint at Index 90)', () => {
  // Values read live from previewPrint(742, T) on the PitBoys mine.
  const cases: Array<[bigint, number]> = [
    [0n, 444.4],
    [100_000n, 404.72],
    [560_000n, 222.2],
    [1_000_000n, 134.9],
    [1_500_000n, 73.4],
    [1_868_000n, 46.22],
    [3_000_000n, 44.0],
  ];
  for (const [ticks, expected] of cases) {
    it(`T=${ticks} -> ~${expected} DERP`, () => {
      const got = Number(rewardAt(ticks, LIVE)) / 1e18;
      expect(got).toBeCloseTo(expected, 1);
    });
  }
});

describe('expectedReward', () => {
  it('exceeds the floor and the print-at-mean-tick at high Index', () => {
    // At Index 90 the print at the mean tick (2^24) is the 44 floor, but the
    // rare early hits lift the expectation to ~58-59 DERP.
    const e = Number(expectedReward(LIVE)) / 1e18;
    expect(e).toBeGreaterThan(55);
    expect(e).toBeLessThan(62);
    expect(e).toBeGreaterThan(44); // strictly above the floor / mean-tick print
  });

  it('rises as the Index falls (less compression)', () => {
    const at90 = Number(expectedReward({ ...LIVE, index: 90n })) / 1e18;
    const at0 = Number(expectedReward({ ...LIVE, index: 0n })) / 1e18;
    expect(at0).toBeGreaterThan(at90 * 3);
  });

  it('scales linearly with the tier multiplier', () => {
    const x1 = expectedReward({ ...LIVE, tierBps: 10_000n });
    const x2 = expectedReward({ ...LIVE, tierBps: 20_000n });
    // 2x tier ~ 2x expected reward (bin rounding tolerance).
    const ratio = Number(x2) / Number(x1);
    expect(ratio).toBeGreaterThan(1.98);
    expect(ratio).toBeLessThan(2.02);
  });
});

function fakeMine(over: Partial<Record<string, unknown>> = {}): Mine {
  return {
    profile: { feeAsset: 'APE' },
    maxTicksPerSecond: async () => 20000n,
    theIndex: async () => 90n,
    minPrint: async () => 44n * 10n ** 18n,
    maxPrint: async () => 4444n * 10n ** 18n,
    halvingTicks: async () => 560_000n,
    tierMultiplierBps: async () => 10_000n,
    previewPrint: async () => 44n * 10n ** 18n, // print at mean tick = floor
    clockInFeeFor: async () => 99_920_000_000_000_000n, // 0.0999 APE
    ...over,
  } as unknown as Mine;
}

describe('quoteSlot', () => {
  it('reports expected print above the print-at-mean-tick', async () => {
    const q = await quoteSlot(fakeMine(), 742n, 3n, CALLER);
    expect(q.printAtMeanTick).toBe(44n * 10n ** 18n);
    expect(Number(q.expectedPrint) / 1e18).toBeGreaterThan(55);
    expect(q.index).toBe(90n);
    expect(q.feeAsset).toBe('APE');
  });

  it('derives ~100 shifts/day and scales DERP/day from the expectation', async () => {
    const q = await quoteSlot(fakeMine(), 742n, 3n, CALLER);
    expect(q.shiftsPerDay).toBeGreaterThan(98);
    expect(q.shiftsPerDay).toBeLessThan(103);
    // ~100 shifts * ~58 DERP
    expect(Number(q.derpPerDay) / 1e18).toBeGreaterThan(5500);
    expect(Number(q.derpPerDay) / 1e18).toBeLessThan(6200);
  });
});
