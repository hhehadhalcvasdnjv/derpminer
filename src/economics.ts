import type { Mine } from './mines/mine.js';
import type { Hex } from 'viem';
import { EXPECTED_SOLVE_TICKS } from './core/proof.js';

export interface SlotQuote {
  /** Expected DERP printed per successful shift, at the expected solve tick. */
  expectedPrint: bigint;
  /** Mean seconds to find a solution at the current pace. */
  solveSeconds: number;
  /** Expected shifts per day if mining continuously. */
  shiftsPerDay: number;
  /** Expected DERP printed per day (before fees). */
  derpPerDay: bigint;
  /** Clock-in fee per shift, in fee-asset wei. */
  clockInFee: bigint;
  /** Fee-asset spend per day, in fee-asset wei. */
  feePerDay: bigint;
  /** Fee asset symbol. */
  feeAsset: string;
  /** The live emission Index (0-90); higher compresses rewards. */
  index: bigint;
}

/**
 * Quote a slot's economics purely from on-chain reads — no token prices, no USD,
 * no yield promises. It answers "how much DERP per day and how much fee-asset
 * per day", and leaves the value judgment to the operator. Expected solve work
 * is 2^24 hashes (24 suffix bits), so at `pace` hashes/sec the mean solve time
 * is 2^24 / pace seconds; `previewPrint` at that tick is the expected print.
 */
export async function quoteSlot(mine: Mine, tokenId: bigint, slot: bigint, caller: Hex): Promise<SlotQuote> {
  const [pace, index, expectedPrint, clockInFee] = await Promise.all([
    mine.maxTicksPerSecond(),
    mine.theIndex(),
    mine.previewPrint(tokenId, EXPECTED_SOLVE_TICKS),
    mine.clockInFeeFor(tokenId, slot, caller),
  ]);

  const solveSeconds = Number(EXPECTED_SOLVE_TICKS) / Number(pace);
  const shiftsPerDay = 86_400 / solveSeconds;
  // Scale bigint DERP by a rational shiftsPerDay without floating the wei.
  const derpPerDay = scaleByRate(expectedPrint, 86_400n, BigInt(Math.round(solveSeconds)) || 1n);
  const feePerDay = scaleByRate(clockInFee, 86_400n, BigInt(Math.round(solveSeconds)) || 1n);

  return {
    expectedPrint,
    solveSeconds,
    shiftsPerDay,
    derpPerDay,
    clockInFee,
    feePerDay,
    feeAsset: mine.profile.feeAsset,
    index,
  };
}

/** value * (numer/denom), computed in bigint (denom guarded non-zero by caller). */
function scaleByRate(value: bigint, numer: bigint, denom: bigint): bigint {
  return (value * numer) / denom;
}
