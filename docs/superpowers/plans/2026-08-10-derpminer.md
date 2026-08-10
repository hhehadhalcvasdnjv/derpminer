# derpminer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A headless, RPC-resilient CLI daemon that mines $DERP on both StonkPit floors (StonkBrokers + PitBoys) by scheduling proof submissions instead of continuously grinding.

**Architecture:** Node/TypeScript + viem. Per-shift the miner precomputes the SHA256 solution once in a worker thread, then sleeps until chain time allows submission and broadcasts the clock-out hedged across a health-scored RPC pool. Default wallet mode is the protocol's own "shadow key" (owner signs a budgeted grant once; the hot key never holds funds).

**Tech Stack:** TypeScript (ESM, Node ≥20), viem, vitest, worker_threads, foundry/anvil (fork E2E), commander (CLI).

---

## Verified facts (do not re-derive; these are load-bearing)

- **Chain:** Robinhood Chain mainnet, chainId **4663**, RPC `https://rpc.mainnet.chain.robinhood.com`.
- **Contracts:** PitMine (broker, ETH) `0x2d0da469115232aD00159757f9d25f81D498206D` · PitBoysMine (APE) `0x6FeD5aE5d486A59081FDC040179CEBDA4be80511` · DERP `0x6543B7746ca744C4bb2198191E71f40FF04C41b9` · StonkBrokers `0x539CdD042c2f3d93EbC5BE7DfFf0c79F3B4fAbF0` · PitBoys `0x57069d845701B50F41327362C1C23789043F8DEc` · APE `0x8f86a15EC17cb3369d8b3E666dAdBC11daA82b79`.
- **Proof:** `sha256(pack(mineAddr:20, tokenId:uint256, ticks:uint256, slotProofHash:bytes32, grindSeed:bytes32))`, low 3 bytes must equal `0x5d3129`. **Verified byte-exact** against on-chain proof: mine=PitBoysMine, tokenId=742, slot=3, ticks=13786224, prev=`0x17347f74003be08a6aeb74c8b47ab0a7bfcf1b188fff228ab382a60dd45d3129`, seed=`0xa08d71887f097dd147ce3c17899f11fa0ed570b34f6a0ade3a3c3d1f0d300cfa` → `0xd2628e42fdfedb9f998a4cd1ff997d5892ccdbaa52c6ccca9de68812cd5d3129`. This is the golden test vector.
- **slotProofHash:** `lastProofHash[tokenId][slot]`; if zero and slot≠0 → `keccak256(pack(tokenId:uint256, slot:uint256))`; slot 0 genesis = `0x0`.
- **Pace:** submit requires `ticks ≤ (chainNow − startTime) × maxTicksPerSecond` (20000). **grace** 150s. Reward via on-chain `previewPrint(tokenId, ticks)`.
- **grindSeed** is emitted in `ClockedIn` (field named `blockHash` in ABI is actually `slotProofHash`; the 7th field `grindSeed` is the seed) and readable via `shiftOf(tokenId, slot)`.
- **ClockedIn**(tokenId idx, slot idx, worker idx, bytes32 slotProofHash, uint256 fee, uint256 timestamp, bytes32 grindSeed, uint256 restarts, uint256 expiryTickerCount)
- **ClockedOut**(tokenId idx, slot idx, worker idx, uint256 ticks, uint256 elapsed, uint256 reward, uint256 index, bytes32 proofHash)
- ABIs are pre-extracted in the scratchpad (`abi_pitMine.json`, `abi_pitBoysMine.json`, `abi_derp.json`) — copy them into `src/chain/abi/` in Task 1.

---

## File structure

```
package.json, tsconfig.json, vitest.config.ts, .gitignore, README.md
src/
  chain/abi/{pitMine,pitBoysMine,derp,erc20,erc721}.json
  chain/registry.ts        addresses, viem chain def, mine profiles
  chain/rpcPool.ts         health-scored multi-endpoint client + hedged send
  chain/txQueue.ts         nonce manager + serial send + gas-bump retry
  core/proof.ts            preimage, sha256 suffix check, chunked precompute
  core/proofWorker.ts      worker_threads grind entry
  core/schedule.ts         chain-time solve/grace window math
  core/shiftEngine.ts      per-slot state machine
  core/watcher.ts          log + state polling (tickerCount, certifiedCount, index)
  core/state.ts            atomic JSON persistence
  wallet/keystore.ts       encrypted hot-key at rest
  wallet/shadow.ts         owner setup tx builders (agree/approve/setShadow/depositTank)
  mines/mine.ts            Mine abstraction (broker vs pitboys fee asset, backing)
  economics.ts             EV/quote math from on-chain views
  cli.ts                   commander entry: init, shadow-setup, activate, run, status, quote, tank
  log.ts                   structured logger
test/
  proof.test.ts, schedule.test.ts, rpcPool.test.ts, txQueue.test.ts,
  shiftEngine.test.ts, economics.test.ts, state.test.ts
  e2e/fork.test.ts
```

