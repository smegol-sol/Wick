# WICK roadmap (engine edition)

Governing principle: the platform moves real money, so quality and safety come before features. Architecture is in `docs/ENGINE.md`, decisions in `docs/adr/`, live state in `docs/STATE.md`.

Every new rule goes through the same order: replay, then shadow, then suggest, then auto (ADR-0004, ADR-0007).

---

## Phase 0: governance and quality gates (one week)

- [x] GitHub Actions on every PR: typecheck, lint, format:check, test, audit, build, smoke.
- [ ] `main` protection: no direct pushes, one review, green CI, squash merge. (A manual GitHub setting; steps in CONTRIBUTING.md.)
- [x] Conventional Commits with commitlint on the PR title.
- [x] PR and issue templates, CODEOWNERS, SECURITY.md, CONTRIBUTING.md.
- [x] Weekly Dependabot and `npm audit --audit-level=high` in CI.
- [x] The state ledger `docs/STATE.md` and the rule to update it in every PR.
- [x] A light monorepo: `apps/desk` (the original), `apps/engine`, `packages/core`.

Exit condition: a PR fails when it breaks a test and cannot merge without review.

## Phase 1: host and data (two weeks)

- [x] Workspace split with `packages/core` (npm workspaces; pure logic in core, the desk imports it as `@wick/core`).
- [x] `ChainAdapter` in `packages/core` and the Solana adapter in `apps/engine` (sources, audit, quote; sign and send throw until Phase 2).
- [x] The API contract in `packages/core/src/api.ts`, the engine's read, approve/reject and halt endpoints, and a WebSocket for state (ADR-0009 §2).
- [x] `apps/console`: Now and Engine screens and the Token detail on labelled example data, served by Caddy (ADR-0010).
- [x] Docker Compose for the host: engine, Postgres+Timescale, Redis, Prometheus, Grafana, Alertmanager, exporters, Caddy, daily backup (`apps/engine/deploy`). Awaits the real VPS.
- [x] Database schema from ENGINE.md §14 with migrations and the retention policy from ADR-0007 (0001 tables; 0002 hypertables, compression, retention and the 10-second aggregate; tested in CI on TimescaleDB).
- [x] `ingest`: pump.fun, DexScreener and the mint audit (moved from the desk), Token-2022 extension checks.
- [ ] LP state (burned / locked / deployer) from the pool account.
- [ ] Helius webhooks for create, migrate, LP and followed-wallet events (instead of polling).
- [ ] Launch transaction parsing (`launch_txs`): creator, buyers in the create slot and the next three, snipers in the first ten.
- [x] Data collection as an explicit deliverable: a snapshot every second for active tokens, every 60 seconds for cooling ones, audits on change only (ADR-0007). Chain events wait for the webhooks.
- [ ] A `features` row every second per active mint, with `uniqueBuyers5m` from events.
- [x] `/metrics` with the liveness and ingest metrics from ENGINE.md §15, the Operations and Host boards.
- [ ] The Quality board (waits for the decision layer).
- [x] A dedicated RPC with public fallbacks; slot lag measured every 5 seconds across every endpoint and fed into health.
- [x] Host monitoring: node_exporter, postgres_exporter, redis_exporter, the Host board, Alertmanager to Telegram with written thresholds, a dead-man ping to an external service, and self-halt on bad health (ADR-0009).
- [x] Private network: Caddy bound to the Tailscale address only, no public ports except key-only SSH; steps in `docs/OPS.md`.

Exit condition: 72 hours of uninterrupted stream, the Operations board showing every source's age, a full week of snapshots kept within the size estimate, and at least one test alert per rule delivered to the phone.

## Phase 2: decision, gates and execution in suggest mode (three weeks)

- [ ] `decision` with the `confirmed-entry` and `exit-policy` rules and weights from `rules.yaml`.
- [ ] The seven gates with the reason codes and adjustments from ENGINE.md §4; every rejection and adjustment written. No eighth gate and no code above 25 without an ADR.
- [ ] Size as the minimum of three terms (equity, pool share, token cap) with the binding term recorded on the intent (ADR-0005).
- [ ] The wallet profiler with the basic behavioural classes; everything after it reads from it (ADR-0008, ENGINE.md §8).
- [ ] The basic supply map: dev share and dev-funded wallets, bundle, early snipers, fresh wallets, early-holder trend (ENGINE.md §7).
- [ ] The four microstructure features: net flow, organic volume, depth in both directions, holder divergence (ENGINE.md §10).
- [ ] The regime layer with one size multiplier for the whole engine, and the funnel metric per layer (ENGINE.md §3 and §11).
- [ ] The defensive MEV policy in the executor for tier 1, and the `mev-suspect` flag on fills worse than the quote (ENGINE.md §12).
- [ ] `replay`: the decision and gates run over stored snapshots with a conservative execution model, results labelled `replay` (ADR-0007).
- [ ] `executor` through `ChainAdapter`: simulate, sign with the sealed key, send, confirm, read balances before and after, idempotency with a lock per intent.
- [ ] The vault on the host and unsealing from the console, the kill-switch file, wallet and tier caps in code.
- [ ] Every mutating API call writes an `events` row; approve, halt and unseal wired to the executor (ADR-0009).
- [ ] The console in live mode: intents with their reasons, adjustments and regime reason; approve and reject; funnel; halt; unseal with the second factor. The desk retires.
- [ ] The Telegram bot: alerts, the daily report, and `/halt`, `/approve` with TOTP and `/status`, restricted to the owner's chat id.
- [ ] `outcomes` for every intent at 5, 30 and 120 minutes, executed or rejected.
- [ ] mirror-follow on webhooks with the copy gap measured.
- [ ] Integration tests for the full path on devnet.

Exit condition: 30 days in suggest mode with a 3 SOL wallet, 50 executed intents with no double signing and no expired transaction, the reason-code distribution readable on the console, and a first honest replay over a month of collected data.

## Phase 3: level-2 learning and auto mode (three weeks)

- [ ] `shadow` mode: a rule runs on the live stream and is evaluated without executing; the precondition before suggest for every new rule.
- [ ] The daily `evaluator`: 14-day rule stats, bounded weight moves, disabling negative rules, every change with a recorded reason.
- [ ] Followed-wallet evaluation by copy gap and slippage, with demotion.
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

- [ ] A written threat model and an external security review (a precondition for capital tier 3).
- [ ] Strict CSP and local fonts in the console, passkeys instead of the bearer token, and a review of the bot's commands.
- [ ] Jito bundles as the tier-2 execution route with a written tip cap (ENGINE.md §12).
- [ ] Failure drills: RPC cut, Postgres stopped, unattended restart; each must end in a safe stop.
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
