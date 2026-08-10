import { formatEther, type Hex } from 'viem';
import { statePath, type Config } from './config.js';
import { MINES, robinhoodChain, type MineKey } from './chain/registry.js';
import { RpcPool } from './chain/rpcPool.js';
import { TxQueue } from './chain/txQueue.js';
import { Mine } from './mines/mine.js';
import { Submitter } from './mines/submitter.js';
import { ShiftEngine } from './core/shiftEngine.js';
import { Watcher } from './core/watcher.js';
import { PoolChainClock, Wake } from './core/chainClock.js';
import { StateStore } from './core/state.js';
import { findSolution } from './core/proof.js';
import { makeSigner } from './wallet/signer.js';
import { notify } from './notify.js';
import { log } from './log.js';

export interface DaemonHandles {
  stop(): Promise<void>;
  /** The engines, keyed "mine:token:slot", for status/inspection. */
  engines: Map<string, ShiftEngine>;
  pool: RpcPool;
  watchers: Map<MineKey, Watcher>;
}

/**
 * Wire the full mining daemon from a config and an unlocked hot key: one RPC
 * pool, one serial TxQueue on the shadow account, and a ShiftEngine per target
 * slot. Watchers wake waiting engines the moment the certified/ticker counters
 * move, so a slot re-checks for stale/orphan status without waiting out its
 * whole sleep.
 */
export async function startDaemon(config: Config, privateKey: Hex): Promise<DaemonHandles> {
  if (config.targets.length === 0) throw new Error('no targets configured — run `derpminer init` first');

  const pool = RpcPool.fromUrls(config.rpcUrls, robinhoodChain, { receiptPollMs: 1500 });
  const signer = makeSigner({ pool, chainId: robinhoodChain.id, privateKey });
  const txQueue = new TxQueue({
    account: { address: signer.address },
    pool,
    signTx: signer.sign,
    confirmMs: Math.max(8000, config.pollMs * 3),
  });
  const clock = new PoolChainClock({ read: (fn) => pool.read(fn), recheckMs: config.pollMs });
  const state = new StateStore(statePath());
  await state.load();

  const engines = new Map<string, ShiftEngine>();
  const wakes = new Map<string, Wake>();
  const watchers = new Map<MineKey, Watcher>();
  const enginesByMine = new Map<MineKey, ShiftEngine[]>();

  const mineKeys = [...new Set(config.targets.map((t) => t.mine))];
  for (const mineKey of mineKeys) {
    const mine = new Mine(MINES[mineKey], pool);
    const directFee =
      config.walletMode === 'direct' && MINES[mineKey].feeAsset === 'ETH'
        ? (tokenId: bigint, slot: bigint) => mine.clockInFeeFor(tokenId, slot, signer.address)
        : undefined;
    const submitter = new Submitter(MINES[mineKey], { submit: (req) => txQueue.submit(req) }, { directFee });

    for (const target of config.targets.filter((t) => t.mine === mineKey)) {
      for (const slot of target.slots) {
        const tokenId = BigInt(target.tokenId);
        const engine = new ShiftEngine(mineKey, tokenId, BigInt(slot), {
          mine,
          submitter,
          grind: findSolution,
          clock,
          state,
          preBufferSeconds: BigInt(config.preBufferSeconds),
          chaseTip: config.chaseTip,
        });
        const key = `${mineKey}:${tokenId}:${slot}`;
        engine.on('printed', (e: { reward: bigint }) => {
          log.info('printed', { key, reward: formatEther(e.reward) });
          void notify(config.webhookUrl, `⛏️ ${key} printed ${formatEther(e.reward)} DERP`);
        });
        engine.on('reclock:free', (e: { reason: string }) => log.info('free re-clock', { key, reason: e.reason }));
        engine.on('error', (err) => log.warn('engine error', { key, err: String(err) }));
        engines.set(key, engine);
        const list = enginesByMine.get(mineKey) ?? [];
        list.push(engine);
        enginesByMine.set(mineKey, list);
      }
    }

    const watcher = new Watcher({ mine, pollMs: config.pollMs });
    const wakeMineEngines = () => {
      for (const engine of enginesByMine.get(mineKey) ?? []) {
        wakes.get(engineKey(engine))?.fire();
      }
    };
    watcher.on('certified', wakeMineEngines);
    watcher.on('ticker', wakeMineEngines);
    watchers.set(mineKey, watcher);
  }

  // Start background loops. Each engine gets a fresh Wake per cycle, registered
  // so its mine's watcher can interrupt the sleep.
  const probeLoop = runProbeLoop(pool, config.pollMs);
  for (const watcher of watchers.values()) void watcher.run();
  for (const engine of engines.values()) {
    void engine.run(() => {
      const wake = new Wake();
      wakes.set(engineKey(engine), wake);
      return wake;
    });
  }

  log.info('daemon started', { targets: engines.size, mines: mineKeys, mode: config.walletMode });

  return {
    engines,
    pool,
    watchers,
    stop: async () => {
      probeLoop.stop();
      for (const w of watchers.values()) w.stop();
      for (const e of engines.values()) e.stop();
    },
  };
}

function engineKey(e: ShiftEngine): string {
  return `${e.mineKey}:${e.tokenId}:${e.slot}`;
}

function runProbeLoop(pool: RpcPool, pollMs: number): { stop(): void } {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      await pool.probe();
      await new Promise((r) => setTimeout(r, pollMs));
    }
  };
  void loop();
  return { stop: () => (stopped = true) };
}
