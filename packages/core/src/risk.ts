import type { Security, Token } from "./market.ts";

export type RiskWhy = "halt" | "heat" | "slots" | "loss" | "streak" | "token" | "cash" | "cluster";
export type RiskGrade = "A" | "B" | "C" | "D" | "F";

export interface RiskLimits {
  riskOn: boolean;
  maxTradeSol: number;
  maxBookPct: number;
  maxPositions: number;
  maxDayLoss: number;
  streakHalt: number;
  maxCluster: number;
}

export interface RiskBook {
  riskHalt: boolean;
  lossStreak: number;
  dayStart: number;
  sol: number;
  positions: Array<{ tokenId: string; costSol: number; amount: number }>;
  marks: number;
}

export interface RiskToken {
  security: Security;
  liq: number;
}

export interface SizedBuy {
  spend: number;
  why: RiskWhy | null;
  score: number;
  scale: number;
}

export const RISK_PRESETS = {
  off: {
    riskOn: false,
    maxTradeSol: 2,
    maxBookPct: 40,
    maxPositions: 6,
    maxDayLoss: 15,
    streakHalt: 3,
    maxCluster: 0,
  },
  desk: {
    riskOn: true,
    maxTradeSol: 2,
    maxBookPct: 40,
    maxPositions: 6,
    maxDayLoss: 15,
    streakHalt: 3,
    maxCluster: 2,
  },
  tight: {
    riskOn: true,
    maxTradeSol: 1,
    maxBookPct: 25,
    maxPositions: 3,
    maxDayLoss: 8,
    streakHalt: 2,
    maxCluster: 1,
  },
} as const;

export const RISK_DEFAULTS: RiskLimits = { ...RISK_PRESETS.desk };

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

export function openHeat(positions: Array<{ costSol: number }>): number {
  return positions.reduce((acc, p) => acc + p.costSol, 0);
}

export function nextStreak(streak: number, pnl: number): number {
  if (pnl < -1e-9) return streak + 1;
  if (pnl > 1e-9) return 0;
  return streak;
}

export function shouldHalt(limits: RiskLimits, book: RiskBook): "loss" | "streak" | null {
  if (!limits.riskOn) return null;
  const equity = book.sol + book.marks;
  if (limits.maxDayLoss > 0 && book.dayStart > 0 && book.dayStart - equity >= limits.maxDayLoss)
    return "loss";
  if (limits.streakHalt > 0 && book.lossStreak >= limits.streakHalt) return "streak";
  return null;
}

/**
 * 0 = junk, 1 = clean. Liquidity in USD plus on-chain authorities. Unknown
 * facts do not raise the score.
 */
export function tokenQuality(sec: Security, liq = 0): number {
  let q = 0.74;
  if (liq < 500) q *= 0.48;
  else if (liq < 2_500) q *= 0.78;
  else if (liq >= 12_000) q = Math.min(1, q + 0.1);
  if (sec.onchain) {
    if (sec.mintable) q *= 0.62;
    if (sec.freeze) q *= 0.42;
    if (!sec.lpBurned) q *= 0.9;
    if (sec.renounced) q = Math.min(1, q + 0.08);
  }
  if (sec.top10 != null) {
    if (sec.top10 >= 60) q *= 0.55;
    else if (sec.top10 >= 40) q *= 0.8;
  }
  return clamp(q, 0, 1);
}

/** Rank a launch/migrate print. Higher is better. Only reported facts move it. */
export function snipeEdge(tk: Token, now: number): number {
  const ageMin = Math.max(0, (now - tk.createdAt) / 60_000);
  let s = 0;
  if (tk.twitter) s += 2.4;
  if (tk.mentions >= 8) s += 1.3;
  else if (tk.mentions >= 2) s += 0.5;
  if (tk.stage === "migrated") {
    s += 1.1;
    if (ageMin < 180) s += 0.7;
  } else {
    if (ageMin < 0.2) s += 0.35;
    else if (ageMin < 4) s += 2.5;
    else if (ageMin < 12) s += 1.2;
    else if (ageMin > 90) s -= 2.2;
    if (tk.stage === "new" && tk.bonding >= 5 && tk.bonding < 40) s += 1.4;
    if (tk.stage === "bonding") s += tk.bonding >= 88 ? 1.6 : 0.7;
  }
  if (tk.liq < 500) s -= 3.2;
  else if (tk.liq < 2_500) s -= 0.7;
  else if (tk.liq >= 12_000) s += 1.2;
  if (tk.security.onchain) {
    if (tk.security.freeze) s -= 3.4;
    if (tk.security.mintable && tk.stage === "migrated") s -= 1.8;
    if (tk.security.renounced) s += 0.55;
  }
  if (tk.security.top10 != null && tk.security.top10 >= 50) s -= 1.5;
  if (tk.buys5m != null && tk.sells5m != null && tk.buys5m + tk.sells5m >= 10) {
    const ratio = tk.buys5m / (tk.buys5m + tk.sells5m);
    s += (ratio - 0.5) * 2;
  }
  if (tk.stage === "new" && tk.mc > 160_000) s -= 1.6;
  return s;
}