---

## Task 1: Project scaffold

**Files:** Create `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/log.ts`, `src/chain/abi/*.json`.

- [ ] **Step 1: Write package.json**

```json
{
  "name": "derpminer",
  "version": "0.1.0",
  "type": "module",
  "bin": { "derpminer": "dist/cli.js" },
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "dev": "node --loader tsx src/cli.ts"
  },
  "dependencies": { "viem": "^2.21.0", "commander": "^12.1.0" },
  "devDependencies": {
    "typescript": "^5.6.0", "vitest": "^2.1.0", "tsx": "^4.19.0", "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 2: tsconfig.json** — `target ES2022`, `module NodeNext`, `moduleResolution NodeNext`, `strict true`, `resolveJsonModule true`, `outDir dist`, `rootDir src`, `verbatimModuleSyntax true`, `skipLibCheck true`. **vitest.config.ts** — default node env, `include: ['test/**/*.test.ts']`, exclude `test/e2e/**` from the default `test` script (separate `test:e2e`). **.gitignore** — `node_modules dist .derpminer *.local .env`.

- [ ] **Step 3: Copy ABIs** — copy the four scratchpad ABIs into `src/chain/abi/` and add a minimal `erc20.json` (approve/allowance/balanceOf/transfer) and `erc721.json` (ownerOf/isApprovedForAll/setApprovalForAll).

```bash
cp /private/tmp/claude-501/-Users-b-yo/*/scratchpad/abi_pitMine.json src/chain/abi/pitMine.json
cp /private/tmp/claude-501/-Users-b-yo/*/scratchpad/abi_pitBoysMine.json src/chain/abi/pitBoysMine.json
cp /private/tmp/claude-501/-Users-b-yo/*/scratchpad/abi_derp.json src/chain/abi/derp.json
```

- [ ] **Step 4: src/log.ts** — tiny leveled logger (`info/warn/error/debug`) writing JSON lines to stderr, honoring `DERPMINER_LOG=debug`. Export `log`.

- [ ] **Step 5:** `npm install`, then `npm run typecheck`. Expected: no errors.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "chore: scaffold derpminer (ts, viem, vitest, abis)"`

---

## Task 2: Proof engine (golden-vector TDD) — **the correctness core**

**Files:** Create `src/core/proof.ts`, `test/proof.test.ts`.

- [ ] **Step 1: Write the failing test** (`test/proof.test.ts`) using the verified golden vector.

```ts
import { describe, it, expect } from 'vitest';
import { proofPreimage, proofHash, hasSuffix, slotProofHashGenesis, SUFFIX } from '../src/core/proof.js';

const MINE = '0x6FeD5aE5d486A59081FDC040179CEBDA4be80511';
const PREV = '0x17347f74003be08a6aeb74c8b47ab0a7bfcf1b188fff228ab382a60dd45d3129';
const SEED = '0xa08d71887f097dd147ce3c17899f11fa0ed570b34f6a0ade3a3c3d1f0d300cfa';

describe('proof golden vector (PitBoys token 742 slot 3)', () => {
  it('reproduces the on-chain proof hash exactly', () => {
    const h = proofHash({ mine: MINE, tokenId: 742n, ticks: 13786224n, prevProofHash: PREV, grindSeed: SEED });
    expect(h).toBe('0xd2628e42fdfedb9f998a4cd1ff997d5892ccdbaa52c6ccca9de68812cd5d3129');
    expect(hasSuffix(h)).toBe(true);
  });
  it('preimage is exactly 148 bytes', () => {
    expect(proofPreimage({ mine: MINE, tokenId: 742n, ticks: 13786224n, prevProofHash: PREV, grindSeed: SEED }).length).toBe(148);
  });
  it('SUFFIX is 0x5d3129', () => expect(SUFFIX).toBe('0x5d3129'));
});

describe('slot genesis', () => {
  it('slot 0 genesis is zero', () => {
    expect(slotProofHashGenesis(742n, 0n)).toBe('0x' + '00'.repeat(32));
  });
  it('slot>0 genesis is keccak256(pack(tokenId,slot))', () => {
    // keccak256(abi.encodePacked(uint256(742), uint256(3)))
    expect(slotProofHashGenesis(742n, 3n)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/proof.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `src/core/proof.ts`.**

```ts
import { createHash } from 'node:crypto';
import { encodePacked, keccak256, type Hex } from 'viem';

