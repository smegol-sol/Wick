# WICK engine: architecture

Inputs this design is built on: starting capital 2,500 USD (about 24 SOL at 101 USD), custody on a VPS with a sealed execution key (ADR-0003), suggest and auto modes (ADR-0004), confirmed entry as the default style with migration sniping as an option, a capital ladder with liquidity-bounded sizing (ADR-0005), a chain-agnostic core trading Solana first (ADR-0006), data collection with replay from day one (ADR-0007), one wallet profiler and a decision budget (ADR-0008), and a private PWA plus Telegram bot as the control plane (ADR-0009). Method reference: The Meme Coin Handbook, chapters 6, 8, 9, 12, 16, 19 and 23.

Written in English because these names are the names in the code (§20). The roadmap and state ledger stay in Arabic for the owner.

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
   +-- background writers: wallet profiler, supply map, ----+       |
   |   microstructure, regime. Each row carries its age.    |       |
   +---------------------------+----------------------------+       |
                               v                                    |
   +------------- features (one row per active mint) -------+       |
   | reads the latest rows; a stale row reads as null       |       |
   +---------------------------+----------------------------+       |
                               v                                    |
   +------------- decision (pure, no network, < 50 ms) -----+       |
   | sieve -> regime multiplier -> weighted rules -> Intent |       |
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
   control plane: HTTP/WS API on the tailnet, the WICK PWA and a
   Telegram bot (ADR-0009). Reads, approves, halts, unseals. Never signs.
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
  holdersDelta30m: number | null; // §10 price/holder divergence
  top10Pct: number | null;
  authorities: { mint: boolean; freeze: boolean; program: "token" | "token2022" } | null;
  extensions: {
    transferFeeBps: number;
    hook: boolean;
    permanentDelegate: boolean;
    defaultFrozen: boolean;
  } | null;
  lp: "burned" | "locked" | "deployer" | "curve" | null;
  lastLpEvent: { kind: "add" | "remove" | "burn" | "lock"; pct: number; ts: number } | null;
  supply: SupplyMap | null; // §7
  micro: Microstructure | null; // §10
  washFlags: string[];
  fundingFlags: string[];
  followBuys3m: number;
  followSells3m: number;
  smartBuys3m: number; // §9, weighted by wallet score
  social: SocialSignals | null; // §6, weight modifier only
};

// Who holds the supply and where it came from (§7).
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

// Flow and depth, from snapshots, events and the wallet profiler (§10).
type Microstructure = {
  at: number;
  netFlowSol1m: number | null;
  netFlowSol5m: number | null;
  organicVolPct5m: number | null; // non-bot, non-round-trip volume / total
  depthBuy2PctUsd: number | null; // size that moves price +2%, from reserves
  depthSell2PctUsd: number | null; // size that moves price -2%
};

// Free social inputs only at tier 1 (§6). Never a gate.
type SocialSignals = {
  at: number;
  repliesPerMin: number | null; // pump.fun
  hasSocials: boolean | null; // metadata
  paidBoost: boolean | null; // DexScreener boosts = paid marketing flag
  telegramMembers: number | null; // public groups only
};

// One wallet's class and the numbers behind it (§8).
type WalletProfile = {
  wallet: string;
  class:
    | "organic"
    | "sniper-bot"
    | "wash-bot"
    | "copy-bot"
    | "dev-adjacent"
    | "exit-liquidity"
    | "early-consistent"
    | "unknown";
  confidence: number; // 0..1
  stats: Record<string, number>; // the inputs that produced the class
  profiledAt: number;
};

