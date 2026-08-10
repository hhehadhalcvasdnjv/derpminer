import { formatEther, type Hex } from 'viem';
import type { RpcPool } from './chain/rpcPool.js';
import type { Mine } from './mines/mine.js';
import type { StateStore } from './core/state.js';
import type { Config } from './config.js';
import type { MineKey } from './chain/registry.js';
import type { DashboardState } from './server.js';
import { EXPECTED_SOLVE_TICKS } from './core/proof.js';
import { log } from './log.js';

interface Cached<T> {
  at: number;
  value: T;
}

const PRICE_URL =
  'https://robinhoodchain.blockscout.com/api/v2/tokens/0x6543b7746ca744c4bb2198191e71f40ff04c41b9';

/**
 * Collects live mining status for the dashboard: an in-memory print feed and
 * per-slot spark history fed by engine 'printed' events, plus cached live reads
 * (index, ticker, tank, price) so /api/state stays cheap. This is monitoring
 * only — the miner runs headless and never depends on it.
 */
export class StatusHub {
  private readonly pool: RpcPool;
  private readonly mines: Map<MineKey, Mine>;
  private readonly state: StateStore;
  private readonly config: Config;
  private readonly paceByMine = new Map<MineKey, bigint>();

  private feed: Array<{ ts: number; key: string; reward: number }> = [];
  private sparkByKey = new Map<string, number[]>();
  private derpToday = 0;
  private dayStamp = 0;

  private priceCache?: Cached<number>;
  private liveCache?: Cached<{ index: number; tickerCount: number; certifiedCount: number; tierBps: number }>;
  private tankCache?: Cached<{ balance: number; reserved: number; withdrawable: number; feeAsset: string }>;
  private chainNowCache?: Cached<bigint>;

  constructor(pool: RpcPool, mines: Map<MineKey, Mine>, state: StateStore, config: Config) {
    this.pool = pool;
    this.mines = mines;
    this.state = state;
    this.config = config;
  }

  /** The headline mine (first configured) drives the single-value gauges. */
  private primaryMine(): { key: MineKey; mine: Mine } {
    const key = this.config.targets[0].mine;
    return { key, mine: this.mines.get(key)! };
  }

  /** Record a print from an engine 'printed' event. */
  recordPrint(mineKey: MineKey, tokenId: bigint, slot: bigint, reward: bigint): void {
    const derp = Number(formatEther(reward));
    const key = `#${tokenId}·${slot}`;
    this.feed.unshift({ ts: nowMs(), key, reward: derp });
    if (this.feed.length > 24) this.feed.pop();

    const sk = `${mineKey}:${tokenId}:${slot}`;
    const spark = this.sparkByKey.get(sk) ?? [];
    spark.push(derp);
    if (spark.length > 20) spark.shift();
    this.sparkByKey.set(sk, spark);

    const day = Math.floor(nowMs() / 86_400_000);
    if (day !== this.dayStamp) {
      this.dayStamp = day;
      this.derpToday = 0;
    }
    this.derpToday += derp;
  }

  private async cachedPrice(): Promise<number> {
    if (this.priceCache && nowMs() - this.priceCache.at < 60_000) return this.priceCache.value;
    let value = this.priceCache?.value ?? 0.000895;
    try {
      const res = await fetch(PRICE_URL);
      const json = (await res.json()) as { exchange_rate?: string };
      if (json.exchange_rate) value = Number(json.exchange_rate);
    } catch (err) {
      log.debug('price fetch failed', { err: String(err) });
    }
    this.priceCache = { at: nowMs(), value };
    return value;
  }