export const SUFFIX = '0x5d3129' as const;
const SUFFIX_BYTES = Buffer.from(SUFFIX.slice(2), 'hex'); // [0x5d,0x31,0x29]

export interface ProofInput { mine: Hex; tokenId: bigint; ticks: bigint; prevProofHash: Hex; grindSeed: Hex; }

export function proofPreimage(i: ProofInput): Buffer {
  const packed = encodePacked(
    ['address', 'uint256', 'uint256', 'bytes32', 'bytes32'],
    [i.mine, i.tokenId, i.ticks, i.prevProofHash, i.grindSeed],
  );
  return Buffer.from(packed.slice(2), 'hex'); // 20+32+32+32+32 = 148
}

export function proofHash(i: ProofInput): Hex {
  return ('0x' + createHash('sha256').update(proofPreimage(i)).digest('hex')) as Hex;
}

export function hasSuffix(hash: Hex): boolean {
  const b = Buffer.from(hash.slice(2), 'hex');
  return b[b.length - 3] === SUFFIX_BYTES[0] && b[b.length - 2] === SUFFIX_BYTES[1] && b[b.length - 1] === SUFFIX_BYTES[2];
}

export function slotProofHashGenesis(tokenId: bigint, slot: bigint): Hex {
  if (slot === 0n) return ('0x' + '00'.repeat(32)) as Hex;
  return keccak256(encodePacked(['uint256', 'uint256'], [tokenId, slot]));
}
```

- [ ] **Step 4: Run** `npx vitest run test/proof.test.ts` → PASS (all 6). If the 148-byte or hash assertion fails, the preimage packing is wrong — do not proceed.

- [ ] **Step 5: Commit** — `git commit -am "feat(proof): sha256 preimage + suffix, verified vs on-chain golden vector"`

---

## Task 3: Chunked precompute + worker

**Files:** Create `src/core/proofWorker.ts`; extend `src/core/proof.ts` with `findSolution`; add tests to `test/proof.test.ts`.

- [ ] **Step 1: Add failing test** — grinding a known shift finds a tick whose hash has the suffix, and it verifies.

```ts
import { findSolution } from '../src/core/proof.js';
it('finds a valid solution for a fixed shift within a bounded search', async () => {
  const base = { mine: MINE, tokenId: 742n, prevProofHash: PREV, grindSeed: SEED };
  const sol = await findSolution({ ...base, startTick: 0n, maxTicks: 50_000_000n });
  expect(sol).not.toBeNull();
  expect(hasSuffix(proofHash({ ...base, ticks: sol!.ticks }))).toBe(true);
}, 60_000);
```

- [ ] **Step 2: Run** → FAIL (`findSolution` undefined).

- [ ] **Step 3: Implement** a synchronous `findSolutionSync(input, startTick, maxTicks)` that loops incrementing `ticks`, hashing, returning `{ ticks, hash }` on first suffix hit or `null`. Implement `findSolution` to offload to `proofWorker.ts` via `worker_threads` (post the input, worker runs `findSolutionSync` over its assigned range, returns result). Keep a synchronous fallback if `maxTicks ≤ 2_000_000` (tests/small ranges run inline). Worker splits nothing in v1 — one worker, sequential range (E[hits] over 50M ≈ 3, so a hit is near-certain; caller extends range if null).

- [ ] **Step 4: Run** → PASS. Note expected wall time (a few seconds).

- [ ] **Step 5: Commit** — `git commit -am "feat(proof): chunked precompute via worker_threads"`

---

## Task 4: Schedule math (chain-time solve window)

**Files:** Create `src/core/schedule.ts`, `test/schedule.test.ts`.

- [ ] **Step 1: Failing test.**

```ts
import { describe, it, expect } from 'vitest';
import { earliestSubmitTime, isInGrace, submitAtChainTime } from '../src/core/schedule.js';

