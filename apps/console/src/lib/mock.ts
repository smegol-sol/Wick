/**
 * Example data for building the console before the decision layer exists
 * (ADR-0010 §4). Deterministic, plainly labelled `example: true`, and never
 * mixed with a live engine: mock mode is all-or-nothing.
 */
import type {
  ApiState,
  Candle,
  FunnelView,
  IntentView,
  PositionView,
  ReplayRunView,
  RuleView,
  TokenView,
} from "@wick/core/api";
import { adjustedMulOf } from "@wick/core/api";
import type { Features, GateResult, Intent } from "@wick/core/contracts";
import { hashString, mulberry32 } from "@wick/core/format";

const MINTS = [
  "ExAmpLe1111111111111111111111111111111111111",
  "ExAmpLe2222222222222222222222222222222222222",
  "ExAmpLe3333333333333333333333333333333333333",
  "ExAmpLe4444444444444444444444444444444444444",
];
const SYMBOLS = ["EXMPL", "SAMPL", "DEMO", "FAKE"];

function rng(seed: string) {
  return mulberry32(hashString(seed));
}

function features(mint: string, now: number): Features {
  const r = rng(`f:${mint}`);
  const liq = 4000 + r() * 40_000;
  return {
    chain: "solana",
    mint,
    ts: now,
    ageSec: Math.round(180 + r() * 5000),
    stage: r() > 0.5 ? "migrated" : "bonding",
    priceUsd: 0.00001 + r() * 0.0002,
    mcUsd: liq * (2 + r() * 6),
    liqUsd: liq,
    vol5m: Math.round(liq * (0.05 + r() * 0.8)),
    vol24: null,
    tx24: null,
    buys5m: Math.round(20 + r() * 60),
    sells5m: Math.round(5 + r() * 30),
    uniqueBuyers5m: Math.round(15 + r() * 40),
    holders: Math.round(60 + r() * 400),
    holdersDelta30m: Math.round(-5 + r() * 40),
    top10Pct: Math.round(15 + r() * 25),
    authorities: { mint: false, freeze: false, program: "token" },
    extensions: { transferFeeBps: 0, hook: false, permanentDelegate: false, defaultFrozen: false },
    lp: "burned",
    lastLpEvent: null,
    supply: {
      at: now - 20_000,
      devPct: Math.round(r() * 12 * 10) / 10,
      bundlePct: Math.round(r() * 22 * 10) / 10,
      sniperPct: Math.round(r() * 28 * 10) / 10,
      freshWalletPct: Math.round(r() * 50),
      lpPct: Math.round(20 + r() * 40),
      clusterPct: null,
      earlyHoldersTrend: r() > 0.6 ? "accumulating" : "distributing",
    },
    micro: {
      at: now - 5000,
      netFlowSol1m: Math.round((r() - 0.4) * 20 * 100) / 100,
      netFlowSol5m: Math.round((r() - 0.4) * 80 * 100) / 100,
      organicVolPct5m: Math.round(35 + r() * 60),
      depthBuy2PctUsd: Math.round(liq * 0.02),
      depthSell2PctUsd: Math.round(liq * 0.02 * (0.4 + r() * 0.8)),
    },
    washFlags: [],
    fundingFlags: [],
    followBuys3m: Math.round(r() * 2),
    followSells3m: 0,
    smartBuys3m: 0,
    social: {
      at: now,
      repliesPerMin: Math.round(r() * 8),
      hasSocials: r() > 0.3,
      paidBoost: r() > 0.7,
      telegramMembers: null,
    },
  };
}

function gatesFor(f: Features, seed: string): GateResult[] {
  const r = rng(`g:${seed}`);
  const s = f.supply!;
  const m = f.micro!;
  const supplyAdj = s.devPct != null && s.devPct > 5 ? { sizeMul: 0.5, reason: "dev 5–10%" } : null;
  const liqAdj =
    m.netFlowSol5m != null && m.netFlowSol5m < 0
      ? { sizeMul: 0.5, reason: "net flow 5m negative" }
      : null;
  const manipAdj =
    (f.holdersDelta30m ?? 0) <= 0 ? { sizeMul: 0.5, reason: "price up, holders flat" } : null;
  // Deterministic: the fourth example is the rejected one.
  const reject = seed.endsWith(":3") && r() >= 0;
  return [
    { gate: "safety", passed: true, reasonCode: null, adjustment: null, ms: 0.3 },
    { gate: "supply", passed: true, reasonCode: null, adjustment: supplyAdj, ms: 0.4 },
    {
      gate: "liquidity",
      passed: !reject,
      reasonCode: reject ? "LIQ_EXIT" : null,
      adjustment: liqAdj,
      ms: 0.2,
    },
    ...(reject
      ? []
      : ([
          { gate: "manipulation", passed: true, reasonCode: null, adjustment: manipAdj, ms: 0.2 },
          { gate: "quote", passed: true, reasonCode: null, adjustment: null, ms: 412 },
          { gate: "risk", passed: true, reasonCode: null, adjustment: null, ms: 0.1 },
        ] as GateResult[])),
  ];
}

