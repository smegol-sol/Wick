# WICK engine: architecture

Inputs this design is built on: starting capital 2,500 USD (about 24 SOL at 101 USD), custody on a VPS with a sealed execution key (ADR-0003), suggest and auto modes (ADR-0004), confirmed entry as the default style with migration sniping as an option, a capital ladder with liquidity-bounded sizing (ADR-0005), a chain-agnostic core trading Solana first (ADR-0006), and data collection with replay from day one (ADR-0007). Method reference: The Meme Coin Handbook, chapters 6, 8, 9, 12, 16, 19 and 23.

Written in English because these names are the names in the code (§13). The roadmap and state ledger stay in Arabic for the owner.

## 1. Shape

```
[pump.fun]  [DexScreener]  [Helius webhooks/WS]  [RPC]          [Jupiter]
     \            |               |                 |               |
      v           v               v                 v               |
   +------------------ ingest (Node worker) -----------------+      |
   |  snapshots, chain events, launch txs, wallet prints     |      |
   |  -> Postgres/Timescale (truth) and Redis streams (now)  |      |
   +---------------------------+-----------------------------+      |
                               v                                    |
   +------------- features ---------------------------------+       |
   | per active mint per second: liquidity, holders, top10, |       |
   | supply map, wallet flow, age, ratios. Unknown = null.  |       |
   +---------------------------+----------------------------+       |
                               v                                    |
   +------------- decision (pure, no network) --------------+       |
   | weighted rules -> Intent (never a transaction)         |       |
   +---------------------------+----------------------------+       |
                               v                                    |
   +------------- gates (fixed order, first reject ends) ---+       |
   | safety -> supply -> liquidity -> manipulation ->       |<------+
   | quote -> risk -> execution                             |
   +---------------------------+----------------------------+
                               v
   +------------- executor (via ChainAdapter) --------------+
   | simulate -> sign (key in memory) -> send -> confirm    |
   | -> reads pre/post balances from chain, writes Fill     |
   +---------------------------+----------------------------+
                               v
   +------------- evaluator (every 5 min + daily) ----------+
   | outcomes at 5/30/120 min, rule stats, bounded weight   |
   | changes with a written reason, wallet scoring          |
   +--------------------------------------------------------+

   replay: the same decision + gates over stored features (ADR-0007)
   dashboard: the current WICK app. Reads Postgres, approves intents,
   unseals the vault, presses halt. Never signs.
```

One Node process at first, as separate modules with fixed contracts, split into processes only when a measurement says so. Postgres is the source of truth, Redis is for immediate hand-off only.

## 2. Contracts

The types below are contracts; a change goes through an ADR.

```ts
type Chain = "solana"; // ADR-0006: more later, never in v1

// What the engine knows about a token at decision time. null = nobody reported it.
type Features = {
  chain: Chain;
  mint: string;
  ts: number;
  ageSec: number;
  stage: "new" | "bonding" | "migrated";
  priceUsd: number;
  mcUsd: number;
  liqUsd: number;
  vol5m: number | null;
  vol24: number | null;
  tx24: number | null;
  buys5m: number | null;
  sells5m: number | null;
  uniqueBuyers5m: number | null;
  holders: number | null;
  top10Pct: number | null;
  authorities: { mint: boolean; freeze: boolean; program: "token" | "token2022" } | null;
  extensions: {
    transferFeeBps: number;
    hook: boolean;
    permanentDelegate: boolean;
    defaultFrozen: boolean;
  } | null;
  lp: "burned" | "locked" | "deployer" | "curve" | null;
  supply: SupplyMap | null; // §6
  washFlags: string[];
  fundingFlags: string[];
  followBuys3m: number;
  followSells3m: number;
  smartBuys3m: number; // §7, weighted by wallet score
};

// Who holds the supply and where it came from (§6).
type SupplyMap = {
  at: number;
  devPct: number | null; // creator wallet + wallets it funded
  bundlePct: number | null; // bought in the create slot or the next 3
  sniperPct: number | null; // bought in the first 10 slots, still holding
  freshWalletPct: number | null; // held by wallets < 24h old with < 5 txs
  lpPct: number | null; // supply inside the pool
  clusterPct: number | null; // top-20 holders sharing a funding source (phase 4)
  earlyHoldersTrend: "distributing" | "accumulating" | "flat" | null; // over the last 30 min
};

type Intent = {
  id: string;
  chain: Chain;
  ts: number;
  kind: "entry" | "exit" | "add";
  strategy: "confirmed-entry" | "migration-snipe" | "mirror-follow" | "smart-copy" | "exit-policy";
  ruleId: string;
  mode: "shadow" | "suggest" | "auto";
  mint: string;
  side: "buy" | "sell";
  sizeSol: number; // after weight, before the risk gate
  sizing: {
    equityTerm: number;
    poolTerm: number;
    capTerm: number;
    binding: "equity" | "pool" | "cap";
  } | null;
  features: Features; // full snapshot at decision time
  why: string; // one sentence shown to the operator
  ttlMs: number; // 90000 in suggest
  replayRunId: string | null; // set only by replay
};

type GateResult = {
  gate: Gate;
  passed: boolean;
  reasonCode: ReasonCode | null;
  adjustment: { sizeMul: number; reason: string } | null; // §3: a gate may shrink instead of reject
  ms: number;
};

type Execution = {
  intentId: string;
  quoteId: string;
  wallet: string; // which execution wallet (tier 3 has several)
  sig: string | null;
  sentAt: number;
  landedAt: number | null;
  status: "simulated" | "sent" | "confirmed" | "failed" | "expired";
  err: string | null;
  feeLamports: number;
  tipLamports: number;
};

type Fill = {
  executionId: string;
  chain: Chain;
  mint: string;
  side: "buy" | "sell";
  solDelta: number;
  tokenDelta: number; // from pre/post balances, never from the quote
  quotedPrice: number;
  realizedPrice: number;
  realizedSlippagePct: number;
};

type Outcome = {
  intentId: string;
  horizonSec: 300 | 1800 | 7200;
  retPct: number;
  maxRetPct: number;
  minRetPct: number;
};
```

