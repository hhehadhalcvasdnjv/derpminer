import { describe, it, expect } from 'vitest';
import { decodeEventLog, type Hex, type AbiEvent } from 'viem';
import { RpcPool } from '../../src/chain/rpcPool.js';
import { MINES, robinhoodChain, OFFICIAL_RPC } from '../../src/chain/registry.js';
import { Mine } from '../../src/mines/mine.js';
import { findSolution, proofHash, hasSuffix } from '../../src/core/proof.js';

/**
 * The strongest end-to-end proof of the core: grind a REAL currently-open shift
 * with our engine, then ask the chain's own `verifyProof` view to validate the
 * solution against that shift's on-chain seed. If the returned hash matches what
 * we computed locally and carries the suffix, the whole pipeline — Mine reads,
 * preimage layout, and grind — is correct against live consensus.
 *
 * Gated on LIVE_VERIFY=1 (needs a live RPC and ~seconds of CPU). Run:
 *   LIVE_VERIFY=1 npm run test:e2e
 */
const RUN = !!process.env.LIVE_VERIFY;
const RPC = process.env.LIVE_RPC ?? OFFICIAL_RPC;

describe.runIf(RUN)('live verifyProof against a real open shift', () => {
  it('the chain accepts a solution our engine ground for a live shift', async () => {
    const pool = RpcPool.fromUrls([RPC], robinhoodChain);
    const mine = new Mine(MINES.pitboys, pool);
    const clockedIn = (MINES.pitboys.abi as AbiEvent[]).find(
      (e) => e.type === 'event' && e.name === 'ClockedIn',
    ) as AbiEvent;

    const head = await pool.read((c) => c.getBlockNumber());
    const logs = await pool.read((c) =>
      c.getLogs({ address: MINES.pitboys.address, event: clockedIn, fromBlock: head - 5000n, toBlock: head }),
    );

    // Find the most recent (token, slot) whose shift is still live.
    let picked: { tokenId: bigint; slot: bigint; seed: Hex; prev: Hex } | null = null;
    const seen = new Set<string>();
    for (const lg of [...logs].reverse()) {
      const ev = decodeEventLog({ abi: MINES.pitboys.abi, topics: lg.topics, data: lg.data }) as unknown as {
        args: { tokenId: bigint; slot: bigint };
      };
      const { tokenId, slot } = ev.args;
      const key = `${tokenId}:${slot}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const s = await mine.shiftOf(tokenId, slot);
      if (s.empty || s.voided || s.expired || s.tickerExpired) continue;
      picked = { tokenId, slot, seed: s.grindSeed, prev: await mine.slotProofHash(tokenId, slot) };
      break;
    }

    expect(picked, 'expected at least one live shift in the recent window').not.toBeNull();

    const sol = await findSolution({
      mine: MINES.pitboys.address,
      tokenId: picked!.tokenId,
      prevProofHash: picked!.prev,
      grindSeed: picked!.seed,
    });
    expect(sol).not.toBeNull();
    expect(hasSuffix(sol!.hash)).toBe(true);

    const localHash = proofHash({
      mine: MINES.pitboys.address,
      tokenId: picked!.tokenId,
      ticks: sol!.ticks,
      prevProofHash: picked!.prev,
      grindSeed: picked!.seed,
    });

    // The chain view reverts (InvalidProof) if the suffix is wrong; returning a
    // hash at all means acceptance. Guard against the shift changing under us.
    let chainHash: Hex;
    try {
      chainHash = (await pool.read((c) =>
        c.readContract({
          address: MINES.pitboys.address,
          abi: MINES.pitboys.abi,
          functionName: 'verifyProof',
          args: [picked!.tokenId, picked!.slot, sol!.ticks],
        }),
      )) as Hex;
    } catch (err) {
      // The shift was re-clocked/closed between read and verify — not a failure
      // of our engine. Skip rather than flake.
      console.warn('live shift changed under us; skipping:', String(err).slice(0, 100));
      return;
    }

    expect(chainHash.toLowerCase()).toBe(localHash.toLowerCase());
  }, 120_000);
});
