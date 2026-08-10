#!/usr/bin/env node
import { Command } from 'commander';
import { formatEther, formatUnits, type Hex } from 'viem';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { existsSync } from 'node:fs';
import {
  loadConfig,
  saveConfig,
  defaultConfig,
  configPath,
  statePath,
  type Config,
  type TargetConfig,
} from './config.js';
import { MINES, robinhoodChain, type MineKey } from './chain/registry.js';
import { RpcPool } from './chain/rpcPool.js';
import { Mine } from './mines/mine.js';
import { StateStore } from './core/state.js';
import { quoteSlot } from './economics.js';
import { buildShadowSetup, buildWithdrawTank } from './wallet/shadow.js';
import { generateShadowKey, saveKeystore, loadKeystore, keystoreAddress } from './wallet/keystore.js';
import { startDaemon } from './daemon.js';

const program = new Command();
program.name('derpminer').description('Headless miner for StonkPit ($DERP) on Robinhood Chain').version('0.1.0');

function poolFor(config: Config): RpcPool {
  return RpcPool.fromUrls(config.rpcUrls, robinhoodChain);
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

// ---------------------------------------------------------------- init
program
  .command('init')
  .description('Interactive setup wizard: RPCs, wallet mode, targets')
  .action(async () => {
    const config = loadConfig();
    const rpcs = await prompt(`RPC URLs (comma-separated) [${config.rpcUrls.join(',')}]: `);
    if (rpcs) config.rpcUrls = rpcs.split(',').map((s) => s.trim()).filter(Boolean);
    const mode = await prompt(`Wallet mode shadow|direct [${config.walletMode}]: `);
    if (mode === 'shadow' || mode === 'direct') config.walletMode = mode;
    const mine = (await prompt(`Mine broker|pitboys [pitboys]: `)) || 'pitboys';
    const tokenId = await prompt('Token id to mine: ');
    const slots = await prompt('Slots (comma-separated, e.g. 0,1,2): ');
    if (tokenId && slots) {
      const target: TargetConfig = {
        mine: (mine === 'broker' ? 'broker' : 'pitboys') as MineKey,
        tokenId,
        slots: slots.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n)),
      };
      config.targets = [target];
    }
    const chase = await prompt(`Chase certified tip on orphan? y/N: `);
    config.chaseTip = chase.toLowerCase().startsWith('y');
    saveConfig(config);
    console.log(`\nSaved ${configPath()}`);
    console.log('Next: `derpminer shadow-setup` (shadow mode) or `derpminer activate` then `derpminer run`.');
  });