Redis streams: `market.snapshot`, `wallet.print`, `chain.event` (create, migrate, LP), `intent.proposed`, `intent.decided`, `execution.result`. Every message carries `ts`, `source` and `schemaVersion`.

## 3. Gates and reason codes

Fixed order. The first rejection ends the cycle and is written to `gate_results`. The distribution of reason codes is the most important diagnostic in the system.

A gate has three outputs, not two: pass, reject with a code, or **adjust** (pass with `sizeMul < 1` and a reason). Adjustments are how the supply map and the liquidity bound shrink a trade instead of killing it. An adjusted intent still shows the adjustment on the dashboard.

| Gate         | Rejects when                                                                                                   | Code               |
| ------------ | -------------------------------------------------------------------------------------------------------------- | ------------------ |
| safety       | mint authority still set after migration                                                                       | `SAFETY_MINT`      |
| safety       | freeze authority set                                                                                           | `SAFETY_FREEZE`    |
| safety       | Token-2022 with transfer hook, permanent delegate, default frozen, or transfer fee > 0                         | `SAFETY_EXT`       |
| safety       | LP held by the deployer, or "locked" without a verifiable locker and duration                                  | `SAFETY_LP`        |
| safety       | authorities or extensions `null` in auto mode                                                                  | `SAFETY_UNKNOWN`   |
| supply       | dev + dev-funded wallets > 10% of supply                                                                       | `SUPPLY_DEV`       |
| supply       | bundled buys in the create slot and the next 3 > 20% of supply                                                 | `SUPPLY_BUNDLE`    |
| supply       | first-10-slot snipers still hold > 25%                                                                         | `SUPPLY_SNIPERS`   |
| supply       | supply map `null` in auto mode                                                                                 | `SUPPLY_UNKNOWN`   |
| supply       | adjust: dev 5–10% → ×0.5; snipers 15–25% → ×0.5; fresh wallets > 40% → ×0.5; early holders accumulating → ×0.5 | adjustment         |
| liquidity    | bounded size (ADR-0005) below `minTradeSol`                                                                    | `LIQ_DEPTH`        |
| liquidity    | estimated exit impact at full size > 5%                                                                        | `LIQ_EXIT`         |
| manipulation | vol24/liq outside [0.05, 20], or unique buyers < 15 with volume implying more                                  | `MANIP_WASH`       |
| manipulation | top10 > 35% (or `null` in auto)                                                                                | `MANIP_TOP10`      |
| manipulation | top holders share a funding source (phase 4)                                                                   | `MANIP_FUNDING`    |
| manipulation | circular flow between the same wallets, or buys at regular intervals (phase 4)                                 | `MANIP_CIRCULAR`   |
| quote        | quote older than 3 s                                                                                           | `QUOTE_STALE`      |
| quote        | price impact > 3% on entry or > 5% on exit (Jupiter returns a fraction; converted once to percent)             | `QUOTE_IMPACT`     |
| risk         | halt active, day ≤ −5%, or week ≤ −10%                                                                         | `RISK_HALT`        |
| risk         | open positions at the tier maximum                                                                             | `RISK_SLOTS`       |
| risk         | exposure to one token would exceed the tier cap                                                                | `RISK_TOKEN_CAP`   |
| risk         | two tokens from the same narrative cluster already open                                                        | `RISK_CLUSTER`     |
| risk         | open exposure in tokens younger than 90 min would exceed 50% of deployed capital                               | `RISK_YOUNG`       |
| risk         | operating balance after the trade < fee reserve 0.05 SOL                                                       | `RISK_CASH`        |
| risk         | adjust: after a losing day, ×0.5 for the next day, back to ×1 after a flat or positive day                     | adjustment         |
| execution    | `simulateTransaction` failed                                                                                   | `EXEC_SIM`         |
| execution    | blockhash expired before send                                                                                  | `EXEC_EXPIRED`     |
| execution    | not confirmed within 60 s                                                                                      | `EXEC_UNCONFIRMED` |

