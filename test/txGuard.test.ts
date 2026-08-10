import { describe, it, expect, vi } from 'vitest';
import { encodeFunctionData, toFunctionSelector, parseEther, type Hex } from 'viem';
import { buildShadowTxGuard, buildDirectTxGuard, SHADOW_ALLOWED_SIGNATURES } from '../src/wallet/txGuard.js';
import { makeSigner } from '../src/wallet/signer.js';
import { MINES, ABIS } from '../src/chain/registry.js';
import { generatePrivateKey } from 'viem/accounts';

const MINE = MINES.pitboys.address;
const ATTACKER = '0x000000000000000000000000000000000000dEaD' as Hex;

function clockOutData(): Hex {
  return encodeFunctionData({ abi: MINES.pitboys.abi, functionName: 'clockOut', args: [742n, 3n, 13786224n] });
}
function clockInData(): Hex {
  return encodeFunctionData({ abi: MINES.pitboys.abi, functionName: 'clockIn', args: [742n, 3n] });
}

describe('shadow tx guard — the hot key can ONLY mine', () => {
  const guard = buildShadowTxGuard([MINE]);

  it('allows clockOut to the mine with zero value', () => {
    expect(() => guard({ to: MINE, data: clockOutData(), value: 0n, nonce: 0, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })).not.toThrow();
  });

  it('allows clockIn to the mine with zero value', () => {
    expect(() => guard({ to: MINE, data: clockInData(), value: 0n, nonce: 0, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })).not.toThrow();
  });

  it('REFUSES a native ETH transfer (drain attempt)', () => {
    expect(() =>
      guard({ to: ATTACKER, data: '0x', value: parseEther('1'), nonce: 0, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
    ).toThrow(/not a configured mine contract/);
  });

  it('REFUSES an ERC20 transfer of the reward token', () => {
    const data = encodeFunctionData({ abi: ABIS.erc20, functionName: 'transfer', args: [ATTACKER, parseEther('1000')] });
    // even if pointed at the mine address, transfer() is not an allowed selector
    expect(() => guard({ to: MINE, data, value: 0n, nonce: 0, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })).toThrow(/not clockIn\/clockOut/);
  });

  it('REFUSES an ERC20 approve (allowance-grant attempt)', () => {
    const data = encodeFunctionData({ abi: ABIS.erc20, functionName: 'approve', args: [ATTACKER, 2n ** 256n - 1n] });
    expect(() => guard({ to: ATTACKER, data, value: 0n, nonce: 0, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })).toThrow();
  });

  it('REFUSES withdrawTank (cannot drain the fee tank)', () => {
    const data = encodeFunctionData({ abi: MINES.pitboys.abi, functionName: 'withdrawTank', args: [parseEther('100')] });
    expect(() => guard({ to: MINE, data, value: 0n, nonce: 0, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })).toThrow(/not clockIn\/clockOut/);
  });

  it('REFUSES setShadow (cannot re-grant itself power)', () => {
    const data = encodeFunctionData({ abi: MINES.pitboys.abi, functionName: 'setShadow', args: [[742n], ATTACKER, 9999999999n, 2n ** 200n, 2n ** 200n] });
    expect(() => guard({ to: MINE, data, value: 0n, nonce: 0, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })).toThrow(/not clockIn\/clockOut/);
  });

  it('REFUSES clockIn carrying native value (tank must fund it)', () => {
    expect(() =>
      guard({ to: MINE, data: clockInData(), value: parseEther('0.1'), nonce: 0, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
    ).toThrow(/must never send native value/);
  });

  it('the allowlist is exactly clockIn and clockOut', () => {
    expect(SHADOW_ALLOWED_SIGNATURES).toEqual(['clockIn(uint256,uint256)', 'clockOut(uint256,uint256,uint256)']);
    expect(toFunctionSelector('clockOut(uint256,uint256,uint256)')).toBe(clockOutData().slice(0, 10));
  });
});

describe('direct-mode guard permits ETH value but same method allowlist', () => {
  const guard = buildDirectTxGuard([MINES.broker.address]);
  it('allows a clockIn paying its ETH fee as value', () => {
    const data = encodeFunctionData({ abi: MINES.broker.abi, functionName: 'clockIn', args: [1n, 0n] });
    expect(() => guard({ to: MINES.broker.address, data, value: 4_996_000_000_000n, nonce: 0, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })).not.toThrow();
  });
  it('still refuses a raw ETH transfer to an attacker', () => {
    expect(() => guard({ to: ATTACKER, data: '0x', value: parseEther('1'), nonce: 0, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })).toThrow();
  });
});

describe('signer refuses to sign a guarded-out transaction', () => {
  it('never produces a signed tx for a drain attempt', async () => {
    const pool = { read: vi.fn(async () => 21000n) } as unknown as Parameters<typeof makeSigner>[0]['pool'];
    const { sign } = makeSigner({
      pool,
      chainId: 4663,
      privateKey: generatePrivateKey(),
      guard: buildShadowTxGuard([MINE]),
    });
    await expect(
      sign({ to: ATTACKER, data: '0x', value: parseEther('5'), nonce: 0, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
    ).rejects.toThrow(/refusing to sign/);
    // and gas estimation was never even reached
    expect(pool.read).not.toHaveBeenCalled();
  });
});
