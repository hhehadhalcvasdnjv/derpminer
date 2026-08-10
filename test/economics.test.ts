import { describe, it, expect } from 'vitest';
import type { Hex } from 'viem';
import { quoteSlot } from '../src/economics.js';
import type { Mine } from '../src/mines/mine.js';

const CALLER = '0x00000000000000000000000000000000000000AA' as Hex;

function fakeMine(over: Partial<Record<string, unknown>> = {}): Mine {
  return {
    profile: { feeAsset: 'APE' },
    maxTicksPerSecond: async () => 20000n,
    theIndex: async () => 90n,
    previewPrint: async () => 44n * 10n ** 18n,
    clockInFeeFor: async () => 10n ** 14n,
    ...over,
  } as unknown as Mine;
}

describe('quoteSlot', () => {
  it('computes solve time and expected print from on-chain reads', async () => {
    const q = await quoteSlot(fakeMine(), 742n, 3n, CALLER);
    // 2^24 / 20000 = 838.86s
    expect(q.solveSeconds).toBeCloseTo(838.86, 1);
    expect(q.expectedPrint).toBe(44n * 10n ** 18n);
    expect(q.index).toBe(90n);
    expect(q.feeAsset).toBe('APE');
  });

  it('scales daily throughput from the solve time', async () => {
    const q = await quoteSlot(fakeMine(), 742n, 3n, CALLER);
    // ~86400/839 = ~103 shifts/day
    expect(q.shiftsPerDay).toBeGreaterThan(100);
    expect(q.shiftsPerDay).toBeLessThan(106);
    // derpPerDay ~ 103 * 44 DERP
    expect(q.derpPerDay).toBeGreaterThan(4000n * 10n ** 18n);
    expect(q.derpPerDay).toBeLessThan(4700n * 10n ** 18n);
  });

  it('reflects a higher print when the tier multiplier lifts previewPrint', async () => {
    const q = await quoteSlot(fakeMine({ previewPrint: async () => 220n * 10n ** 18n }), 742n, 3n, CALLER);
    expect(q.expectedPrint).toBe(220n * 10n ** 18n);
  });
});
