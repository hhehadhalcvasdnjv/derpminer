import type { Mine } from './mines/mine.js';
import type { Hex } from 'viem';
import { EXPECTED_SOLVE_TICKS, SUFFIX } from './core/proof.js';

export interface SlotQuote {
  /**
   * EXPECTED DERP per shift — the mean over the geometric distribution of the
   * winning tick, not the print at the mean tick. Early hits are rare but pay
   * far more (the curve halves every `halvingTicks`), so this is materially
   * higher than `previewPrint(expectedTick)`.
   */
  expectedPrint: bigint;
  /** For reference: the print exactly at the mean tick (what a naive quote shows). */
  printAtMeanTick: bigint;
  /** Mean seconds to find a solution at the current pace. */
  solveSeconds: number;
  /** Expected shifts per day mining continuously (renewal rate, incl. overhead). */
  shiftsPerDay: number;
  /** Expected DERP printed per day (before fees). */
  derpPerDay: bigint;
  /** Clock-in fee per shift, in fee-asset wei. */
  clockInFee: bigint;
  /** Fee-asset spend per day, in fee-asset wei. */
  feePerDay: bigint;
  feeAsset: string;
  /** The live emission Index (0-90); higher compresses rewards. */
  index: bigint;
  /** The broker's tier multiplier in bps (10000 = 1.00x). */
  tierBps: bigint;
}

/** Per-shift latency beyond pure grind time (clock-in confirm + clock-out). */
const OVERHEAD_SECONDS = 20;

/**
 * Quote a slot's economics from on-chain reads — no token prices, no USD, no
 * yield promises. The headline number is the EXPECTED print per shift, obtained
 * by integrating the contract's own reward curve over the geometric
 * distribution of the winning tick (mean 2^24). This is the honest figure: the
 * naive `previewPrint(meanTick)` understates it by ~a third at high Index,
 * because the rare early hits dominate the mean.
 */
export async function quoteSlot(mine: Mine, tokenId: bigint, slot: bigint, caller: Hex): Promise<SlotQuote> {
  const [pace, index, minPrint, maxPrint, halvingTicks, tierBps, clockInFee, printAtMeanTick] = await Promise.all([
    mine.maxTicksPerSecond(),
    mine.theIndex(),
    mine.minPrint(),
    mine.maxPrint(),
    mine.halvingTicks(),
    mine.tierMultiplierBps(tokenId),
    mine.clockInFeeFor(tokenId, slot, caller),
    mine.previewPrint(tokenId, EXPECTED_SOLVE_TICKS),
  ]);

  const expectedPrint = expectedReward({ index, minPrint, maxPrint, halvingTicks, tierBps });

  const solveSeconds = Number(EXPECTED_SOLVE_TICKS) / Number(pace);
  const shiftSeconds = solveSeconds + OVERHEAD_SECONDS;
  const shiftsPerDay = 86_400 / shiftSeconds;
  const perDayScale = BigInt(Math.round(shiftsPerDay * 1e6));
  const derpPerDay = (expectedPrint * perDayScale) / 1_000_000n;
  const feePerDay = (clockInFee * perDayScale) / 1_000_000n;

  return {
    expectedPrint,
    printAtMeanTick,
    solveSeconds,
    shiftsPerDay,
    derpPerDay,
    clockInFee,
    feePerDay,
    feeAsset: mine.profile.feeAsset,
    index,
    tierBps,
  };
}

export interface RewardParams {
  index: bigint;
  minPrint: bigint;
  maxPrint: bigint;
  halvingTicks: bigint;
  tierBps: bigint;
}

/**
 * The exact reward the contract prints for a hit at `ticks` — a faithful
 * reimplementation of PitMine._printAmount (verified byte-exact against
 * `previewPrint` on-chain). All bigint, no floats.
 */
export function rewardAt(ticks: bigint, p: RewardParams): bigint {
  const halvings = ticks / p.halvingTicks;
  let base = halvings < 64n ? p.maxPrint >> halvings : 0n;
  if (base !== 0n) {
    const next = base >> 1n;
    base -= ((base - next) * (ticks % p.halvingTicks)) / p.halvingTicks;
  }
  if (base < p.minPrint) base = p.minPrint;
  base = (base * (100n - p.index)) / 100n;
  if (base < p.minPrint) base = p.minPrint;
  return (base * p.tierBps) / 10_000n;
}

/**
 * E[reward] over the winning-tick distribution. The tick of the first suffix
 * hit is geometric with p = 2^-SUFFIX_BITS, so P(T in [a,b)) = (1-p)^a-(1-p)^b.
 * We integrate the reward curve over fine bins until it flattens to the floor,
 * then add the floor-valued tail in closed form. Uses high-precision floats for
 * the probability weights (the tiny p makes bigint powers impractical) and
 * exact bigint rewards, returning DERP wei.
 */
export function expectedReward(p: RewardParams, opts?: { binTicks?: number; cutoffTicks?: number }): bigint {
  const suffixBits = (SUFFIX.length - 2) * 4; // 3 bytes -> 24 bits
  const prob = Math.pow(2, -suffixBits);
  const bin = opts?.binTicks ?? 2000;
  // Past ~8 halvings the compressed curve is pinned to the floor; integrate to
  // a safe multiple of the halving span, then treat the rest as floor.
  const cutoff = opts?.cutoffTicks ?? Math.max(4_000_000, Number(p.halvingTicks) * 8);

  let acc = 0; // accumulate reward in DERP (float) weighted by probability mass
  for (let a = 0; a < cutoff; a += bin) {
    const mass = Math.pow(1 - prob, a) - Math.pow(1 - prob, a + bin);
    const mid = BigInt(a + Math.floor(bin / 2));
    acc += mass * Number(rewardAt(mid, p)) / 1e18;
  }
  const tailMass = Math.pow(1 - prob, cutoff);
  acc += (tailMass * Number(p.minPrint * p.tierBps / 10_000n)) / 1e18;

  return BigInt(Math.round(acc * 1e18));
}
