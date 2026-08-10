import { encodeFunctionData, type Hex } from 'viem';
import type { MineProfile } from '../chain/registry.js';
import { ABIS } from '../chain/registry.js';

export type SetupKind = 'agree' | 'approve' | 'setShadow' | 'depositTank' | 'activate';

/** One owner-signed transaction in the shadow-enable sequence. */
export interface SetupTx {
  kind: SetupKind;
  to: Hex;
  data: Hex;
  value: bigint;
  summary: string;
}

export interface ShadowSetupParams {
  mine: MineProfile;
  /** Tokens the shadow key may mine. */
  tokenIds: bigint[];
  /** The hot (shadow) key's address. */
  operator: Hex;
  /** Grant expiry, unix seconds. */
  expiry: bigint;
  /** Total tank spend the shadow may draw per token (the payment-card limit). */
  budget: bigint;
  /** Per-clock-in fee ceiling. */
  maxFee: bigint;
  /** APE/ETH (fee-asset wei) to pre-fund into the owner's fee tank. */
  tankDeposit: bigint;
}

/**
 * Build the exact ordered transactions an owner signs once to hand mining to a
 * shadow key. Order matters and mirrors the contract's own rules:
 *   1. agree()          — the pledge gate; setShadow and activate both require it.
 *   2. approve(APE)      — PitBoys only: depositTank pulls APE via transferFrom.
 *   3. setShadow(...)    — reserve the budget (grant BEFORE funding the tank).
 *   4. depositTank(...)  — fund the tank the shadow spends from.
 * The shadow key never holds funds and can only spend the tank via clock-in
 * inside this budget; a leaked key buys only grief-mining, never theft.
 */
export function buildShadowSetup(p: ShadowSetupParams): SetupTx[] {
  const mineAddr = p.mine.address;
  const txs: SetupTx[] = [];

  txs.push({
    kind: 'agree',
    to: mineAddr,
    data: encodeFunctionData({ abi: p.mine.abi, functionName: 'agree', args: [] }),
    value: 0n,
    summary: 'Agree to the Pit Pledge (one-time, required before granting or activating).',
  });

  const isApe = p.mine.feeAsset === 'APE';
  if (isApe) {
    if (!p.mine.feeToken) throw new Error('APE mine profile missing feeToken');
    txs.push({
      kind: 'approve',
      to: p.mine.feeToken,
      data: encodeFunctionData({ abi: ABIS.erc20, functionName: 'approve', args: [mineAddr, p.tankDeposit] }),
      value: 0n,
      summary: `Approve ${p.tankDeposit} APE (wei) for the mine to pull into your fee tank.`,
    });
  }

  txs.push({
    kind: 'setShadow',
    to: mineAddr,
    data: encodeFunctionData({
      abi: p.mine.abi,
      functionName: 'setShadow',
      args: [p.tokenIds, p.operator, p.expiry, p.budget, p.maxFee],
    }),
    value: 0n,
    summary: `Grant shadow key ${p.operator} to mine ${p.tokenIds.length} token(s), budget ${p.budget}/token, maxFee ${p.maxFee}, until ${p.expiry}.`,
  });

  txs.push({
    kind: 'depositTank',
    to: mineAddr,
    data: encodeFunctionData({ abi: p.mine.abi, functionName: 'depositTank', args: [p.tankDeposit] }),
    // ETH mine: send the deposit as value. APE mine: value 0, pulled via approve.
    value: isApe ? 0n : p.tankDeposit,
    summary: `Fund the fee tank with ${p.tankDeposit} ${p.mine.feeAsset} (wei).`,
  });

  return txs;
}

export interface ActivateParams {
  mine: MineProfile;
  tokenId: bigint;
  slot: bigint;
  /** Activation fee in fee-asset wei (activationFee for slot 0, else slotActivationFee). */
  fee: bigint;
  /** Prepend agree() when the owner has not signed the pledge yet. */
  needsAgree: boolean;
}

/**
 * Build the owner transactions that activate a slot. Activation is an owner
 * action (the shadow key may never activate). On the APE floor the fee is
 * pulled via transferFrom, so an approve precedes it; on the ETH floor the fee
 * rides as value. Prepends agree() when the owner has not signed the pledge.
 */
export function buildActivate(p: ActivateParams): SetupTx[] {
  const txs: SetupTx[] = [];
  if (p.needsAgree) {
    txs.push({
      kind: 'agree',
      to: p.mine.address,
      data: encodeFunctionData({ abi: p.mine.abi, functionName: 'agree', args: [] }),
      value: 0n,
      summary: 'Agree to the Pit Pledge (one-time, required before activating).',
    });
  }
  const isApe = p.mine.feeAsset === 'APE';
  if (isApe) {
    if (!p.mine.feeToken) throw new Error('APE mine profile missing feeToken');
    txs.push({
      kind: 'approve',
      to: p.mine.feeToken,
      data: encodeFunctionData({ abi: ABIS.erc20, functionName: 'approve', args: [p.mine.address, p.fee] }),
      value: 0n,
      summary: `Approve ${p.fee} APE (wei) for the activation fee.`,
    });
  }
  txs.push({
    kind: 'activate',
    to: p.mine.address,
    data: encodeFunctionData({ abi: p.mine.abi, functionName: 'activate', args: [p.tokenId, p.slot] }),
    value: isApe ? 0n : p.fee,
    summary: `Activate token ${p.tokenId} slot ${p.slot} (fee ${p.fee} ${p.mine.feeAsset} wei).`,
  });
  return txs;
}

/** Build the owner's tank withdraw calldata (escape hatch; depositor-locked). */
export function buildWithdrawTank(mine: MineProfile, amount: bigint): SetupTx {
  return {
    kind: 'depositTank',
    to: mine.address,
    data: encodeFunctionData({ abi: mine.abi, functionName: 'withdrawTank', args: [amount] }),
    value: 0n,
    summary: `Withdraw ${amount} ${mine.feeAsset} (wei) from your fee tank.`,
  };
}