export function riskGrade(score: number): RiskGrade {
  if (score >= 0.8) return "A";
  if (score >= 0.6) return "B";
  if (score >= 0.4) return "C";
  if (score >= 0.25) return "D";
  return "F";
}

/** Equal-weight heat × 1.5, so a name can over-index slightly before the clip. */
export function nameCapSol(limits: RiskLimits, book: RiskBook): number {
  if (!limits.riskOn || limits.maxBookPct <= 0 || !(book.dayStart > 0))
    return Number.POSITIVE_INFINITY;
  const heatCap = book.dayStart * (limits.maxBookPct / 100);
  if (limits.maxPositions > 0) return (heatCap / limits.maxPositions) * 1.5;
  return heatCap * 0.5;
}

/** Soft de-risk before a hard halt. Token score only belongs on auto sizing. */
export function sizingScale(limits: RiskLimits, book: RiskBook, tokenScore = 1): number {
  if (!limits.riskOn || book.riskHalt || shouldHalt(limits, book)) return 0;
  const equity = book.sol + book.marks;
  const dd = Math.max(0, book.dayStart - equity);
  const ddF = limits.maxDayLoss > 0 ? clamp(1 - dd / limits.maxDayLoss, 0.2, 1) : 1;
  let heatF = 1;
  if (limits.maxBookPct > 0 && book.dayStart > 0) {
    const cap = book.dayStart * (limits.maxBookPct / 100);
    const used = openHeat(book.positions);
    heatF = cap > 0 ? clamp(1 - used / cap, 0.15, 1) : 1;
  }
  const stF = limits.streakHalt > 0 ? clamp(1 - book.lossStreak / limits.streakHalt, 0.25, 1) : 1;
  return clamp(tokenScore * ddF * heatF * stF, 0, 1);
}

export function sizeAutoBuy(
  limits: RiskLimits,
  book: RiskBook,
  tokenId: string,
  want: number,
  opts?: { token?: RiskToken | null; auto?: boolean; clusterNames?: number },
): SizedBuy {
  const cash = Math.max(0, book.sol);
  const auto = opts?.auto !== false;
  const score = opts?.token ? tokenQuality(opts.token.security, opts.token.liq) : 1;
  const fail = (why: RiskWhy): SizedBuy => ({ spend: 0, why, score, scale: 0 });

  if (!limits.riskOn) {
    const spend = Math.min(want, cash);
    return { spend, why: spend >= 0.05 ? null : cash < 0.05 ? "cash" : "heat", score, scale: 1 };
  }
  if (book.riskHalt) return fail("halt");
  const halt = shouldHalt(limits, book);
  if (halt) return fail(halt);

  const stacked = book.positions.some((p) => p.tokenId === tokenId);
  if (!stacked && limits.maxPositions > 0 && book.positions.length >= limits.maxPositions) {
    return fail("slots");
  }
  if (auto && !stacked && limits.maxCluster > 0 && (opts?.clusterNames ?? 0) >= limits.maxCluster) {
    return fail("cluster");
  }
  if (opts?.token?.security.onchain && opts.token.security.freeze) return fail("token");
  if (auto && score < 0.25) return fail("token");

  const scale = auto ? sizingScale(limits, book, score) : 1;
  let spend = Math.min(want * (auto ? scale : 1), cash);
  if (limits.maxTradeSol > 0) spend = Math.min(spend, limits.maxTradeSol);

  if (limits.maxBookPct > 0 && book.dayStart > 0) {
    const cap = book.dayStart * (limits.maxBookPct / 100);
    const room = cap - openHeat(book.positions);
    if (room < 0.05) return fail("heat");
    spend = Math.min(spend, room);
  }

  const capName = nameCapSol(limits, book);
  if (Number.isFinite(capName)) {
    const have = book.positions.find((p) => p.tokenId === tokenId)?.costSol ?? 0;
    const room = capName - have;
    if (room < 0.05) return fail("heat");
    spend = Math.min(spend, room);
  }

  if (spend < 0.05) return fail(cash < 0.05 ? "cash" : "heat");
  return { spend, why: null, score, scale };
}
