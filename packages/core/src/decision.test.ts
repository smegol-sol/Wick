import assert from "node:assert/strict";
import test from "node:test";
import type { Features } from "@wick/core/contracts";
import { GATES } from "@wick/core/contracts";
import { evaluateEntry, evaluateExit, sieve, type EntryRule } from "@wick/core/decide";
import {
  exitImpactPct,
  runGates,
  type GateBook,
  type GateInput,
  type GateLimits,
} from "@wick/core/gates";
import { entryRules, exitRule, validateRules, type ExitParams } from "@wick/core/rules";
import { sizeEntry } from "@wick/core/sizing";

const NOW = 1_700_000_000_000;

const RULES = {
  version: 1,
  intentTtlMs: 90_000,
  intentCooldownMs: 300_000,
  rules: {
    "confirmed-entry": {
      strategy: "confirmed-entry",
      mode: "shadow",
      weight: 1,
      params: {
        ageMinSec: 180,
        ageMaxSec: 5400,
        minLiqUsd: 4000,
        minBuySellRatio: 1.3,
        minTrades5m: 20,
        volLiqMin: 0.05,
        volLiqMax: 2,
        minUniqueBuyers: 15,
        minNetFlowSol5m: 0,
        followBoost: 1.5,
        sizeMul: 1,
      },
    },
    "exit-policy": {
      strategy: "exit-policy",
      mode: "shadow",
      weight: 1,
      params: {
        trailingStopPct: 22,
        hardDropPct: 18,
        timeExitSec: 14_400,
        liqDropPct: 30,
        takeProfit: [
          { atPct: 50, sellPct: 30 },
          { atPct: 100, sellPct: 40 },
        ],
      },
    },
  },
};

function features(over: Partial<Features> = {}): Features {
  return {
    chain: "solana",
    mint: "Mint111111111111111111111111111111111111111",
    ts: NOW,
    ageSec: 600,
    stage: "bonding",
    priceUsd: 0.001,
    mcUsd: 50_000,
    liqUsd: 8000,
    vol5m: 2000,
    vol24: null,
    tx24: null,
    buys5m: 30,
    sells5m: 10,
    uniqueBuyers5m: null,
    holders: 120,
    holdersDelta30m: 20,
    top10Pct: 20,
    authorities: { mint: false, freeze: false, program: "token" },
    extensions: { transferFeeBps: 0, hook: false, permanentDelegate: false, defaultFrozen: false },
    lp: "curve",
    lastLpEvent: null,
    supply: {
      at: NOW - 600_000,
      devPct: 2,
      bundlePct: 5,
      sniperPct: 8,
      freshWalletPct: null,
      lpPct: null,
      clusterPct: null,
      earlyHoldersTrend: null,
    },
    micro: {
      at: NOW,
      netFlowSol1m: 1,
      netFlowSol5m: 4,
      organicVolPct5m: null,
      depthBuy2PctUsd: 600,
      depthSell2PctUsd: 500,
    },
    washFlags: [],
    fundingFlags: [],
    followBuys3m: 0,
    followSells3m: 0,
    smartBuys3m: 0,
    social: null,
    ...over,
  };
}

const LIMITS: GateLimits = {
  minTradeSol: 0.05,
  quoteMaxAgeMs: 3000,
  maxImpactEntryPct: 3,
  maxImpactExitPct: 5,
  maxOpenPositions: 6,
  tokenCapSol: 0.45,
  youngTokenExposurePct: 50,
  feeReserveSol: 0.05,
  dailyHaltPct: -5,
  weeklyHaltPct: -10,
  postLossDayMul: 0.5,
};

function book(over: Partial<GateBook> = {}): GateBook {
  return {
    halted: false,
    haltReason: null,
    dayPnlPct: null,
    weekPnlPct: null,
    openPositions: 0,
    openExposureSol: 0,
    youngExposureSol: 0,
    equitySol: 15,
    deployedSol: 0,
    cashSol: null,
    clusterOpen: 0,
    lostYesterday: false,
    ...over,
  };
}

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    features: features(),
    mode: "suggest",
    side: "buy",
    sizeSol: 0.2,
    solUsd: 100,
    quote: { ageMs: 500, impactPct: 1 },
    book: book(),
    limits: LIMITS,
    now: NOW,
    ...over,
  };
}

