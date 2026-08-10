import { describe, it, expect } from 'vitest';
import { decodeFunctionData, encodeEventTopics, encodeAbiParameters, type Hex } from 'viem';
import { Submitter, type SubmitterQueue } from '../src/mines/submitter.js';
import { MINES } from '../src/chain/registry.js';

interface Captured {
  to: Hex;
  data: Hex;
  value?: bigint;
}

function spyQueue(logs: readonly unknown[] = []): { queue: SubmitterQueue; calls: Captured[] } {
  const calls: Captured[] = [];
  const queue: SubmitterQueue = {
    submit: async (req) => {
      calls.push(req);
      return { receipt: { logs } };
    },
  };
  return { queue, calls };
}

/** Build a real ClockedOut log the submitter can decode. */
function clockedOutLog(mine: Hex, tokenId: bigint, slot: bigint, reward: bigint): { address: Hex; topics: Hex[]; data: Hex } {
  const abi = MINES.pitboys.abi;
  const topics = encodeEventTopics({
    abi,
    eventName: 'ClockedOut',
    args: { tokenId, slot, worker: '0x000000000000000000000000000000000000dEaD' },
  }) as Hex[];
  // Non-indexed: ticks, elapsed, reward, index, proofHash
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }],
    [13786224n, 700n, reward, 90n, ('0x' + '00'.repeat(29) + '5d3129') as Hex],
  );
  return { address: mine, topics, data };
}

describe('Submitter clock-in encoding', () => {
  it('encodes clockIn with value 0 on the APE floor (tank-funded)', async () => {
    const { queue, calls } = spyQueue();
    const sub = new Submitter(MINES.pitboys, queue);
    await sub.clockIn(742n, 3n);
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe(MINES.pitboys.address);
    expect(calls[0].value).toBe(0n);
    const decoded = decodeFunctionData({ abi: MINES.pitboys.abi, data: calls[0].data });
    expect(decoded.functionName).toBe('clockIn');
    expect(decoded.args).toEqual([742n, 3n]);
  });

  it('passes the quoted fee as value in ETH direct mode', async () => {
    const { queue, calls } = spyQueue();
    const sub = new Submitter(MINES.broker, queue, { directFee: async () => 4_996_000_000_000n });
    await sub.clockIn(1n, 0n);
    expect(calls[0].value).toBe(4_996_000_000_000n);
  });
});

describe('Submitter clock-out reward extraction', () => {
  it('returns the reward from the matching ClockedOut event', async () => {
    const reward = 4_444n * 10n ** 18n;
    const { queue } = spyQueue([clockedOutLog(MINES.pitboys.address, 742n, 3n, reward)]);
    const sub = new Submitter(MINES.pitboys, queue);
    const r = await sub.clockOut(742n, 3n, 13786224n);
    expect(r.reward).toBe(reward);
  });

  it('ignores a ClockedOut for a different slot', async () => {
    const { queue } = spyQueue([clockedOutLog(MINES.pitboys.address, 742n, 9n, 4_444n * 10n ** 18n)]);
    const sub = new Submitter(MINES.pitboys, queue);
    const r = await sub.clockOut(742n, 3n, 13786224n);
    expect(r.reward).toBe(0n); // no matching event
  });

  it('encodes clockOut with the ticks and zero value', async () => {
    const { queue, calls } = spyQueue([clockedOutLog(MINES.pitboys.address, 742n, 3n, 44n * 10n ** 18n)]);
    const sub = new Submitter(MINES.pitboys, queue);
    await sub.clockOut(742n, 3n, 13786224n);
    const decoded = decodeFunctionData({ abi: MINES.pitboys.abi, data: calls[0].data });
    expect(decoded.functionName).toBe('clockOut');
    expect(decoded.args).toEqual([742n, 3n, 13786224n]);
    expect(calls[0].value).toBe(0n);
  });
});
