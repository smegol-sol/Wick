# ADR-0004: Autonomy modes, and what "learns from its mistakes" means

- Status: accepted (September 2026)
- Context: the owner wants an engine that suggests and lets them approve at first, then trades fully on their behalf, and learns from its mistakes.
- Decision on autonomy:
  - Every strategy rule has a mode: `suggest` or `auto`. The default for every new rule is `suggest`. (ADR-0007 adds `shadow` before `suggest`.)
  - In `suggest` the decision (the intent) is published to the control panel and Telegram with a 90-second deadline. Without approval the intent expires and is recorded `expired`. Approval skips no gate: an approved intent passes the full gate chain before signing.
  - Promotion to `auto` is a human decision only, and becomes available to a rule after at least 20 suggestions, an approval rate of 60% or more, and positive expectancy on the executed suggestions.
  - Demotion to `suggest` is automatic on: a 5% daily loss, four consecutive losses for the same rule, or three consecutive rejections from the execution gate.
- Decision on learning, three levels in order, and no level is skipped:
  1. **Decision memory**: every intent with its features at decision time, every gate and its result with a reason code, every quote, every transaction and its on-chain result, and the outcome measured after 5, 30 and 120 minutes whether the intent was executed or rejected. A recorded rejection is half of the learning.
  2. **Rule evaluation and weight changes**: a daily job computes, per rule over a 14-day window, the count, win rate, expectancy, worst drawdown, and the distribution rather than the mean. A weight moves at most 10% a day inside [0.25, 1.5]. A rule with 20 or more intents and negative expectancy for seven days is disabled and only the operator re-enables it. Every change is written with its reason and number. Followed wallets get the same logic: copy gap and realized slippage per wallet, and demotion for any wallet that costs more than it earns.
  3. **Predictive models**: not built before at least 2,000 recorded intents, paper-tested for at least 30 days before touching any trade size, and never allowed to do more than adjust size inside the gate limits.
- Explicitly rejected: any self-change without a `rule_stats` row carrying the reason and the number. Any "learning" that cannot be explained in one sentence on the control panel.
- Consequences: slower learning that is explainable and reversible. Data recorded from day one is the real capital of the later phases.
