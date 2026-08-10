import type { Hex, PublicClient } from 'viem';
import type { MineProfile } from '../chain/registry.js';
import { slotProofHashGenesis } from '../core/proof.js';

/** The reads the Mine needs from the RPC layer. */
export interface MineReader {
  read<T>(fn: (client: PublicClient) => Promise<T>): Promise<T>;
}

/** Decoded live shift state, straight from the on-chain `shiftOf` view. */
export interface ShiftState {
  worker: Hex;
  startTime: bigint;
  tickBudget: bigint;
  voided: boolean;
  expired: boolean;
  grindSeed: Hex;
  tickerExpired: boolean;
  expiryTickerCount: bigint;
  printsRemaining: bigint;
  /** True when no shift is open (worker is the zero address). */
  empty: boolean;
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

/**
 * Typed, read-only view over one mine contract. Every value the miner needs to
 * decide what to do comes from here; the contract's own views already compute
 * voided/expired/tickerExpired/orphaned, so the engine trusts them rather than
 * re-deriving protocol rules off-chain.
 */
export class Mine {
  readonly profile: MineProfile;
  private readonly reader: MineReader;

  constructor(profile: MineProfile, reader: MineReader) {
    this.profile = profile;
    this.reader = reader;
  }

  get address(): Hex {
    return this.profile.address;
  }

  private call<T>(name: string, args: readonly unknown[]): Promise<T> {
    return this.reader.read((client) =>
      client.readContract({ address: this.profile.address, abi: this.profile.abi, functionName: name, args }) as Promise<T>,
    );
  }

  maxTicksPerSecond(): Promise<bigint> {
    return this.call('maxTicksPerSecond', []);
  }

  graceSeconds(): Promise<bigint> {
    return this.call('graceSeconds', []);
  }

  shiftTtl(): Promise<bigint> {
    return this.call('shiftTtl', []);
  }

  theIndex(): Promise<bigint> {
    return this.call('theIndex', []);
  }

  tickerCount(): Promise<bigint> {
    return this.call('tickerCount', []);
  }

  certifiedCount(): Promise<bigint> {
    return this.call('certifiedCount', []);
  }

  isActivated(tokenId: bigint, slot: bigint): Promise<boolean> {
    return this.call('isActivated', [tokenId, slot]);
  }

  activeSlotCount(tokenId: bigint): Promise<bigint> {
    return this.call('activeSlotCount', [tokenId]);
  }

  clockInFeeFor(tokenId: bigint, slot: bigint, caller: Hex): Promise<bigint> {
    return this.call('clockInFeeFor', [tokenId, slot, caller]);
  }

  activationFee(): Promise<bigint> {
    return this.call('activationFee', []);
  }

  slotActivationFee(slot: bigint): Promise<bigint> {
    return this.call('slotActivationFee', [slot]);
  }

  previewPrint(tokenId: bigint, ticks: bigint): Promise<bigint> {
    return this.call('previewPrint', [tokenId, ticks]);
  }

  minPrint(): Promise<bigint> {
    return this.call('minPrint', []);
  }

  maxPrint(): Promise<bigint> {
    return this.call('maxPrint', []);
  }

  halvingTicks(): Promise<bigint> {
    return this.call('halvingTicks', []);
  }

  /** The broker's live mining multiplier in bps (10000 = 1.00x). */
  tierMultiplierBps(tokenId: bigint): Promise<bigint> {
    return this.call('tierMultiplierBps', [tokenId]);
  }

  tickerExpiryPrints(): Promise<bigint> {
    return this.call('tickerExpiryPrints', []);
  }

  async tankOf(owner: Hex): Promise<{ balance: bigint; reserved: bigint; withdrawable: bigint }> {
    const [balance, reserved, withdrawable] = await this.call<[bigint, bigint, bigint]>('tankOf', [owner]);
    return { balance, reserved, withdrawable };
  }

  /** The slot's chained previous proof hash, from the on-chain view. */
  slotProofHash(tokenId: bigint, slot: bigint): Promise<Hex> {
    return this.call('slotProofHash', [tokenId, slot]);
  }

  /**
   * Client-side genesis fallback, cross-checked against the on-chain view in
   * tests. The engine uses `slotProofHash` (on-chain) as the source of truth;
   * this exists so precompute can proceed even if that read is flaky, by
   * reading the raw `lastProofHash` and applying genesis locally.
   */
  async slotProofHashResilient(tokenId: bigint, slot: bigint): Promise<Hex> {
    const raw = await this.call<Hex>('lastProofHash', [tokenId, slot]);
    if (raw === ('0x' + '00'.repeat(32))) return slotProofHashGenesis(tokenId, slot);
    return raw;
  }

  async shiftOf(tokenId: bigint, slot: bigint): Promise<ShiftState> {
    const r = await this.call<
      [Hex, bigint, bigint, boolean, boolean, Hex, boolean, bigint, bigint]
    >('shiftOf', [tokenId, slot]);
    return {
      worker: r[0],
      startTime: r[1],
      tickBudget: r[2],
      voided: r[3],
      expired: r[4],
      grindSeed: r[5],
      tickerExpired: r[6],
      expiryTickerCount: r[7],
      printsRemaining: r[8],
      empty: r[0].toLowerCase() === ZERO_ADDR,
    };
  }

  /** Certified-chain anchor for the open shift, incl. whether it is orphaned. */
  async shiftAnchor(tokenId: bigint, slot: bigint): Promise<{ certifiedAnchor: bigint; orphaned: boolean }> {
    const [certifiedAnchor, orphaned] = await this.call<[bigint, boolean]>('shiftAnchor', [tokenId, slot]);
    return { certifiedAnchor, orphaned };
  }

  /** PitBoys-only: which shift a backing boy is leased to, and whether it is live. */
  async boyLease(boyId: bigint): Promise<{ anchorId: bigint; slot: bigint; live: boolean }> {
    const [anchorId, slot, live] = await this.call<[bigint, bigint, boolean]>('boyLease', [boyId]);
    return { anchorId, slot, live };
  }
}
