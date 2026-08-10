# derpminer — Headless CLI-Miner für StonkPit ($DERP) auf Robinhood Chain

**Datum:** 2026-08-10 · **Status:** Approved (User: "entscheide du, soll einfach funktionieren und mega gut sein")

## 1. Ziel

Ein robuster, headless CLI-Miner/Daemon für die StonkPit-Mines (StonkBrokers **und** PitBoys), der die zwei Schwächen des Browser-Minings behebt:

1. **RPC-Fragilität** — verpasste Clock-outs/Re-clocks durch flaky RPCs kosten direkt Reward (Repricing nach 150s Grace, TickerStale-Voids). Der Miner nutzt einen Multi-RPC-Pool mit Failover und gehedgten Submits.
2. **Browser-Zwang** — Tab offen halten, Wallet-Popups. Der Miner läuft 24/7 auf einem Server mit dem vom Protokoll vorgesehenen Shadow-Key-Modell (Haupt-Wallet bleibt kalt).

Nicht-Ziele v1: kein Umgehen von Protokollregeln (unmöglich, alles on-chain enforced), kein Multi-Chain-Bridging, keine GUI, kein Auto-Verkauf von DERP (keine Trades!).

## 2. Protokoll-Referenz (aus verifizierten Contracts destilliert)

### Adressen (Robinhood Chain Mainnet, Chain-ID 4663)

| Rolle | Adresse |
|---|---|
| DERP Token ("pit") | `0x6543B7746ca744C4bb2198191E71f40FF04C41b9` |
| PitMine (Broker-Mine, ETH-Fees) | `0x2d0da469115232aD00159757f9d25f81D498206D` |
| PitBoysMine (APE-Fees) | `0x6FeD5aE5d486A59081FDC040179CEBDA4be80511` |
| StonkBrokers NFT | `0x539CdD042c2f3d93EbC5BE7DfFf0c79F3B4fAbF0` |
| PitBoys NFT | `0x57069d845701B50F41327362C1C23789043F8DEc` |
| APE (Robinhood Chain) | `0x8f86a15EC17cb3369d8b3E666dAdBC11daA82b79` |
| RPC (offiziell) | `https://rpc.mainnet.chain.robinhood.com` |

ABIs: aus Blockscout-Verified-Sources extrahiert (`abi_pitMine.json`, `abi_pitBoysMine.json`, `abi_derp.json`) — werden ins Repo eingecheckt.

### PoW & Timing