  private async cachedLive(): Promise<{ index: number; tickerCount: number; certifiedCount: number; tierBps: number }> {
    if (this.liveCache && nowMs() - this.liveCache.at < 3_000) return this.liveCache.value;
    const { mine } = this.primaryMine();
    const firstToken = BigInt(this.config.targets[0].tokenId);
    const [index, tickerCount, certifiedCount, tierBps] = await Promise.all([
      mine.theIndex(),
      mine.tickerCount(),
      mine.certifiedCount(),
      mine.tierMultiplierBps(firstToken).catch(() => 10_000n),
    ]);
    const value = { index: Number(index), tickerCount: Number(tickerCount), certifiedCount: Number(certifiedCount), tierBps: Number(tierBps) };
    this.liveCache = { at: nowMs(), value };
    return value;
  }

  private async cachedTank(): Promise<{ balance: number; reserved: number; withdrawable: number; feeAsset: string }> {
    const { mine } = this.primaryMine();
    const feeAsset = mine.profile.feeAsset;
    if (!this.config.ownerAddress) return { balance: 0, reserved: 0, withdrawable: 0, feeAsset };
    if (this.tankCache && nowMs() - this.tankCache.at < 10_000) return this.tankCache.value;
    try {
      const t = await mine.tankOf(this.config.ownerAddress as Hex);
      const value = {
        balance: Number(formatEther(t.balance)),
        reserved: Number(formatEther(t.reserved)),
        withdrawable: Number(formatEther(t.withdrawable)),
        feeAsset,
      };
      this.tankCache = { at: nowMs(), value };
      return value;
    } catch {
      return { balance: 0, reserved: 0, withdrawable: 0, feeAsset };
    }
  }

  private async chainNow(): Promise<bigint> {
    if (this.chainNowCache && nowMs() - this.chainNowCache.at < 2_000) return this.chainNowCache.value;
    const block = await this.pool.read((c) => c.getBlock({ blockTag: 'latest' }));
    this.chainNowCache = { at: nowMs(), value: block.timestamp };
    return block.timestamp;
  }

  private async pace(key: MineKey): Promise<bigint> {
    const cached = this.paceByMine.get(key);
    if (cached) return cached;
    const p = await this.mines.get(key)!.maxTicksPerSecond();
    this.paceByMine.set(key, p);
    return p;
  }

  /** Assemble the full dashboard state. Cheap: everything expensive is cached. */
  async getState(): Promise<DashboardState> {
    const [price, live, tank, chainNow] = await Promise.all([
      this.cachedPrice(),
      this.cachedLive(),
      this.cachedTank(),
      this.chainNow(),
    ]);

    const slots: DashboardState['slots'] = [];
    for (const { key, record } of this.state.allSlots()) {
      const [mineKey, tokenStr, slotStr] = key.split(':');
      const pace = await this.pace(mineKey as MineKey);
      const ticks = record.ticks ?? 0n;
      const startTime = record.startTime ?? chainNow;
      const shiftLen = ticks > 0n ? Number(ticks) / Number(pace) : Number(EXPECTED_SOLVE_TICKS) / Number(pace);
      const earliest = startTime + (ticks + pace - 1n) / pace;
      const nextSolveEta = Number(earliest > chainNow ? earliest - chainNow : 0n);
      slots.push({
        mine: mineKey,
        tokenId: Number(tokenStr),
        slot: Number(slotStr),
        phase: record.phase ?? 'IDLE',
        nextSolveEta,
        shiftLen,
        prints: record.prints ?? 0,
        totalPrinted: record.totalPrinted ? Number(formatEther(record.totalPrinted)) : 0,
        justPrinted: 0,
        spark: this.sparkByKey.get(key) ?? [44],
      });
    }

    const runwayDays = tank.balance > 0 && slots.length > 0 ? tank.balance / (slots.length * 0.0999 * 101) : 0;

    return {
      price,
      index: live.index,
      tierBps: live.tierBps,
      tickerCount: live.tickerCount,
      certifiedCount: live.certifiedCount,
      tank: { ...tank, runwayDays },
      slots,
      feed: this.feed,
      rpc: this.pool.status().map((r) => ({ url: r.url, latencyMs: r.latencyMs, block: Number(r.block), healthy: !r.errored })),
      derpToday: this.derpToday,
    };
  }
}

function nowMs(): number {
  return Date.now();
}
