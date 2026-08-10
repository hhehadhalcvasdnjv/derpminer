import { toFunctionSelector, type Hex } from 'viem';
import type { TxRequest, FeeFields } from '../chain/txQueue.js';

/**
 * A guard run inside the signer, before any transaction is signed. If it
 * throws, nothing is signed — so it is a hard boundary on what the hot key can
 * ever do, independent of the rest of the codebase. Defense in depth on top of
 * the on-chain shadow restriction, and an explicit, testable statement of the
 * key's capability for anyone auditing the code.
 */
export type TxGuard = (req: TxRequest & FeeFields) => void;

/** The only two methods the mining daemon ever sends with the hot key. */
export const SHADOW_ALLOWED_SIGNATURES = [
  'clockIn(uint256,uint256)',
  'clockOut(uint256,uint256,uint256)',
] as const;

/**
 * Build the guard for shadow-mode mining. It permits ONLY:
 *   - `to` ∈ the configured mine contracts,
 *   - a 4-byte selector ∈ {clockIn, clockOut},
 *   - `value` == 0 (the hot key never moves native funds; clock-ins are paid
 *     from the owner's on-chain tank, clock-outs are non-payable).
 * Everything else — transfers, approvals, activation, setShadow, calls to any
 * other contract — is refused before signing. A leaked or malicious client
 * still cannot make this key do anything but mine.
 */
export function buildShadowTxGuard(mineAddresses: Hex[]): TxGuard {
  const allowedTo = new Set(mineAddresses.map((a) => a.toLowerCase()));
  const allowedSelectors = new Set(SHADOW_ALLOWED_SIGNATURES.map((s) => toFunctionSelector(s)));

  return (req) => {
    if (!req.to || !allowedTo.has(req.to.toLowerCase())) {
      throw new Error(`tx guard: refusing to sign — 'to' ${req.to} is not a configured mine contract`);
    }
    if ((req.value ?? 0n) !== 0n) {
      throw new Error(`tx guard: refusing to sign — hot key must never send native value (got ${req.value})`);
    }
    const selector = (req.data ?? '0x').slice(0, 10) as Hex;
    if (!allowedSelectors.has(selector)) {
      throw new Error(`tx guard: refusing to sign — selector ${selector} is not clockIn/clockOut`);
    }
  };
}

/**
 * Direct-mode guard (owner mining their own broker without a shadow key). Same
 * method allowlist, but native value IS permitted, because on the ETH floor a
 * direct clock-in pays its fee as msg.value. Still scoped to the mine contracts
 * and to clockIn/clockOut only.
 */
export function buildDirectTxGuard(mineAddresses: Hex[]): TxGuard {
  const allowedTo = new Set(mineAddresses.map((a) => a.toLowerCase()));
  const allowedSelectors = new Set(SHADOW_ALLOWED_SIGNATURES.map((s) => toFunctionSelector(s)));
  return (req) => {
    if (!req.to || !allowedTo.has(req.to.toLowerCase())) {
      throw new Error(`tx guard: refusing to sign — 'to' ${req.to} is not a configured mine contract`);
    }
    const selector = (req.data ?? '0x').slice(0, 10) as Hex;
    if (!allowedSelectors.has(selector)) {
      throw new Error(`tx guard: refusing to sign — selector ${selector} is not clockIn/clockOut`);
    }
  };
}
