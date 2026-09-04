# Project state

Read this file first in every session and update it last before pushing. It answers four questions: where we are, what was decided, what is open, and how to verify. Long detail lives in `ROADMAP.md`, `ENGINE.md` and `adr/`, not here.

Last updated: 2026-09-04 · branch `claude/new-project-review-h5rmic`

## Where we are

| Phase (from ROADMAP)                | Status      | Note                                                                                                                                                                |
| ----------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pre-0: turn WICK into a real desk   | done        | no fabricated data, no paper mode, configurable RPC, a confirm step before every trade                                                                              |
| 0: governance and quality gates     | done        | except `main` protection (a manual GitHub setting)                                                                                                                  |
| 1: host and data                    | in progress | skeleton, schema, ingest v1, LP state, launch parsing, poll-side chain events, deploy stack, API and console are in; left: webhooks, the features row; then the VPS |
| 2: decision, gates and suggest mode | not started |                                                                                                                                                                     |
| 3: level-2 learning and auto mode   | not started |                                                                                                                                                                     |
| 4 to 7                              | not started |                                                                                                                                                                     |

## What was decided (summary; details in the ADRs)

- **Starting capital:** 2,500 USD. 1.5% risk per trade, 6 positions at most, a daily halt at −5%, infrastructure ≤ 70 USD a month.
- **Capital ladder (ADR-0005):** three tiers, 2,500 then 10,000 then 30,000, with written promotion criteria; size is always the minimum of an equity share, a pool-liquidity share and the token cap.
- **Custody:** the desk uses a browser hot wallet (ADR-0002). The engine runs on a VPS with a sealed key (ADR-0003), replaced by a separate signer or KMS as a tier-3 precondition.
- **Autonomy:** two modes, suggest then auto, and three learning levels (ADR-0004). Shadow precedes suggest for every new rule.
- **Chains (ADR-0006):** Solana only in v1; the core is chain-agnostic behind `ChainAdapter`; Base is the candidate after 90 days of positive expectancy.
- **Data and backtesting (ADR-0007):** second-resolution collection from day one of Phase 1; replay is the production decision code over stored snapshots, always labelled.
- **Supply map:** a `supply` gate (dev, bundle, snipers, fresh wallets, trend) with three handlings: reject, shrink size, or wait for distribution. Basics in Phase 2, the funding tree in Phase 4.
- **Smart copy:** wallet discovery, classification and numeric scores in Phase 4, at most 6 copied wallets in total.
- **Wallet profiler and decision budget (ADR-0008):** one module classifies wallets and everything reads it; four microstructure features only; rejects for capital-loss risk only, seven gates, ≤ 40 features, ≤ 25 codes, decisions under 50 ms, and any feature without replay evidence within 60 days is removed. Order books, offensive MEV, time-based DCA and the paid X API are deliberately not built.
- **Console (ADR-0010):** `apps/console` with two screens and a detail (Now, Engine, Token) on the API contract in core, with a labelled mock mode; the desk is frozen and retires at the end of Phase 2. A screen is added only for a daily question Now cannot answer.
- **Control plane and operations (ADR-0009):** an HTTP/WS API on Tailscale only, the console as an installed PWA, a Telegram bot for alerts and `/halt` and `/approve`, no native app; exporters, Alertmanager, a dead-man ping and self-halt on bad health.
- **Language:** the whole platform is English: code, identifiers, strings, documents, the state ledger and the roadmap. No second language in the UI.
- **Numbers:** any number without a source is `null` and renders n/a; filters reject unknown (ADR-0001).
- **Merging:** squash to `main`; the PR title is checked by commitlint. Standing rule (owner, 2026-09-04): the assistant performs the merge, only after the owner's explicit permission for that specific merge; a PR is opened without asking (standing permission, 2026-09-04) and is never merged unasked. Merge plan adopted the same day (`CONTRIBUTING.md`): one foundation PR, then one PR per verifiable slice, a tag on `main` at the end of each phase, deploys from tags only.

## Open

