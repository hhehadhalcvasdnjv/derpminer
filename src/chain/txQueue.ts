import type { Hex, TransactionReceipt } from 'viem';
import { log } from '../log.js';

/** A transaction request in the terms the queue needs to sign and send. */
export interface TxRequest {
  to: Hex;
  data: Hex;
  value?: bigint;
  gas?: bigint;
}

/** The fee fields the queue fills in and bumps across retries. */
export interface FeeFields {
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** What the signer returns: the serialized raw tx and its hash. */
export interface SignedTx {
  rawTx: Hex;
  hash: Hex;
}

export type SignFn = (req: TxRequest & FeeFields) => Promise<SignedTx>;

/** The slice of RpcPool the queue depends on (keeps it unit-testable). */
export interface PoolLike {
  read<T>(fn: (client: { getTransactionCount(args: { address: Hex; blockTag: 'pending' }): Promise<number> }) => Promise<T>): Promise<T>;
  hedgedSend(rawTx: Hex): Promise<Hex>;
  waitForReceipt(hash: Hex, timeoutMs?: number): Promise<TransactionReceipt | null>;
}

export interface TxQueueOptions {
  account: { address: Hex };
  pool: PoolLike;
  signTx: SignFn;
  /** How long to wait for a receipt before bumping gas and resending. */
  confirmMs?: number;
  /** Multiplier applied to both fee fields on each bump (default 1.25x). */
  bumpNumerator?: bigint;
  bumpDenominator?: bigint;
  /** Max send attempts (initial + bumps) before giving up. */
  maxAttempts?: number;
  /** Base fee fields when none can be read from chain (test/first tx). */
  baseFee?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
}

export interface SubmitResult {
  hash: Hex;
  receipt: TransactionReceipt;
  attempts: number;
}

/**
 * Serializes transactions from one signer: assigns sequential nonces, sends
 * hedged across the RPC pool, and on a stuck tx bumps the gas and resends on
 * the SAME nonce. All submits share one promise-chain mutex, so nonces never
 * collide. On "nonce too low" it resyncs from chain and retries.
 */
export class TxQueue {
  private readonly account: { address: Hex };
  private readonly pool: PoolLike;
  private readonly signTx: SignFn;
  private readonly confirmMs: number;
  private readonly bumpNum: bigint;
  private readonly bumpDen: bigint;
  private readonly maxAttempts: number;
  private readonly baseFee: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

  private nextNonce: number | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: TxQueueOptions) {
    this.account = opts.account;
    this.pool = opts.pool;
    this.signTx = opts.signTx;
    this.confirmMs = opts.confirmMs ?? 20_000;
    this.bumpNum = opts.bumpNumerator ?? 5n;
    this.bumpDen = opts.bumpDenominator ?? 4n; // 5/4 = 1.25x
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.baseFee = opts.baseFee ?? { maxFeePerGas: 100_000_000n, maxPriorityFeePerGas: 1_000_000n };
  }

  /** Enqueue a transaction; resolves when it is mined (or throws after retries). */
  submit(req: TxRequest): Promise<SubmitResult> {
    const run = this.chain.then(() => this.doSubmit(req));
    // Keep the mutex chain alive regardless of this submit's outcome.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async ensureNonce(): Promise<number> {
    if (this.nextNonce !== null) return this.nextNonce;
    const n = await this.pool.read((c) =>
      c.getTransactionCount({ address: this.account.address, blockTag: 'pending' }),
    );
    this.nextNonce = n;
    return n;
  }

  private bump(v: bigint): bigint {
    return (v * this.bumpNum) / this.bumpDen;
  }

  private async doSubmit(req: TxRequest): Promise<SubmitResult> {
    const nonce = await this.ensureNonce();
    let maxFeePerGas = this.baseFee.maxFeePerGas;
    let maxPriorityFeePerGas = this.baseFee.maxPriorityFeePerGas;
    const sentHashes: Hex[] = [];

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let signed: SignedTx;
      try {
        signed = await this.signTx({ ...req, nonce, maxFeePerGas, maxPriorityFeePerGas });
      } catch (err) {
        throw new Error(`sign failed: ${String(err)}`);
      }

      try {
        await this.pool.hedgedSend(signed.rawTx);
      } catch (err) {
        if (isNonceTooLow(err)) {
          await this.resyncNonce();
          throw new Error(`nonce too low, resynced; caller should retry: ${String(err)}`);
        }
        log.warn('send failed, will bump and retry', { attempt, err: String(err) });
        maxFeePerGas = this.bump(maxFeePerGas);
        maxPriorityFeePerGas = this.bump(maxPriorityFeePerGas);
        continue;
      }

      sentHashes.push(signed.hash);
      // Wait for ANY of the same-nonce hashes to mine (bumped tx replaces prior).
      const receipt = await this.waitForAny(sentHashes, this.confirmMs);
      if (receipt) {
        this.nextNonce = nonce + 1;
        return { hash: receipt.transactionHash, receipt, attempts: attempt };
      }

      log.info('tx unconfirmed, bumping gas', { nonce, attempt, maxFeePerGas });
      maxFeePerGas = this.bump(maxFeePerGas);
      maxPriorityFeePerGas = this.bump(maxPriorityFeePerGas);
    }

    throw new Error(`tx not mined after ${this.maxAttempts} attempts (nonce ${nonce})`);
  }

  /** Race receipt polling across all same-nonce candidate hashes. */
  private async waitForAny(hashes: Hex[], timeoutMs: number): Promise<TransactionReceipt | null> {
    const polls = hashes.map((h) => this.pool.waitForReceipt(h, timeoutMs));
    const results = await Promise.all(polls);
    return results.find((r): r is TransactionReceipt => r !== null) ?? null;
  }

  private async resyncNonce(): Promise<void> {
    const n = await this.pool.read((c) =>
      c.getTransactionCount({ address: this.account.address, blockTag: 'pending' }),
    );
    this.nextNonce = n;
  }
}

function isNonceTooLow(err: unknown): boolean {
  return String((err as { message?: string })?.message ?? err)
    .toLowerCase()
    .includes('nonce too low');
}
