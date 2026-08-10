import { describe, it, expect } from 'vitest';
import { decodeFunctionData, type Hex } from 'viem';
import { buildShadowSetup, buildWithdrawTank } from '../src/wallet/shadow.js';
import { MINES, ABIS, APE_TOKEN } from '../src/chain/registry.js';
import { generateShadowKey, saveKeystore, loadKeystore, keystoreAddress } from '../src/wallet/keystore.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OP = '0x00000000000000000000000000000000000000AA' as Hex;

describe('buildShadowSetup (PitBoys / APE)', () => {
  const txs = buildShadowSetup({
    mine: MINES.pitboys,
    tokenIds: [742n, 743n],
    operator: OP,
    expiry: 9_999_999_999n,
    budget: 10n ** 18n,
    maxFee: 10n ** 15n,
    tankDeposit: 5n * 10n ** 18n,
  });

  it('orders the txs agree, approve, setShadow, depositTank', () => {
    expect(txs.map((t) => t.kind)).toEqual(['agree', 'approve', 'setShadow', 'depositTank']);
  });

  it('routes the approve to the APE token for the mine as spender', () => {
    const approve = txs.find((t) => t.kind === 'approve')!;
    expect(approve.to.toLowerCase()).toBe(APE_TOKEN.toLowerCase());
    const decoded = decodeFunctionData({ abi: ABIS.erc20, data: approve.data });
    expect(decoded.functionName).toBe('approve');
    expect((decoded.args as unknown[])[0]).toBe(MINES.pitboys.address);
    expect((decoded.args as unknown[])[1]).toBe(5n * 10n ** 18n);
  });

  it('encodes setShadow with all five args', () => {
    const set = txs.find((t) => t.kind === 'setShadow')!;
    const decoded = decodeFunctionData({ abi: MINES.pitboys.abi, data: set.data });
    expect(decoded.functionName).toBe('setShadow');
    const args = decoded.args as unknown[];
    expect(args[0]).toEqual([742n, 743n]);
    expect(args[1]).toBe(OP);
    expect(args[4]).toBe(10n ** 15n);
  });

  it('sends depositTank with zero value on the APE floor (pulled via approve)', () => {
    const dep = txs.find((t) => t.kind === 'depositTank')!;
    expect(dep.value).toBe(0n);
  });
});

describe('buildShadowSetup (Broker / ETH)', () => {
  const txs = buildShadowSetup({
    mine: MINES.broker,
    tokenIds: [1n],
    operator: OP,
    expiry: 1n,
    budget: 1n,
    maxFee: 1n,
    tankDeposit: 7n * 10n ** 15n,
  });

  it('has no approve step', () => {
    expect(txs.map((t) => t.kind)).toEqual(['agree', 'setShadow', 'depositTank']);
  });

  it('funds depositTank with ETH value directly', () => {
    const dep = txs.find((t) => t.kind === 'depositTank')!;
    expect(dep.value).toBe(7n * 10n ** 15n);
  });
});

describe('buildWithdrawTank', () => {
  it('encodes withdrawTank against the mine', () => {
    const tx = buildWithdrawTank(MINES.pitboys, 3n * 10n ** 18n);
    const decoded = decodeFunctionData({ abi: MINES.pitboys.abi, data: tx.data });
    expect(decoded.functionName).toBe('withdrawTank');
    expect((decoded.args as unknown[])[0]).toBe(3n * 10n ** 18n);
  });
});

describe('keystore', () => {
  it('round-trips a hot key through encrypt/decrypt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'derp-ks-'));
    const path = join(dir, 'keystore.json');
    const { privateKey, address } = generateShadowKey();
    const savedAddr = saveKeystore(path, privateKey, 'correct horse battery staple');
    expect(savedAddr).toBe(address);
    expect(keystoreAddress(path)).toBe(address);
    expect(loadKeystore(path, 'correct horse battery staple')).toBe(privateKey);
  });

  it('rejects a wrong passphrase', () => {
    const dir = mkdtempSync(join(tmpdir(), 'derp-ks-'));
    const path = join(dir, 'keystore.json');
    const { privateKey } = generateShadowKey();
    saveKeystore(path, privateKey, 'right');
    expect(() => loadKeystore(path, 'wrong')).toThrow(/failed to decrypt/);
  });
});
