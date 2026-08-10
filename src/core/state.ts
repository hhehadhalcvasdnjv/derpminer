import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MineKey } from '../chain/registry.js';

/** Phases a slot can be in; persisted so a restart resumes deterministically. */
export type Phase =
  | 'IDLE'
  | 'CLOCKIN_SENT'
  | 'GRINDING'
  | 'WAITING'
  | 'PRECHECK'
  | 'CLOCKOUT_SENT'
  | 'PRINTED';

export interface SlotRecord {
  phase: Phase;
  /** The found solution tick, once grinding completes. */
  ticks?: bigint;
  /** The open shift's start time (chain seconds). */
  startTime?: bigint;
  /** The open shift's grind seed. */
  grindSeed?: string;
  /** Last reward printed (DERP wei), for status/accounting. */
  lastReward?: bigint;
  /** Total DERP printed on this slot across the daemon's lifetime. */
  totalPrinted?: bigint;
  /** Count of prints on this slot. */
  prints?: number;
  updatedAt?: number;
}

interface StateShape {
  version: 1;
  slots: Record<string, SlotRecord>;
}

const KEY = (mine: MineKey, tokenId: bigint, slot: bigint): string => `${mine}:${tokenId}:${slot}`;

/**
 * Atomic, bigint-safe JSON persistence for per-slot mining state. Written with
 * temp-file + rename so a crash mid-write never corrupts the file. On restart
 * the daemon loads this, then reconciles each slot against the chain.
 */
export class StateStore {
  private readonly path: string;
  private data: StateShape = { version: 1, slots: {} };

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<void> {
    if (!existsSync(this.path)) return;
    const raw = readFileSync(this.path, 'utf8');
    this.data = JSON.parse(raw, reviver) as StateShape;
    if (this.data.version !== 1) throw new Error(`unknown state version ${this.data.version}`);
    if (!this.data.slots) this.data.slots = {};
  }

  getSlot(mine: MineKey, tokenId: bigint, slot: bigint): SlotRecord | undefined {
    return this.data.slots[KEY(mine, tokenId, slot)];
  }

  allSlots(): Array<{ key: string; record: SlotRecord }> {
    return Object.entries(this.data.slots).map(([key, record]) => ({ key, record }));
  }

  async upsertSlot(mine: MineKey, tokenId: bigint, slot: bigint, patch: Partial<SlotRecord>): Promise<void> {
    const key = KEY(mine, tokenId, slot);
    const prev = this.data.slots[key] ?? { phase: 'IDLE' as Phase };
    this.data.slots[key] = { ...prev, ...patch, updatedAt: nowMs() };
    await this.flush();
  }

  private async flush(): Promise<void> {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, replacer, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

/** Monotonic-ish wall clock; isolated so tests can tolerate its absence. */
function nowMs(): number {
  // Date.now via performance origin keeps this side-effecting call in one place.
  return Math.floor(performance.timeOrigin + performance.now());
}

// --- bigint-safe JSON codec ---------------------------------------------------
const BIGINT_TAG = '$bigint';

function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? { [BIGINT_TAG]: value.toString() } : value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && BIGINT_TAG in (value as Record<string, unknown>)) {
    return BigInt((value as Record<string, string>)[BIGINT_TAG]);
  }
  return value;
}
