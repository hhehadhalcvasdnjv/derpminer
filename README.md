# ⛏ derpminer

**Mine `$DERP` on StonkPit headless — no browser, no open tab, no popups — and keep your main wallet cold.**

[![CI](https://github.com/hhehadhalcvasdnjv/derpminer/actions/workflows/ci.yml/badge.svg)](https://github.com/hhehadhalcvasdnjv/derpminer/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-2bff88.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-38e8ff.svg)](package.json)

StonkPit is a browser proof-of-work game on Robinhood Chain: clock a **StonkBroker** or **PitBoy** in, your browser grinds SHA-256 at a fixed pace, a winning hash prints `$DERP`. derpminer does the same thing from a terminal — built to **survive flaky RPCs** (where browser miners bleed rewards) and to run 24/7 with a **budgeted shadow key** that can't touch your funds.

> ⚠️ Independent, unaffiliated software built on public contracts. Experimental, on an experimental chain. **NFA.**

The optional dashboard (`http://127.0.0.1:8787`) is an amber-phosphor text-mode terminal: miner slots with ASCII countdown bars and sparklines, a live print feed, RPC-pool health, and the emission-index gauge — all served locally by the daemon. Mining runs the same with it closed or with `--no-ui`.

<!-- Tip: run `derpminer run`, open http://127.0.0.1:8787, screenshot it, and drop it at docs/dashboard.png to feature it here. -->

## Why a dedicated miner

- **It's a scheduling problem, not a speed problem.** The on-chain pace cap means everyone mines at the same rate. derpminer precomputes each shift's solution once (seconds of CPU in a worker thread), then sleeps until the pace cap clears and submits inside the 150-second certified window — capturing the full tick-based reward that laggy browser tabs get repriced out of.
- **RPC-resilient.** A health-scored pool of your endpoints with automatic failover; time-critical clock-outs are **broadcast to every healthy RPC at once** (hedged), with gas-bump retries and a serial nonce queue. Stale/orphaned shifts re-clock for free the instant they're detected.
- **Headless & cold.** Runs as pure CLI (`--no-ui`) on your machine or a small server. Your main wallet key never touches the tool — mining uses a throwaway hot key the contract restricts on-chain.

## 🔒 It cannot drain your wallet — verify in 60 seconds

The safety guarantee is **enforced on-chain**, so it holds even if you don't trust this code:

- Your **owner key is never entered into, stored by, or seen by the tool.** You sign a one-time budgeted grant in your own wallet.
- The hot key it mines with is restricted by the StonkPit contract to **clock in** (paid from a tank *you* fund, capped by `maxFee`) and **clock out** (which **always pays your wallet, never the key**). It can't activate, withdraw the tank, re-grant itself, or transfer anything.
- **Worst case if the hot key leaks:** an attacker wastes your budgeted fees by grief-mining. Your wallet, NFTs, DERP, and tank are unreachable.

Check it yourself:

```bash
# Every outbound connection this tool makes (only your RPCs + one price GET + your webhook):
grep -rn "fetch\|http\.\|WebSocket\|net\.\|dns\." src/ --include="*.ts"

# Watch every theft attempt (transfer/approve/withdrawTank/setShadow) get rejected before signing:
npx vitest run test/txGuard.test.ts
```

Full model and audit recipe in **[SECURITY.md](SECURITY.md)**.

## Quickstart

Prerequisites (you acquire these yourself): a **PitBoy** on Robinhood Chain, **~60–75 APE**, and a little **ETH** for gas. Then:

```bash
npm install && npm run build
alias derpminer="node $PWD/dist/cli.js"

derpminer quote pitboys 742 0                  # see live economics (free, read-only)
derpminer init                                 # configure mine, token, slots
derpminer activate pitboys <TOKEN> 0 --web     # activate the slot (signs in your browser wallet)
derpminer shadow-setup --deposit 15 --budget 100 --max-fee 0.2 --days 14 --web
derpminer run                                  # headless miner + dashboard on :8787
```

Full walkthrough with troubleshooting: **[QUICKSTART.md](QUICKSTART.md)**.

## How mining works

- **Proof:** `sha256(mine ++ tokenId ++ ticks ++ slotProofHash ++ grindSeed)` must end in `0x5d3129` (~16.8M expected hashes). The seed is set by the contract at clock-in, so nothing can be pre-ground.
- **Reward:** the quickest hash prints the most (up to 4 444 DERP), decaying to a 44 floor. The live **Index** (0–90) compresses rewards when the floor runs hot. The *expected* print integrates the geometric hit distribution — `quote` shows the honest number, not the naive floor.
- **Both floors, one engine:**

| | StonkBrokers (`broker`) | PitBoys (`pitboys`) |
|---|---|---|
| Fees | ETH | APE |
| Slots | 16, cheap flat fees | 16, each backed by a distinct boy |
| Capital / slot | ~$1,320 (NFT floor ~11 ETH ÷ 16) | ~$316 (one boy) |

## Commands

`init` · `quote <mine> <tok> <slot>` · `activate <mine> <tok> <slot> [--web]` · `shadow-setup [--web]` · `run [--no-ui] [--port]` · `status` · `tank <mine> [--withdraw]`

## Testing & verification provenance

```bash
npm run check                              # typecheck + unit tests
DERP_SLOW_TESTS=1 npm test                 # + real multi-million-hash grinds
LIVE_VERIFY=1 npm run test:e2e             # grind a live shift; chain's verifyProof confirms it
FORK_RPC=<rpc> npm run test:e2e            # full clock-out on an anvil fork
```

Correctness is anchored three ways: a **golden vector** (the preimage reproduces a real on-chain proof byte-exact), **live consensus** (the engine grinds a currently-open shift and the chain's own `verifyProof` accepts it), and the **full write path** (a ground solution clocks out against real bytecode on an anvil fork and DERP transfers out of the mine's pool).

## Disclaimer

This tool mines and reports; it never trades or sells your DERP, and assumes no token price. Mining profitability depends on the DERP price, the emission index, and NFT floors — all volatile. Nothing here is financial advice. Never stake more than you accept losing.

## License

[MIT](LICENSE)