- Proof: `sha256(abi.encodePacked(mineAddr[20], tokenId[u256], ticks[u256], slotProofHash(tokenId,slot)[b32], shift.grindSeed[b32]))` — 148-Byte-Preimage; die **letzten 3 Bytes** müssen `proofSuffix = 0x5d3129` sein (P=2⁻²⁴ pro Tick, E[Ticks]≈16,78M).
- `slotProofHash`: `lastProofHash[tokenId][slot]`, Genesis: Slot 0 → `0x0`, Slots 1–15 → `keccak256(tokenId, slot)`. Chained: jeder Print wird das prev des nächsten.
- `grindSeed` wird beim `clockIn` vom Contract gesetzt (`keccak256(ticker, blockhash(n-1))`) — steht im `ClockedIn`-Event und in `shiftOf`. Kein Pre-Grinding möglich.
- **Pace-Cap (on-chain):** `ticks ≤ (block.timestamp - startTime) × maxTicksPerSecond` (aktuell 20 000/s). → Der Client darf beliebig schnell **rechnen**, aber erst ab Chain-Zeit `startTime + ticks/pace` **submitten**.
- **Certified-Fenster:** Submission mit Inclusion-Timestamp ≤ `startTime + ticks/pace + graceSeconds` (150s) → certified (wenn zusätzlich Single-Link-Tip + Distinct-Identity + Epoch-Cap ≤ 16/h passen) → `FRESH_TIP_BONUS_BPS`-Aufschlag. Später: Print bleibt gültig, wird aber auf Wall-Clock-Position **repriced**.
- **Reward:** `base = maxPrint >> (ticks/560000)`, linear interpoliert je Stufe, Floor `minPrint = 44e18`; dann `× (100 − Index)/100` (Index 0–90 aus Floor-Durchsatz; aktuell 90 → ×0,1), wieder gefloort; dann `× tierMultiplierBps` (1,00×–5,00×). On-chain-View: `previewPrint(tokenId, ticks)`.
- **Streak-Anker:** Pricing-Position ist `max(ticks, (now − streak.start)×pace − graceTicks)` — der Decay läuft ab letztem Print des Slots, Restarts/Re-clocks rewinden nie.
- **TickerStale:** Shift snapshottet bei Clock-in `expiryTickerCount = tickerCount + tickerExpiryPrints()` (~3 erwartete Solves, min 8 Prints). Läuft `tickerCount` darüber, revertet clockOut → **kostenloser Re-clock** (fee 0), neuer Seed, Streak unangetastet.
- **Orphan (nur Certified-Track):** landet ein fremder certified Print nach unserem Clock-in, kann unser Shift nie mehr certified printen (zahlt aber voll) → für den Bonus: free Re-clock zur neuen Tip.
- `verifyProof(tokenId, slot, ticks)` ist ein on-chain View → via `eth_call` kostenloser Pre-Check vor jedem Submit.
- `clockOut` ist bewusst **nicht pausierbar**; Fees/Kurven sind immutable oder nur-bei-Pause änderbar; `ShiftTtl` = 7 Tage; Transfer des NFT voidet Shift & Aktivierung.

### Auth & Fees

- **Pledge-Gate:** Nicht-Shadow-Caller müssen einmalig `agree()` gecallt haben.
- **Shadow-Modell (unser Default):** Owner signiert einmalig `setShadow(tokenIds[], operator, expiry, budget, maxFee)` + `depositTank(amount)`. Der Shadow-Key darf: clockIn nur auf leeren/toten Slots oder free Re-clocks (aus dem Tank bezahlt, nie > maxFee/budget), clockOut auf jedem Shift des Brokers (zahlt **immer an den Owner**). Er darf nicht: aktivieren, gesunde Shifts restarten, Tank anfassen. Gestohlener Key ⇒ nur Grief im Budget.
- **Slots:** 16 pro Broker. Broker-Mine: Slot 0 über Preis-Kurve (aktuell ~0,00285 ETH), Slots 1–15 flat 0,0005 ETH. Volume-Discount auf Clock-in-Fees bis ~50% bei 16 Slots. Clock-in-Fee atmet mit Index (~5× bei 90); Broker-Mine aktuell ~0,000005 ETH.
- **PitBoysMine:** identische Engine, aber (a) Fees in **APE** via `transferFrom` (exakt, kein Overpay; `msg.value` muss 0 sein) — Aktivierung ~58,7 APE, Slot-Fee 10 APE, Clock-in ~0,1 APE; Tank ebenfalls APE (Approve nötig); (b) **Bodies back slots:** Slot 0 = Panel-Anchor-Boy, Slots 1–15 je ein weiterer PitBoy im Panel-Registry; 1 Boy = 1 Live-Shift (Lazy Lease, `boyLease`-View); (c) Certified-Identity ist der Boy, nicht der Anchor.
- Quote-Views: `clockInFeeFor(tokenId, slot, caller)`, `activationFee()`, `slotActivationFee(slot)`, `tankOf(owner)`, `theIndex()`, `floorHealth()`.

### Events (Client-Feed)

- `ClockedIn(tokenId, slot, worker, prevProofHash, fee, ts, grindSeed, restarts, expiryTickerCount)` — alles für den Grind.
- `ClockedOut(tokenId, slot, caller, ticks, elapsed, reward, index, proofHash)`.
- `TickerPrinted(count, ticker)` — global; treibt Stale-Detection.
- `TickerCertified(certifiedCount, tickerCount, ticker)` — treibt Orphan-Detection.

## 3. Architektur