export function mockIntents(now: number): IntentView[] {
  // Anchored to a two-minute window so countdowns do not jump between refetches.
  const base = now - (now % 120_000);
  return MINTS.map((mint, i): IntentView => {
    const f = features(mint, base - i * 40_000);
    const gates = gatesFor(f, `${mint}:${i}`);
    const rejected = gates.some((g) => !g.passed);
    const intent: Intent = {
      id: `ex-${i + 1}`,
      chain: "solana",
      ts: base + 30_000 - i * 40_000,
      kind: "entry",
      strategy: i === 3 ? "migration-snipe" : "confirmed-entry",
      ruleId: i === 3 ? "migration-snipe.v1" : "confirmed-entry.v1",
      mode: "suggest",
      mint,
      side: "buy",
      sizeSol: Math.round((0.2 + (i % 3) * 0.07) * 100) / 100,
      sizing: {
        equityTerm: 0.35,
        poolTerm: 0.28 + i * 0.05,
        capTerm: 0.7,
        binding: i % 2 ? "pool" : "equity",
        regimeMul: 1,
        socialMul: 1,
      },
      features: f,
      why: [
        "3–90 min old, liquidity 18k, buys/sells 2.1, 31 unique buyers, dev 4%, net flow +12 SOL.",
        "Migrated 6 min ago, supply map clean, 44 unique buyers, one followed wallet bought.",
        "Liquidity 9k, buys/sells 1.6, holders +22 in 30 min, snipers 9%.",
        "Migration event 40 s ago, half size, suggest mode until the rule proves itself.",
      ][i]!,
      ttlMs: 90_000,
      replayRunId: null,
    };
    return {
      intent,
      symbol: SYMBOLS[i]!,
      status: rejected ? "rejected" : i === 2 ? "approved" : "proposed",
      gates,
      adjustedMul: adjustedMulOf(gates),
      expiresAt: intent.ts + intent.ttlMs + i * 30_000,
      decidedBy: i === 2 ? "owner" : rejected ? "gates" : null,
      decidedAt: i === 2 || rejected ? intent.ts + 20_000 : null,
      execution: null,
      fill: null,
    };
  });
}

export function mockPositions(now: number): PositionView[] {
  const r = rng("pos");
  return [0, 1].map((i): PositionView => {
    const cost = 0.35 - i * 0.07;
    const pnlPct = Math.round((r() - 0.35) * 60 * 10) / 10;
    return {
      mint: MINTS[i + 1]!,
      symbol: SYMBOLS[i + 1]!,
      wallet: "ExAmpLeWa11et11111111111111111111111111111111",
      openedAt: now - (25 + i * 70) * 60_000,
      costSol: cost,
      qty: 1_250_000 + i * 400_000,
      priceUsd: 0.00003,
      valueSol: Math.round(cost * (1 + pnlPct / 100) * 1000) / 1000,
      pnlSol: Math.round(cost * (pnlPct / 100) * 1000) / 1000,
      pnlPct,
      trailStopPct: 22,
      status: "open",
    };
  });
}

export function mockState(now: number): ApiState {
  const positions = mockPositions(now);
  const pnl = positions.reduce((a, p) => a + (p.pnlSol ?? 0), 0);
  return {
    version: "example",
    now,
    chain: "solana",
    tier: 1,
    walletCapSol: 15,
    equitySol: 24.3,
    solUsd: 101.2,
    dayPnlSol: Math.round(pnl * 1000) / 1000,
    dayPnlPct: Math.round((pnl / 24.3) * 1000) / 10,
    openPositions: positions.length,
    pendingIntents: mockIntents(now).filter((i) => i.status === "proposed").length,
    modes: { shadow: 1, suggest: 2, auto: 0 },
    regime: {
      at: now - 30_000,
      solChange1hPct: -1.2,
      breadth5m: 0.52,
      launchesPerHour: 140,
      migrationsPerHour: 9,
      safetyRejectRate1h: 0.61,
      sizeMul: 1,
      reason: "SOL −1.2% 1h, breadth 52%, launches normal",
    },
    halts: [],
    health: {
      ok: true,
      selfHalt: false,
      reasons: [],
      sourceAges: { "pump.fun": 2.1, rpc: 0.8, dexscreener: 6.4 },
      slotLag: 2,
      dbOk: true,
    },
    vault: "sealed",
    example: true,
  };
}

export function mockCandles(mint: string, now: number, bucketSec: number, n: number): Candle[] {
  const r = rng(`c:${mint}`);
  let price = 0.00002 + r() * 0.0001;
  const out: Candle[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const t = now - i * bucketSec * 1000;
    const o = price;
    const drift = (r() - 0.48) * 0.06;
    const c = o * (1 + drift);
    const h = Math.max(o, c) * (1 + r() * 0.02);
    const l = Math.min(o, c) * (1 - r() * 0.02);
    out.push({ t, o, h, l, c, v: Math.round(r() * 3000), samples: 6 });
    price = c;
  }
  return out;
}

