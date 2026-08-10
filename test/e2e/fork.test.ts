import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  decodeEventLog,
  type Hex,
  type AbiEvent,
  type PublicClient,
} from 'viem';
import { MINES, robinhoodChain, DERP, ABIS } from '../../src/chain/registry.js';
import { Mine } from '../../src/mines/mine.js';
import { RpcPool } from '../../src/chain/rpcPool.js';
import { findSolution } from '../../src/core/proof.js';

/**
 * Full write-path proof against real bytecode: fork Robinhood Chain with anvil,
 * find a live shift, grind its solution with our engine, warp past the pace cap,
 * impersonate the shift's worker, and clock out. Asserts a ClockedOut event with
 * reward > 0 and that the mine's DERP pool actually pays it out.
 *
 * Gated on FORK_RPC (the upstream RPC anvil forks). Run:
 *   FORK_RPC=https://rpc.mainnet.chain.robinhood.com npm run test:e2e
 */
const FORK_RPC = process.env.FORK_RPC;
const PORT = Number(process.env.ANVIL_PORT ?? 8578);
const LOCAL = `http://127.0.0.1:${PORT}`;

let anvil: ChildProcess | undefined;

async function waitForRpc(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('anvil did not become ready');
}

beforeAll(async () => {
  if (!FORK_RPC) return;
  anvil = spawn('anvil', ['--fork-url', FORK_RPC, '--port', String(PORT), '--silent'], { stdio: 'ignore' });
  await waitForRpc(LOCAL, 60_000);
}, 90_000);

afterAll(() => {
  anvil?.kill('SIGKILL');
});

describe.runIf(!!FORK_RPC)('fork e2e: full clock-out loop against deployed bytecode', () => {
  it('grinds a live shift and clocks it out for real DERP', async () => {
    const transport = http(LOCAL);
    const pub = createPublicClient({ chain: robinhoodChain, transport }) as PublicClient;
    const test = createTestClient({ chain: robinhoodChain, transport, mode: 'anvil' });
    const wallet = createWalletClient({ chain: robinhoodChain, transport });
    const pool = RpcPool.fromUrls([LOCAL], robinhoodChain);
    const mine = new Mine(MINES.pitboys, pool);

    const pace = await mine.maxTicksPerSecond();

    // Find a live shift and its worker from recent ClockedIn events.
    const clockedIn = (MINES.pitboys.abi as AbiEvent[]).find((e) => e.type === 'event' && e.name === 'ClockedIn')!;
    const head = await pub.getBlockNumber();
    const logs = await pub.getLogs({ address: MINES.pitboys.address, event: clockedIn, fromBlock: head - 5000n, toBlock: head });

    let picked: { tokenId: bigint; slot: bigint; worker: Hex; seed: Hex; prev: Hex; startTime: bigint } | null = null;
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
      picked = { tokenId, slot, worker: s.worker, seed: s.grindSeed, prev: await mine.slotProofHash(tokenId, slot), startTime: s.startTime };
      break;
    }
    expect(picked, 'expected a live shift to clock out').not.toBeNull();

    // Grind the real solution with our engine.
    const sol = await findSolution({ mine: MINES.pitboys.address, tokenId: picked!.tokenId, prevProofHash: picked!.prev, grindSeed: picked!.seed });
    expect(sol).not.toBeNull();

    // Warp the fork so the pace cap clears: need elapsed*pace >= ticks.
    const latest = await pub.getBlock({ blockTag: 'latest' });
    const needElapsed = sol!.ticks / pace + 1n;
    const haveElapsed = latest.timestamp - picked!.startTime;
    if (haveElapsed < needElapsed) {
      await test.increaseTime({ seconds: Number(needElapsed - haveElapsed) + 30 });
    }
    await test.mine({ blocks: 1 });

    // Fund + impersonate the worker, then clock out against real bytecode.
    await test.setBalance({ address: picked!.worker, value: 10n ** 18n });
    await test.impersonateAccount({ address: picked!.worker });

    const poolBefore = (await pub.readContract({ address: DERP, abi: ABIS.derp, functionName: 'balanceOf', args: [MINES.pitboys.address] })) as bigint;

    const hash = await wallet.writeContract({
      account: picked!.worker,
      address: MINES.pitboys.address,
      abi: MINES.pitboys.abi,
      functionName: 'clockOut',
      args: [picked!.tokenId, picked!.slot, sol!.ticks],
      chain: robinhoodChain,
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');

    // Decode the ClockedOut reward from the receipt.
    let reward = 0n;
    for (const lg of receipt.logs) {
      if (lg.address.toLowerCase() !== MINES.pitboys.address.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: MINES.pitboys.abi, topics: lg.topics, data: lg.data }) as unknown as {
          eventName: string;
          args: { reward: bigint; tokenId: bigint; slot: bigint };
        };
        if (ev.eventName === 'ClockedOut' && ev.args.tokenId === picked!.tokenId && ev.args.slot === picked!.slot) {
          reward = ev.args.reward;
        }
      } catch {
        // not a mine event
      }
    }
    expect(reward).toBeGreaterThan(0n);

    // The mine paid the reward out of its DERP pool.
    const poolAfter = (await pub.readContract({ address: DERP, abi: ABIS.derp, functionName: 'balanceOf', args: [MINES.pitboys.address] })) as bigint;
    expect(poolBefore - poolAfter).toBe(reward);
  }, 200_000);
});
