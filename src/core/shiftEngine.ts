import { EventEmitter } from 'node:events';
import type { Hex } from 'viem';
import type { MineKey } from '../chain/registry.js';
import type { Mine, ShiftState } from '../mines/mine.js';
import type { Solution } from './proof.js';
import { submitAtChainTime } from './schedule.js';
import type { StateStore } from './state.js';
import { log } from '../log.js';

/** A chain-time aware clock: reads chain seconds and sleeps until a target. */
export interface ChainClock {
  chainNow(): Promise<bigint>;
  /** Resolve when chain time reaches `target`, or earlier if `signal` wakes. */
  sleepUntilChain(target: bigint, signal?: WakeSignal): Promise<void>;
}

/** A one-shot wake handle so a watcher can interrupt a pending sleep. */
export interface WakeSignal {
  readonly woken: boolean;
  onWake(cb: () => void): void;
}

/** The write side the engine drives; returns the printed reward on clock-out. */
export interface ShiftSubmitter {
  clockIn(tokenId: bigint, slot: bigint): Promise<void>;
  clockOut(tokenId: bigint, slot: bigint, ticks: bigint): Promise<{ reward: bigint }>;
}

export type GrindFn = (opts: {
  mine: Hex;
  tokenId: bigint;
  prevProofHash: Hex;
  grindSeed: Hex;
}) => Promise<Solution | null>;

export interface ShiftEngineDeps {
  mine: Mine;
  submitter: ShiftSubmitter;
  grind: GrindFn;
  clock: ChainClock;
  state: StateStore;
  /** Seconds of inclusion buffer past the earliest legal submit moment. */
  preBufferSeconds?: bigint;
  /** Re-clock (free) to chase the certified tip when a shift is orphaned. */
  chaseTip?: boolean;
  /** Cached pace/grace to avoid a read every cycle; refreshed if absent. */
  pace?: bigint;
  grace?: bigint;
}

interface Prepared {
  startTime: bigint;
  grindSeed: Hex;
  ticks: bigint;
}

/**
 * Drives one (mine, token, slot) through its mining lifecycle: open a shift,
 * grind the solution once off-thread, sleep until the pace cap clears, and
 * clock out inside the certified grace window — re-clocking free when a shift
 * goes ticker-stale or (optionally) orphaned. All protocol truth comes from the
 * mine's own views (`shiftOf`, `shiftAnchor`), so the engine never re-derives
 * consensus rules; it reacts to them.
 *
 * Emits: 'clockIn', 'grind', 'wait', 'clockOut', 'reclock:free', 'printed',
 * 'error' — for status displays and tests.
 */
export class ShiftEngine extends EventEmitter {
  readonly mineKey: MineKey;
  readonly tokenId: bigint;
  readonly slot: bigint;
  private readonly d: ShiftEngineDeps;
  private stopped = false;
  private pace = 0n;
  private grace = 0n;

  constructor(mineKey: MineKey, tokenId: bigint, slot: bigint, deps: ShiftEngineDeps) {
    super();
    this.mineKey = mineKey;
    this.tokenId = tokenId;
    this.slot = slot;
    this.d = deps;
    this.pace = deps.pace ?? 0n;
    this.grace = deps.grace ?? 0n;
  }

  stop(): void {
    this.stopped = true;
  }

  private async params(): Promise<void> {
    if (this.pace === 0n) this.pace = await this.d.mine.maxTicksPerSecond();
    if (this.grace === 0n) this.grace = await this.d.mine.graceSeconds();
  }

  private async persist(patch: Parameters<StateStore['upsertSlot']>[3]): Promise<void> {
    await this.d.state.upsertSlot(this.mineKey, this.tokenId, this.slot, patch);
  }

  /** True when a shift is dead and must be re-opened before it can print. */
  private isDead(s: ShiftState): boolean {
    return s.empty || s.voided || s.expired || s.tickerExpired;
  }

