# derpminer — Quickstart

From nothing to a running headless miner. Read [SECURITY.md](SECURITY.md) first if you want to know why this can't drain your wallet.

---

## 0. What you need first (you buy/bridge these yourself)

The tool mines; it can't buy NFTs or move money for you. Before you start, have in a wallet **on the Robinhood Chain**:

1. **At least one PitBoy** — floor ~0.16 ETH on [OpenSea](https://opensea.io/collection/pitboys). One boy lets you mine **slot 0**. (More slots need more boys assigned in the panel.)
2. **~60–75 APE** — activation of slot 0 costs **58.78 APE** right now; the rest funds the fee tank.
3. **A few dollars of ETH** — for gas (transactions cost ~$0.01–0.03 each).

Bridging APE/boys to the Robinhood Chain: see the "Setup guide" on [stonkpit.xyz](https://stonkpit.xyz).

---

## 1. Install

```bash
cd /Users/b/yo
npm install
npm run build
```

Make the `derpminer` command available without `sudo` (avoids the `npm link` permission error):

```bash
echo 'alias derpminer="node /Users/b/yo/dist/cli.js"' >> ~/.zshrc && source ~/.zshrc
```

Check it works:

```bash
derpminer --help
```

---

## 2. Look before you leap (free, read-only)

See the live economics of any boy — no wallet, no cost:

```bash
derpminer quote pitboys 742 0
```

Shows the emission index, expected DERP per shift, DERP/day, and fees. Swap `742` for your token id once you have one.

---

## 3. Configure

```bash
derpminer init
```

Answer the prompts: mine = `pitboys`, your token id, slots = `0`, wallet mode = `shadow`, chase tip = `n`. This writes `~/.derpminer/config.json`.

---

## 4. Activate your slot (owner action)

```bash
derpminer activate pitboys <YOUR_TOKEN_ID> 0 --web
```

`--web` opens a local page that signs the transactions (agree → approve 58.78 APE → activate) **through your own browser wallet** (Rabby/MetaMask) — your key never leaves the extension. Click through them; it even offers to add the Robinhood Chain.

Prefer not to use `--web`? Drop the flag to print raw calldata, or just click *activate* on [stonkpit.xyz](https://stonkpit.xyz) — same on-chain result.

---

## 5. Hand mining to a shadow key

```bash
derpminer shadow-setup --budget 100 --max-fee 0.2 --deposit 15 --days 14 --web
```

This:
- generates an **encrypted hot key** (asks for a passphrase — remember it),
- opens the browser signing page for the four owner transactions: `agree` → `approve` APE → `setShadow` → `depositTank`.

Amounts are in **APE**: `--deposit 15` puts 15 APE in the fee tank (~1.5 days of testing), `--budget 100` caps what the hot key may ever spend, `--max-fee 0.2` caps each clock-in. Sign them in your browser wallet (drop `--web` for raw calldata instead).

> Your owner key never touches the tool. The hot key it made can only clock in from that tank and clock out to you — nothing else (SECURITY.md).

---

## 6. Run it

```bash
derpminer run                 # headless miner + dashboard on http://127.0.0.1:8787
derpminer run --no-ui         # pure CLI, no dashboard at all
```

Enter your keystore passphrase. It now mines autonomously — close the terminal tab's browser, no popups, 24/7. Leave it running on your machine or a small server.

---

## 7. Watch it

```bash
derpminer status              # per-slot prints + lifetime DERP, one-shot
```

Or open **http://127.0.0.1:8787** for the live dashboard (slots, countdowns, print feed, RPC health). The miner runs the same whether the dashboard is open or not.

Check your fee tank so it never runs dry:

```bash
derpminer tank pitboys
derpminer tank pitboys --withdraw 5    # prints calldata to pull 5 APE back out
```

---

## Start small

First run: **1 boy, slot 0, `--deposit 15`, `--days 14`.** Watch the first prints land in `status`, confirm DERP arrives in your wallet, *then* scale up with more boys/slots. The first real print is your go/no-go.

## Common snags

- **`npm error EACCES … symlink`** → you ran `npm link`; use the alias from step 1 instead.
- **`no targets configured`** → run `derpminer init` first.
- **`no hot key`** → run `derpminer shadow-setup` first.
- **Slot won't mine / `NotActivated`** → the slot isn't activated yet (step 4), or (for slots >0) the backing boy isn't assigned in the panel on stonkpit.xyz.
- **Tank empty / clock-ins failing** → top up with another `depositTank` (re-run `shadow-setup` with a bigger `--deposit`, or deposit directly on stonkpit.xyz).
