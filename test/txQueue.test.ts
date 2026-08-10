import { describe, it, expect, vi } from 'vitest';
import { TxQueue, type PoolLike, type SignFn } from '../src/chain/txQueue.js';
import type { Hex, TransactionReceipt } from 'viem';

const ACCOUNT = { address: '0x0000000000000000000000000000000000000001' as Hex };

function receipt(hash: Hex): TransactionReceipt {
  return { transactionHash: hash, status: 'success' } as unknown as TransactionReceipt;
}

/** A signer that records every (nonce, fee) it was asked to sign. */
function recordingSigner(): { sign: SignFn; calls: Array<{ nonce: number; maxFeePerGas: bigint }> } {
  const calls: Array<{ nonce: number; maxFeePerGas: bigint }> = [];
  const sign: SignFn = async (req) => {
    calls.push({ nonce: req.nonce, maxFeePerGas: req.maxFeePerGas });
    return { rawTx: ('0x' + req.nonce.toString(16).padStart(2, '0') + 'ff') as Hex, hash: ('0x' + 'a'.repeat(64)) as Hex };
  };
  return { sign, calls };
}

describe('TxQueue', () => {
  it('reads the start nonce from chain and mines on the first attempt', async () => {
    const { sign, calls } = recordingSigner();
    const pool: PoolLike = {
      read: vi.fn(async () => 5),
      hedgedSend: vi.fn(async () => '0xhash' as Hex),
      waitForReceipt: vi.fn(async () => receipt('0xhash' as Hex)),
    };
    const q = new TxQueue({ account: ACCOUNT, pool, signTx: sign, confirmMs: 100 });
    const r = await q.submit({ to: '0x2' as Hex, data: '0x' as Hex });
    expect(calls[0].nonce).toBe(5);
    expect(r.attempts).toBe(1);
    expect(r.receipt.status).toBe('success');
  });

  it('assigns sequential nonces across submits', async () => {
    const { sign, calls } = recordingSigner();
    const pool: PoolLike = {
      read: vi.fn(async () => 10),
      hedgedSend: vi.fn(async () => '0xhash' as Hex),
      waitForReceipt: vi.fn(async () => receipt('0xhash' as Hex)),
    };
    const q = new TxQueue({ account: ACCOUNT, pool, signTx: sign, confirmMs: 100 });
    await q.submit({ to: '0x2' as Hex, data: '0x' as Hex });
    await q.submit({ to: '0x3' as Hex, data: '0x' as Hex });
    expect(calls.map((c) => c.nonce)).toEqual([10, 11]);
  });

  it('bumps gas on the same nonce when the first attempt does not confirm', async () => {
    const { sign, calls } = recordingSigner();
    const waitForReceipt = vi
      .fn<[Hex, number?], Promise<TransactionReceipt | null>>()
      .mockResolvedValueOnce(null) // first attempt times out
      .mockResolvedValue(receipt('0xhash' as Hex)); // bumped attempt lands
    const pool: PoolLike = {
      read: vi.fn(async () => 7),
      hedgedSend: vi.fn(async () => '0xhash' as Hex),
      waitForReceipt,
    };
    const q = new TxQueue({ account: ACCOUNT, pool, signTx: sign, confirmMs: 50 });
    const r = await q.submit({ to: '0x2' as Hex, data: '0x' as Hex });
    expect(calls).toHaveLength(2);
    expect(calls[0].nonce).toBe(7);
    expect(calls[1].nonce).toBe(7); // same nonce
    expect(calls[1].maxFeePerGas).toBeGreaterThan(calls[0].maxFeePerGas); // bumped
    expect(r.attempts).toBe(2);
  });

  it('gives up after maxAttempts if never mined', async () => {
    const { sign } = recordingSigner();
    const pool: PoolLike = {
      read: vi.fn(async () => 0),
      hedgedSend: vi.fn(async () => '0xhash' as Hex),
      waitForReceipt: vi.fn(async () => null),
    };
    const q = new TxQueue({ account: ACCOUNT, pool, signTx: sign, confirmMs: 10, maxAttempts: 3 });
    await expect(q.submit({ to: '0x2' as Hex, data: '0x' as Hex })).rejects.toThrow(/not mined after 3/);
  });
});