const PACE = 20000n, GRACE = 150n;
describe('schedule', () => {
  it('earliest submit = startTime + ceil(ticks/pace)', () => {
    expect(earliestSubmitTime(1000n, 13786224n, PACE)).toBe(1000n + 690n); // 13786224/20000 = 689.31 -> 690
  });
  it('in grace iff chainNow*pace <= ticks + grace*pace', () => {
    const start = 1000n, ticks = 13786224n;
    const earliest = earliestSubmitTime(start, ticks, PACE);
    expect(isInGrace(start, earliest, ticks, PACE, GRACE)).toBe(true);
    expect(isInGrace(start, earliest + GRACE, ticks, PACE, GRACE)).toBe(true);
    expect(isInGrace(start, earliest + GRACE + 5n, ticks, PACE, GRACE)).toBe(false);
  });
  it('submitAtChainTime targets earliest + preBufferSeconds inside grace', () => {
    expect(submitAtChainTime(1000n, 13786224n, PACE, 2n)).toBe(1000n + 690n + 2n);
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `earliestSubmitTime = startTime + (ticks + pace - 1n)/pace` (ceil-div). `isInGrace(start, now, ticks, pace, grace) = (now - start) * pace <= ticks + grace*pace`. `submitAtChainTime(start, ticks, pace, preBuffer) = earliestSubmitTime(...) + preBuffer` (clamped so it stays in grace). All bigint.

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `git commit -am "feat(schedule): chain-time submit window math"`

---

## Task 5: RPC pool with health scoring + hedged send

**Files:** Create `src/chain/rpcPool.ts`, `test/rpcPool.test.ts`.

- [ ] **Step 1: Failing test** using viem's ability to inject a custom transport. Build a pool over three fake transports where one is slow, one errors, one is healthy; assert reads route to healthy, and `hedgedSend` broadcasts to all healthy and returns the first hash.

```ts
import { describe, it, expect, vi } from 'vitest';
import { RpcPool } from '../src/chain/rpcPool.js';

function fakeTransport(behavior: (method: string, params: any) => Promise<any>) {
  return () => ({ request: ({ method, params }: any) => behavior(method, params) });
}
describe('RpcPool', () => {
  it('routes reads to a healthy endpoint when one errors', async () => {
    const good = vi.fn(async (m) => m === 'eth_blockNumber' ? '0x10' : '0x1');
    const bad = vi.fn(async () => { throw new Error('boom'); });
    const pool = new RpcPool([
      { url: 'bad', transport: fakeTransport(bad) },
      { url: 'good', transport: fakeTransport(good) },
    ]);
    const bn = await pool.read((c) => c.getBlockNumber());
    expect(bn).toBe(16n);
  });
  it('hedgedSend broadcasts raw tx to all healthy endpoints', async () => {
    const seen: string[] = [];
    const mk = (url: string) => ({ url, transport: fakeTransport(async (m, p) => {
      if (m === 'eth_sendRawTransaction') { seen.push(url); return '0xabc'; }
      return '0x1';
    })});
    const pool = new RpcPool([mk('a'), mk('b')]);
    const hash = await pool.hedgedSend('0xdeadbeef');
    expect(hash).toBe('0xabc');
    expect(seen.sort()).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement `RpcPool`.** Each endpoint wraps a viem `createPublicClient({ chain, transport })`. Track EWMA latency + a rolling error flag per endpoint; `healthy()` filters out endpoints that errored on their last probe or lag > N blocks behind the max seen. `read(fn)` tries endpoints ordered by score, moving to the next on throw/timeout (2 tries min). `hedgedSend(rawTx)` calls `eth_sendRawTransaction` on every healthy endpoint via `Promise.any`, deduping the returned hash; swallow per-endpoint "already known"/nonce errors. Expose `waitForReceipt(hash)` that polls `getTransactionReceipt` across the pool. Add a `probe()` that refreshes block numbers; caller runs it on an interval.

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `git commit -am "feat(rpc): health-scored pool with failover reads + hedged sends"`

---

## Task 6: Nonce manager + tx queue with gas bump

**Files:** Create `src/chain/txQueue.ts`, `test/txQueue.test.ts`.

- [ ] **Step 1: Failing test** — serial ordering assigns sequential nonces; a send that times out is retried with higher `maxFeePerGas` on the same nonce.

```ts
import { describe, it, expect, vi } from 'vitest';
import { TxQueue } from '../src/chain/txQueue.js';

it('assigns sequential nonces and bumps gas on retry', async () => {
  const sent: any[] = [];
  const account = { address: '0x0000000000000000000000000000000000000001' } as any;
  const signed = vi.fn(async (tx: any) => { sent.push(tx); return ('0x' + tx.nonce.toString(16)) as `0x${string}`; });
  const pool = {
    read: vi.fn(async () => 5n),                 // getTransactionCount -> start nonce 5
    hedgedSend: vi.fn(async () => '0xhash'),
    waitForReceipt: vi.fn()
      .mockResolvedValueOnce(null)               // first attempt times out
      .mockResolvedValue({ status: 'success' }), // bumped attempt lands
  } as any;
  const q = new TxQueue({ account, pool, signTx: signed, startNonceFrom: 'chain' });
  const r = await q.submit({ to: '0x2', data: '0x', gas: 100000n });
  expect(sent[0].nonce).toBe(5);
  expect(sent[1].nonce).toBe(5);
  expect(sent[1].maxFeePerGas).toBeGreaterThan(sent[0].maxFeePerGas);
  expect(r.receipt.status).toBe('success');
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `TxQueue`: a promise-chain mutex serializes `submit`; nonce initialized from `pool.read(c=>c.getTransactionCount(...,'pending'))`, incremented locally on success; on `waitForReceipt` null after `confirmMs`, re-sign same nonce with `maxFeePerGas *= 1.25` (cap attempts at 4); on `nonce too low` resync from chain. Returns `{ hash, receipt }`. **Step 4: Run** → PASS. **Step 5: Commit** — `git commit -am "feat(tx): serial nonce queue with gas-bump retry"`

---

## Task 7: Registry + Mine abstraction

**Files:** Create `src/chain/registry.ts`, `src/mines/mine.ts`, `test/registry.test.ts`.

- [ ] **Step 1: Failing test** — registry exposes both mine profiles with correct addresses/fee assets; `Mine` reads live params (mocked pool) and computes `slotProofHash` using genesis fallback.

```ts
import { describe, it, expect, vi } from 'vitest';
import { MINES, robinhoodChain } from '../src/chain/registry.js';
import { Mine } from '../src/mines/mine.js';

it('has both mines with correct fee assets', () => {
  expect(robinhoodChain.id).toBe(4663);
  expect(MINES.broker.feeAsset).toBe('ETH');
  expect(MINES.pitboys.feeAsset).toBe('APE');
  expect(MINES.pitboys.address.toLowerCase()).toBe('0x6fed5ae5d486a59081fdc040179cebda4be80511');
});
it('slotProofHash falls back to genesis when lastProofHash is zero', async () => {
  const pool = { read: vi.fn(async () => ('0x' + '00'.repeat(32))) } as any;
  const mine = new Mine(MINES.pitboys, pool);
  const h = await mine.slotProofHash(742n, 3n);
  expect(h).not.toBe('0x' + '00'.repeat(32)); // keccak genesis for slot>0
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `registry.ts` (viem `defineChain` for 4663, `MINES` map with `{ address, feeAsset, nft, mineAbi }`) and `Mine` class wrapping a pool + mine profile: typed read helpers (`maxTicksPerSecond`, `graceSeconds`, `theIndex`, `previewPrint`, `shiftOf`, `clockInFeeFor`, `activationFee`, `tankOf`, `lastProofHash`) and `slotProofHash(tokenId, slot)` that reads `lastProofHash` then applies `slotProofHashGenesis` from proof.ts on zero. **Step 4: Run** → PASS. **Step 5: Commit** — `git commit -am "feat(chain): registry + Mine read abstraction"`

---

## Task 8: State persistence

**Files:** Create `src/core/state.ts`, `test/state.test.ts`.

- [ ] **Step 1: Failing test** — write then read round-trips per-slot records; write is atomic (temp+rename), bigints survive via string codec.

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { StateStore } from '../src/core/state.js';
it('round-trips slot state with bigints', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'derp-'));
  const s = new StateStore(join(dir, 'state.json'));
  await s.upsertSlot('pitboys', 742n, 3n, { phase: 'GRINDING', ticks: 13786224n, startTime: 1000n });
  const again = new StateStore(join(dir, 'state.json'));
  await again.load();
  expect(again.getSlot('pitboys', 742n, 3n)?.ticks).toBe(13786224n);
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `StateStore` with JSON serialization using a bigint-aware replacer/reviver (`{"$bigint":"..."}`), keys like `${mine}:${tokenId}:${slot}`, and atomic `writeFileSync(tmp)`+`renameSync`. **Step 4: Run** → PASS. **Step 5: Commit** — `git commit -am "feat(state): atomic json persistence with bigint codec"`

---

## Task 9: Shift engine (state machine)

**Files:** Create `src/core/shiftEngine.ts`, `test/shiftEngine.test.ts`.

- [ ] **Step 1: Failing test** — drive one slot through a full happy path with fakes (fake Mine returns a fixed shift/seed; fake clock; injected `findSolution` returning a known tick; fake submitter). Assert order: clockIn → wait until `earliestSubmitTime` → clockOut with the found ticks. Then a stale test: when `tickerCount` exceeds the shift's `expiryTickerCount`, engine issues a **free re-clock** (fee 0) rather than clocking out.

```ts
import { describe, it, expect, vi } from 'vitest';
import { ShiftEngine } from '../src/core/shiftEngine.js';
// fakes: deps = { mine, clock, findSolution, submitter, state, watcher }
it('runs clockIn -> grind -> waits -> clockOut', async () => {
  const events: string[] = [];
  const deps = makeFakeDeps({ events, ticksToFind: 13786224n, paceTps: 20000n, startTime: 1000n });
  const eng = new ShiftEngine('pitboys', 742n, 3n, deps);
  await eng.tickUntilPrinted();  // test helper advancing the fake clock
  expect(events).toEqual(['clockIn', 'grind', 'wait', 'clockOut']);
  expect(deps.submitter.clockOut).toHaveBeenCalledWith(742n, 3n, 13786224n);
});
it('free re-clocks a ticker-stale shift instead of clocking out', async () => {
  const events: string[] = [];
  const deps = makeFakeDeps({ events, staleAfterGrind: true });
  const eng = new ShiftEngine('pitboys', 742n, 3n, deps);
  await eng.tickUntilPrinted();
  expect(events).toContain('reclock:free');
  expect(events).not.toContain('clockOut');
});
```

Write `makeFakeDeps` in the test file — explicit fakes, no magic.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `ShiftEngine` with phases IDLE→CLOCKIN_SENT→GRINDING→WAITING→PRECHECK→CLOCKOUT_SENT→PRINTED and guard transitions TICKER_STALE→free re-clock, ORPHANED→(config `chaseTip`) free re-clock, TTL_NEAR→force clockout. It reads the seed from the `ClockedIn` receipt/`shiftOf`, calls injected `findSolution`, computes `earliestSubmitTime` from on-chain `startTime`, waits on the injected clock, `eth_call verifyProof` precheck, then hedged `clockOut`. Never restarts a healthy shift. Persists phase transitions via `state`. All external effects are injected deps (no direct viem here) so it stays unit-testable. **Step 4: Run** → PASS. **Step 5: Commit** — `git commit -am "feat(engine): per-slot shift state machine with stale/orphan handling"`

---

## Task 10: Watcher

**Files:** Create `src/core/watcher.ts`, `test/watcher.test.ts`.

- [ ] **Step 1: Failing test** — given a pool returning increasing `tickerCount`/`certifiedCount` and `getLogs` yielding a `ClockedOut`, watcher emits `stale-risk` when a tracked shift's expiry is crossed and `orphaned` when certified height advanced past a shift anchor.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `Watcher` as an `EventEmitter` polling on an interval: `tickerCount()`, `certifiedCount()`, `theIndex()` reads + `getLogs` for `ClockedOut`/`TickerCertified` since last block; compares against registered shifts (from state) and emits `stale-risk`, `orphaned`, `index-change`. Poll interval configurable (default 3s). **Step 4: Run** → PASS. **Step 5: Commit** — `git commit -am "feat(watcher): ticker/certified/index polling with stale+orphan signals"`

---

## Task 11: Economics / quote

**Files:** Create `src/economics.ts`, `test/economics.test.ts`.

- [ ] **Step 1: Failing test** — `expectedPrintPerShift` calls `previewPrint` at the expected solve tick and applies nothing extra; `evPerDay` divides by expected solve seconds and subtracts clock-in fee (in fee-asset). `breakEven` returns activation/clock-in inputs. Use mocked Mine reads.

```ts
it('computes EV/day from previewPrint and pace', async () => {
  const mine = { previewPrint: vi.fn(async () => 44n * 10n**18n), maxTicksPerSecond: vi.fn(async () => 20000n),
                 clockInFeeFor: vi.fn(async () => 10n**14n), theIndex: vi.fn(async () => 90n) } as any;
  const q = await quoteSlot(mine, 742n, 3n);
  expect(q.expectedPrint).toBe(44n * 10n**18n);
  expect(q.solveSeconds).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `economics.ts`: expected solve ticks = `2^24` (mean of geometric, P=2⁻²⁴), solveSeconds = `2^24 / pace`, `expectedPrint = previewPrint(tokenId, 2^24)`, shifts/day = `86400/solveSeconds`, `evPerDay = expectedPrint*shiftsPerDay`, minus `clockInFee*shiftsPerDay` (report DERP and fee-asset costs separately — no price oracle, no USD). **Step 4: Run** → PASS. **Step 5: Commit** — `git commit -am "feat(econ): on-chain EV/quote math (no price assumptions)"`

---

## Task 12: Keystore + shadow setup builders

**Files:** Create `src/wallet/keystore.ts`, `src/wallet/shadow.ts`, `test/shadow.test.ts`.

- [ ] **Step 1: Failing test** — `buildShadowSetup` returns the correct ordered calldata list for pitboys (agree, approve APE, setShadow, depositTank) and for broker (agree, setShadow, depositTank — no approve); each entry has `to`, `data`, human `summary`. Keystore encrypts/decrypts a private key with a passphrase round-trip.

```ts
it('builds pitboys shadow setup incl. APE approve', () => {
  const txs = buildShadowSetup({ mine: MINES.pitboys, tokenIds: [742n], operator: '0xhot',
    expiry: 9999999999n, budget: 10n**18n, maxFee: 10n**15n, tankDeposit: 5n*10n**18n });
  expect(txs.map(t => t.kind)).toEqual(['agree', 'approve', 'setShadow', 'depositTank']);
  expect(txs.find(t => t.kind === 'approve')!.to.toLowerCase()).toBe('0x8f86a15ec17cb3369d8b3e666dadbc11daa82b79');
});
it('broker shadow setup has no approve', () => {
  const txs = buildShadowSetup({ mine: MINES.broker, tokenIds: [1n], operator: '0xhot',
    expiry: 1n, budget: 1n, maxFee: 1n, tankDeposit: 1n });
  expect(txs.map(t => t.kind)).toEqual(['agree', 'setShadow', 'depositTank']);
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `keystore.ts` (scrypt + aes-256-gcm, stored under `~/.derpminer/keystore.json`, 0600) and `shadow.ts` `buildShadowSetup` using viem `encodeFunctionData` against the mine ABI (`agree()`, `setShadow(tokenIds,operator,expiry,budget,maxFee)`, `depositTank(amount)`) and erc20 `approve(spender=mine,amount)` for the APE path only. Each returns `{ kind, to, data, value, summary }`. **Step 4: Run** → PASS. **Step 5: Commit** — `git commit -am "feat(wallet): encrypted keystore + shadow setup tx builders"`

---

## Task 13: Submitter (glue: engine → txQueue on real ABIs)

**Files:** Create `src/mines/submitter.ts`, `test/submitter.test.ts`.

- [ ] **Step 1: Failing test** — `Submitter.clockOut(tokenId, slot, ticks)` encodes `clockOut` calldata against the mine ABI and hands a tx to the queue; `clockIn` encodes `clockIn` with the correct `value` (0 for pitboys — APE via tank/transferFrom; fee for broker direct mode). Assert encoded selector + args via a spy queue.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `Submitter` taking `{ mine, txQueue }`, methods `activate/clockIn/clockOut` that `encodeFunctionData` and call `txQueue.submit`. In shadow mode `value` is always 0 (tank-funded); document that broker direct mode passes the quoted fee as value. **Step 4: Run** → PASS. **Step 5: Commit** — `git commit -am "feat(mines): submitter encoding clockIn/clockOut/activate"`

---

## Task 14: CLI wiring

**Files:** Create `src/cli.ts`, `src/config.ts`, `test/config.test.ts`.

- [ ] **Step 1: Failing test (config only)** — `loadConfig`/`saveConfig` round-trip under a temp `DERPMINER_HOME`; defaults include the official RPC and `mine: 'pitboys'`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `config.ts` (schema: `mines`, `rpcUrls[]`, `walletMode`, `tokens: {mine, tokenId, slots[]}[]`, `chaseTip`, `preBufferSeconds`, `pollMs`, `webhookUrl?`) then `cli.ts` with commander commands wiring the modules:
  - `init` — interactive wizard → writes config.
  - `shadow-setup` — prints/【optionally sends】 the `buildShadowSetup` txs; generates+stores hot key.
  - `activate <mine> <tokenId> <slot>` — owner action, prints fee quote + confirm.
  - `run` — builds RpcPool→Mine→Watcher→TxQueue→Submitter→one ShiftEngine per configured slot; starts pool.probe + watcher loops; renders a status table (tokens, phase, next solve ETA, index, tank) and reacts to watcher events.
  - `status` — one-shot render from state + a couple of reads.
  - `quote <mine> <tokenId> <slot>` — `quoteSlot` output.
  - `tank <mine>` — show tank balance; print deposit/withdraw calldata.
  Keep command bodies thin (delegate to modules). No network calls in the config unit test.

- [ ] **Step 4: Run** `npx vitest run` (all unit tests) + `npm run typecheck` → PASS. **Step 5: Commit** — `git commit -am "feat(cli): init/shadow-setup/activate/run/status/quote/tank"`

---

## Task 15: Fork E2E against real bytecode

**Files:** Create `test/e2e/fork.test.ts`, add `test:e2e` script.

- [ ] **Step 1: Write the E2E** (skipped unless `FORK_RPC` set): boot `anvil --fork-url $FORK_RPC --chain-id 4663`; pick a PitBoys tokenId currently backed & owned (discover via reads); impersonate the owner; run the real flow through our modules against the forked mine — `agree`, `activate` if needed, `clockIn`, read seed from the emitted event, `findSolution`, `evm_increaseTime` to pass `earliestSubmitTime`, `clockOut`; assert DERP balance increased and `ClockedOut.proofHash` ends `5d3129`.

```ts
import { describe, it, expect } from 'vitest';
const RUN = !!process.env.FORK_RPC;
describe.runIf(RUN)('fork e2e: full mine loop against deployed bytecode', () => {
  it('clockIn -> grind -> warp -> clockOut prints DERP', async () => {
    // boot anvil, impersonate, run real modules; assert balance delta > 0
  }, 180_000);
});
```

- [ ] **Step 2: Run** `FORK_RPC=https://rpc.mainnet.chain.robinhood.com npm run test:e2e`. Expected: PASS, prints reward. If pace/timestamp behaves differently on this Arbitrum-lineage fork, record the measured submit buffer and set `preBufferSeconds` default accordingly.

- [ ] **Step 3: Commit** — `git commit -am "test(e2e): full mine loop on anvil fork of Robinhood Chain"`

---

## Task 16: README + release prep (no publish)

**Files:** Create `README.md`, `LICENSE` (MIT), `.env.example`.

- [ ] **Step 1:** README: what it is, the shadow-key safety model (owner key never persisted), install, `init`→`shadow-setup`→`activate`→`run`, the `quote` disclaimer (shows on-chain EV only, NFA, experimental), and an explicit "independent, unaffiliated; built on public contracts" note. Include the golden-vector line as provenance.
- [ ] **Step 2:** MIT LICENSE, `.env.example` with `FORK_RPC`, `DERPMINER_LOG`.
- [ ] **Step 3:** `npm run typecheck && npx vitest run` green.
- [ ] **Step 4: Commit** — `git commit -am "docs: readme, license, env example (publication-ready, unpublished)"`

---

## Self-review notes

- **Spec coverage:** RPC pool+hedged (T5/6), shift engine incl. stale/orphan/ttl (T9), watcher (T10), shadow model (T12), APE approve path (T12/13), both mines (T7), quote/EV (T11), golden-vector proof (T2), fork E2E (T15), persistence/restart (T8/9), CLI surface (T14), docs/no-publish (T16). No auto-sell anywhere. ✅
- **Type consistency:** `Mine`, `RpcPool.read/hedgedSend/waitForReceipt`, `TxQueue.submit`, `ShiftEngine` deps, `buildShadowSetup` `{kind,to,data,value,summary}`, `quoteSlot` used consistently across tasks.
- **Ordering:** proof→schedule→rpc→tx→registry→state→engine→watcher→econ→wallet→submitter→cli→e2e→docs. Each task is independently testable and committed.
