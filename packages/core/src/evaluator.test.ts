import assert from "node:assert/strict";
import test from "node:test";
import {
  eligibleForAuto,
  nextWeight,
  outcomeOf,
  ruleStats,
  shouldDisable,
  signedReturn,
  WEIGHT_RULES,
} from "@wick/core/evaluator";

const T = 1_700_000_000_000;

test("outcome: last sample inside the horizon, the best and worst on the way, null without samples", () => {
  const samples = [
    { ts: T - 1000, price: 0.9 }, // before the intent: ignored
    { ts: T + 60_000, price: 1.2 },
    { ts: T + 120_000, price: 0.8 },
    { ts: T + 290_000, price: 1.1 },
    { ts: T + 400_000, price: 5 }, // after the 5-minute horizon: ignored
  ];
  const o = outcomeOf(1, samples, T, 300);
  assert.deepEqual(o, { retPct: 10, maxRetPct: 20, minRetPct: -20 });
  assert.equal(outcomeOf(1, samples.slice(0, 1), T, 300), null, "nothing inside the window");
  assert.equal(outcomeOf(0, samples, T, 300), null, "no entry price, no outcome");
  const long = outcomeOf(1, samples, T, 1800);
  assert.equal(long?.retPct, 400, "the 30-minute horizon sees the last sample");
});

test("rule stats: signed by side, counts only measured rows, quantiles and the worst excursion", () => {
  const rows = [
    { side: "buy" as const, retPct: 10, minRetPct: -5, maxRetPct: 12 },
    { side: "buy" as const, retPct: -20, minRetPct: -25, maxRetPct: 3 },
    { side: "sell" as const, retPct: -30, minRetPct: -35, maxRetPct: 4 }, // a good sell: +30
    { side: "buy" as const, retPct: null, minRetPct: null, maxRetPct: null }, // unmeasured
    { side: "buy" as const, retPct: 0, minRetPct: -1, maxRetPct: 1 },
  ];
  assert.equal(signedReturn(rows[2]!), 30);
  const s = ruleStats(rows);
  assert.equal(s.n, 4);
  assert.equal(s.winRate, 0.5, "10 and +30 win; -20 and 0 do not");
  assert.equal(s.expectancy, 5, "(10 - 20 + 30 + 0) / 4");
  assert.equal(s.worstDd, -25, "the buy that went to -25 inside the window");
  assert.equal(s.p50, 5);
  assert.equal(s.p25, -5);
  assert.equal(s.p75, 15);
  const empty = ruleStats([rows[3]!]);
  assert.equal(empty.n, 0);
  assert.equal(empty.expectancy, null);
});

test("weight moves: one step a day, held under 20 intents, never outside [0.25, 1.5]", () => {
  const good = { n: 25, winRate: 0.6, expectancy: 4, worstDd: -10, p25: 0, p50: 3, p75: 8 };
  const bad = { ...good, expectancy: -2 };
  const few = { ...good, n: 19 };
  assert.equal(nextWeight(1, good).weight, 1.1);
  assert.match(nextWeight(1, good).reason, /1 → 1.1/);
  assert.equal(nextWeight(1, bad).weight, 0.909);
  assert.equal(nextWeight(1, few).weight, 1);
  assert.match(nextWeight(1, few).reason, /under 20/);
  assert.equal(nextWeight(1.45, good).weight, 1.5, "capped at the top");
  assert.equal(nextWeight(0.26, bad).weight, 0.25, "floored at the bottom");
  assert.equal(nextWeight(3, few).weight, 1.5, "a held weight is still clamped");
  assert.equal(nextWeight(1, { ...good, expectancy: 0 }).weight, 1);
  assert.equal(WEIGHT_RULES.windowDays, 14);
});

test("disable after seven negative days with enough intents; auto needs 20 suggestions, 60% approved, positive expectancy", () => {
  const neg = { n: 20, expectancy: -1 };
  const pos = { n: 20, expectancy: 1 };
  const thin = { n: 5, expectancy: -9 };
  assert.equal(shouldDisable(Array(7).fill(neg)), true);
  assert.equal(shouldDisable(Array(6).fill(neg)), false, "six days is not seven");
  assert.equal(shouldDisable([...Array(6).fill(neg), pos]), false);
  assert.equal(shouldDisable([...Array(6).fill(neg), thin]), false, "a thin day breaks the run");
  assert.equal(shouldDisable([pos, ...Array(7).fill(neg)]), true, "only the last seven count");
  assert.equal(
    eligibleForAuto({ suggested: 20, approved: 12, decided: 20, executedExpectancy: 0.5 }),
    true,
  );
  assert.equal(
    eligibleForAuto({ suggested: 19, approved: 19, decided: 19, executedExpectancy: 5 }),
    false,
  );
  assert.equal(
    eligibleForAuto({ suggested: 30, approved: 17, decided: 30, executedExpectancy: 5 }),
    false,
    "56% approved",
  );
  assert.equal(
    eligibleForAuto({ suggested: 30, approved: 25, decided: 30, executedExpectancy: -0.1 }),
    false,
  );
  assert.equal(
    eligibleForAuto({ suggested: 30, approved: 25, decided: 30, executedExpectancy: null }),
    false,
  );
});
