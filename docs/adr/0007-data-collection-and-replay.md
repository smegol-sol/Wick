# ADR-0007: Data collection and replay (backtesting)

- Status: accepted (September 2026)

## Context

The owner asked whether the build includes a backtest engine and data collection. It did not. ENGINE.md recorded intents and measured their outcomes, but there was no way to run a new rule over the past, and no source of second-resolution history: pump.fun and DexScreener expose current state, not history, and the tokens that matter live for hours.

The decision layer is already pure (features in, intent out, no network). That makes replay cheap to add and honest to run: the same function that trades live can be fed stored features.

## Decision

### 1. Collection starts on day one of Phase 1 and is a deliverable, not a side effect

- `token_snapshots` at 1-second resolution for every **active** token: seen in the last 2 hours, or with an open position, or with any intent in the last 24 hours. Inactive tokens are sampled every 60 seconds until 24 hours after last activity, then dropped from sampling.
- `chain_events`: create, migrate, LP add/remove/burn/lock, authority changes.
- `launch_txs`: the parsed first blocks of every launch the engine saw (creator, buyers in the create slot and the next three, amounts, funding source of each buyer where known).
- `wallet_prints` for followed and candidate wallets.
- `audits` on every change, not only on first sight.
- Retention (TimescaleDB): raw 1-second rows for 30 days; a 10-second continuous aggregate for 1 year; events and launch transactions kept indefinitely.
- Every row carries `source` and `schemaVersion`. Rows bought from an external history provider (Bitquery, Dune or similar) enter through their own ingest adapter with `source = "external:<provider>"` and are never mixed with observed rows in the same statistic without saying so.

### 2. Replay is the decision layer run over stored features

```
replay(ruleSet, window, executionModel) →
  intents, gate results, simulated fills, positions, outcomes, rule_stats
```

- Input: a rule set (`rules.yaml` at a given version), a time window, and an execution model.
- The decision and gate code is the production code. Replay injects stored `Features` at their original timestamps instead of live ones and a stored `Quote` where one exists.
- The execution model is explicit and conservative: fill price from the constant-product estimate on the pool's liquidity at that second, plus a fixed latency assumption (default 1.5 s), plus fees and the priority tip in force at that time. A rule that only works with a zero-latency assumption is not a rule.
- Output tables have the same shape as live ones, written under a `replay_run_id`, and are labelled `replay` everywhere they appear. A replay statistic never appears next to a live one without the label.
- **Shadow mode** is replay on the live stream: a rule runs in `shadow`, produces intents that are gated and evaluated but never executed. Shadow is the paper test required before a rule enters `suggest` (ADR-0004) and before level-3 learning touches sizing.

### 3. What replay cannot claim

- It only knows the tokens the engine saw. That is survivorship bias in the other direction: the engine's own filters decided what was sampled. The active-token rule above is wide on purpose.
- It cannot model being front-run or copied at size; tier-3 slicing (ADR-0005) exists because of that.
- Results before collection began do not exist. The first honest backtest is available roughly 30 days after Phase 1 goes live.

## Alternatives rejected

- **Buying a full history and backtesting before building.** Rejected as the primary path: no vendor sells 1-second pool state for pump.fun tokens, and the engine's real features (unique buyers, supply map, wallet flow) are derived from events we must parse ourselves. Kept as an optional supplement.
- **A separate backtesting framework with its own strategy code.** Rejected: two implementations of the same rule drift, and the drift is invisible until money is lost.

## Consequences

- Phase 1 gains the collection scope and retention policy; Phase 2 gains `replay` and the `replay_runs` table; Phase 3 gains shadow mode as the gate before suggest.
- Storage grows: at 1-second sampling of a few hundred active tokens, roughly 20–30 million rows a day raw, compressed by Timescale to a few GB a month. The tier-1 VPS handles it; the retention policy is what keeps it there.
- Every new rule has a required order: replay → shadow → suggest → auto.
