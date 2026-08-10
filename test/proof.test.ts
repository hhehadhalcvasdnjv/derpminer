import { describe, it, expect } from 'vitest';
import {
  proofPreimage,
  proofHash,
  hasSuffix,
  slotProofHashGenesis,
  findSolutionSync,
  findSolution,
  SUFFIX,
} from '../src/core/proof.js';
import type { Hex } from 'viem';

// Verified on-chain golden vector: PitBoysMine, token 742, slot 3.
// ClockedOut(ticks=13786224) produced proofHash ...cd5d3129.
const MINE = '0x6FeD5aE5d486A59081FDC040179CEBDA4be80511' as Hex;
const PREV = '0x17347f74003be08a6aeb74c8b47ab0a7bfcf1b188fff228ab382a60dd45d3129' as Hex;
const SEED = '0xa08d71887f097dd147ce3c17899f11fa0ed570b34f6a0ade3a3c3d1f0d300cfa' as Hex;
const EXPECTED = '0xd2628e42fdfedb9f998a4cd1ff997d5892ccdbaa52c6ccca9de68812cd5d3129';

describe('proof golden vector (PitBoys token 742 slot 3)', () => {
  it('reproduces the on-chain proof hash exactly', () => {
    const h = proofHash({ mine: MINE, tokenId: 742n, ticks: 13786224n, prevProofHash: PREV, grindSeed: SEED });
    expect(h).toBe(EXPECTED);
  });

  it('the golden hash carries the suffix', () => {
    expect(hasSuffix(EXPECTED as Hex)).toBe(true);
  });

  it('rejects a non-suffix hash', () => {
    expect(hasSuffix(('0x' + '00'.repeat(32)) as Hex)).toBe(false);
  });

  it('preimage is exactly 148 bytes', () => {
    const pre = proofPreimage({ mine: MINE, tokenId: 742n, ticks: 13786224n, prevProofHash: PREV, grindSeed: SEED });
    expect(pre.length).toBe(148);
  });

  it('SUFFIX is 0x5d3129', () => {
    expect(SUFFIX).toBe('0x5d3129');
  });
});

describe('slot genesis', () => {
  it('slot 0 genesis is zero', () => {
    expect(slotProofHashGenesis(742n, 0n)).toBe('0x' + '00'.repeat(32));
  });

  it('slot>0 genesis is keccak256(pack(tokenId,slot))', () => {
    // cast keccak (0x0..2e6 ++ 0x0..03) — computed independently.
    expect(slotProofHashGenesis(742n, 3n)).toBe(
      '0xf134e874a7011e95723ed46ffd7389d1fbb6c64b2986e1c52cd2d8ef0a0f8f7e',
    );
  });
});

describe('findSolutionSync', () => {
  it('finds the exact golden tick when the search window contains it', () => {
    // Start a little before the known solution and confirm we land on it,
    // proving no earlier tick in this window also satisfies the suffix.
    const sol = findSolutionSync({
      mine: MINE,
      tokenId: 742n,
      prevProofHash: PREV,
      grindSeed: SEED,
      startTick: 13786224n - 5000n,
      maxTicks: 6000n,
    });
    expect(sol).not.toBeNull();
    expect(sol!.ticks).toBe(13786224n);
    expect(sol!.hash).toBe(EXPECTED);
  });

  it('returns null for a dry range', () => {
    const sol = findSolutionSync({
      mine: MINE,
      tokenId: 742n,
      prevProofHash: PREV,
      grindSeed: SEED,
      startTick: 0n,
      maxTicks: 100n,
    });
    expect(sol).toBeNull();
  });
});

// These grind millions of real hashes (~10-25s). Gated so `npm test` stays
// fast; run with DERP_SLOW_TESTS=1 (CI / pre-release) to exercise the worker.
const SLOW = !!process.env.DERP_SLOW_TESTS;

describe.runIf(SLOW)('findSolution (worker thread)', () => {
  it('finds a valid suffix solution off the main thread and it verifies', async () => {
    const sol = await findSolution({
      mine: MINE,
      tokenId: 742n,
      prevProofHash: PREV,
      grindSeed: SEED,
      chunkTicks: 1n << 22n,
      maxChunks: 16,
    });
    expect(sol).not.toBeNull();
    expect(hasSuffix(sol!.hash)).toBe(true);
    // Independently recompute the hash for the returned tick.
    expect(proofHash({ mine: MINE, tokenId: 742n, ticks: sol!.ticks, prevProofHash: PREV, grindSeed: SEED })).toBe(
      sol!.hash,
    );
  }, 60_000);

  it('is the lowest-tick solution (matches sequential search)', async () => {
    const viaWorker = await findSolution({ mine: MINE, tokenId: 742n, prevProofHash: PREV, grindSeed: SEED });
    const seq = findSolutionSync({
      mine: MINE,
      tokenId: 742n,
      prevProofHash: PREV,
      grindSeed: SEED,
      startTick: 0n,
      maxTicks: viaWorker!.ticks + 1n,
    });
    expect(viaWorker!.ticks).toBe(seq!.ticks);
  }, 60_000);
});
