import type { PublicClient } from 'viem';
import type { ChainClock, WakeSignal } from './shiftEngine.js';

export interface ChainClockDeps {
  read<T>(fn: (client: PublicClient) => Promise<T>): Promise<T>;
  /** Injectable real-time sleep (ms) — overridable in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** How often to re-check chain time while waiting (ms). */
  recheckMs?: number;
}

/**
 * A ChainClock backed by the RPC pool. Chain time is the latest block's
 * timestamp; sleeping until a target chain time naps in real-time chunks and
 * re-reads the block clock, so it self-corrects for block-time drift on this
 * Arbitrum-lineage chain and can be interrupted by a wake signal (e.g. a
 * watcher spotting a stale/orphan condition).
 */
export class PoolChainClock implements ChainClock {
  private readonly deps: ChainClockDeps;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly recheckMs: number;

  constructor(deps: ChainClockDeps) {
    this.deps = deps;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.recheckMs = deps.recheckMs ?? 4000;
  }

  async chainNow(): Promise<bigint> {
    const block = await this.deps.read((c) => c.getBlock({ blockTag: 'latest' }));
    return block.timestamp;
  }

  async sleepUntilChain(target: bigint, signal?: WakeSignal): Promise<void> {
    let woken = false;
    if (signal) signal.onWake(() => (woken = true));
    for (;;) {
      if (woken || signal?.woken) return;
      const now = await this.chainNow();
      if (now >= target) return;
      const remainingSeconds = Number(target - now);
      const napMs = Math.min(this.recheckMs, Math.max(250, remainingSeconds * 1000));
      await this.sleep(napMs);
    }
  }
}

/** A simple one-shot wake handle for interrupting a sleep. */
export class Wake implements WakeSignal {
  private _woken = false;
  private cbs: Array<() => void> = [];

  get woken(): boolean {
    return this._woken;
  }

  onWake(cb: () => void): void {
    if (this._woken) cb();
    else this.cbs.push(cb);
  }

  fire(): void {
    if (this._woken) return;
    this._woken = true;
    for (const cb of this.cbs) cb();
    this.cbs = [];
  }
}