- [ ] **Manual:** enable `main` branch protection in GitHub settings (steps in `CONTRIBUTING.md`).
- [ ] **Manual, Vercel:** set the desk project's Root Directory to `apps/desk` after the merge, or its deploy fails. (The desk retires at the end of Phase 2; the console is served from the VPS.)
- [ ] **Bring the engine up on a VPS:** steps in `docs/OPS.md`; needs a Hetzner account, Tailscale, a Telegram bot, healthchecks.io and an RPC key from the owner.
- [ ] Phase 1 ingest remainder: Helius webhooks (create, migrate, LP, followed-wallet prints) and the per-second features row.
- [ ] Provider choices at VPS time: RPC and webhooks (Helius by default), VPS (Hetzner by default), dead-man service (healthchecks.io by default).
- [ ] The holder count and the LP holder read work only with a private RPC; public ones refuse `getTokenLargestAccounts`. Without it LP is `burned` or `null`, never `locked` or `deployer`.
- [ ] The PumpSwap pool layout and the locker program ids were written from memory and are validated by the base/quote-mint check, not against a live pool yet; the first VPS run must confirm them on a migrated token before the safety gate reads `lp`.
- [ ] Google Fonts is blocked in the test sandbox; the one console error in the desk's render smoke is expected.
- [ ] The desk (`apps/desk`) still carries its Arabic dictionary; it is frozen to bug fixes and retires with Phase 2, so it is left as is.

## How to verify

```sh
npm run typecheck && npm run lint && npm run format:check && npm test && npm run audit
NITRO_PRESET=node-server npm run build && PORT=3000 node apps/desk/.output/server/index.mjs &
npm run smoke -- http://127.0.0.1:3000/ screenshots
VITE_MOCK=1 npm run build -w @wick/console && (cd apps/console && npx vite preview --port 8091 &) && npm run smoke -- http://127.0.0.1:8091/ screenshots/console
# with a local Postgres: TEST_DATABASE_URL=postgres://wick@127.0.0.1:5432/wick npm -w @wick/engine test
```

State at last update: everything above green, 40 tests (17 core, 3 desk, 3 console, 17 engine including a Postgres integration test), 0 vulnerabilities, 0 lint warnings.

## Session log

| Date       | Done                                                                                                                                                                                                                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-04 | LP state reader (PumpSwap, Raydium v4, lockers), launch transaction parsing into `launch_txs`, poll-side `chain_events` (create, migrate, lp_state), base58 moved to its own core module; 40 tests                                                                                                   |
| 2026-09-04 | Merge policy recorded as permanent in `CLAUDE.md`, `CONTRIBUTING.md` and this ledger: the assistant merges, only with the owner's explicit permission each time; ruleset steps and check names for `main` written out                                                                                |
| 2026-09-04 | Everything English: ADRs 0001–0004, the roadmap and this ledger translated; the console loses its second language and toggle; the language rule recorded                                                                                                                                             |
| 2026-09-04 | ADR-0010 and the console: the API contract, the engine's endpoints (state, intents with approve/reject, positions, token with candles, funnel, halt, WebSocket), `apps/console` on mock data, Caddy serves it, CI builds and smokes it                                                               |
| 2026-09-04 | Engine skeleton: contracts and ChainAdapter in core, the Solana adapter, config with the capital-ladder check, health, metrics and HTTP, migrations (tables + conditional Timescale), ingest v1 (per-second snapshots, Token-2022 audit, slot lag), the full deploy stack, OPS.md, CI on TimescaleDB |
| 2026-09-04 | Phase 1 start: the repository split into npm workspaces (`packages/core`, `apps/desk`, `apps/engine`), pure logic moved to core, tests split, CI on the new paths                                                                                                                                    |
| 2026-09-04 | Triage of the extra proposals: ADR-0008 (wallet profiler, microstructure, decision budget) and ADR-0009 (control plane and operations); ENGINE.md extended with decision layers, funnel, regime, MEV policy and monitoring                                                                           |
| 2026-09-03 | Decision review with the owner; ADRs 0005–0007 (capital ladder, chain-agnostic core, collection and replay); ENGINE.md with the supply map and smart copy; roadmap updated                                                                                                                           |
| 2026-09-03 | Import, Grok scaffolding removed, real desk, roadmap, price-impact unit fix, ENGINE and ADRs 0001–0004, Phase 0, STATE.md                                                                                                                                                                            |

## Starting a new session

1. Read this file, then the current phase in `ROADMAP.md`, then `ENGINE.md` if the engine is touched.
2. Run the verification commands above and confirm they are green before any change.
3. Work on a branch and update this file (the table, the open list, the session log) in the same PR.
