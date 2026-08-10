/**
 * Chain-time submission math. The contract enforces a pace cap: a clock-out
 * with `ticks` is only accepted once `(chainNow - startTime) * pace >= ticks`.
 * Submitting within `graceSeconds` of that earliest moment keeps the print
 * certified and priced at the attested tick; later prints are repriced down
 * the decay curve. So the optimal moment is: as soon as the pace cap clears,
 * with a small pre-buffer so inclusion lands just inside the window.
 *
 * All times are chain timestamps (seconds) as bigints.
 */

/** ceil(ticks / pace): the earliest chain second the pace cap allows submission. */
export function earliestSubmitTime(startTime: bigint, ticks: bigint, pace: bigint): bigint {
  return startTime + ceilDiv(ticks, pace);
}

/**
 * Whether a clock-out included at `now` still certifies (in-band):
 * (now - startTime) * pace <= ticks + grace * pace.
 */
export function isInGrace(
  startTime: bigint,
  now: bigint,
  ticks: bigint,
  pace: bigint,
  grace: bigint,
): boolean {
  const elapsed = now - startTime;
  return elapsed * pace <= ticks + grace * pace;
}

/** Fallback grace if the caller does not pass a live value (contract: 150s). */
export const DEFAULT_GRACE_SECONDS = 150n;

/**
 * The last chain second at which a clock-out still certifies in-band. Exact:
 * the largest `now` with (now - startTime) * pace <= ticks + grace * pace, i.e.
 * startTime + floor((ticks + grace*pace) / pace). This is tighter than
 * earliestSubmitTime + grace, because the ceil in earliestSubmitTime spends
 * part of the grace budget on rounding. Submitting past this second reprices
 * the print down the decay curve and strips certification.
 */
export function latestInBandTime(
  startTime: bigint,
  ticks: bigint,
  pace: bigint,
  grace: bigint,
): bigint {
  return startTime + (ticks + grace * pace) / pace;
}

/**
 * The chain time to aim inclusion at: the earliest legal second plus a
 * pre-buffer, clamped to stay inside the grace window. Keeping a couple of
 * seconds of buffer absorbs block-time jitter without falling out of band.
 */
export function submitAtChainTime(
  startTime: bigint,
  ticks: bigint,
  pace: bigint,
  preBufferSeconds: bigint,
  grace: bigint = DEFAULT_GRACE_SECONDS,
): bigint {
  const earliest = earliestSubmitTime(startTime, ticks, pace);
  const latest = latestInBandTime(startTime, ticks, pace, grace);
  const target = earliest + preBufferSeconds;
  return target > latest ? latest : target;
}

/** Seconds until `target` from `now`, floored at zero. */
export function secondsUntil(target: bigint, now: bigint): bigint {
  const d = target - now;
  return d > 0n ? d : 0n;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}