Human approval in suggest mode does not skip a gate; the only practical difference between suggest and auto inside the gates is the `*_UNKNOWN` rows.

## 4. Sizing and tier-1 risk numbers

Size is the minimum of three terms (ADR-0005), and the binding term is recorded on the intent:

```
size = min(equity × perTradePct, poolLiqUsd × poolSharePct / solUsd, tokenCapSol − openExposureSol)
```

The handbook leaves the numbers to the operator on purpose. These are the tier-1 choices, all in `risk.yaml`, never in code. The ladder to tiers 2 and 3 is in ADR-0005.

| Item                   | Value                                                     | Why                                                           |
| ---------------------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| Execution wallet       | 15 SOL cap, funded by hand                                | Everything else stays away from any program                   |
| Per-trade size         | 1.5% of equity (~0.35 SOL), liquidity-bounded             | Fixed fractional; twenty straight losses keep you in the game |
| Minimum trade          | 0.05 SOL                                                  | Below it, fees eat the trade                                  |
| Pool share cap         | 1% of pool liquidity                                      | The exit has to fit too                                       |
| Max open positions     | 6                                                         | Meme correlation is higher than it looks                      |
| Max exposure per token | 3%                                                        | Two adds at most                                              |
| Young-token exposure   | ≤ 50% of deployed capital in tokens < 90 min old          | Most rugs happen there                                        |
| Daily halt             | −5% → no new entries, cleared by hand                     |                                                               |
| Weekly halt            | −10% → halt, every rule back to suggest                   |                                                               |
| Losing streak          | 4 → the rule goes back to suggest                         |                                                               |
| Post-loss day          | ×0.5 size the day after a losing day                      | Cheap insurance against tilt in the rules                     |
| Priority fee           | dynamic from `getRecentPrioritizationFees`, cap 0.002 SOL |                                                               |
| Infra budget           | ≤ 70 USD/month                                            | 2.8% of capital per month is the hurdle before any profit     |

A direct consequence of these numbers: launch-second sniping is out at tier 1. The cost of reaching it (a gRPC stream, Jito tips paid on failure too) exceeds what this size can carry. Confirmed entry is the default; migration sniping runs from a webhook at half size in suggest mode until it proves itself. Launch sniping becomes an optional module at tier 3 (ADR-0005).

## 5. Strategies in the first release

Every rule goes through the same order: replay → shadow → suggest → auto (ADR-0004, ADR-0007).

**confirmed-entry** (default): age 3 to 90 min, liquidity ≥ 4,000 USD, authorities revoked and no dangerous extensions, supply map passes §3, top10 ≤ 35%, buys5m/sells5m ≥ 1.3 with ≥ 20 trades, vol5m/liq inside [0.05, 2], unique buyers ≥ 15, no wash flag. A followed or high-score wallet buying within 3 min raises the weight. Exit: 22% trailing stop, take-profit ladder, immediate exit on an 18% drop in one poll, time exit after 4 h, exit when liquidity falls 30%, exit when the supply map flips to `distributing` by the dev cluster.

**migration-snipe** (optional): triggered by the migration event over a webhook, same safety and supply gates, 50% size, suggest mode.

**mirror-follow**: as in the current desk but on webhooks instead of polling, with the copy gap measured per trade, and the wallet demoted when gap plus slippage exceed its profit over the last 10 copies.

