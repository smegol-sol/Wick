/**
 * The gates (ENGINE §4), in their fixed order, as one pure function over a
 * features row and what the engine knows about its own book. The first
 * rejection ends the run; every gate before it is recorded with its timing,
 * and every adjustment shrinks the running size for the gates after it.
 *
 * Only the six decision-time gates run here. The seventh, `execution`, is
 * the executor's: its three codes come from simulating, sending and
 * confirming, none of which a pure function can do.
 *
 * `*_UNKNOWN` and the "null in auto" rows fire only in auto mode; in shadow
 * and suggest an unknown input passes and the human sees the gap. The rules
 * themselves (decide.ts) still refuse a candidate whose safety inputs are
 * missing, so an unknown reaches a gate only from a rule that accepts it.
 *
 * The supply map the engine has today is the launch-time map (who bought in
 * the create slot and the next ten), stamped with the launch time. In auto
 * mode the "older than 5 min" row therefore rejects every candidate with
 * SUPPLY_UNKNOWN until a live holder refresh exists; that is the intended
 * safe default, not a bug.
 */
import type { Features, Gate, GateResult, Mode, ReasonCode } from "./contracts.ts";

/** Tier limits the gates read; all from risk.yaml, never from code. */
export type GateLimits = {
  minTradeSol: number;
  quoteMaxAgeMs: number;
  maxImpactEntryPct: number;
  maxImpactExitPct: number;
  maxOpenPositions: number;
  /** equity × maxTokenExposurePct, in SOL. */
  tokenCapSol: number;
  youngTokenExposurePct: number;
  feeReserveSol: number;
  dailyHaltPct: number;
  weeklyHaltPct: number;
  postLossDayMul: number;
};

/** What the engine knows about its own book at decision time. */
export type GateBook = {
  /** A manual halt, a P&L halt or the engine's health self-halt is active. */
  halted: boolean;
  haltReason: string | null;
  dayPnlPct: number | null;
  weekPnlPct: number | null;
  openPositions: number;
  /** SOL already deployed in this mint. */
  openExposureSol: number;
  /** SOL deployed in tokens younger than 90 minutes, this mint included. */
  youngExposureSol: number;
  /** Capital the engine works with (the execution wallet's equity). */
  equitySol: number;
  /** SOL in every open position. */
  deployedSol: number;
  /** Free SOL in the execution wallet; null until the executor reads balances. */
  cashSol: number | null;
  /** Open positions from this token's narrative cluster (phase 4 data; 0 until then). */
  clusterOpen: number;
  lostYesterday: boolean;
};

export type GateQuote = { ageMs: number; impactPct: number | null };

export type GateInput = {
  features: Features;
  mode: Mode;
  side: "buy" | "sell";
  /** The bounded size (sizing.ts) before any gate adjustment. */
  sizeSol: number;
  solUsd: number | null;
  /** `undefined` when no quote was fetched (shadow mode); `null` when the fetch failed. */
  quote: GateQuote | null | undefined;
  book: GateBook;
  limits: GateLimits;
  now: number;
  /** Run only these gates, in the fixed order; the loop runs the cheap four before it pays for a quote, and only `quote` for an exit. */
  only?: Gate[];
};

export type GateRun = {
  results: GateResult[];
  /** Product of every adjustment applied. */
  sizeMul: number;
  /** Size after the adjustments; 0 when rejected. */
  sizeSol: number;
  rejected: GateResult | null;
};

const YOUNG_SEC = 90 * 60;
const LP_PULL_WINDOW_MS = 10 * 60_000;
const LP_PULL_PCT = 20;
const SUPPLY_MAX_AGE_MS = 5 * 60_000;

type Verdict = { reject: ReasonCode } | { adjust: { sizeMul: number; reason: string }[] };

type Ctx = GateInput & { sizeSol: number };

