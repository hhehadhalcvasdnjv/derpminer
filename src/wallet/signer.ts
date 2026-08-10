import { privateKeyToAccount } from 'viem/accounts';
import { serializeTransaction, keccak256, type Hex, type PublicClient } from 'viem';
import type { SignFn, TxRequest, FeeFields } from '../chain/txQueue.js';
import type { RpcPool } from '../chain/rpcPool.js';

export interface SignerContext {
  pool: RpcPool;
  chainId: number;
  privateKey: Hex;
  /** Fixed gas ceiling per call type when estimation is unavailable. */
  gasFallback?: bigint;
}

/**
 * Build a SignFn for the TxQueue backed by a real key. It estimates gas through
 * the pool (falling back to a ceiling), signs an EIP-1559 transaction, and
 * returns the serialized raw tx plus its hash. The account address is exposed
 * so the queue can read the starting nonce.
 */
export function makeSigner(ctx: SignerContext): { sign: SignFn; address: Hex } {
  const account = privateKeyToAccount(ctx.privateKey);
  const gasFallback = ctx.gasFallback ?? 500_000n;

  const sign: SignFn = async (req: TxRequest & FeeFields) => {
    const gas = req.gas ?? (await estimateGas(ctx.pool, account.address, req, gasFallback));
    const serialized = await account.signTransaction({
      to: req.to,
      data: req.data,
      value: req.value ?? 0n,
      nonce: req.nonce,
      gas,
      maxFeePerGas: req.maxFeePerGas,
      maxPriorityFeePerGas: req.maxPriorityFeePerGas,
      chainId: ctx.chainId,
      type: 'eip1559',
    });
    return { rawTx: serialized, hash: keccak256(serialized) };
  };

  return { sign, address: account.address };
}

async function estimateGas(pool: RpcPool, from: Hex, req: TxRequest, fallback: bigint): Promise<bigint> {
  try {
    const est = await pool.read((c: PublicClient) =>
      c.estimateGas({ account: from, to: req.to, data: req.data, value: req.value ?? 0n }),
    );
    // 20% headroom over the estimate.
    return (est * 12n) / 10n;
  } catch {
    return fallback;
  }
}

/** Re-export for callers that only need serialization (e.g. tests). */
export { serializeTransaction };