export function mockToken(mint: string, now: number): TokenView {
  const idx = Math.max(0, MINTS.indexOf(mint));
  const f = features(mint, now);
  const r = rng(`h:${mint}`);
  const classes = [
    "organic",
    "sniper-bot",
    "early-consistent",
    "organic",
    "dev-adjacent",
    "organic",
    "unknown",
    "organic",
  ] as const;
  return {
    mint,
    symbol: SYMBOLS[idx] ?? "EX",
    name: `Example token ${idx + 1}`,
    stage: f.stage,
    createdAt: now - f.ageSec * 1000,
    latest: {
      ts: now,
      mint,
      price: f.priceUsd,
      mc: f.mcUsd,
      liq: f.liqUsd,
      vol5m: f.vol5m,
      vol24: null,
      tx24: null,
      buys5m: f.buys5m,
      sells5m: f.sells5m,
      holders: f.holders,
      top10: f.top10Pct,
      source: "example",
      statsAt: now,
    },
    audit: {
      mint,
      at: now - 60_000,
      authorities: f.authorities,
      extensions: f.extensions,
      decimals: 6,
      supply: 1e9,
      lp: f.lp,
    },
    supply: f.supply,
    micro: f.micro,
    holders: classes.map((cls, i) => ({
      wallet: `ExAmpLeHo1der${i}11111111111111111111111111111`,
      pct: Math.round((8 - i) * (0.6 + r() * 0.5) * 10) / 10,
      class: cls,
      confidence: Math.round((0.6 + r() * 0.4) * 100) / 100,
    })),
    candles: mockCandles(mint, now, 60, 180),
    candleBucketSec: 60,
    intents: mockIntents(now).filter((v) => v.intent.mint === mint),
    example: true,
  };
}

export function mockFunnel(now: number): FunnelView {
  return {
    sinceMs: now - 24 * 3600_000,
    layers: [
      { layer: "activity", entered: 3120, passed: 3120 },
      { layer: "sieve", entered: 3120, passed: 412 },
      { layer: "regime", entered: 412, passed: 412 },
      { layer: "decision", entered: 412, passed: 57 },
      { layer: "gates", entered: 57, passed: 11 },
      { layer: "execution", entered: 8, passed: 8 },
    ],
    rejections: [
      { gate: "safety", reason: "SAFETY_LP", n: 14 },
      { gate: "supply", reason: "SUPPLY_SNIPERS", n: 9 },
      { gate: "supply", reason: "SUPPLY_DEV", n: 7 },
      { gate: "liquidity", reason: "LIQ_EXIT", n: 6 },
      { gate: "manipulation", reason: "MANIP_WASH", n: 5 },
      { gate: "quote", reason: "QUOTE_IMPACT", n: 3 },
      { gate: "risk", reason: "RISK_YOUNG", n: 2 },
    ],
    adjustments: [
      { gate: "supply", n: 12 },
      { gate: "liquidity", n: 7 },
      { gate: "manipulation", n: 4 },
    ],
    example: true,
  };
}

export function mockRules(now: number): RuleView[] {
  return [
    {
      id: "confirmed-entry.v1",
      strategy: "confirmed-entry",
      mode: "suggest",
      weight: 1,
      stats: {
        windowDays: 14,
        n: 23,
        winRate: 0.48,
        expectancy: 0.06,
        worstDd: -0.11,
        changedAt: now - 86_400_000,
        changeReason: "daily evaluation: expectancy +0.06, weight unchanged",
      },
      eligibleForAuto: true,
    },
    {
      id: "migration-snipe.v1",
      strategy: "migration-snipe",
      mode: "suggest",
      weight: 0.5,
      stats: {
        windowDays: 14,
        n: 7,
        winRate: 0.29,
        expectancy: -0.02,
        worstDd: -0.18,
        changedAt: now - 86_400_000,
        changeReason: "n < 20, no change",
      },
      eligibleForAuto: false,
    },
    {
      id: "exit-policy.v1",
      strategy: "exit-policy",
      mode: "auto",
      weight: 1,
      stats: null,
      eligibleForAuto: true,
    },
  ];
}

export function mockReplays(now: number): ReplayRunView[] {
  return [
    {
      id: "replay-ex-1",
      rulesVersion: "rules@a1b2c3",
      windowStart: now - 30 * 86_400_000,
      windowEnd: now - 86_400_000,
      startedAt: now - 3600_000,
      finishedAt: now - 3500_000,
      summary: { intents: 188, executed: 41, expectancy: 0.05, winRate: 0.46, worstDd: -0.14 },
    },
  ];
}