test("rules file: validated with the offending path, ids kebab-case, exit rule found", () => {
  const file = validateRules(RULES);
  assert.equal(entryRules(file).length, 1);
  assert.equal(exitRule(file)?.id, "exit-policy");
  assert.equal(file.intentTtlMs, 90_000);
  const bad = structuredClone(RULES) as {
    rules: Record<string, { params: Record<string, unknown> }>;
  };
  delete bad.rules["confirmed-entry"]!.params.minLiqUsd;
  assert.throws(() => validateRules(bad), /confirmed-entry\.minLiqUsd/);
  const bad2 = structuredClone(RULES) as { rules: Record<string, unknown> };
  bad2.rules.BadId = bad2.rules["confirmed-entry"];
  assert.throws(() => validateRules(bad2), /kebab-case/);
  const bad3 = structuredClone(RULES) as { rules: Record<string, { mode: string }> };
  bad3.rules["confirmed-entry"]!.mode = "live";
  assert.throws(() => validateRules(bad3), /mode/);
  const bad4 = structuredClone(RULES) as unknown as {
    rules: Record<string, { params: ExitParams }>;
  };
  bad4.rules["exit-policy"]!.params.takeProfit = [
    { atPct: 100, sellPct: 30 },
    { atPct: 50, sellPct: 40 },
  ];
  assert.throws(() => validateRules(bad4), /ascend/);
  assert.throws(() => validateRules({ ...RULES, rules: {} }), /no rules/);
});

test("sizing: the minimum of three terms with the binding term recorded", () => {
  const eq = sizeEntry({
    equitySol: 15,
    perTradePct: 1.5,
    poolLiqUsd: 100_000,
    poolSharePct: 1,
    solUsd: 100,
    tokenCapSol: 0.45,
    openExposureSol: 0,
    regimeMul: 1,
    socialMul: 1,
  });
  assert.equal(eq.sizing.binding, "equity");
  assert.equal(eq.sizeSol, 0.225);
  const pool = sizeEntry({
    equitySol: 100,
    perTradePct: 1.5,
    poolLiqUsd: 5000,
    poolSharePct: 1,
    solUsd: 100,
    tokenCapSol: 3,
    openExposureSol: 0,
    regimeMul: 0.5,
    socialMul: 1.2,
  });
  assert.equal(pool.sizing.binding, "pool");
  assert.equal(pool.baseSol, 0.5);
  assert.equal(pool.sizeSol, 0.3, "base × regime × social");
  const cap = sizeEntry({
    equitySol: 15,
    perTradePct: 1.5,
    poolLiqUsd: 100_000,
    poolSharePct: 1,
    solUsd: 100,
    tokenCapSol: 0.45,
    openExposureSol: 0.4,
    regimeMul: 1,
    socialMul: 1,
  });
  assert.equal(cap.sizing.binding, "cap");
  assert.equal(cap.sizeSol, 0.05);
  const over = sizeEntry({
    equitySol: 15,
    perTradePct: 1.5,
    poolLiqUsd: 100_000,
    poolSharePct: 1,
    solUsd: 100,
    tokenCapSol: 0.45,
    openExposureSol: 0.5,
    regimeMul: 1,
    socialMul: 1,
  });
  assert.equal(over.sizeSol, 0, "never negative");
  assert.equal(over.sizing.binding, "cap");
});

test("gates: a clean candidate passes six gates in order with no adjustment", () => {
  const run = runGates(input());
  assert.equal(run.rejected, null);
  assert.deepEqual(
    run.results.map((r) => r.gate),
    GATES.filter((g) => g !== "execution"),
  );
  assert.equal(run.sizeMul, 1);
  assert.equal(run.sizeSol, 0.2);
  assert.ok(run.results.every((r) => r.passed && r.reasonCode === null && r.ms >= 0));
});

