# derpminer

A headless, RPC-resilient CLI miner for **StonkPit** ($DERP) on Robinhood Chain — for **StonkBrokers** and **PitBoys**.

StonkPit is a browser proof-of-work game: you clock a broker/boy in, your browser grinds SHA-256 at a fixed pace, and a winning hash prints `$DERP`. This tool does the same thing **headless from a terminal or server — no browser, no open tab, no wallet popups** — and it's built to survive flaky RPCs, which is where browser miners bleed rewards. The mining loop is pure CLI; an optional local dashboard (`http://127.0.0.1:8787`) lets you watch it, but the bot mines the same with it closed or with `--no-ui`.

> Independent, unaffiliated software built on public contracts. Experimental. **NFA.** Read the fine print on [stonkpit.xyz](https://stonkpit.xyz).

## Why a dedicated miner

The reward is set by **when** your proof lands, not how fast you hash — the on-chain pace cap means everyone submits at the same rate. That turns mining into a **scheduling** problem:

- **Precompute, then wait.** Each shift's solution is ground once (a few seconds of CPU), then the miner sleeps until the pace cap clears and submits inside the 150-second certified grace window. Near-zero idle CPU; hundreds of slots per box.
- **Never miss a submit.** Clock-outs are broadcast to every healthy RPC at once (hedged), with automatic failover, gas-bump retries, and a serial nonce queue. A stale or orphaned shift is re-clocked for free the instant it's detected.
- **Your main key stays cold.** By default the miner runs as a protocol **shadow key**: you sign one budgeted grant with your owner wallet, fund a fee tank, and the hot key can only spend that tank via clock-in and pay prints back to you. A leaked hot key buys an attacker nothing but grief-mining inside your budget.

## How mining works (the parts that matter)

- **Proof:** `sha256(mine ++ tokenId ++ ticks ++ slotProofHash ++ grindSeed)` must end in `0x5d3129` (P = 2⁻²⁴, ~16.8M expected hashes).
- **Seed:** the contract sets the grind seed at clock-in (from the ticker + previous block hash), so nothing can be pre-ground.
- **Pace cap:** a clock-out with `ticks` is only accepted after `ticks / 20000` seconds have passed since clock-in. Submit within 150s of that moment to print **certified** and be paid at your tick position; later prints still pay but are repriced down the decay curve.
- **Reward:** the quickest hash prints the most (up to 4 444 DERP), decaying to a 44 DERP floor. The live **Index** (0–90) compresses rewards when the floor runs hot.
- **PitBoys:** same engine, but fees are in **APE** and every active slot must be backed by a distinct PitBoy in the panel (one boy = one live shift).

Every one of these is enforced on-chain; this client can't and doesn't try to bend them. It just schedules submissions perfectly and never misses one.

## Install

```bash
npm install
npm run build
```

Requires Node ≥ 20. For the fork E2E test you also need [Foundry](https://book.getfoundry.sh/) (`anvil`).

## Usage

```bash
# 1. Configure RPCs, wallet mode, and which token/slots to mine.
#    Bring your own RPC endpoints — add at least two for resilience.
derpminer init

# 2. Shadow mode (recommended): generate a hot key and print the owner
#    transactions that grant it a budget. Sign these with your OWNER wallet.
derpminer shadow-setup --budget <wei> --max-fee <wei> --deposit <wei> --days 30

# 3. Check the economics before committing (on-chain reads only, no price guess).
derpminer quote pitboys <tokenId> <slot>

# 4. Run the daemon. Headless by default; dashboard on http://127.0.0.1:8787.
derpminer run
derpminer run --no-ui          # pure CLI, no dashboard server at all

# Anytime:
derpminer status              # persisted per-slot state + lifetime prints
derpminer tank pitboys        # fee-tank balance; --withdraw <wei> for calldata
```

The miner reads its config and encrypted hot key from `~/.derpminer` (override with `DERPMINER_HOME`). Set `DERPMINER_LOG=debug` for verbose logs.

## Safety model — it cannot drain you

Running this **cannot cost you anything but the mining fees you explicitly budget**, even if the code were malicious. Full details and a self-audit recipe in [SECURITY.md](SECURITY.md); in short:

- **Your owner private key is never entered, stored, or seen by this tool.** `shadow-setup` prints calldata you sign in your own wallet.
- The tool mines with a throwaway **hot key** that the StonkPit contract restricts *on-chain* to two harmless actions: clock in (paid from a budget **you** set, capped by `maxFee`) and clock out (which **always pays your wallet, never the key**). It cannot activate, withdraw the tank, re-grant itself, or transfer anything.
- **Defense in depth:** the signer itself refuses to sign anything but `clockIn`/`clockOut` to your mine, with zero native value — proven by [`test/txGuard.test.ts`](test/txGuard.test.ts) (every drain/transfer/approve attempt is rejected).
- **Worst case if the hot key leaks:** an attacker wastes your budgeted fees by grief-mining. Your wallet, NFTs, DERP, and tank are unreachable.
- **No hidden network calls:** only your RPCs, one optional price GET (`enablePrice: false` to disable), and your optional webhook. The dashboard binds to `127.0.0.1` only; `--no-ui` removes it entirely.
- **No trading, ever.** It mines and reports; `quote` assumes no token price — the value judgment is yours.

## Testing & verification provenance

```bash
npm test                                  # fast unit suite
DERP_SLOW_TESTS=1 npm test                # + real multi-million-hash grinds
LIVE_VERIFY=1 npm run test:e2e            # grind a live shift; chain's verifyProof confirms it
FORK_RPC=https://rpc.mainnet.chain.robinhood.com npm run test:e2e   # full clock-out on an anvil fork
```

Correctness is anchored three ways:

1. **Golden vector** — the SHA-256 preimage reproduces a real on-chain proof byte-exact (PitBoys token 742, slot 3, ticks 13 786 224 → `…cd5d3129`).
2. **Live consensus** — the engine grinds a currently-open shift and the chain's own `verifyProof` view accepts the solution.
3. **Full write path** — on an anvil fork of Robinhood Chain, a ground solution is clocked out against real deployed bytecode and DERP transfers out of the mine's pool, exactly matching the emitted reward.

## License

MIT — see [LICENSE](LICENSE).