function safety(c: Ctx): Verdict {
  const f = c.features;
  const auto = c.mode === "auto";
  if (f.authorities) {
    if (f.authorities.freeze) return { reject: "SAFETY_FREEZE" };
    if (f.authorities.mint && f.stage === "migrated") return { reject: "SAFETY_MINT" };
  } else if (auto) return { reject: "SAFETY_UNKNOWN" };
  const x = f.extensions;
  if (x) {
    if (x.hook || x.permanentDelegate || x.defaultFrozen || x.transferFeeBps > 0)
      return { reject: "SAFETY_EXT" };
  } else if (auto) return { reject: "SAFETY_UNKNOWN" };
  if (f.lp === "deployer") return { reject: "SAFETY_LP" };
  if (f.lp == null && f.stage === "migrated" && auto) return { reject: "SAFETY_UNKNOWN" };
  return { adjust: [] };
}

function supply(c: Ctx): Verdict {
  const s = c.features.supply;
  const auto = c.mode === "auto";
  if (!s) return auto ? { reject: "SUPPLY_UNKNOWN" } : { adjust: [] };
  if (auto && c.now - s.at > SUPPLY_MAX_AGE_MS) return { reject: "SUPPLY_UNKNOWN" };
  if (s.devPct != null && s.devPct > 10) return { reject: "SUPPLY_DEV" };
  if (s.bundlePct != null && s.bundlePct > 20) return { reject: "SUPPLY_BUNDLE" };
  if (s.sniperPct != null && s.sniperPct > 25) return { reject: "SUPPLY_SNIPERS" };
  const adjust: { sizeMul: number; reason: string }[] = [];
  if (s.devPct != null && s.devPct >= 5)
    adjust.push({ sizeMul: 0.5, reason: `dev holds ${s.devPct.toFixed(1)}%` });
  if (s.sniperPct != null && s.sniperPct >= 15)
    adjust.push({ sizeMul: 0.5, reason: `snipers hold ${s.sniperPct.toFixed(1)}%` });
  if (s.freshWalletPct != null && s.freshWalletPct > 40)
    adjust.push({ sizeMul: 0.5, reason: `fresh wallets hold ${s.freshWalletPct.toFixed(1)}%` });
  if (s.earlyHoldersTrend === "accumulating")
    adjust.push({ sizeMul: 0.5, reason: "early holders accumulating" });
  return { adjust };
}

/** Constant-product estimate: `depth` moves price 2%, so `size` moves it about 2 × size / depth. */
export function exitImpactPct(sizeUsd: number, depthSell2PctUsd: number): number {
  return depthSell2PctUsd > 0 ? (2 * sizeUsd) / depthSell2PctUsd : Infinity;
}

function liquidity(c: Ctx): Verdict {
  const f = c.features;
  if (c.sizeSol < c.limits.minTradeSol) return { reject: "LIQ_DEPTH" };
  const depthSell = f.micro?.depthSell2PctUsd ?? null;
  if (depthSell != null && c.solUsd != null) {
    if (exitImpactPct(c.sizeSol * c.solUsd, depthSell) > c.limits.maxImpactExitPct)
      return { reject: "LIQ_EXIT" };
  }
  const ev = f.lastLpEvent;
  if (ev && ev.kind === "remove" && ev.pct >= LP_PULL_PCT && c.now - ev.ts <= LP_PULL_WINDOW_MS)
    return { reject: "LIQ_PULL" };
  const adjust: { sizeMul: number; reason: string }[] = [];
  const flow = f.micro?.netFlowSol5m ?? null;
  if (flow != null && flow < 0)
    adjust.push({ sizeMul: 0.5, reason: `net flow 5m ${flow.toFixed(2)} SOL` });
  const depthBuy = f.micro?.depthBuy2PctUsd ?? null;
  if (depthSell != null && depthBuy != null && depthSell < depthBuy / 2)
    adjust.push({ sizeMul: 0.5, reason: "sell depth under half of buy depth" });
  return { adjust };
}

function manipulation(c: Ctx): Verdict {
  const f = c.features;
  const auto = c.mode === "auto";
  if (f.washFlags.length) return { reject: "MANIP_WASH" };
  const organic = f.micro?.organicVolPct5m ?? null;
  if (organic != null && organic < 40) return { reject: "MANIP_WASH" };
  if (
    f.uniqueBuyers5m != null &&
    f.uniqueBuyers5m < 15 &&
    f.buys5m != null &&
    f.buys5m >= 2 * Math.max(15, f.uniqueBuyers5m)
  )
    return { reject: "MANIP_WASH" };
  if (f.top10Pct == null) {
    if (auto) return { reject: "MANIP_TOP10" };
  } else if (f.top10Pct > 35) return { reject: "MANIP_TOP10" };
  if (f.fundingFlags.length) return { reject: "MANIP_FUNDING" };
  // MANIP_CIRCULAR and the 30-minute price adjustment need the profiler and a price history (phase 4).
  return { adjust: [] };
}