test("gates: the first rejection ends the run and carries its code", () => {
  const cases: [Partial<Features>, string, string][] = [
    [{ authorities: { mint: false, freeze: true, program: "token" } }, "safety", "SAFETY_FREEZE"],
    [
      { authorities: { mint: true, freeze: false, program: "token" }, stage: "migrated" },
      "safety",
      "SAFETY_MINT",
    ],
    [
      {
        extensions: {
          transferFeeBps: 50,
          hook: false,
          permanentDelegate: false,
          defaultFrozen: false,
        },
      },
      "safety",
      "SAFETY_EXT",
    ],
    [{ lp: "deployer" }, "safety", "SAFETY_LP"],
    [{ supply: { ...features().supply!, devPct: 12 } }, "supply", "SUPPLY_DEV"],
    [{ supply: { ...features().supply!, bundlePct: 25 } }, "supply", "SUPPLY_BUNDLE"],
    [{ supply: { ...features().supply!, sniperPct: 30 } }, "supply", "SUPPLY_SNIPERS"],
    [{ lastLpEvent: { kind: "remove", pct: 40, ts: NOW - 60_000 } }, "liquidity", "LIQ_PULL"],
    [{ micro: { ...features().micro!, depthSell2PctUsd: 5 } }, "liquidity", "LIQ_EXIT"],
    [{ micro: { ...features().micro!, organicVolPct5m: 30 } }, "manipulation", "MANIP_WASH"],
    [{ uniqueBuyers5m: 5, buys5m: 40 }, "manipulation", "MANIP_WASH"],
    [{ top10Pct: 40 }, "manipulation", "MANIP_TOP10"],
    [{ fundingFlags: ["shared-funder"] }, "manipulation", "MANIP_FUNDING"],
  ];
  for (const [over, gate, code] of cases) {
    const run = runGates(input({ features: features(over) }));
    assert.equal(run.rejected?.gate, gate, code);
    assert.equal(run.rejected?.reasonCode, code);
    assert.equal(run.results[run.results.length - 1], run.rejected, "rejection is the last row");
    assert.equal(run.sizeSol, 0);
  }
  assert.equal(runGates(input({ sizeSol: 0.01 })).rejected?.reasonCode, "LIQ_DEPTH");
  assert.equal(
    runGates(input({ quote: { ageMs: 5000, impactPct: 1 } })).rejected?.reasonCode,
    "QUOTE_STALE",
  );
  assert.equal(
    runGates(input({ quote: { ageMs: 100, impactPct: 4 } })).rejected?.reasonCode,
    "QUOTE_IMPACT",
  );
  assert.equal(
    runGates(input({ quote: null })).rejected?.reasonCode,
    "QUOTE_STALE",
    "a failed quote in suggest",
  );
  assert.equal(
    runGates(input({ side: "sell", quote: { ageMs: 100, impactPct: 4 } })).rejected,
    null,
    "exit impact limit is 5%",
  );
  assert.equal(runGates(input({ book: book({ halted: true }) })).rejected?.reasonCode, "RISK_HALT");
  assert.equal(
    runGates(input({ book: book({ dayPnlPct: -5 }) })).rejected?.reasonCode,
    "RISK_HALT",
  );
  assert.equal(
    runGates(input({ book: book({ openPositions: 6 }) })).rejected?.reasonCode,
    "RISK_SLOTS",
  );
  assert.equal(
    runGates(input({ book: book({ openExposureSol: 0.3 }) })).rejected?.reasonCode,
    "RISK_TOKEN_CAP",
  );
  assert.equal(
    runGates(input({ book: book({ clusterOpen: 2 }) })).rejected?.reasonCode,
    "RISK_CLUSTER",
  );
  assert.equal(
    runGates(input({ book: book({ youngExposureSol: 7.4 }) })).rejected?.reasonCode,
    "RISK_YOUNG",
  );
  assert.equal(runGates(input({ book: book({ cashSol: 0.2 }) })).rejected?.reasonCode, "RISK_CASH");
  assert.equal(
    runGates(input({ side: "sell", book: book({ halted: true, openPositions: 6 }) })).rejected,
    null,
    "an exit is never blocked by the book",
  );
});

test("gates: adjustments multiply the running size and are recorded per gate", () => {
  const run = runGates(
    input({
      features: features({
        supply: { ...features().supply!, devPct: 7, sniperPct: 18 },
        micro: { ...features().micro!, netFlowSol5m: -1, depthSell2PctUsd: 250 },
      }),
      book: book({ lostYesterday: true }),
    }),
  );
  assert.equal(run.rejected, null);
  const by = Object.fromEntries(run.results.map((r) => [r.gate, r.adjustment]));
  assert.equal(by.supply?.sizeMul, 0.25);
  assert.match(by.supply!.reason, /dev holds 7.0%; snipers hold 18.0%/);
  assert.equal(by.liquidity?.sizeMul, 0.25);
  assert.equal(by.risk?.sizeMul, 0.5);
  assert.equal(by.safety, null);
  assert.equal(run.sizeMul, 0.03125);
  assert.equal(run.sizeSol, 0.00625);
});