// ---------------------------------------------------------------- shadow-setup
program
  .command('shadow-setup')
  .description('Generate a hot key and print the owner transactions that grant it a budget')
  .option('--budget <wei>', 'total tank spend the shadow may draw per token', '0')
  .option('--max-fee <wei>', 'per-clock-in fee ceiling', '0')
  .option('--deposit <wei>', 'fee-asset to pre-fund into the tank', '0')
  .option('--days <n>', 'grant validity in days', '30')
  .action(async (opts: { budget: string; maxFee: string; deposit: string; days: string }) => {
    const config = loadConfig();
    const target = config.targets[0];
    if (!target) throw new Error('configure a target first with `derpminer init`');
    const mine = MINES[target.mine];

    let operator: Hex;
    if (existsSync(config.keystorePath)) {
      operator = keystoreAddress(config.keystorePath);
      console.log(`Using existing hot key ${operator}`);
    } else {
      const pass = await prompt('Passphrase to encrypt the new hot key: ');
      const { privateKey, address } = generateShadowKey();
      saveKeystore(config.keystorePath, privateKey, pass);
      operator = address;
      console.log(`Generated hot key ${operator}, encrypted at ${config.keystorePath}`);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const expiry = BigInt(nowSec + Number(opts.days) * 86_400);
    const txs = buildShadowSetup({
      mine,
      tokenIds: config.targets.filter((t) => t.mine === target.mine).map((t) => BigInt(t.tokenId)),
      operator,
      expiry,
      budget: BigInt(opts.budget),
      maxFee: BigInt(opts.maxFee),
      tankDeposit: BigInt(opts.deposit),
    });

    console.log('\nSign these with your OWNER wallet, in order:\n');
    txs.forEach((tx, i) => {
      console.log(`${i + 1}. ${tx.kind} — ${tx.summary}`);
      console.log(`   to:    ${tx.to}`);
      console.log(`   value: ${tx.value}`);
      console.log(`   data:  ${tx.data}\n`);
    });
    console.log('After they confirm, run `derpminer run`.');
  });

// ---------------------------------------------------------------- quote
program
  .command('quote <mine> <tokenId> <slot>')
  .description('Show on-chain economics for a slot (DERP/day and fee/day — no price assumptions)')
  .action(async (mineKey: string, tokenId: string, slot: string) => {
    const config = loadConfig();
    const mine = new Mine(MINES[mineKey as MineKey], poolFor(config));
    const caller = existsSync(config.keystorePath)
      ? keystoreAddress(config.keystorePath)
      : ('0x0000000000000000000000000000000000000000' as Hex);
    const q = await quoteSlot(mine, BigInt(tokenId), BigInt(slot), caller);
    const feeDecimals = q.feeAsset === 'APE' ? 18 : 18;
    console.log(`Mine:            ${mineKey}`);
    console.log(`Index:           ${q.index}/90 (higher compresses rewards)`);
    console.log(`Expected print:  ${formatEther(q.expectedPrint)} DERP per shift`);
    console.log(`Solve time:      ~${q.solveSeconds.toFixed(0)}s`);
    console.log(`Shifts/day:      ~${q.shiftsPerDay.toFixed(1)}`);
    console.log(`DERP/day:        ~${formatEther(q.derpPerDay)} DERP (before fees)`);
    console.log(`Clock-in fee:    ${formatUnits(q.clockInFee, feeDecimals)} ${q.feeAsset} per shift`);
    console.log(`Fee/day:         ~${formatUnits(q.feePerDay, feeDecimals)} ${q.feeAsset}`);
    console.log('\nNFA. Experimental. Values are on-chain reads only; no token price is assumed.');
  });

// ---------------------------------------------------------------- tank
program
  .command('tank <mine>')
  .description('Show fee-tank balance and print deposit/withdraw calldata')
  .option('--withdraw <wei>', 'print withdraw calldata for this amount')
  .action(async (mineKey: string, opts: { withdraw?: string }) => {
    const config = loadConfig();
    const profile = MINES[mineKey as MineKey];
    const mine = new Mine(profile, poolFor(config));
    if (!existsSync(config.keystorePath)) throw new Error('no keystore; run shadow-setup first');
    const owner = await prompt('Owner address (the tank depositor): ');
    const tank = await mine.tankOf(owner as Hex);
    console.log(`balance:      ${formatEther(tank.balance)} ${profile.feeAsset}`);
    console.log(`reserved:     ${formatEther(tank.reserved)} ${profile.feeAsset}`);
    console.log(`withdrawable: ${formatEther(tank.withdrawable)} ${profile.feeAsset}`);
    if (opts.withdraw) {
      const tx = buildWithdrawTank(profile, BigInt(opts.withdraw));
      console.log(`\nWithdraw calldata (sign with owner wallet):\n  to:   ${tx.to}\n  data: ${tx.data}`);
    }
  });

// ---------------------------------------------------------------- status
program
  .command('status')
  .description('One-shot status from persisted state and live counters')
  .action(async () => {
    const config = loadConfig();
    const state = new StateStore(statePath());
    await state.load();
    const slots = state.allSlots();
    if (slots.length === 0) {
      console.log('No slot state yet. Start mining with `derpminer run`.');
      return;
    }
    console.log('slot                         phase        prints   totalDERP');
    for (const { key, record } of slots) {
      const total = record.totalPrinted ? formatEther(record.totalPrinted) : '0';
      console.log(
        `${key.padEnd(28)} ${(record.phase ?? '-').padEnd(12)} ${String(record.prints ?? 0).padStart(6)}   ${total}`,
      );
    }
  });

// ---------------------------------------------------------------- run
program
  .command('run')
  .description('Start the mining daemon')
  .action(async () => {
    const config = loadConfig();
    if (config.walletMode === 'shadow' && !existsSync(config.keystorePath)) {
      throw new Error('no hot key; run `derpminer shadow-setup` first');
    }
    const pass = await prompt('Keystore passphrase: ');
    const privateKey = loadKeystore(config.keystorePath, pass);
    const handles = await startDaemon(config, privateKey);
    console.log(`Mining ${handles.engines.size} slot(s). Ctrl-C to stop.`);
    const shutdown = async () => {
      console.log('\nStopping…');
      await handles.stop();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  });

program.parseAsync().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