**smart-copy** (phase 4, §7): like mirror-follow, but the wallet list is discovered and scored by the engine rather than typed in by hand, and size is weighted by the wallet's score.

## 6. Supply map: who holds what, and where it came from

Most fraud in this market is supply control: the dev, a bundle, or a sniper ring holds enough to sell into every buyer. The safety gate reads authorities and LP; the supply map reads ownership. Basic rows ship in Phase 2, the funding tree in Phase 4.

| Measured                         | How                                                                                         | Handling                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Dev share and dev-funded wallets | creator wallet plus every wallet it funded before or after launch (`launch_txs`, transfers) | reject > 10%, ×0.5 at 5–10%                                               |
| Bundled buys at launch           | all buys in the create slot and the next 3, by any wallet                                   | reject > 20% of supply                                                    |
| Early snipers                    | buyers in the first 10 slots that still hold                                                | reject > 25%, ×0.5 at 15–25%, watch distribution                          |
| Common funding cluster           | top-20 holders funded from one source within 7 days (phase 4)                               | `MANIP_FUNDING`                                                           |
| Fresh wallets among holders      | wallet age < 24 h and < 5 transactions                                                      | ×0.5 above 40%; a signal, never alone a reject                            |
| Pool share and LP ownership      | LP account, burned share, locker and lock duration                                          | `SAFETY_LP` when the deployer holds it                                    |
| Transfer fee, hook, delegate     | Token-2022 extensions                                                                       | `SAFETY_EXT`                                                              |
| Early-holder trend               | change in dev + sniper + bundle share over the last 30 min                                  | `distributing` is fine; `accumulating` ×0.5; required to be known in auto |

Handling has three levels, not one: reject with a code, adjust size, or wait for distribution. All of it is computed in a background job that writes `supply_maps`; the hot path only reads the latest row and its age. A supply map older than 5 minutes counts as `null`.

## 7. Copy trading: mirror and smart

**Mirror** (phase 2–3): the owner types in up to 6 wallets. Every print arrives on a webhook, becomes an intent with `strategy = mirror-follow`, and passes the full gate chain. The copy gap (`seen_at − ts`) and realized slippage are recorded per copy.

**Smart** (phase 4): the engine builds its own candidate list and score.

- Discovery: wallets that appear among the first 20 buyers of tokens that later reached ≥ 3× from that price, across at least 5 distinct tokens in 30 days, excluding wallets flagged as dev, bundle or sniper by the supply map.
- Classification, from behaviour not labels: `early-consistent`, `sniper`, `dev-adjacent`, `exit-liquidity` (buys late, sells into dumps), `unknown`.
- Score per wallet over a 30-day window: hit rate at 30 min, median return at 120 min, median hold time, and the engine's own realized outcome when copying it. Stored in `wallet_scores` with the numbers, never as a bare rank.
- Sizing: `smart-copy` intents are weighted by score inside the normal three-term size; a wallet under a threshold is watched, not copied. Demotion follows the same rule as mirror: when copying a wallet costs more than it earns over the last 10 copies, it drops to watch.
- Never more than 6 copied wallets in total (mirror plus smart); the owner's list wins ties.

## 8. Data collection and replay

Collection is a Phase 1 deliverable with a written retention policy, and replay is the production decision and gate code run over stored features (ADR-0007). Shadow mode is replay on the live stream and is the required paper test before a rule enters suggest.

- Sampling: 1 s for active tokens, 60 s for cooling tokens, plus every chain event, every parsed launch transaction, every audit change and every wallet print.
- Retention: 1 s rows for 30 days; 10 s continuous aggregate for a year; events and launch transactions indefinitely.
- Replay execution model: constant-product fill on the pool's liquidity at that second, 1.5 s latency assumption, fees and priority tip in force at the time. Results are labelled `replay` and never sit next to live numbers without the label.
- External history (Bitquery, Dune) is optional, enters through its own adapter with `source = "external:<provider>"`, and is kept separate in every statistic.

## 9. Database schema (Postgres + TimescaleDB)

