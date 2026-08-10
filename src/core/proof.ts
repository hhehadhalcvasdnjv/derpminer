import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';
import { encodePacked, keccak256, type Hex } from 'viem';
import type { WorkerRequest, WorkerResult } from './proofWorker.js';

/** The trailing 3 bytes every winning sha256 proof must end with (PitMine.proofSuffix). */
export const SUFFIX = '0x5d3129' as const;
const S0 = 0x5d;
const S1 = 0x31;
const S2 = 0x29;

/** Mean attempts to find a suffix hit: 2^24 (24 suffix bits, geometric mean). */
export const EXPECTED_SOLVE_TICKS = 1n << 24n;

const ZERO32 = ('0x' + '00'.repeat(32)) as Hex;

export interface ProofInput {
  /** The mine contract address — bound into the preimage (a proof is mine-specific). */
  mine: Hex;
  tokenId: bigint;
  ticks: bigint;
  /** slotProofHash(tokenId, slot): the slot's chained previous proof, or its genesis. */
  prevProofHash: Hex;
  /** The shift's grind seed, set by the contract at clock-in. */
  grindSeed: Hex;
}

/**
 * The exact 148-byte preimage the contract hashes:
 * abi.encodePacked(address(20), uint256(32), uint256(32), bytes32(32), bytes32(32)).
 * Verified byte-exact against the on-chain proof for PitBoys token 742 / slot 3.
 */
export function proofPreimage(i: ProofInput): Buffer {
  const packed = encodePacked(
    ['address', 'uint256', 'uint256', 'bytes32', 'bytes32'],
    [i.mine, i.tokenId, i.ticks, i.prevProofHash, i.grindSeed],
  );
  return Buffer.from(packed.slice(2), 'hex');
}

export function proofHash(i: ProofInput): Hex {
  return ('0x' + createHash('sha256').update(proofPreimage(i)).digest('hex')) as Hex;
}

export function hasSuffix(hash: Hex): boolean {
  const b = Buffer.from(hash.slice(2), 'hex');
  const n = b.length;
  return b[n - 3] === S0 && b[n - 2] === S1 && b[n - 1] === S2;
}

/**
 * The genesis prev-hash for a slot with no prints yet: slot 0 starts at zero
 * (the original audited chain), slots 1-15 start at keccak256(pack(tokenId, slot))
 * so every (token, slot) mines a unique chain. Use this only when the on-chain
 * lastProofHash reads zero.
 */
export function slotProofHashGenesis(tokenId: bigint, slot: bigint): Hex {
  if (slot === 0n) return ZERO32;
  return keccak256(encodePacked(['uint256', 'uint256'], [tokenId, slot]));
}

export interface Solution {
  ticks: bigint;
  hash: Hex;
}

export interface GrindRange {
  mine: Hex;
  tokenId: bigint;
  prevProofHash: Hex;
  grindSeed: Hex;
  startTick: bigint;
  maxTicks: bigint;
}

/**
 * Synchronous suffix search over [startTick, startTick+maxTicks). Reuses one
 * buffer and mutates only the 32-byte `ticks` window (bytes 52..84) so the hot
 * loop allocates nothing. Returns the first hit, or null if the range is dry.
 */
export function findSolutionSync(r: GrindRange): Solution | null {
  const buf = proofPreimage({
    mine: r.mine,
    tokenId: r.tokenId,
    ticks: r.startTick,
    prevProofHash: r.prevProofHash,
    grindSeed: r.grindSeed,
  });
  // ticks occupies bytes [20+32, 20+32+32) = [52, 84).
  const TICKS_END = 84;
  const end = r.startTick + r.maxTicks;
  for (let t = r.startTick; t < end; t++) {
    writeUint256BE(buf, t, TICKS_END);
    const h = createHash('sha256').update(buf).digest();
    if (h[29] === S0 && h[30] === S1 && h[31] === S2) {
      return { ticks: t, hash: ('0x' + h.toString('hex')) as Hex };
    }
  }
  return null;
}

/** Write a bigint as a big-endian uint256 into buf ending at offset `end`. */
function writeUint256BE(buf: Buffer, value: bigint, end: number): void {
  let v = value;
  for (let i = end - 1; i >= end - 32; i--) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

// --- Async precompute: one worker per solve, capped by a semaphore. ---------
// A single worker searches sequentially, so it returns the LOWEST-tick hit —
// exactly the solution the contract rewards most. Parallelism is across slots
// (many concurrent solves), not within one solve.

const UNDER_TSX = import.meta.url.endsWith('.ts');
const WORKER_URL = new URL(UNDER_TSX ? './proofWorker.ts' : './proofWorker.js', import.meta.url);
const WORKER_EXEC_ARGV = UNDER_TSX ? ['--import', 'tsx'] : [];

let maxWorkers = Math.max(1, cpus().length - 2);
let active = 0;
const waiters: Array<() => void> = [];

/** Override the concurrent-worker cap (mainly for tests/tuning). */
export function setMaxGrindWorkers(n: number): void {
  maxWorkers = Math.max(1, n);
}

async function acquire(): Promise<void> {
  if (active < maxWorkers) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
}

function release(): void {
  active--;
  const next = waiters.shift();
  if (next) next();
}

export interface FindSolutionOpts {
  mine: Hex;
  tokenId: bigint;
  prevProofHash: Hex;
  grindSeed: Hex;
  startTick?: bigint;
  /** Ticks scanned per internal chunk before checking for cancellation. */
  chunkTicks?: bigint;
  /** Safety cap on chunks; with P=2^-24 a hit is near-certain within a few. */
  maxChunks?: number;
}

/**
 * Find the lowest tick whose proof hash carries the suffix, off the main
 * thread. Resolves to the solution, or null only if the (very large) bounded
 * search is exhausted without a hit.
 */
export async function findSolution(opts: FindSolutionOpts): Promise<Solution | null> {
  const req: WorkerRequest = {
    mine: opts.mine,
    tokenId: opts.tokenId.toString(),
    prevProofHash: opts.prevProofHash,
    grindSeed: opts.grindSeed,
    startTick: (opts.startTick ?? 0n).toString(),
    chunkTicks: (opts.chunkTicks ?? 1n << 22n).toString(),
    maxChunks: opts.maxChunks ?? 64,
  };
  await acquire();
  try {
    const result = await new Promise<WorkerResult>((resolve, reject) => {
      const worker = new Worker(fileURLToPath(WORKER_URL), {
        workerData: req,
        execArgv: WORKER_EXEC_ARGV,
      });
      worker.once('message', (m: WorkerResult) => {
        worker.terminate();
        resolve(m);
      });
      worker.once('error', (e) => {
        worker.terminate();
        reject(e);
      });
    });
    if (result.ticks === null || result.hash === null) return null;
    return { ticks: BigInt(result.ticks), hash: result.hash };
  } finally {
    release();
  }
}