test("gates: unknown inputs reject only in auto mode; the supply map's age too", () => {
  const unknown = features({ authorities: null, extensions: null, supply: null, top10Pct: null });
  assert.equal(
    runGates(input({ features: unknown, mode: "shadow", quote: undefined })).rejected,
    null,
  );
  assert.equal(runGates(input({ features: unknown, mode: "suggest" })).rejected, null);
  assert.equal(
    runGates(input({ features: unknown, mode: "auto" })).rejected?.reasonCode,
    "SAFETY_UNKNOWN",
  );
  const known = features({ supply: null });
  assert.equal(
    runGates(input({ features: known, mode: "auto" })).rejected?.reasonCode,
    "SUPPLY_UNKNOWN",
  );
  const stale = features();
  assert.equal(
    runGates(input({ features: stale, mode: "auto" })).rejected?.reasonCode,
    "SUPPLY_UNKNOWN",
    "launch-time map is older than 5 min",
  );
  const fresh = features({ supply: { ...features().supply!, at: NOW - 1000 } });
  assert.equal(
    runGates(input({ features: fresh, mode: "auto", book: book({ cashSol: 5 }) })).rejected,
    null,
  );
  assert.equal(
    runGates(input({ features: fresh, mode: "auto", quote: undefined })).rejected?.reasonCode,
    "QUOTE_STALE",
  );
  assert.equal(
    runGates(input({ features: fresh, mode: "auto", book: book({ cashSol: null }) })).rejected
      ?.reasonCode,
    "RISK_CASH",
  );
  assert.equal(
    runGates(input({ features: { ...fresh, top10Pct: null }, mode: "auto" })).rejected?.reasonCode,
    "MANIP_TOP10",
  );
});

test("gates: `only` runs a subset in the fixed order", () => {
  const run = runGates(
    input({ quote: null, only: ["safety", "supply", "liquidity", "manipulation"] }),
  );
  assert.equal(run.rejected, null);
  assert.deepEqual(
    run.results.map((r) => r.gate),
    ["safety", "supply", "liquidity", "manipulation"],
  );
  const exit = runGates(input({ side: "sell", only: ["quote"], book: book({ halted: true }) }));
  assert.deepEqual(
    exit.results.map((r) => r.gate),
    ["quote"],
  );
  assert.ok(Math.abs(exitImpactPct(20, 500) - 0.08) < 1e-12);
  assert.equal(exitImpactPct(20, 0), Infinity);
});

test("decision: the sieve and confirmed-entry accept a clean row and refuse each missing input", () => {
  const rule = entryRules(validateRules(RULES))[0]!;
  const f = features();
  assert.equal(sieve(f, [rule]), true);
  assert.equal(sieve(features({ ageSec: 60 }), [rule]), false);
  assert.equal(sieve(features({ liqUsd: 1000 }), [rule]), false);
  assert.equal(sieve(f, []), false);
  const ok = evaluateEntry(rule, f);
  assert.ok(ok.ok);
  assert.equal(ok.weight, 1);
  assert.match(
    ok.why,
    /age 10m, liq 8000 USD, authorities revoked, buy\/sell 30\/10 on 40 trades, vol\/liq 0.25, net flow 5m \+4 SOL/,
  );
  assert.deepEqual(ok.notes, ["organic volume n/a, raw volume used", "unique buyers n/a"]);
  const boosted = evaluateEntry(rule, features({ followBuys3m: 2, uniqueBuyers5m: 20 }));
  assert.ok(boosted.ok);
  assert.equal(boosted.weight, 1.5);
  assert.match(boosted.why, /20 unique buyers, .*2 follow buys in 3m/);
  const refusals: [Partial<Features>, RegExp][] = [
    [{ ageSec: 6000 }, /age 6000s outside/],
    [{ liqUsd: 3000 }, /liquidity 3000 USD under 4000/],
    [{ authorities: null }, /authorities unknown/],
    [{ authorities: { mint: true, freeze: false, program: "token" } }, /not revoked/],
    [{ extensions: null }, /extensions unknown/],
    [
      {
        extensions: {
          transferFeeBps: 0,
          hook: true,
          permanentDelegate: false,
          defaultFrozen: false,
        },
      },
      /dangerous extension/,
    ],
    [{ buys5m: null }, /trade counts unknown/],
    [{ buys5m: 10, sells5m: 5 }, /15 trades in 5m, need 20/],
    [{ buys5m: 20, sells5m: 20 }, /buy\/sell 1 under 1.3/],
    [{ vol5m: null }, /5m volume unknown/],
    [{ vol5m: 100 }, /vol\/liq 0.01 outside/],
    [{ uniqueBuyers5m: 3 }, /3 unique buyers, need 15/],
    [{ micro: null }, /net flow unknown/],
    [{ micro: { ...f.micro!, netFlowSol5m: -2 } }, /net flow 5m -2 SOL not above 0/],
  ];
  for (const [over, re] of refusals) {
    const v = evaluateEntry(rule, features(over));
    assert.equal(v.ok, false, String(re));
    assert.match((v as { reason: string }).reason, re);
  }
  const snipe: EntryRule = { ...rule, id: "migration-snipe", strategy: "migration-snipe" };
  assert.deepEqual(evaluateEntry(snipe, f), { ok: false, reason: "not migrated" });
  assert.ok(evaluateEntry(snipe, features({ stage: "migrated" })).ok);
});

