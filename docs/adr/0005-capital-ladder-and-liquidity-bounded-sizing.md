# ADR-0005: Capital ladder and liquidity-bounded sizing

- Status: accepted (September 2026)

## Context

The engine starts with 2,500 USD. The owner asked what changes at 30,000 USD and whether a plan exists for getting there. Nothing was written down beyond a note in ADR-0003 to revisit custody above 25,000 USD.

The meme market does not scale with the account. At 2,500 USD a 1.5% trade is about 37 USD and any pump.fun pool absorbs it. At 30,000 USD the same rule gives 450 USD, and the liquidity gate (trade ≤ 1% of pool liquidity) then requires pools of 45,000 USD or more, which excludes most of the tokens the confirmed-entry rule targets. Exits are worse than entries: selling 450 USD into a 20,000 USD pool moves the price more than a 22% trailing stop tolerates.

## Decision

### 1. Size is bounded by liquidity at every tier

The size of every entry is the minimum of three numbers, computed in the risk gate and recorded on the intent:

```
size = min(
  equity      × perTradePct,          // fixed fractional
  poolLiqUsd  × poolSharePct / solUsd, // never more than a share of the pool
  tokenCapSol − openExposureSol(mint)  // room left under the per-token cap
)
```

`poolSharePct` is 1% by default. The liquidity gate still rejects with `LIQ_DEPTH` when even the bounded size cannot fit (below `minTradeSol`), so small pools stay tradable with small size instead of being rejected outright. This rule is correct at every tier and costs nothing now, so it ships in Phase 2.

### 2. Three tiers, each with written parameters and promotion criteria

| Parameter                      | Tier 1 (2,500)                                            | Tier 2 (10,000)                        | Tier 3 (30,000)                                             |
| ------------------------------ | --------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------- |
| Execution wallet cap           | 15 SOL                                                    | 40 SOL                                 | 100 SOL across 2–3 wallets                                  |
| Per-trade size                 | 1.5% of equity                                            | 1.25%                                  | 1.0%                                                        |
| Pool share cap                 | 1%                                                        | 1%                                     | 0.75%                                                       |
| Minimum pool liquidity (entry) | 4,000 USD                                                 | 12,000 USD                             | 40,000 USD for full size; smaller pools at bounded size     |
| Max open positions             | 6                                                         | 8                                      | 12                                                          |
| Max exposure per token         | 3%                                                        | 3%                                     | 2.5%                                                        |
| Entry / exit slicing           | single order                                              | 2 slices above 1 SOL                   | 3–5 time-sliced orders (TWAP) above 2 SOL                   |
| Daily / weekly halt            | −5% / −10%                                                | −5% / −10%                             | −4% / −8%                                                   |
| Infra budget                   | ≤ 70 USD/month                                            | ≤ 250 USD/month                        | ≤ 800 USD/month (gRPC stream, second RPC, second host)      |
| Custody                        | sealed key on the VPS                                     | sealed key on the VPS, hourly backup   | separate policy signer host or cloud KMS (ADR-0003 revisit) |
| Execution wallets              | 1                                                         | 1                                      | 2–3, randomised assignment, to reduce on-chain footprint    |
| Strategies                     | confirmed-entry, migration-snipe (suggest), mirror-follow | + smart-copy                           | + launch-snipe as an optional module, suggest mode first    |
| Second chain                   | no                                                        | no                                     | eligible (ADR-0006)                                         |
| Learning                       | levels 1–2                                                | levels 1–2, level 3 if ≥ 2,000 intents | level 3 sizing within gate bounds                           |

All tier parameters live in `risk.yaml` under a `tier` key. The engine refuses to start if the configured tier does not match the wallet cap actually funded (a tier-3 config on a 15 SOL wallet is a misconfiguration, not a feature).

### 3. Promotion is a human decision with written preconditions

Moving to the next tier requires all of the following at the current tier, verified from `rule_stats` and `halts`:

- 90 days of operation with positive expectancy across all enabled rules combined.
- No weekly halt triggered in the last 60 days.
- No operational incident (unattended restart, unconfirmed transaction without a fill, key unseal failure) in the last 60 days.
- The external security review from Phase 5 completed before entering tier 3.
- A fresh 30-day suggest-mode period after the tier change, because every mistake costs 4× to 12× more.

Demotion is automatic: a weekly halt at any tier drops the parameters (not the capital) to the previous tier until the owner restores them.

## Alternatives rejected

- **Scaling per-trade size linearly with capital.** Rejected: at tier 3 it produces sizes the market cannot fill without moving the price; the liquidity bound is what keeps the rule honest.
- **More capital per trade instead of more positions.** Rejected: the limiting factor is pool depth, not the number of good opportunities, so spreading across more positions is the only way to deploy more capital in this market.
- **Launch-second sniping at tier 1 or 2.** Rejected as before (ADR-0003, ENGINE §4): the stream and tip costs exceed what the account can carry. It becomes a separate optional module at tier 3.

## Consequences

- Sizing is a three-term minimum from Phase 2 on, and the chosen term is recorded on each intent so the evaluator can see which bound is binding most often.
- ENGINE.md §4 carries the tier-1 numbers; this ADR carries the ladder.
- ADR-0003 custody is revisited at tier 3 as a precondition, not after.
