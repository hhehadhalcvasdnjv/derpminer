import { encodeFunctionData, decodeEventLog, type Hex } from 'viem';
import type { MineProfile } from '../chain/registry.js';
import type { TxQueue } from '../chain/txQueue.js';
import type { ShiftSubmitter } from '../core/shiftEngine.js';

/** The queue surface the submitter needs (keeps it unit-testable). */
export interface SubmitterQueue {
  submit(req: { to: Hex; data: Hex; value?: bigint }): Promise<{ receipt: { logs: readonly unknown[] } }>;
}

/**
 * Encodes the mine's write calls and hands them to the TxQueue. In shadow mode
 * every clock-in is funded from the on-chain tank, so `value` is always 0 (the
 * shadow key holds no fee money). Direct mode — for owners mining their own
 * broker on the ETH floor — passes the quoted fee as `value`.
 */
export class Submitter implements ShiftSubmitter {
  private readonly mine: MineProfile;
  private readonly queue: SubmitterQueue;
  private readonly directFee?: (tokenId: bigint, slot: bigint) => Promise<bigint>;

  constructor(mine: MineProfile, queue: SubmitterQueue, opts?: { directFee?: (tokenId: bigint, slot: bigint) => Promise<bigint> }) {
    this.mine = mine;
    this.queue = queue;
    this.directFee = opts?.directFee;
  }

  private encode(fn: string, args: readonly unknown[]): Hex {
    return encodeFunctionData({ abi: this.mine.abi, functionName: fn, args });
  }

  async activate(tokenId: bigint, slot: bigint, feeValue: bigint): Promise<void> {
    // Activation is an owner action. On the APE floor the fee is pulled via
    // transferFrom (value 0, requires a prior approve); on the ETH floor it is
    // sent as value.
    const value = this.mine.feeAsset === 'APE' ? 0n : feeValue;
    await this.queue.submit({ to: this.mine.address, data: this.encode('activate', [tokenId, slot]), value });
  }

  async clockIn(tokenId: bigint, slot: bigint): Promise<void> {
    let value = 0n;
    if (this.directFee && this.mine.feeAsset === 'ETH') {
      value = await this.directFee(tokenId, slot);
    }
    await this.queue.submit({ to: this.mine.address, data: this.encode('clockIn', [tokenId, slot]), value });
  }

  async clockOut(tokenId: bigint, slot: bigint, ticks: bigint): Promise<{ reward: bigint }> {
    const { receipt } = await this.queue.submit({
      to: this.mine.address,
      data: this.encode('clockOut', [tokenId, slot, ticks]),
      value: 0n,
    });
    return { reward: this.extractReward(receipt.logs, tokenId, slot) };
  }

  /** Pull the printed reward from the ClockedOut event in the receipt logs. */
  private extractReward(logs: readonly unknown[], tokenId: bigint, slot: bigint): bigint {
    for (const raw of logs) {
      const lg = raw as { address?: Hex; topics?: [Hex, ...Hex[]] | []; data?: Hex };
      if (!lg.topics || lg.topics.length === 0 || !lg.data) continue;
      if (lg.address && lg.address.toLowerCase() !== this.mine.address.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: this.mine.abi, topics: lg.topics, data: lg.data });
        if (ev.eventName === 'ClockedOut') {
          const a = ev.args as unknown as { tokenId: bigint; slot: bigint; reward: bigint };
          if (a.tokenId === tokenId && a.slot === slot) return a.reward;
        }
      } catch {
        // not a mine event we recognize — skip
      }
    }
    return 0n;
  }
}
