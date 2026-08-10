import { EventEmitter } from 'node:events';
import type { Mine } from '../mines/mine.js';
import { log } from '../log.js';

export interface WatcherSnapshot {
  tickerCount: bigint;
  certifiedCount: bigint;
  index: bigint;
}

export interface WatcherDeps {
  mine: Mine;
  /** Poll interval in ms (default 3000). */
  pollMs?: number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Polls the mine's global counters and emits change signals. It does not decide
 * per-slot actions — the engines own that via their own `shiftOf` checks — but
 * a rising certified count or ticker count is the cue for the daemon to wake
 * waiting slots so they re-check for stale/orphan status without waiting out
 * their full sleep.
 *
 * Emits: 'snapshot' (every poll), 'ticker' (tickerCount rose),
 * 'certified' (certifiedCount rose), 'index' (index changed), 'error'.
 */
export class Watcher extends EventEmitter {
  private readonly mine: Mine;
  private readonly pollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private stopped = false;
  private last?: WatcherSnapshot;

  constructor(deps: WatcherDeps) {
    super();
    this.mine = deps.mine;
    this.pollMs = deps.pollMs ?? 3000;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  stop(): void {
    this.stopped = true;
  }

  snapshot(): WatcherSnapshot | undefined {
    return this.last;
  }

  /** Read once and emit any changes. Exposed for tests and manual refresh. */
  async pollOnce(): Promise<WatcherSnapshot> {
    const [tickerCount, certifiedCount, index] = await Promise.all([
      this.mine.tickerCount(),
      this.mine.certifiedCount(),
      this.mine.theIndex(),
    ]);
    const snap: WatcherSnapshot = { tickerCount, certifiedCount, index };
    const prev = this.last;
    this.last = snap;
    this.emit('snapshot', snap);
    if (prev) {
      if (snap.tickerCount > prev.tickerCount) this.emit('ticker', snap);
      if (snap.certifiedCount > prev.certifiedCount) this.emit('certified', snap);
      if (snap.index !== prev.index) this.emit('index', snap);
    }
    return snap;
  }

  /** Loop polling until stopped. */
  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (err) {
        this.emit('error', err);
        log.debug('watcher poll failed', { err: String(err) });
      }
      await this.sleep(this.pollMs);
    }
  }
}
