# WICK roadmap (engine edition)

Governing principle: the platform moves real money, so quality and safety come before features. Architecture is in `docs/ENGINE.md`, decisions in `docs/adr/`, live state in `docs/STATE.md`.

Every new rule goes through the same order: replay, then shadow, then suggest, then auto (ADR-0004, ADR-0007).

---

## Phase 0: governance and quality gates (one week)

- [x] GitHub Actions on every PR: typecheck, lint, format:check, test, audit, build, smoke.
- [x] `main` protection: no direct pushes, green CI on four checks, squash merge, zero required approvals while there is one maintainer (a PR's author cannot approve it). Ruleset active 2026-09-08; a direct push was refused with `GH013`.
- [x] Conventional Commits with commitlint on the PR title.
- [x] PR and issue templates, CODEOWNERS, SECURITY.md, CONTRIBUTING.md.
- [x] Weekly Dependabot and `npm audit --audit-level=high` in CI.
- [x] The state ledger `docs/STATE.md` and the rule to update it in every PR.
- [x] A light monorepo: `apps/desk` (the original), `apps/engine`, `packages/core`.

Exit condition: a PR fails when it breaks a test and cannot merge until the checks are green; nothing lands on `main` outside a pull request. Met 2026-09-08.

## Phase 1: host and data (two weeks)

- [x] Workspace split with `packages/core` (npm workspaces; pure logic in core, the desk imports it as `@wick/core`).
- [x] `ChainAdapter` in `packages/core` and the Solana adapter in `apps/engine` (sources, audit, quote; sign and send throw until Phase 2).
- [x] The API contract in `packages/core/src/api.ts`, the engine's read, approve/reject and halt endpoints, and a WebSocket for state (ADR-0009 §2).
- [x] `apps/console`: Now and Engine screens and the Token detail on labelled example data, served by Caddy (ADR-0010).
- [x] Docker Compose for the host: engine, Postgres+Timescale, Redis, Prometheus, Grafana, Alertmanager, exporters, Caddy, daily backup (`apps/engine/deploy`). Awaits the real VPS.
- [x] Database schema from ENGINE.md §14 with migrations and the retention policy from ADR-0007 (0001 tables; 0002 hypertables, compression, retention and the 10-second aggregate; tested in CI on TimescaleDB).
- [x] `ingest`: pump.fun, DexScreener and the mint audit (moved from the desk), Token-2022 extension checks.
- [x] LP state (burned / locked / deployer) from the pool account: PumpSwap and Raydium v4 layouts, LP supply and largest holders, known lockers; `curve` on the bonding curve; unknown stays `null` (holders need a private RPC).
- [x] Push events instead of polling: an RPC WebSocket log stream (`logsSubscribe`) on every active mint, every followed wallet and the migration authority; migrations and followed-wallet prints land as they happen. Chosen over Helius HTTP webhooks because a webhook needs a public endpoint and the host has none (ADR-0009); LP add/remove events on pools wait for the pool subscriptions in Phase 2.
- [x] Launch transaction parsing (`launch_txs`): creator, buyers in the create slot and the next three, snipers in the first ten, from token-balance deltas; parsed once per mint, capped at 60 transactions.
- [x] Data collection as an explicit deliverable: a snapshot every second for active tokens, every 60 seconds for cooling ones, audits on change only (ADR-0007). `chain_events` carries what polling can see (create, migrate, LP state); the rest waits for the webhooks.
- [x] The features row every second per active mint, assembled in memory from stored rows (snapshots, audits, launch, events, stream counts) and served to the decision layer; the microstructure row (net flow and depth from reserves, stream-counted buys and sells) is written every second. `uniqueBuyers5m` stays null until per-trade wallets exist (needs event decoding or an enhanced stream).
- [x] `/metrics` with the liveness and ingest metrics from ENGINE.md §15, the Operations and Host boards.
- [ ] The Quality board (waits for the decision layer).
- [x] A dedicated RPC with public fallbacks; slot lag measured every 5 seconds across every endpoint and fed into health.
- [x] Host monitoring: node_exporter, postgres_exporter, redis_exporter, the Host board, Alertmanager to Telegram with written thresholds, a dead-man ping to an external service, and self-halt on bad health (ADR-0009).
- [x] Private network: Caddy bound to the Tailscale address only, no public ports except key-only SSH; steps in `docs/OPS.md`.

Exit condition: 72 hours of uninterrupted stream, the Operations board showing every source's age, a full week of snapshots kept within the size estimate, and at least one test alert per rule delivered to the phone.

## Phase 2: decision, gates and execution in suggest mode (three weeks)

- [x] `decision` with the `confirmed-entry`, `migration-snipe` and `exit-policy` rules and weights from `rules.yaml`, validated at boot; a loop every second over the active mints and the open positions, per-mint-and-rule cooldown, intents written in every mode (shadow rows included). Unique buyers and organic volume are noted, not required, until the profiler exists.
- [x] The six decision-time gates with the reason codes and adjustments from ENGINE.md §4 as a pure function; every rejection and adjustment written to `gate_results`. `execution` and its three codes land with the executor. No eighth gate and no code above 25 without an ADR.
- [x] Size as the minimum of three terms (equity, pool share, token cap) with the binding term recorded on the intent (ADR-0005); the regime and social multipliers are ×1 until their layers land.
- [x] The wallet profiler with the basic behavioural classes; everything after it reads from it (ADR-0008, ENGINE.md §8). Phase 2 classes: `sniper-bot` from create-slot buys, fresh from age and activity, `organic`; the rest need per-wallet trades and land with the funding tree.
- [x] The basic supply map: dev share, bundle, early snipers, fresh wallets, early-holder trend (ENGINE.md §7), live from holder reads on an RPC budget. Dev-funded wallets and the funding cluster wait for the funding tree (Phase 4).
- [ ] The four microstructure features: net flow, organic volume, depth in both directions, holder divergence (ENGINE.md §10).
- [x] The regime layer with one size multiplier for the whole engine, and the funnel metric per layer (ENGINE.md §3 and §11).
- [ ] The defensive MEV policy in the executor for tier 1, and the `mev-suspect` flag on fills worse than the quote (ENGINE.md §12).
- [x] `replay`: the decision and gates run over stored snapshots with a conservative execution model, results labelled `replay` (ADR-0007). Version 1 scores entries at the evaluator's 30-minute horizon; the exit policy in replay is a later slice.
- [x] `executor` through `ChainAdapter`: quote, build (Jupiter, priority fee under the risk.yaml cap), simulate, sign with the sealed key, send, confirm, read balances before and after, the fill and the position written, `mev-suspect` flagged; one intent at a time, locked by its status and one execution row per intent; entries wait and expire under a halt, exits keep running. The `execution` gate and its three codes.
- [x] The vault on the host (`vault:init`) unsealed from the API with the passphrase and a TOTP code, the kill-switch file checked every second, wallet caps in code (per transaction, per day, operating balance).
- [x] Every mutating API call writes an `events` row; approve, halt, halt-clear (second factor), unseal (second factor) and seal wired to the executor (ADR-0009).
- [x] The console in live mode: intents with their reasons, adjustments and regime reason; approve and reject; funnel; halt; unseal and halt-clear with the second factor; fills on executed intents.
- [x] The desk retired on 2026-09-13 (ADR-0010): `apps/desk` deleted, the console is the only surface; the core modules only it used stay until Phase 4 decides which the engine reuses.
- [x] The Telegram bot: alerts (Alertmanager), the daily report, `/status` and `/halt`, restricted to the owner's chat id, plus pushes for suggest intents, executions, halts, self-halt, the vault and rule changes. No `/approve` in v1: approval stays in the console on the tailnet (ADR-0009, amended).
- [x] `outcomes` for every intent at 5, 30 and 120 minutes, executed or rejected.
- [x] A decision fingerprint on every intent: the rules-file hash, the code version and the price source next to the stored features, so any decision can be reproduced after the rules change (migration 0004).
- [x] A resume point for the log stream: after a reconnect, the followed wallets' and the migration authority's signatures since the last seen one are fetched, so a dropped connection loses no print and no migration (seeded from `wallet_prints` and `chain_events` at boot, so a restart resumes too).
- [x] Before the first real SOL, moved up from Phase 5: a short written threat model (`docs/THREAT-MODEL.md`), secret scanning in CI (gitleaks over the tree and the history), and the failure drills as a script (`apps/engine/deploy/drill.sh`: RPC cut, Postgres stopped, unattended restart), each ending in a safe stop. The drills' first run on the host is recorded in `docs/STATE.md`.
- [x] mirror-follow with the copy gap measured: prints of the owner's followed wallets (Engine → Followed wallets, six at most) become intents through the full gate chain at half size, sells close the position, every copy is an `events` row with its gap, and the evaluator demotes a wallet whose last ten copies lost money. On the log stream the collector already holds rather than a separate webhook.
- [x] Integration tests for the full path on devnet: the production adapter and the executor against a real cluster, gated by `DEVNET_RPC_URL` (simulate, sign, send, confirm, balances, the fill and the position rows). Jupiter has no devnet, so the venue is a hand-built SOL self-transfer; everything after the quote is production code.

Exit condition: 30 days in suggest mode with a 3 SOL wallet, 50 executed intents with no double signing and no expired transaction, the reason-code distribution readable on the console, and a first honest replay over a month of collected data.

## Phase 3: level-2 learning and auto mode (three weeks)

- [ ] `shadow` mode: a rule runs on the live stream and is evaluated without executing; the precondition before suggest for every new rule.
- [x] The daily `evaluator`: 14-day rule stats, bounded weight moves, disabling negative rules, every change with a recorded reason (landed in Phase 2 with the outcomes, since shadow intents are exactly what it consumes).
- [x] Followed-wallet evaluation by copy gap and slippage, with demotion (landed in Phase 2 with mirror-follow: the daily pass over the last ten copies' 30-minute outcomes).
- [ ] Promotion to auto per rule under the ADR-0004 conditions, and automatic demotion to suggest.
- [ ] `migration-snipe` over a webhook in suggest mode.
- [ ] Size reduction after a losing day and the exposure cap on tokens younger than 90 minutes.
- [ ] Free social signals as a size multiplier between 0.8 and 1.2, never a gate (ENGINE.md §6).
- [ ] The feature-sunset rule: any feature in shadow that has not improved a rule's expectancy within 60 days is removed and its removal recorded (ADR-0008).
- [ ] The daily Telegram report: performance, top reason codes and adjustments, the binding sizing term, what changed in the weights and why.

Exit condition: at least one rule earned auto under its conditions, and a full month without an operational incident.

## Phase 4: detection depth and smart copy (four weeks)

- [ ] The funding tree for the top twenty holders (`MANIP_FUNDING` and `clusterPct`) as a background job, never on the hot path, plus realized-performance classes in the wallet profiler.
- [ ] Circular wash and timing-regularity detection (`MANIP_CIRCULAR`).
- [ ] Smart copy: wallet discovery from early buyers of winners, behavioural classification, `wallet_scores` with their numbers, score-weighted copying (ENGINE.md §9).
- [ ] Historical candles from an OHLC source, and a trial of an external history provider through a separate adapter labelled `external`.

Exit condition: replay shows the full supply map improves the default rule's expectancy over two months, and at least one discovered wallet earns copying by its numbers.

## Phase 5: hardening and security (two weeks)

- [ ] An external security review (a precondition for capital tier 3); the threat model itself moved to Phase 2.
- [ ] Strict CSP and local fonts in the console, passkeys instead of the bearer token, and a decision on whether `/approve` returns to the bot.
- [ ] Jito bundles as the tier-2 execution route with a written tip cap (ENGINE.md §12).
- [ ] Failure drills repeated on the production host after every custody change (first run moved to Phase 2).
- [ ] Custody review (ADR-0003) against the capital ladder (ADR-0005): a separate signer or KMS at tier 3.
- [ ] Time-sliced sizing and multiple execution wallets for tier 3.

## Phase 6: level-3 learning (after 2,000 recorded intents)

- [ ] A predictive model trained on `intents` and `outcomes`, tested in replay then shadow for 30 days, and limited to adjusting size inside the gate limits.

## Phase 7: a second chain (conditional)

- [ ] Not before 90 days of positive expectancy on Solana. A Base adapter first, then BNB Chain, each with its own ADR, its own sources table and its own suggest-mode month (ADR-0006).

---

## Rules that hold in every phase

1. No number without a source; unknown is `null`, renders n/a, and fails the filter.
2. Nothing signs without the full gate chain; human approval skips no gate.
3. Money stops in the engine, not in a notification.
4. No merge without green CI and a review; no file grows without a test.
5. Every self-change of the engine has a recorded row with a reason and a number.
6. An architectural decision is an ADR. Every document, identifier and string in the platform is English.
7. Replay results never sit next to live results without the label.
8. Rejects are for capital-loss risk only; seven gates, and any new signal adjusts size or weight. No feature without replay evidence (ADR-0008).
9. No public port on the engine host; the console over the private network, and no native app in v1 (ADR-0009).
