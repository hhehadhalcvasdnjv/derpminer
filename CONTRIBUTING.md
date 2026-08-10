# Contributing

Thanks for looking under the hood. This is experimental software on an experimental chain — issues, fixes, and audits are all welcome.

## Ground rules

- **Safety first.** Anything touching keys, signing, or the transaction path must keep the guarantee that the hot key can only `clockIn`/`clockOut` (see [SECURITY.md](SECURITY.md)). Changes there need tests in `test/txGuard.test.ts`.
- **No new network egress** without discussion. The tool talks only to the user's RPCs, the optional price GET, and the optional webhook. Keep it that way.
- **Tests are the spec.** Every behavior change comes with a test. The proof engine in particular is anchored to a real on-chain vector — don't loosen it.

## Dev loop

```bash
npm install
npm run check          # typecheck + unit tests (fast)
npm run test:watch     # TDD
DERP_SLOW_TESTS=1 npm test   # + real multi-million-hash grind tests
```

Verify against the live chain (needs a Robinhood Chain RPC, and Foundry for the fork test):

```bash
LIVE_VERIFY=1 npm run test:e2e
FORK_RPC=https://rpc.mainnet.chain.robinhood.com npm run test:e2e
```

## Style

- TypeScript, ESM, strict mode. `npm run typecheck` must be clean.
- Small, focused modules. Match the existing structure (`src/chain`, `src/core`, `src/mines`, `src/wallet`).
- Comments explain *why*, not *what*.

## Reporting security issues

Please open a minimal issue or contact the maintainer before public disclosure of anything that could put funds at risk.
