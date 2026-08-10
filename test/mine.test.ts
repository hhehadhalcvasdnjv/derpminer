import { describe, it, expect } from 'vitest';
import type { Hex, PublicClient } from 'viem';
import { MINES, robinhoodChain, MAX_SLOTS } from '../src/chain/registry.js';
import { Mine, type MineReader } from '../src/mines/mine.js';
import { slotProofHashGenesis } from '../src/core/proof.js';

/** A reader that answers readContract from a canned map keyed by function name. */
function cannedReader(answers: Record<string, unknown>): MineReader {
  const client = {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (!(functionName in answers)) throw new Error(`no canned answer for ${functionName}`);
      return answers[functionName];
    },
  } as unknown as PublicClient;
  return { read: (fn) => fn(client) };
}

describe('registry', () => {
  it('defines Robinhood Chain 4663 and both mines', () => {
    expect(robinhoodChain.id).toBe(4663);
    expect(MAX_SLOTS).toBe(16);
    expect(MINES.broker.feeAsset).toBe('ETH');
    expect(MINES.broker.bodiesBackSlots).toBe(false);
    expect(MINES.pitboys.feeAsset).toBe('APE');
    expect(MINES.pitboys.bodiesBackSlots).toBe(true);
    expect(MINES.pitboys.address.toLowerCase()).toBe('0x6fed5ae5d486a59081fdc040179cebda4be80511');
    expect(MINES.pitboys.feeToken?.toLowerCase()).toBe('0x8f86a15ec17cb3369d8b3e666dadbc11daa82b79');
  });
});

describe('Mine.shiftOf', () => {
  it('decodes the shift struct and flags an empty shift by zero worker', async () => {
    const zero = ('0x' + '00'.repeat(32)) as Hex;
    const empty = new Mine(
      MINES.pitboys,
      cannedReader({ shiftOf: ['0x0000000000000000000000000000000000000000', 0n, 0n, false, false, zero, false, 0n, 0n] }),
    );
    const s = await empty.shiftOf(742n, 3n);
    expect(s.empty).toBe(true);

    const live = new Mine(
      MINES.pitboys,
      cannedReader({
        shiftOf: ['0x5e081a3A8aD90552a5CDf74fB6d907Dd2a3AcB90', 1786361207n, 15760000n, false, false,
          '0x0c1d625ac0d7282375346227b7f1f5543c96365de6a85ddceccb75f399ecabb7', false, 2140241n, 2990n],
      }),
    );
    const ls = await live.shiftOf(742n, 3n);
    expect(ls.empty).toBe(false);
    expect(ls.startTime).toBe(1786361207n);
    expect(ls.grindSeed).toBe('0x0c1d625ac0d7282375346227b7f1f5543c96365de6a85ddceccb75f399ecabb7');
    expect(ls.printsRemaining).toBe(2990n);
  });
});

describe('Mine.slotProofHashResilient', () => {
  it('applies keccak genesis when lastProofHash is zero for slot>0', async () => {
    const mine = new Mine(MINES.pitboys, cannedReader({ lastProofHash: '0x' + '00'.repeat(32) }));
    const h = await mine.slotProofHashResilient(742n, 3n);
    expect(h).toBe(slotProofHashGenesis(742n, 3n));
  });
  it('returns the raw lastProofHash when non-zero', async () => {
    const raw = '0x7112a44e47493c9545401b975f95ff0a64cd00d0c30b3ca86bfae924655d3129' as Hex;
    const mine = new Mine(MINES.pitboys, cannedReader({ lastProofHash: raw }));
    expect(await mine.slotProofHashResilient(742n, 3n)).toBe(raw);
  });
});

describe('Mine.tankOf', () => {
  it('decodes balance/reserved/withdrawable', async () => {
    const mine = new Mine(MINES.pitboys, cannedReader({ tankOf: [100n, 40n, 60n] }));
    const t = await mine.tankOf('0x0000000000000000000000000000000000000001');
    expect(t).toEqual({ balance: 100n, reserved: 40n, withdrawable: 60n });
  });
});