function quote(c: Ctx): Verdict {
  const q = c.quote;
  const auto = c.mode === "auto";
  if (q === undefined) return auto ? { reject: "QUOTE_STALE" } : { adjust: [] };
  if (q === null) return c.mode === "shadow" ? { adjust: [] } : { reject: "QUOTE_STALE" };
  if (q.ageMs > c.limits.quoteMaxAgeMs) return { reject: "QUOTE_STALE" };
  const max = c.side === "buy" ? c.limits.maxImpactEntryPct : c.limits.maxImpactExitPct;
  if (q.impactPct == null) return auto ? { reject: "QUOTE_IMPACT" } : { adjust: [] };
  if (q.impactPct > max) return { reject: "QUOTE_IMPACT" };
  return { adjust: [] };
}

function risk(c: Ctx): Verdict {
  const b = c.book;
  const l = c.limits;
  if (c.side === "sell") return { adjust: [] }; // an exit is never blocked by the book
  if (b.halted) return { reject: "RISK_HALT" };
  if (b.dayPnlPct != null && b.dayPnlPct <= l.dailyHaltPct) return { reject: "RISK_HALT" };
  if (b.weekPnlPct != null && b.weekPnlPct <= l.weeklyHaltPct) return { reject: "RISK_HALT" };
  if (b.openPositions >= l.maxOpenPositions) return { reject: "RISK_SLOTS" };
  if (b.openExposureSol + c.sizeSol > l.tokenCapSol + 1e-9) return { reject: "RISK_TOKEN_CAP" };
  if (b.clusterOpen >= 2) return { reject: "RISK_CLUSTER" };
  if (c.features.ageSec < YOUNG_SEC) {
    const youngAfter = b.youngExposureSol + c.sizeSol;
    if (youngAfter > (b.equitySol * l.youngTokenExposurePct) / 100 + 1e-9)
      return { reject: "RISK_YOUNG" };
  }
  if (b.cashSol == null) {
    if (c.mode === "auto") return { reject: "RISK_CASH" };
  } else if (b.cashSol - c.sizeSol < l.feeReserveSol) return { reject: "RISK_CASH" };
  const adjust: { sizeMul: number; reason: string }[] = [];
  if (b.lostYesterday) adjust.push({ sizeMul: l.postLossDayMul, reason: "day after a losing day" });
  return { adjust };
}

const ORDER: { gate: Gate; fn: (c: Ctx) => Verdict }[] = [
  { gate: "safety", fn: safety },
  { gate: "supply", fn: supply },
  { gate: "liquidity", fn: liquidity },
  { gate: "manipulation", fn: manipulation },
  { gate: "quote", fn: quote },
  { gate: "risk", fn: risk },
];

function clock(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Run the decision-time gates in order. Pure apart from the clock used for `ms`. */
export function runGates(input: GateInput): GateRun {
  const results: GateResult[] = [];
  const c: Ctx = { ...input, sizeSol: input.sizeSol };
  let sizeMul = 1;
  for (const { gate, fn } of ORDER) {
    if (input.only && !input.only.includes(gate)) continue;
    const t0 = clock();
    const v = fn(c);
    const ms = Math.max(0, clock() - t0);
    if ("reject" in v) {
      const r: GateResult = { gate, passed: false, reasonCode: v.reject, adjustment: null, ms };
      results.push(r);
      return { results, sizeMul, sizeSol: 0, rejected: r };
    }
    let adjustment: GateResult["adjustment"] = null;
    if (v.adjust.length) {
      const mul = v.adjust.reduce((m, a) => m * a.sizeMul, 1);
      adjustment = { sizeMul: mul, reason: v.adjust.map((a) => a.reason).join("; ") };
      sizeMul *= mul;
      c.sizeSol = round(c.sizeSol * mul);
    }
    results.push({ gate, passed: true, reasonCode: null, adjustment, ms });
  }
  return { results, sizeMul, sizeSol: c.sizeSol, rejected: null };
}
