# ADR-0008: One wallet profiler, a few microstructure features, and a decision budget

- Status: accepted (September 2026)

## Context

After ADR-0005 to 0007 the owner asked about a long list of further tools: MEV strategy analysis, price-manipulation detection, bot-behaviour fingerprinting, wash-volume analysis, liquidity-flow monitoring, order-book analysis, DCA, market and social sentiment. Then the better question: does all of it deserve to be built, and will it degrade decision speed or quality?

Speed is not the risk. The decision layer reads one precomputed feature row and applies weighted rules in well under a millisecond; every heavy analysis is a background writer with a timestamp, and a stale row reads as `null`. Adding analyses does not slow decisions.

Quality is the risk, in three ways:

1. **Coverage erosion.** Every reject gate multiplies the pass rate. Seven gates passing 60% each leave 2.8% of candidates; three more at 80% each halve that. Fewer trades means fewer intents, which means slower learning.
2. **Unknown inflation.** In auto mode every `null` feature a rule requires is a rejection. More required features means more rejections caused by a late source, not a bad token.
3. **Overfitting.** Thirty features with daily weight moves on a 14-day window and a few hundred intents learns noise.

Five of the proposed tools also measure the same thing from different angles: wash detection, bot volume, sniper share, fresh-wallet share and smart-copy discovery all need to know what kind of wallet a given address is.

## Decision

### 1. One wallet profiler, built once, read by everything

A background module classifies every wallet the engine sees in launch transactions, holder lists and prints, and writes `wallet_profiles(wallet, class, confidence, stats jsonb, profiled_at)`.

Inputs, all derivable from data we already collect:

| Signal               | How                                                                    |
| -------------------- | ---------------------------------------------------------------------- |
| Timing regularity    | low variance of inter-trade intervals                                  |
| Amount repetition    | identical or round sizes                                               |
| Create-slot buys     | bought in the create slot or the next 3 (humans cannot)                |
| Age and activity     | wallet age, transaction count, first funding time                      |
| Program path         | direct AMM calls vs a router, fixed compute-unit settings, Jito tips   |
| Common funder        | many wallets funded by one source within hours                         |
| Exit behaviour       | always sells within N seconds of buying; round trips                   |
| Realized performance | hit rate and median return when the wallet buys early (for smart copy) |

Classes: `organic`, `sniper-bot`, `wash-bot`, `copy-bot`, `dev-adjacent`, `exit-liquidity`, `early-consistent`, `unknown`. A class is stored with the numbers that produced it, never as a bare label.

Consumers: the supply map (`sniperPct`, `freshWalletPct`, `devPct`), organic-volume estimation, the manipulation gate's wash flag, and smart-copy discovery (ENGINE §7). None of them re-derives what the profiler already computed.

### 2. Four microstructure features, and what was dropped

Added to `Features`, all computed from snapshots, events and the profiler, all background:

- `netFlowSol1m`, `netFlowSol5m`: SOL into the pool minus SOL out.
- `organicVolPct5m`: volume from wallets not classed as bots and not in round trips, divided by total volume. Volume-to-liquidity checks use organic volume, not raw volume.
- `depthBuy2Pct`, `depthSell2Pct`: the USD size that moves price 2% in each direction, computed from reserves; their ratio is the impact asymmetry.
- `holdersDelta30m`: change in holder count, for price/holder divergence.

Explicitly not built, with the reason:

| Proposal                                                         | Decision              | Why                                                                              |
| ---------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------- |
| Order-book analysis                                              | not built             | Meme tokens trade on AMMs; depth from reserves is exact and cannot be spoofed    |
| CEX order book / funding for SOL                                 | not built             | SOL price change from Jupiter is enough for the regime layer                     |
| Fake-support detection                                           | not built             | Needs order-book style data that does not exist; low value                       |
| Separate wash-volume module                                      | merged                | It is `organicVolPct5m` from the profiler                                        |
| Sandwich attacks as a signal                                     | deferred, maybe never | Requires parsing every block; value at tier 1 does not cover the cost            |
| Offensive MEV (sandwiching, backrunning)                         | out of scope          | Needs infrastructure the account cannot carry, and it is not this engine's style |
| New reject codes (`MANIP_BOTVOL`, `MANIP_ROUNDTRIP`, `EXEC_MEV`) | not added             | Rejects are for capital-loss risk only; these are adjustments (rule 1 below)     |
| Paid X/Twitter API                                               | tier 2 or later       | Exceeds the tier-1 budget; value unproven                                        |
| Time-based DCA into meme tokens                                  | not built             | Averaging down is the fastest way to turn a 1.5% loss into 4.5%                  |

### 3. A decision budget with three rules

1. **Rejects are for capital-loss risk only.** The gate count stays at seven. Every new signal enters as a feature that adjusts size or weight, never as a new reject gate.
2. **No feature without replay evidence.** A new feature enters in shadow mode. If it does not improve the expectancy of at least one rule within 60 days, it is removed. Removal is planned like addition and recorded in `rule_stats.change_reason`.
3. **Fixed budget:** decision path under 50 ms end to end (features read to intent written), at most 40 feature columns, 7 gates, at most 25 reason codes. Exceeding any of these needs an ADR.

Related constraints restated here so they live in one place:

- Social and sentiment signals are weight modifiers between −20% and +20% of size, never a gate. Tier-1 sources are free ones only (pump.fun reply velocity, metadata socials and their age, DexScreener paid boosts as a "paid marketing" flag, public Telegram member counts, narrative cluster from names).
- Scale-in (`kind = "add"`) is allowed only above the entry price and only while the supply map is clean. Never below entry.
- The regime layer (ENGINE §11) outputs one size multiplier for the whole engine from our own data; it never rejects a token.

## Alternatives rejected

- **Build everything and let the evaluator sort it out.** Rejected: with a few hundred intents the evaluator cannot separate thirty features, and the coverage loss is immediate while the benefit is hypothetical.
- **One combined "manipulation score" in a single number.** Rejected: a single score hides which signal fired, and the reason-code distribution is the main diagnostic.

## Consequences

- ADR-0008 replaces the broader proposals discussed with the owner; anything not listed above is not planned.
- ENGINE.md gains §3 (decision layers and budget), §8 (wallet profiler), §10 (microstructure), §11 (regime) and §12 (execution and MEV policy).
- Phase 2 gains the profiler's basic classes and the four features; Phase 4 gains the funding tree and realized-performance classes.