TypeScript (Node ≥ 20, ESM), viem, vitest. Ein Prozess, ereignisgetrieben, kein Dauer-CPU-Load (Precompute je Shift einmalig in `worker_threads`, danach reine Timer).

```
src/
  chain/registry.ts      Adressen, Chain-Defs (4663), ABIs
  chain/rpcPool.ts       RPC-Manager: Pool, Health-Scoring, Failover, hedged send
  chain/txQueue.ts       Nonce-Manager + serielle Sende-Queue + Gas-Bump-Retry
  core/proof.ts          Preimage/SHA256/Suffix, Chunk-Precompute (worker_threads)
  core/schedule.ts       Solve-Zeitpunkte, Grace-Fenster, Chain-Zeit-Puffer
  core/shiftEngine.ts    State-Machine pro (mine, tokenId, slot)
  core/watcher.ts        Log-Polling (getLogs) + State-Polling (tickerCount, certifiedCount, Index)
  wallet/shadow.ts       Shadow-Key-Handling, Setup-Tx-Builder (agree/setShadow/depositTank/approve)
  mines/broker.ts        ETH-Fee-Spezifika
  mines/pitboys.ts       APE-Fee-Spezifika (Approve-Flow), Panel/Lease-Checks
  cli.ts                 Commands; state/config unter ~/.derpminer/
```

### RPC-Manager (der Kern gegen "RPC issues")

- Pool aus n Endpoints (Default: offizieller RPC; `init` fragt nach eigenem Alchemy/Custom-Key und empfiehlt ≥2).
- Health: rollierendes Latenz-/Fehler-Scoring pro Endpoint (EWMA), Blockhöhen-Vergleich (lagging Endpoints degradiert), automatische Wiederaufnahme.
- Reads: schnellster gesunder Endpoint, Retry auf nächstem bei Fehler/Timeout (kurze Timeouts, 2 Versuche, dann nächster).
- **Writes (clockOut/clockIn): eine signierte Raw-Tx, parallel an alle gesunden Endpoints gebroadcastet** (idempotent — gleiche Tx-Hash). Bestätigung via Receipt-Polling über den Pool. Bei Timeout: Gas-Bump (gleiche Nonce) und erneut.
- Lokaler Nonce-Manager (ein Signer ⇒ serielle Queue; Nonce-Resync bei `nonce too low`).

### Shift-Engine (State-Machine pro Slot)

```
IDLE → CLOCKIN_SENT → GRINDING → WAITING(bis Chain-Zeit startTime+T/pace+puffer)
     → PRECHECK(eth_call verifyProof) → CLOCKOUT_SENT → PRINTED → (re-clock) …
Störpfade: TICKER_STALE → FREE_RECLOCK · ORPHANED → FREE_RECLOCK (nur wenn EV[Bonus] > Re-Grind-Verlust, sonst weiterlaufen lassen) · TTL_NEAR → Force-Clockout am Floor · RPC_DOWN → Backoff, hedged Retry
```

- Precompute chunked (50M Ticks ≈ Sekunden CPU; P(kein Hit) ≈ 7·10⁻⁶ → nächster Chunk).
- Alle Zeitrechnung in **Chain-Zeit** (Block-Timestamps aus Events/Blöcken), Submit-Vorlauf konfigurierbar (Default: Tx 3s vor Fenster-Start abschicken, Ziel-Inclusion kurz nach `T/pace`).
- Restart-Escalation-Fees werden nie ausgelöst (Shadow darf eh nicht; Engine re-clockt nur tote/stale Shifts).
- State-File (JSON, atomisch) für Wiederanlauf; nach Crash: `shiftOf()` lesen → deterministisch weiterrechnen (Seed on-chain).
- Orphan-Ökonomie: Re-clock nur, wenn erwarteter Bonus-Gewinn > erwarteter Streak-Decay-Verlust (beides aus previewPrint ableitbar); Default konservativ (kein Re-clock bei gesundem Grind), per Config `chaseTip: true|false`.

### Wallet-Layer

