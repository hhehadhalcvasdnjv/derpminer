import { parentPort, workerData } from 'node:worker_threads';
import { findSolutionSync } from './proof.js';
import type { Hex } from 'viem';

export interface WorkerRequest {
  mine: Hex;
  tokenId: string; // bigint as string (structured-clone-safe, explicit)
  prevProofHash: Hex;
  grindSeed: Hex;
  startTick: string;
  chunkTicks: string;
  maxChunks: number;
}

export interface WorkerResult {
  ticks: string | null;
  hash: Hex | null;
  scannedTicks: string;
}

function run(req: WorkerRequest): WorkerResult {
  const mine = req.mine;
  const tokenId = BigInt(req.tokenId);
  const chunk = BigInt(req.chunkTicks);
  let start = BigInt(req.startTick);
  let scanned = 0n;
  for (let c = 0; c < req.maxChunks; c++) {
    const sol = findSolutionSync({
      mine,
      tokenId,
      prevProofHash: req.prevProofHash,
      grindSeed: req.grindSeed,
      startTick: start,
      maxTicks: chunk,
    });
    scanned += chunk;
    if (sol) return { ticks: sol.ticks.toString(), hash: sol.hash, scannedTicks: scanned.toString() };
    start += chunk;
  }
  return { ticks: null, hash: null, scannedTicks: scanned.toString() };
}

if (parentPort) {
  parentPort.postMessage(run(workerData as WorkerRequest));
}