// Market-wide state (§11). One multiplier for the whole engine.
type Regime = {
  at: number;
  solChange1hPct: number | null;
  breadth5m: number | null; // share of active tokens up over 5 min
  launchesPerHour: number | null;
  migrationsPerHour: number | null;
  safetyRejectRate1h: number | null; // share of candidates killed by the safety gate
  sizeMul: 0 | 0.5 | 1; // derived, written with its reason
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
  sizeSol: number; // after weight and regime, before the risk gate
  sizing: {
    equityTerm: number;
    poolTerm: number;
    capTerm: number;
    binding: "equity" | "pool" | "cap";
    regimeMul: number;
    socialMul: number;
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
  adjustment: { sizeMul: number; reason: string } | null; // §4: a gate may shrink instead of reject
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
  route: "rpc" | "jito"; // §12
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

## 3. Decision layers, the funnel, and the budget

Six layers, cheapest first. Each one counts what enters and what leaves, and why, as `wick_funnel_total{layer,outcome}`; the funnel board is how you know whether opportunities die in the sieve or in the gates.

| Layer     | What it does                                                                                 | Cost                      |
| --------- | -------------------------------------------------------------------------------------------- | ------------------------- |
| activity  | which tokens get a 1 s snapshot at all (ADR-0007)                                            | ingest                    |
| sieve     | hard, cheap rules on the feature row: age window, minimum liquidity, authorities read, stage | µs                        |
| regime    | one multiplier for the whole engine from market-wide state (§11); never rejects a token      | µs                        |
| decision  | weighted rules produce an intent with a size and a one-sentence why                          | < 1 ms                    |
| gates     | seven gates, pass / reject with code / adjust (§4)                                           | ms, quote is the slow one |
| execution | simulate, sign, send, confirm (§12)                                                          | seconds                   |

The budget (ADR-0008): the path from feature row to written intent stays under 50 ms at p99; at most 40 feature columns; exactly 7 gates; at most 25 reason codes. Rejects are reserved for capital-loss risk; every other signal adjusts size or weight. A feature enters in shadow mode and is removed if it has not improved a rule's expectancy within 60 days.

## 4. Gates and reason codes

Fixed order. The first rejection ends the cycle and is written to `gate_results`. The distribution of reason codes is the most important diagnostic in the system.

A gate has three outputs, not two: pass, reject with a code, or **adjust** (pass with `sizeMul < 1` and a reason). Adjustments are how the supply map, the liquidity bound and the microstructure features shrink a trade instead of killing it. An adjusted intent still shows the adjustment on the dashboard.

| Gate         | Rejects when                                                                                           | Code               |
| ------------ | ------------------------------------------------------------------------------------------------------ | ------------------ |
| safety       | mint authority still set after migration                                                               | `SAFETY_MINT`      |
| safety       | freeze authority set                                                                                   | `SAFETY_FREEZE`    |
| safety       | Token-2022 with transfer hook, permanent delegate, default frozen, or transfer fee > 0                 | `SAFETY_EXT`       |
| safety       | LP held by the deployer, or "locked" without a verifiable locker and duration                          | `SAFETY_LP`        |
| safety       | authorities or extensions `null` in auto mode                                                          | `SAFETY_UNKNOWN`   |
| supply       | dev + dev-funded wallets > 10% of supply                                                               | `SUPPLY_DEV`       |
| supply       | bundled buys in the create slot and the next 3 > 20% of supply                                         | `SUPPLY_BUNDLE`    |
| supply       | first-10-slot snipers still hold > 25%                                                                 | `SUPPLY_SNIPERS`   |
| supply       | supply map `null` or older than 5 min in auto mode                                                     | `SUPPLY_UNKNOWN`   |
| supply       | adjust: dev 5–10% ×0.5; snipers 15–25% ×0.5; fresh wallets > 40% ×0.5; early holders accumulating ×0.5 | adjustment         |
| liquidity    | bounded size (ADR-0005) below `minTradeSol`                                                            | `LIQ_DEPTH`        |
| liquidity    | estimated exit impact at full size > 5%, using `depthSell2PctUsd` when present                         | `LIQ_EXIT`         |
| liquidity    | an LP removal ≥ 20% in the last 10 min                                                                 | `LIQ_PULL`         |
| liquidity    | adjust: `netFlowSol5m` negative ×0.5; sell depth < half of buy depth ×0.5                              | adjustment         |
| manipulation | `organicVolPct5m` < 40%, or unique buyers < 15 with volume implying more                               | `MANIP_WASH`       |
| manipulation | top10 > 35% (or `null` in auto)                                                                        | `MANIP_TOP10`      |
| manipulation | top holders share a funding source (phase 4)                                                           | `MANIP_FUNDING`    |
| manipulation | circular flow between the same wallets, or buys at regular intervals (phase 4)                         | `MANIP_CIRCULAR`   |
| manipulation | adjust: price up > 50% in 30 min with `holdersDelta30m` ≤ 0 → ×0.5                                     | adjustment         |
| quote        | quote older than 3 s                                                                                   | `QUOTE_STALE`      |
| quote        | price impact > 3% on entry or > 5% on exit (Jupiter returns a fraction; converted once to percent)     | `QUOTE_IMPACT`     |
| risk         | halt active, day ≤ −5%, week ≤ −10%, or engine health self-halt (§16)                                  | `RISK_HALT`        |
| risk         | open positions at the tier maximum                                                                     | `RISK_SLOTS`       |
| risk         | exposure to one token would exceed the tier cap                                                        | `RISK_TOKEN_CAP`   |
| risk         | two tokens from the same narrative cluster already open                                                | `RISK_CLUSTER`     |
| risk         | open exposure in tokens younger than 90 min would exceed 50% of deployed capital                       | `RISK_YOUNG`       |
| risk         | operating balance after the trade < fee reserve 0.05 SOL                                               | `RISK_CASH`        |
| risk         | adjust: after a losing day ×0.5 for the next day                                                       | adjustment         |
| execution    | `simulateTransaction` failed                                                                           | `EXEC_SIM`         |
| execution    | blockhash expired before send                                                                          | `EXEC_EXPIRED`     |
| execution    | not confirmed within 60 s                                                                              | `EXEC_UNCONFIRMED` |

Twenty-four reason codes; the cap is 25. Human approval in suggest mode does not skip a gate; the only practical difference between suggest and auto inside the gates is the `*_UNKNOWN` rows.

## 5. Sizing and tier-1 risk numbers

Size is the minimum of three terms (ADR-0005), then multiplied by the regime and social multipliers, and the binding term is recorded on the intent:

```
base = min(equity × perTradePct, poolLiqUsd × poolSharePct / solUsd, tokenCapSol − openExposureSol)
size = base × regimeMul × socialMul × Π(gate adjustments)
```

The handbook leaves the numbers to the operator on purpose. These are the tier-1 choices, all in `risk.yaml`, never in code. The ladder to tiers 2 and 3 is in ADR-0005.

| Item                   | Value                                                     | Why                                                           |
| ---------------------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| Execution wallet       | 15 SOL cap, funded by hand                                | Everything else stays away from any program                   |
| Per-trade size         | 1.5% of equity (~0.35 SOL), liquidity-bounded             | Fixed fractional; twenty straight losses keep you in the game |
| Minimum trade          | 0.05 SOL                                                  | Below it, fees eat the trade                                  |
| Pool share cap         | 1% of pool liquidity                                      | The exit has to fit too                                       |
| Max open positions     | 6                                                         | Meme correlation is higher than it looks                      |
| Max exposure per token | 3%                                                        | Two adds at most, both above entry (§6)                       |
| Young-token exposure   | ≤ 50% of deployed capital in tokens < 90 min old          | Most rugs happen there                                        |
| Daily halt             | −5% → no new entries, cleared by hand                     |                                                               |
| Weekly halt            | −10% → halt, every rule back to suggest                   |                                                               |
| Losing streak          | 4 → the rule goes back to suggest                         |                                                               |
| Post-loss day          | ×0.5 size the day after a losing day                      | Cheap insurance against tilt in the rules                     |
| Social multiplier      | 0.8 to 1.2                                                | Sentiment moves size a little, never the decision             |
| Priority fee           | dynamic from `getRecentPrioritizationFees`, cap 0.002 SOL |                                                               |
| Infra budget           | ≤ 70 USD/month                                            | 2.8% of capital per month is the hurdle before any profit     |

A direct consequence of these numbers: launch-second sniping is out at tier 1. The cost of reaching it (a gRPC stream, Jito tips paid on failure too) exceeds what this size can carry. Confirmed entry is the default; migration sniping runs from a webhook at half size in suggest mode until it proves itself. Launch sniping becomes an optional module at tier 3 (ADR-0005).

## 6. Strategies in the first release

Every rule goes through the same order: replay → shadow → suggest → auto (ADR-0004, ADR-0007).

**confirmed-entry** (default): age 3 to 90 min, liquidity ≥ 4,000 USD, authorities revoked and no dangerous extensions, supply map passes §4, top10 ≤ 35%, buys5m/sells5m ≥ 1.3 with ≥ 20 trades, organic vol5m/liq inside [0.05, 2], unique buyers ≥ 15, net flow over 5 min positive. A followed or high-score wallet buying within 3 min raises the weight. Exit: 22% trailing stop, take-profit ladder, immediate exit on an 18% drop in one poll, time exit after 4 h, exit when liquidity falls 30% or an LP removal lands, exit when the supply map flips to `distributing` by the dev cluster.

**scale-in** (`kind = "add"`, part of confirmed-entry): at most two adds, each only while price is above the entry price, the supply map is still clean and net flow is positive. Never below entry. There is no time-based DCA into a meme token.

**migration-snipe** (optional): triggered by the migration event over a webhook, same safety and supply gates, 50% size, suggest mode.

**mirror-follow**: as in the current desk but on webhooks instead of polling, with the copy gap measured per trade, and the wallet demoted when gap plus slippage exceed its profit over the last 10 copies.

**smart-copy** (phase 4, §9): like mirror-follow, but the wallet list is discovered and scored by the wallet profiler rather than typed in by hand, and size is weighted by the wallet's score.

**Social signals** enter every rule the same way: as `socialMul` between 0.8 and 1.2 from the free sources in `SocialSignals`. A paid-boost flag lowers, reply velocity from wallets the profiler calls organic raises. Never a gate.

## 7. Supply map: who holds what, and where it came from

Most fraud in this market is supply control: the dev, a bundle, or a sniper ring holds enough to sell into every buyer. The safety gate reads authorities and LP; the supply map reads ownership. Basic rows ship in Phase 2, the funding tree in Phase 4. The wallet classes come from §8.

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

## 8. Wallet profiler

One background module classifies every wallet the engine meets (ADR-0008) and writes `wallet_profiles`. Everything that needs to know "what kind of wallet is this" reads it: the supply map, organic volume, the wash flag, smart-copy discovery.

| Signal               | How                                                                   |
| -------------------- | --------------------------------------------------------------------- |
| Timing regularity    | low variance of inter-trade intervals                                 |
| Amount repetition    | identical or round sizes                                              |
| Create-slot buys     | bought in the create slot or the next 3                               |
| Age and activity     | wallet age, transaction count, first funding time                     |
| Program path         | direct AMM calls vs a router, fixed compute-unit settings, Jito tips  |
| Common funder        | many wallets funded by one source within hours                        |
| Exit behaviour       | sells within N seconds of buying; round trips                         |
| Realized performance | hit rate and median return when buying early (for `early-consistent`) |

Classes and the numbers behind them are stored together. Profiles are recomputed on new activity and expire after 7 days without it. Phase 2 ships the behavioural classes; Phase 4 adds the funding tree and realized-performance classes.

## 9. Copy trading: mirror and smart

**Mirror** (phase 2–3): the owner types in up to 6 wallets. Every print arrives on a webhook, becomes an intent with `strategy = mirror-follow`, and passes the full gate chain. The copy gap (`seen_at − ts`) and realized slippage are recorded per copy.

**Smart** (phase 4): the engine builds its own candidate list from the profiler.

- Discovery: wallets classed `early-consistent`: among the first 20 buyers of tokens that later reached ≥ 3× from that price, across at least 5 distinct tokens in 30 days, excluding wallets the supply map flags as dev, bundle or sniper.
- Score per wallet over a 30-day window: hit rate at 30 min, median return at 120 min, median hold time, and the engine's own realized outcome when copying it. Stored in `wallet_scores` with the numbers, never as a bare rank.
- Sizing: `smart-copy` intents are weighted by score inside the normal size; a wallet under a threshold is watched, not copied. Demotion follows the same rule as mirror.
- Never more than 6 copied wallets in total (mirror plus smart); the owner's list wins ties.

## 10. Market microstructure: flow, organic volume, depth

There is no order book for these tokens; they trade on AMMs. Depth is computed exactly from reserves and cannot be spoofed with cancelled orders, which makes it better than an order book for this purpose. The tape (prints) is the other half. Four features, all background (ADR-0008):

- **Net flow:** SOL into the pool minus SOL out, over 1 and 5 minutes. Negative 5-minute flow halves size; the confirmed-entry rule requires it positive.
- **Organic volume:** volume from wallets the profiler does not class as bots and that are not in round trips (same wallet buy and sell within 60 s), over total. Every volume-to-liquidity check uses organic volume. Under 40% is `MANIP_WASH`.
- **Depth in both directions:** the USD size that moves price 2% up and 2% down, from reserves. The exit gate uses sell depth; sell depth under half of buy depth halves size.
- **Holder divergence:** price up more than 50% in 30 minutes while holders did not grow halves size.

Not built, on purpose: order-book analysis, CEX order books, fake-support detection, sandwich counting, and any new reject code for these signals (ADR-0008 lists each with its reason).

## 11. Regime: the market as a whole

A background writer computes `Regime` every minute from our own data and writes one multiplier with its reason:

| Condition                                                                                       | `sizeMul`                                    |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------- |
| SOL down more than 5% in 1 h, or breadth under 30%, or safety-reject rate over 80% in 1 h       | 0 (no new entries, existing exits still run) |
| SOL down 2–5% in 1 h, or breadth 30–45%, or launches per hour under a third of the 7-day median | 0.5                                          |
| otherwise                                                                                       | 1                                            |

The regime never rejects a token; it scales the whole engine. Its reason is shown on the dashboard next to every intent it touched. No external source is needed; the CEX order book for SOL was considered and dropped.

## 12. Execution and the MEV policy

The executor is the only code that signs (ADR-0003). Its order is fixed: quote → build → simulate → sign with the key in memory → send → confirm → read balances → write `Fill`.

Defensive MEV policy by tier:

- **Tier 1:** slippage cap from the quote gate (3% entry, 5% exit), simulation before every send, no route through a hop with liquidity under 10,000 USD, `route = "rpc"`. Realized-versus-quoted slippage is recorded per fill; a fill worse than quote by more than the cap is flagged `mev-suspect` in `events` for the evaluator.
- **Tier 2 and up:** `route = "jito"` bundles with a tip cap in `risk.yaml`, so the transaction is not visible before it lands. Entries above 1 SOL are sliced (ADR-0005).
- **Never:** offensive MEV of any kind.

## 13. Data collection and replay

Collection is a Phase 1 deliverable with a written retention policy, and replay is the production decision and gate code run over stored features (ADR-0007). Shadow mode is replay on the live stream and is the required paper test before a rule enters suggest.

- Sampling: 1 s for active tokens, 60 s for cooling tokens, plus every chain event, every parsed launch transaction, every audit change and every wallet print.
- Retention: 1 s rows for 30 days; 10 s continuous aggregate for a year; events and launch transactions indefinitely.
- Replay execution model: constant-product fill on the pool's liquidity at that second, 1.5 s latency assumption, fees and priority tip in force at the time. Results are labelled `replay` and never sit next to live numbers without the label.
- External history (Bitquery, Dune) is optional, enters through its own adapter with `source = "external:<provider>"`, and is kept separate in every statistic.

## 14. Database schema (Postgres + TimescaleDB)

```sql
tokens(chain, mint pk, symbol, name, creator, created_at, first_seen, stage)
token_snapshots(ts, mint, price, mc, liq, vol5m, vol24, tx24, buys5m, sells5m, holders, top10, source)  -- hypertable, 1s/60s
chain_events(ts, mint, kind, sig, data jsonb)                                 -- create, migrate, lp_*, authority_*
launch_txs(mint pk, slot, creator, buyers jsonb, bundle_pct, sniper_pct, parsed_at)
audits(mint, at, program, mint_auth, freeze_auth, extensions jsonb, lp_state, top10, funding_flags jsonb)
supply_maps(mint, at, dev_pct, bundle_pct, sniper_pct, fresh_pct, lp_pct, cluster_pct, trend, inputs jsonb)
microstructure(mint, at, net_flow_1m, net_flow_5m, organic_vol_pct_5m, depth_buy_2pct, depth_sell_2pct)  -- hypertable
regime(at, sol_change_1h, breadth_5m, launches_ph, migrations_ph, safety_reject_rate_1h, size_mul, reason)
wallets(pk pk, label, kind, tracked_since, status, stats jsonb)               -- kind: owner | discovered
wallet_profiles(wallet pk, class, confidence, stats jsonb, profiled_at)
wallet_prints(sig pk, wallet, ts, seen_at, mint, side, sol, amount)           -- copy gap = seen_at - ts
wallet_scores(wallet, window_days, n, hit_rate_30m, med_ret_120m, med_hold_sec, copied_pnl_sol, class, scored_at)
intents(id pk, chain, ts, kind, strategy, rule_id, mode, mint, side, size_sol, sizing jsonb, features jsonb, why, status, decided_by, decided_at, replay_run_id)
gate_results(intent_id, gate, passed, reason_code, adjustment jsonb, ms)
quotes(id pk, intent_id, ts, in_amount, out_amount, impact_pct, slippage_bps, route jsonb)
executions(id pk, intent_id, quote_id, wallet, sig, sent_at, landed_at, status, err, fee_lamports, tip_lamports, route)
fills(execution_id pk, chain, mint, side, sol_delta, token_delta, quoted_price, realized_price, realized_slippage_pct)
positions(mint, wallet, opened_at, closed_at, cost_sol, qty, exits jsonb, realized_pnl_sol, status)
outcomes(intent_id, horizon_sec, ret_pct, max_ret_pct, min_ret_pct)           -- every intent, executed or rejected
rule_stats(rule_id, window_days, n, win_rate, expectancy, worst_dd, weight, changed_at, change_reason, replay_run_id)
replay_runs(id pk, rules_version, window_start, window_end, exec_model jsonb, started_at, finished_at, summary jsonb)
halts(ts, kind, reason, cleared_at, cleared_by)
tiers(active_tier, wallet_cap_sol, changed_at, changed_by, reason)
events(ts, level, component, msg, data jsonb)                                 -- hypertable, 90-day retention; every API mutation lands here
```

## 15. Metrics (Prometheus, prefix `wick_`)

Never a label with a token address, wallet or signature; details go to `events`.

| Metric                                      | Type      |
| ------------------------------------------- | --------- |
| `wick_up`                                   | gauge     |
| `wick_source_heartbeat_age_seconds{source}` | gauge     |
| `wick_source_call_duration_seconds{source}` | histogram |
| `wick_slot_lag`                             | gauge     |
| `wick_event_loop_lag_seconds`               | gauge     |
| `wick_active_tokens`                        | gauge     |
| `wick_funnel_total{layer,outcome}`          | counter   |
| `wick_feature_age_seconds{feature}`         | histogram |
| `wick_decision_duration_seconds`            | histogram |
| `wick_send_duration_seconds`                | histogram |
| `wick_land_duration_seconds`                | histogram |
| `wick_attempts_total{outcome}`              | counter   |
| `wick_rejections_total{gate,reason}`        | counter   |
| `wick_adjustments_total{gate}`              | counter   |
| `wick_sizing_binding_total{term}`           | counter   |
| `wick_regime_size_mul`                      | gauge     |
| `wick_realized_slippage_pct`                | histogram |
| `wick_copy_gap_seconds`                     | histogram |
| `wick_open_positions`                       | gauge     |
| `wick_realized_pnl_sol_day`                 | gauge     |
| `wick_halted{kind}`                         | gauge     |
| `wick_replay_runs_total{status}`            | counter   |

Host and service metrics come from `node_exporter`, `postgres_exporter` and `redis_exporter` (§16). Three Grafana boards: Operations (is it alive?), Quality (is it working?), Host (is the box healthy?). Alerts are for liveness and infrastructure; the brakes are in code.

## 16. Operations: monitoring, alerts, self-halt

ADR-0009 §1 in short:

- Exporters for host, Postgres and Redis next to the engine's `/metrics`. Alertmanager routes to Telegram with written thresholds: engine down 60 s, source stale 30 s, slot lag 20, decision p99 over 50 ms, event-loop lag 100 ms, disk 80%, memory 85%, backup older than 26 h, any unconfirmed transaction.
- A dead-man ping to an external uptime service every minute, so a dead VPS still alerts.
- **Self-halt:** engine health is a risk-gate input. Slot lag over 20, a stale source over 30 s, or decision p99 over budget for 5 minutes stops new entries with `RISK_HALT` and the reason `health`. Exits keep running.

## 17. Control plane: API, network, PWA, bot

ADR-0009 §2–4 in short:

- One HTTP + WebSocket API on the host, behind a reverse proxy that listens only on the Tailscale address. No public ports except key-only SSH. Every mutating call is an `events` row.
- The WICK web app, installed as a PWA on the phone and laptop, is the read-and-approve client: intents with why, gate results and adjustments, funnel, rule stats, regime reason, halt, unseal. It gains a `server` mode that reads the API instead of calling sources itself.
- A Telegram bot delivers alerts and the daily report and accepts three commands from the owner's chat id: `/halt` (immediate, no second factor), `/approve <id> <totp>`, `/status`. Unseal and halt-clear need the PWA plus a second factor.
- Passkeys replace the bearer token in Phase 5. No native app in v1.

## 18. Chain adapters

Everything chain-specific lives behind `ChainAdapter` (ADR-0006), one implementation per chain under `apps/engine/src/chains/`. The core never imports a chain SDK. Solana is the only adapter in v1; Base is the first candidate after 90 days of positive expectancy.

## 19. What moves from the current code

`risk.ts`, `exits.ts`, `entry.ts`, `guard.ts`, `hot-wallet.ts` (vault format and signer) and `jup.ts` move as they are into `packages/core` and the Solana adapter. `sieve.ts` becomes the sieve layer, `sentiment.ts` seeds the regime writer, `fraud.ts` seeds the profiler's first heuristics. `live-auto.ts` becomes `executor`. The browser store loses execution and becomes a read-and-approve client.

## 20. Language

Code, identifiers, reason codes, schema, logs, configuration and engine documents (this file and ADRs from 0005 on) are English, so the name in the document is the name in the code. The roadmap, the state ledger and ADRs 0001–0004 stay in Arabic for the owner; a decision recorded there is restated in English here when it touches the engine.