- **Shadow-Mode (Default):** `derpminer shadow-setup` erzeugt Hot-Key (verschlüsselt via OS-Keychain oder Passphrase in `~/.derpminer/`), gibt die vier Owner-Transaktionen aus (`agree`, ggf. `approve APE`, `setShadow`, `depositTank`) — wahlweise als Calldata zum Selbst-Signieren oder direkt via einmalig eingelesenem Owner-Key (nur im Speicher, nie persistiert; explizite Warnung).
- **Direct-Mode:** ein Key für alles (nur für Tests/kleine Setups, deutliche Warnung).
- Tank-Monitor: warnt via Webhook/Console, wenn Budget/Tank < konfigurierter Reichweite (z.B. < 24h Fees).

### CLI

`derpminer init` (Wizard: Mine, RPCs, Wallet-Modus, Tokens/Slots) · `shadow-setup` · `activate` (Owner-Aktion, Slot-Kurven-Quote inkl. Bestätigung) · `run` (Daemon; Status-TUI mit Slots, nächsten Solve-Zeiten, Index, Tank) · `status` · `quote` (Fees, Index, Tier, EV/Tag pro Slot, Break-even) · `tank` (Stand/Deposit/Withdraw-Calldata) · `simulate` (EV-Rechner offline).

## 4. Sicherheit & Fairness

- Nur dokumentierte, permissionless Contract-Pfade; Pace/Fees/Certification sind on-chain enforced — der Client kann und will nichts umgehen. Die offizielle App nennt sich selbst "independent, unaffiliated software built on public contracts"; dieses Tool ist dasselbe in headless.
- Shadow-Restricted-Profile als Default-Sicherheitsmodell; Owner-Key wird nie persistiert.
- Kein Auto-Sell, keine Preis-Empfehlungen. `quote` zeigt nur on-chain ablesbare Größen.
- Der im offiziellen Frontend gefundene Alchemy-Key wird **nicht** verwendet — User bringt eigene Endpoints mit.

## 5. Teststrategie

1. **Golden Vectors:** echte akzeptierte Proofs von der Chain (ClockedIn/ClockedOut-Event-Paare) → `proof.ts` muss Hash + Suffix exakt reproduzieren (verifiziert Preimage-Layout byte-genau, inkl. Slot-Genesis 0 vs. keccak(tokenId,slot)).
2. **Unit:** Reward-Kurve (gegen `previewPrint`-eth_calls als Referenzwerte), Scheduler-Mathe (Pace/Grace-Fenster, Chain-Zeit-Puffer), RPC-Pool (gemockte Transports: Timeouts, Fehler, lagging Blocks, hedged Dedupe), State-Machine-Übergänge (stale/orphan/ttl).
3. **E2E gegen echten Bytecode:** `anvil --fork-url <robinhood-rpc>`, Broker-Owner impersonieren, kompletten Loop fahren (clockIn → Seed aus Event → grind → warp → clockOut → DERP-Balance prüfen), inkl. Stale- und Shadow-Pfad.
4. Lint/Typecheck strikt; CI-fähige Scripts.

## 6. Risiken & offene Punkte

- **Ökonomie:** Bei Index 90 printen fast alle Solves den Floor (44 × Tier − Kompression greift bis zum Floor). Ob sich Slots lohnen, zeigt `quote` live — das Tool macht die Rechnung transparent, verspricht nichts.
- **Robinhood-Chain-Eigenheiten** (Arbitrum-Lineage): Block-Timestamp-Granularität und Sequencer-Latenz werden im Fork-Test vermessen; Submit-Puffer ist konfigurierbar.
- WebSocket-Support der RPCs ungewiss → v1 pollt (`getLogs`, 2–3s), WS optional später.
- Tier-Source (Clutch-Tiers) wird nur gelesen (`tierMultiplierBps`), nicht verwaltet.
- Veröffentlichung auf GitHub erst nach explizitem User-Go (Repo wird publikationsfertig aufgebaut: MIT, README, keine Secrets).