  /**
   * Ensure a live shift exists and grind its solution. If the current shift is
   * dead — or `forceReclock` is set (orphan tip-chase, a free re-clock) — clock
   * in first. Otherwise resume an already-open healthy shift without restarting
   * it (restart fees are punitive and the shadow profile forbids paid restarts).
   */
  private async prepare(forceReclock = false): Promise<Prepared> {
    let s = await this.d.mine.shiftOf(this.tokenId, this.slot);
    if (forceReclock || this.isDead(s)) {
      this.emit('clockIn');
      await this.persist({ phase: 'CLOCKIN_SENT' });
      await this.d.submitter.clockIn(this.tokenId, this.slot);
      s = await this.d.mine.shiftOf(this.tokenId, this.slot);
      if (s.empty) throw new Error('shift still empty after clockIn');
    }

    const prevProofHash = await this.d.mine.slotProofHash(this.tokenId, this.slot);
    this.emit('grind');
    await this.persist({ phase: 'GRINDING', startTime: s.startTime, grindSeed: s.grindSeed });
    const sol = await this.d.grind({
      mine: this.d.mine.address,
      tokenId: this.tokenId,
      prevProofHash,
      grindSeed: s.grindSeed,
    });
    if (!sol) throw new Error('grind exhausted its bounded search without a solution');
    await this.persist({ phase: 'WAITING', ticks: sol.ticks });
    return { startTime: s.startTime, grindSeed: s.grindSeed, ticks: sol.ticks };
  }

  /** Run one full cycle: prepare → wait → (re-clock if stale) → clock out. */
  async runCycle(wake?: WakeSignal): Promise<{ reward: bigint }> {
    await this.params();
    let prep = await this.prepare();

    // Retry loop for stale/orphan re-clocks discovered while waiting.
    for (let guard = 0; guard < 32; guard++) {
      const target = submitAtChainTime(prep.startTime, prep.ticks, this.pace, this.d.preBufferSeconds ?? 3n, this.grace);
      this.emit('wait', { target });
      await this.d.clock.sleepUntilChain(target, wake);

      const s = await this.d.mine.shiftOf(this.tokenId, this.slot);
      // The grind seed changed under us (stale/void re-seeded) — re-clock free.
      if (this.isDead(s) || s.grindSeed.toLowerCase() !== prep.grindSeed.toLowerCase()) {
        this.emit('reclock:free', { reason: s.tickerExpired ? 'ticker-stale' : 'shift-dead' });
        prep = await this.prepare();
        continue;
      }
      if (this.d.chaseTip) {
        const anchor = await this.d.mine.shiftAnchor(this.tokenId, this.slot);
        if (anchor.orphaned) {
          this.emit('reclock:free', { reason: 'orphaned' });
          prep = await this.prepare(true); // force a free re-clock to chase the tip
          continue;
        }
      }

      await this.persist({ phase: 'CLOCKOUT_SENT' });
      const { reward } = await this.d.submitter.clockOut(this.tokenId, this.slot, prep.ticks);
      this.emit('clockOut', { ticks: prep.ticks, reward });
      const prev = this.d.state.getSlot(this.mineKey, this.tokenId, this.slot);
      await this.persist({
        phase: 'PRINTED',
        lastReward: reward,
        prints: (prev?.prints ?? 0) + 1,
        totalPrinted: (prev?.totalPrinted ?? 0n) + reward,
      });
      this.emit('printed', { reward });
      return { reward };
    }
    throw new Error('re-clock guard tripped: shift never stabilized');
  }

  /** Mine this slot forever, one cycle after another, until stopped. */
  async run(wakeFor?: () => WakeSignal): Promise<void> {
    while (!this.stopped) {
      try {
        await this.runCycle(wakeFor?.());
      } catch (err) {
        this.emit('error', err);
        log.warn('shift cycle failed, backing off', {
          mine: this.mineKey,
          tokenId: this.tokenId,
          slot: this.slot,
          err: String(err),
        });
        await this.d.clock.sleepUntilChain((await this.d.clock.chainNow()) + 15n);
      }
    }
  }
}
