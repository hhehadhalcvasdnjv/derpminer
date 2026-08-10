# Security & Trust Model

derpminer is built so that **running it cannot cost you anything but the mining fees you explicitly budget** — even if the code were malicious, even if the machine it runs on is compromised. This document explains why, and shows you how to verify it yourself rather than take our word for it.

## TL;DR

- Your **main wallet private key is never entered into, stored by, or seen by this tool.** Ever.
- The tool mines with a throwaway **hot key** that the StonkPit contracts restrict, on-chain, to two harmless actions: clock in (paid from a budget *you* set) and clock out (which **always pays your wallet, never the key**).
- **Worst case if the hot key is stolen or the client is malicious:** an attacker can waste the fee budget you funded by mining pointlessly. They **cannot** move your NFTs, drain your wallet, touch your DERP, or withdraw your tank.
- The tool talks to **only** the RPC endpoints you configure, plus one optional price GET and your optional webhook. Nothing else. The dashboard binds to `127.0.0.1` only.

## 1. Non-custodial by design — the shadow key

You never give this tool your wallet key. Instead you sign a one-time, **budgeted grant** in your own wallet (`derpminer shadow-setup` prints the exact transactions; you sign them in Rabby/Frame or on stonkpit.xyz):

- `setShadow(tokenIds, operator, expiry, budget, maxFee)` authorizes a **hot key** you generate locally as your "shadow" worker, bounded by an expiry, a per-clock-in fee ceiling, and a total budget.
- `depositTank(amount)` pre-funds a fee tank the shadow may spend from.

The StonkPit `PitMine` contract then enforces — **on-chain, not in this client** — that the shadow key can only:

- **clock in** on empty/dead slots, paying the quoted fee *from your tank*, never above `maxFee`, never past `budget`, never past `expiry`;
- **clock out**, which pays the reward to **the owner** (`payee = brokerOwner` on the shadow path), never to the key.

It **cannot** activate slots, restart healthy shifts, withdraw the tank, re-grant itself power, or transfer anything. This is the contract's own "restricted shadow profile." The real guarantee lives in the smart contract and does not depend on trusting this code at all.

> A leaked shadow key buys an attacker exactly: grief-mining for you inside the signed budget, plus the key's gas dust. The tank and your wallet are unreachable in both directions.

## 2. Defense in depth — the client can't even try

On top of the on-chain restriction, the signer itself enforces a hard allowlist ([`src/wallet/txGuard.ts`](src/wallet/txGuard.ts)). Before **any** transaction is signed, it must be:

- `to` one of your configured mine contracts, **and**
- a call to `clockIn` or `clockOut` (nothing else), **and**
- carrying **zero native value** (shadow clock-ins are tank-funded).

Anything else — a transfer, an approve, `withdrawTank`, `setShadow`, a call to any other address — throws before the key is ever used. This is proven by tests in [`test/txGuard.test.ts`](test/txGuard.test.ts): drain attempts, ERC20 transfers, approvals, tank withdrawals, and self-re-grants are all refused.

```bash
npx vitest run test/txGuard.test.ts   # watch every theft attempt get rejected
```

## 3. Network transparency — what talks to what

The **entire** outbound surface of this tool (audit it yourself):

```bash
grep -rn "fetch\|http\.\|https\.\|WebSocket\|net\.\|dns\." src/ --include="*.ts"
grep -rhoE "https?://[a-zA-Z0-9./_-]+" src/ --include="*.ts" | sort -u
```

You will find exactly:

| Destination | Why | Sends your data? |
|---|---|---|
| The RPC URLs **you** configure | reads + broadcasting your clock-in/out txs | only signed, public txs |
| `robinhoodchain.blockscout.com` (one GET) | DERP price for the dashboard | no — read-only, disable with `enablePrice: false` |
| Your webhook URL (only if you set one) | print/alert pings | only the message you'd expect |

- The dashboard server **binds to `127.0.0.1` only** — it is not reachable from your network. Run fully headless with `derpminer run --no-ui` and there is no server at all.
- No telemetry, no analytics, no "call home." Set `enablePrice: false` in your config for **zero** egress beyond your own RPCs.

## 4. Key storage

- The hot key is generated locally and stored **encrypted** (scrypt N=2¹⁵ + AES-256-GCM), file mode `0600` ([`src/wallet/keystore.ts`](src/wallet/keystore.ts)). It is decrypted in memory only while mining, behind a passphrase you set.
- We never write your owner key anywhere — the tool is never given it.

## 5. Minimal, auditable dependencies

Two runtime dependencies, both widely used and inspectable:

- [`viem`](https://viem.sh) — Ethereum library (signing, encoding, RPC).
- [`commander`](https://github.com/tj/commander.js) — CLI parsing.

No obfuscation, no build-time code generation, no postinstall scripts of our own. The source you read is the code that runs (`npm run build` is a plain `tsc`).

## 6. What this tool will never do

- **Never trades or sells your DERP.** It mines and reports; selling is yours alone.
- **Never gives financial advice.** `quote` shows on-chain reads (DERP/day, fees) and assumes no token price.
- **Never asks for your seed phrase or main key.**

## Reporting

Found something? Open an issue or reach the maintainer before public disclosure. This is experimental software on an experimental chain — **NFA**, and never stake more than you accept losing to smart-contract or market risk (that risk is real and separate from the wallet-safety guarantees above).