test("decision: exits fire in danger order, then trailing, time and the take-profit ladder", () => {
  const p = exitRule(validateRules(RULES))!.params;
  const pos = {
    openedAt: NOW - 3600_000,
    entryPriceUsd: 0.001,
    entryLiqUsd: 8000,
    peakPriceUsd: 0.001,
    lastPriceUsd: 0.001,
    tpTaken: 0,
  };
  assert.equal(evaluateExit(p, pos, features(), NOW), null);
  assert.match(
    evaluateExit(
      p,
      pos,
      features({ lastLpEvent: { kind: "remove", pct: 10, ts: NOW - 5000 } }),
      NOW,
    )!.reason,
    /LP removal 10%/,
  );
  assert.match(
    evaluateExit(p, pos, features({ liqUsd: 5000 }), NOW)!.reason,
    /liquidity down 37.5%/,
  );
  assert.match(
    evaluateExit(
      p,
      pos,
      features({ supply: { ...features().supply!, earlyHoldersTrend: "distributing" } }),
      NOW,
    )!.reason,
    /distributing/,
  );
  assert.match(
    evaluateExit(p, pos, features({ priceUsd: 0.0008 }), NOW)!.reason,
    /down 20% in one poll/,
  );
  assert.match(
    evaluateExit(
      p,
      { ...pos, peakPriceUsd: 0.002, lastPriceUsd: 0.0017 },
      features({ priceUsd: 0.0015 }),
      NOW,
    )!.reason,
    /25% off the peak/,
  );
  assert.match(
    evaluateExit(p, { ...pos, openedAt: NOW - 5 * 3600_000 }, features(), NOW)!.reason,
    /held 300m/,
  );
  const tp = evaluateExit(
    p,
    { ...pos, peakPriceUsd: 0.0016 },
    features({ priceUsd: 0.0016 }),
    NOW,
  )!;
  assert.equal(tp.kind, "take-profit");
  assert.equal(tp.sellPct, 30);
  assert.equal(
    evaluateExit(
      p,
      { ...pos, peakPriceUsd: 0.0016, tpTaken: 1 },
      features({ priceUsd: 0.0016 }),
      NOW,
    ),
    null,
    "first rung already taken",
  );
  assert.equal(
    evaluateExit(
      p,
      { ...pos, peakPriceUsd: 0.0021, tpTaken: 1 },
      features({ priceUsd: 0.0021 }),
      NOW,
    )!.sellPct,
    40,
  );
  const blind = {
    ...pos,
    entryPriceUsd: null,
    entryLiqUsd: null,
    peakPriceUsd: null,
    lastPriceUsd: null,
  };
  assert.equal(
    evaluateExit(p, blind, features({ liqUsd: 100, priceUsd: 0.0001 }), NOW),
    null,
    "unknown entry: nothing to compare against",
  );
});