```sql
tokens(chain, mint pk, symbol, name, creator, created_at, first_seen, stage)
token_snapshots(ts, mint, price, mc, liq, vol5m, vol24, tx24, buys5m, sells5m, holders, top10, source)  -- hypertable, 1s/60s
chain_events(ts, mint, kind, sig, data jsonb)                                 -- create, migrate, lp_*, authority_*
launch_txs(mint pk, slot, creator, buyers jsonb, bundle_pct, sniper_pct, parsed_at)
audits(mint, at, program, mint_auth, freeze_auth, extensions jsonb, lp_state, top10, funding_flags jsonb)
supply_maps(mint, at, dev_pct, bundle_pct, sniper_pct, fresh_pct, lp_pct, cluster_pct, trend, inputs jsonb)
wallets(pk pk, label, kind, tracked_since, status, stats jsonb)               -- kind: owner | discovered
wallet_prints(sig pk, wallet, ts, seen_at, mint, side, sol, amount)           -- copy gap = seen_at - ts
wallet_scores(wallet, window_days, n, hit_rate_30m, med_ret_120m, med_hold_sec, copied_pnl_sol, class, scored_at)
intents(id pk, chain, ts, kind, strategy, rule_id, mode, mint, side, size_sol, sizing jsonb, features jsonb, why, status, decided_by, decided_at, replay_run_id)
gate_results(intent_id, gate, passed, reason_code, adjustment jsonb, ms)
quotes(id pk, intent_id, ts, in_amount, out_amount, impact_pct, slippage_bps, route jsonb)
executions(id pk, intent_id, quote_id, wallet, sig, sent_at, landed_at, status, err, fee_lamports, tip_lamports)
fills(execution_id pk, chain, mint, side, sol_delta, token_delta, quoted_price, realized_price, realized_slippage_pct)
positions(mint, wallet, opened_at, closed_at, cost_sol, qty, exits jsonb, realized_pnl_sol, status)
outcomes(intent_id, horizon_sec, ret_pct, max_ret_pct, min_ret_pct)           -- every intent, executed or rejected
rule_stats(rule_id, window_days, n, win_rate, expectancy, worst_dd, weight, changed_at, change_reason, replay_run_id)
replay_runs(id pk, rules_version, window_start, window_end, exec_model jsonb, started_at, finished_at, summary jsonb)
halts(ts, kind, reason, cleared_at, cleared_by)
tiers(active_tier, wallet_cap_sol, changed_at, changed_by, reason)
events(ts, level, component, msg, data jsonb)                                 -- hypertable, 90-day retention
```

## 10. Metrics (Prometheus, prefix `wick_`)

Never a label with a token address, wallet or signature; details go to `events`.

| Metric                                      | Type      |
| ------------------------------------------- | --------- |
| `wick_up`                                   | gauge     |
| `wick_source_heartbeat_age_seconds{source}` | gauge     |
| `wick_source_call_duration_seconds{source}` | histogram |
| `wick_slot_lag`                             | gauge     |
| `wick_active_tokens`                        | gauge     |
| `wick_supply_map_age_seconds`               | histogram |
| `wick_decision_duration_seconds`            | histogram |
| `wick_send_duration_seconds`                | histogram |
| `wick_land_duration_seconds`                | histogram |
| `wick_attempts_total{outcome}`              | counter   |
| `wick_rejections_total{gate,reason}`        | counter   |
| `wick_adjustments_total{gate}`              | counter   |
| `wick_sizing_binding_total{term}`           | counter   |
| `wick_realized_slippage_pct`                | histogram |
| `wick_copy_gap_seconds`                     | histogram |
| `wick_open_positions`                       | gauge     |
| `wick_realized_pnl_sol_day`                 | gauge     |
| `wick_halted{kind}`                         | gauge     |
| `wick_replay_runs_total{status}`            | counter   |

Two dashboards only: Operations (is it alive?) and Quality (is it working?). Alerts are for liveness and infrastructure; the brakes are in code.

## 11. Chain adapters

Everything chain-specific lives behind `ChainAdapter` (ADR-0006), one implementation per chain under `apps/engine/src/chains/`. The core never imports a chain SDK. Solana is the only adapter in v1; Base is the first candidate after 90 days of positive expectancy.

## 12. What moves from the current code

`risk.ts`, `exits.ts`, `entry.ts`, `guard.ts`, `hot-wallet.ts` (vault format and signer) and `jup.ts` move as they are into `packages/core` and the Solana adapter. `live-auto.ts` becomes `executor`. The browser store loses execution and becomes a read-and-approve client.

## 13. Language

Code, identifiers, reason codes, schema, logs, configuration and engine documents (this file and ADRs from 0005 on) are English, so the name in the document is the name in the code. The roadmap, the state ledger and ADRs 0001–0004 stay in Arabic for the owner; a decision recorded there is restated in English here when it touches the engine.
