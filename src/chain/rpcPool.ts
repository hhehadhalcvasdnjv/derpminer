import {
  createPublicClient,
  http,
  keccak256,
  type Chain,
  type PublicClient,
  type Transport,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { log } from '../log.js';

export interface Endpoint {
  url: string;
  /** A viem transport factory. Defaults to http(url) in fromUrls(). */
  transport: Transport;
}

interface Health {
  ep: Endpoint;
  client: PublicClient;
  /** EWMA of latency in ms (lower is better). */
  latencyMs: number;
  /** Last observed block number, for lag detection. */
  block: bigint;
  /** True if the last probe/read on this endpoint threw. */
  errored: boolean;
}

export interface RpcPoolOptions {
  /** Endpoints lagging more than this many blocks behind the best are demoted. */
  maxLagBlocks?: bigint;
  /** Per-read attempt timeout in ms. */
  readTimeoutMs?: number;
  /** Receipt poll interval in ms. */
  receiptPollMs?: number;
}

const EWMA_ALPHA = 0.3;

/**
 * A pool of RPC endpoints with health scoring, read failover, and hedged
 * broadcast of raw transactions. This is the layer that makes the miner
 * survive flaky RPCs: reads retry across healthy endpoints, and time-critical
 * clock-outs go to every healthy endpoint at once.
 */
export class RpcPool {
  private readonly nodes: Health[];
  private readonly maxLagBlocks: bigint;
  private readonly readTimeoutMs: number;
  private readonly receiptPollMs: number;

  /**
   * Build a pool from plain URLs using viem's http transport with internal
   * retries disabled — the pool owns failover, so per-endpoint retries would
   * only add latency before we move on to a healthier endpoint.
   */
  static fromUrls(urls: string[], chain?: Chain, opts: RpcPoolOptions = {}): RpcPool {
    const endpoints = urls.map((url) => ({
      url,
      transport: http(url, { retryCount: 0, timeout: opts.readTimeoutMs ?? 8_000 }),
    }));
    return new RpcPool(endpoints, chain, opts);
  }

  constructor(endpoints: Endpoint[], chain?: Chain, opts: RpcPoolOptions = {}) {
    if (endpoints.length === 0) throw new Error('RpcPool needs at least one endpoint');
    this.nodes = endpoints.map((ep) => ({
      ep,
      client: createPublicClient({ chain, transport: ep.transport }),
      latencyMs: 0,
      block: 0n,
      errored: false,
    }));
    this.maxLagBlocks = opts.maxLagBlocks ?? 5n;
    this.readTimeoutMs = opts.readTimeoutMs ?? 8_000;
    this.receiptPollMs = opts.receiptPollMs ?? 1_500;
  }

  /** Endpoints considered usable right now, best (lowest latency) first. */
  private healthy(): Health[] {
    const bestBlock = this.nodes.reduce((m, n) => (n.block > m ? n.block : m), 0n);
    const usable = this.nodes.filter(
      (n) => !n.errored && (bestBlock === 0n || bestBlock - n.block <= this.maxLagBlocks),
    );
    const pool = usable.length > 0 ? usable : this.nodes; // never strand the caller
    return [...pool].sort((a, b) => a.latencyMs - b.latencyMs);
  }

  /** Ordered candidates for a read: healthy first, then everything as fallback. */
  private readOrder(): Health[] {
    const h = this.healthy();
    const rest = this.nodes.filter((n) => !h.includes(n));
    return [...h, ...rest];
  }

  private record(node: Health, ms: number, ok: boolean): void {
    node.latencyMs = node.latencyMs === 0 ? ms : EWMA_ALPHA * ms + (1 - EWMA_ALPHA) * node.latencyMs;
    node.errored = !ok;
  }

  /**
   * Run a read against the pool, failing over to the next endpoint on error or
   * timeout. `fn` receives a viem PublicClient. Throws only if every endpoint
   * fails.
   */
  async read<T>(fn: (client: PublicClient) => Promise<T>): Promise<T> {
    const order = this.readOrder();
    let lastErr: unknown;
    for (const node of order) {
      const started = monotonicMs();
      try {
        const result = await withTimeout(fn(node.client), this.readTimeoutMs);
        this.record(node, monotonicMs() - started, true);
        return result;
      } catch (err) {
        this.record(node, monotonicMs() - started, false);
        lastErr = err;
        log.debug('rpc read failed, failing over', { url: node.ep.url, err: String(err) });
      }
    }
    throw new Error(`all RPC endpoints failed on read: ${String(lastErr)}`);
  }

  /**
   * Broadcast one signed raw transaction to every healthy endpoint at once and
   * return its hash as soon as any endpoint accepts it. A submitted tx's hash
   * is keccak256(rawTx), so endpoints that reject with a benign race ("already
   * known", "nonce too low") still count as success — the tx is already out.
   * Rejects only if every endpoint fails with a real error.
   */
  async hedgedSend(rawTx: Hex): Promise<Hex> {
    const expectedHash = keccak256(rawTx);
    const targets = this.healthy();
    const attempts = targets.map((node) =>
      node.client
        .sendRawTransaction({ serializedTransaction: rawTx })
        .then((hash) => {
          this.record(node, node.latencyMs || 1, true);
          return hash;
        })
        .catch((err) => {
          if (isBenignSendError(err)) return expectedHash; // already broadcast elsewhere
          log.debug('hedged send rejected', { url: node.ep.url, err: String(err) });
          throw err;
        }),
    );
    try {
      return await firstFulfilled(attempts);
    } catch (err) {
      throw new Error(`hedged send failed on all endpoints: ${String(err)}`);
    }
  }

  /** Poll the pool for a receipt until found or `timeoutMs` elapses (null on timeout). */
  async waitForReceipt(hash: Hex, timeoutMs = 60_000): Promise<TransactionReceipt | null> {
    const deadline = monotonicMs() + timeoutMs;
    while (monotonicMs() < deadline) {
      try {
        const receipt = await this.read((c) => c.getTransactionReceipt({ hash }));
        if (receipt) return receipt;
      } catch {
        // not mined yet, or endpoint hiccup — keep polling
      }
      await sleep(this.receiptPollMs);
    }
    return null;
  }

  /** Refresh block numbers across all endpoints; call on an interval. */
  async probe(): Promise<void> {
    await Promise.all(
      this.nodes.map(async (node) => {
        const started = monotonicMs();
        try {
          const bn = await withTimeout(node.client.getBlockNumber(), this.readTimeoutMs);
          node.block = bn;
          this.record(node, monotonicMs() - started, true);
        } catch {
          this.record(node, monotonicMs() - started, false);
        }
      }),
    );
  }

  /** Snapshot of endpoint health for status displays. */
  status(): Array<{ url: string; latencyMs: number; block: bigint; errored: boolean }> {
    return this.nodes.map((n) => ({
      url: n.ep.url,
      latencyMs: Math.round(n.latencyMs),
      block: n.block,
      errored: n.errored,
    }));
  }
}

/**
 * Send errors that unambiguously mean "this exact tx is already in the mempool"
 * — safe to treat as success in a hedged broadcast because the hash we'd wait
 * on (keccak256(rawTx)) is the very tx already accepted elsewhere. Nonce and
 * pricing errors are deliberately NOT here: they can mean a different tx took
 * the slot, which the TxQueue must resolve via nonce resync, not the pool.
 */
function isBenignSendError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err).toLowerCase();
  return (
    msg.includes('already known') ||
    msg.includes('known transaction') ||
    msg.includes('already imported')
  );
}

/** Resolve with the first fulfilled promise; reject only if all reject. */
async function firstFulfilled<T>(promises: Promise<T>[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let remaining = promises.length;
    if (remaining === 0) reject(new Error('no endpoints'));
    let lastErr: unknown;
    for (const p of promises) {
      p.then(resolve).catch((e) => {
        lastErr = e;
        remaining -= 1;
        if (remaining === 0) reject(lastErr);
      });
    }
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function monotonicMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}
