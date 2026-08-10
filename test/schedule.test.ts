import { describe, it, expect } from 'vitest';
import {
  earliestSubmitTime,
  isInGrace,
  latestInBandTime,
  submitAtChainTime,
  secondsUntil,
} from '../src/core/schedule.js';

const PACE = 20000n;
const GRACE = 150n;

describe('earliestSubmitTime', () => {
  it('is startTime + ceil(ticks/pace)', () => {
    // 13786224 / 20000 = 689.31 -> ceil 690
    expect(earliestSubmitTime(1000n, 13786224n, PACE)).toBe(1000n + 690n);
  });
  it('is exact when ticks divides pace', () => {
    expect(earliestSubmitTime(0n, 40000n, PACE)).toBe(2n);
  });
});

describe('isInGrace', () => {
  const start = 1000n;
  const ticks = 13786224n;
  const earliest = earliestSubmitTime(start, ticks, PACE); // 1690

  it('is true at the earliest legal second', () => {
    expect(isInGrace(start, earliest, ticks, PACE, GRACE)).toBe(true);
  });
  it('is true at the exact in-band edge', () => {
    const edge = latestInBandTime(start, ticks, PACE, GRACE); // 1839
    expect(isInGrace(start, edge, ticks, PACE, GRACE)).toBe(true);
  });
  it('is false one second past the in-band edge', () => {
    const edge = latestInBandTime(start, ticks, PACE, GRACE);
    expect(isInGrace(start, edge + 1n, ticks, PACE, GRACE)).toBe(false);
  });
});

describe('latestInBandTime', () => {
  it('is tighter than earliest + grace by the ceil slack', () => {
    const start = 1000n;
    const ticks = 13786224n;
    // earliest + grace = 1690 + 150 = 1840, but exact edge is 1839.
    expect(latestInBandTime(start, ticks, PACE, GRACE)).toBe(1839n);
    expect(earliestSubmitTime(start, ticks, PACE) + GRACE).toBe(1840n);
  });
});

describe('submitAtChainTime', () => {
  it('targets earliest + preBuffer while inside grace', () => {
    expect(submitAtChainTime(1000n, 13786224n, PACE, 2n)).toBe(1000n + 690n + 2n);
  });
  it('clamps to the exact in-band edge when preBuffer would overshoot', () => {
    expect(submitAtChainTime(1000n, 13786224n, PACE, 500n, GRACE)).toBe(1839n);
  });
});

describe('secondsUntil', () => {
  it('floors at zero when the target has passed', () => {
    expect(secondsUntil(100n, 200n)).toBe(0n);
  });
  it('returns the positive delta', () => {
    expect(secondsUntil(200n, 100n)).toBe(100n);
  });
});
