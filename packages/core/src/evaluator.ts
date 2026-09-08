/**
 * Level-2 learning (ADR-0004): outcomes per intent, rule statistics over a
 * window, bounded weight moves, and the disable and auto-eligibility rules.
 * Pure functions; the engine's evaluator job feeds them rows and writes back.
 *
 * The scoring horizon is 30 minutes: an entry's return at 30 minutes is what
 * `expectancy` and `winRate` measure; 5 and 120 minutes are recorded for
 * replay and the later models. A sell intent scores the other way round: the
 * price falling after a sell is the win.
 */

export const SCORING_HORIZON_SEC = 1800 as const;
export const HORIZONS_SEC = [300, 1800, 7200] as const;
export type HorizonSec = (typeof HORIZONS_SEC)[number];

/** ADR-0004 §2 numbers; the evaluator never moves outside them. */
export const WEIGHT_RULES = {
  min: 0.25,
  max: 1.5,
  /** Largest move in one day, as a share of the current weight. */
  stepPct: 10,
  /** Intents in the window before a weight moves or a rule can be disabled. */
  minN: 20,
  /** Consecutive daily evaluations with negative expectancy before a rule is disabled. */
  disableDays: 7,
  windowDays: 14,
} as const;

export type PriceSample = { ts: number; price: number };

export type OutcomeNumbers = { retPct: number; maxRetPct: number; minRetPct: number };

/**
 * Return from the intent's price to the last sample inside the horizon, with the
 * best and worst sample on the way. Null when no sample landed in the window
 * (the token left the sampled set): recorded as an empty outcome, never guessed.
 */
export function outcomeOf(
  entryPrice: number,
  samples: PriceSample[],
  intentTs: number,
  horizonSec: number,
): OutcomeNumbers | null {
  if (!(entryPrice > 0)) return null;
  const end = intentTs + horizonSec * 1000;
  let last: number | null = null;
  let max = -Infinity;
  let min = Infinity;
  for (const s of samples) {
    if (s.ts <= intentTs || s.ts > end || !(s.price > 0)) continue;
    last = s.price;
    if (s.price > max) max = s.price;
    if (s.price < min) min = s.price;
  }
  if (last == null) return null;
  const pct = (p: number) => Math.round((p / entryPrice - 1) * 100 * 1000) / 1000;
  return { retPct: pct(last), maxRetPct: pct(max), minRetPct: pct(min) };
}

export type OutcomeRow = {
  side: "buy" | "sell";
  retPct: number | null;
  minRetPct: number | null;
  maxRetPct: number | null;
};

export type RuleStats = {
  /** Intents with a measured outcome; unmeasured ones are not counted. */
  n: number;
  winRate: number | null;
  /** Mean signed return in percent. */
  expectancy: number | null;
  /** The worst signed excursion inside the horizon across the window. */
  worstDd: number | null;
  /** The distribution, not only the mean (ADR-0004). */
  p25: number | null;
  p50: number | null;
  p75: number | null;
};

/** The signed return: what the rule's side earned. */
export function signedReturn(row: OutcomeRow): number | null {
  if (row.retPct == null) return null;
  return row.side === "sell" ? -row.retPct : row.retPct;
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const v = sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
  return Math.round(v * 1000) / 1000;
}

export function ruleStats(rows: OutcomeRow[]): RuleStats {
  const rets: number[] = [];
  let worst: number | null = null;
  for (const r of rows) {
    const s = signedReturn(r);
    if (s == null) continue;
    rets.push(s);
    const dd = r.side === "sell" ? (r.maxRetPct == null ? null : -r.maxRetPct) : r.minRetPct;
    if (dd != null && (worst == null || dd < worst)) worst = dd;
  }
  const n = rets.length;
  if (n === 0)
    return {
      n: 0,
      winRate: null,
      expectancy: null,
      worstDd: null,
      p25: null,
      p50: null,
      p75: null,
    };
  const sorted = [...rets].sort((a, b) => a - b);
  const wins = rets.filter((r) => r > 0).length;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  return {
    n,
    winRate: Math.round((wins / n) * 10000) / 10000,
    expectancy: Math.round(mean * 1000) / 1000,
    worstDd: worst,
    p25: quantile(sorted, 0.25),
    p50: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
  };
}

export type WeightMove = { weight: number; reason: string };

/**
 * One day's move: up a step on positive expectancy, down a step on negative,
 * nothing under `minN` or at exactly zero; always inside [min, max].
 */
export function nextWeight(current: number, stats: RuleStats, r = WEIGHT_RULES): WeightMove {
  const clamp = (w: number) => Math.round(Math.min(r.max, Math.max(r.min, w)) * 1000) / 1000;
  if (stats.n < r.minN || stats.expectancy == null)
    return { weight: clamp(current), reason: `n ${stats.n} under ${r.minN}; weight held` };
  const step = 1 + r.stepPct / 100;
  if (stats.expectancy > 0) {
    const w = clamp(current * step);
    return {
      weight: w,
      reason: `expectancy +${stats.expectancy}% on ${stats.n}; weight ${current} → ${w}`,
    };
  }
  if (stats.expectancy < 0) {
    const w = clamp(current / step);
    return {
      weight: w,
      reason: `expectancy ${stats.expectancy}% on ${stats.n}; weight ${current} → ${w}`,
    };
  }
  return { weight: clamp(current), reason: `expectancy 0 on ${stats.n}; weight held` };
}

export type DailyPoint = { n: number; expectancy: number | null };

/** Seven consecutive daily evaluations, each with 20+ intents and negative expectancy. */
export function shouldDisable(recentDays: DailyPoint[], r = WEIGHT_RULES): boolean {
  if (recentDays.length < r.disableDays) return false;
  const last = recentDays.slice(-r.disableDays);
  return last.every((d) => d.n >= r.minN && d.expectancy != null && d.expectancy < 0);
}

export type SuggestRecord = {
  /** Intents proposed in suggest mode. */
  suggested: number;
  approved: number;
  /** Approved, rejected or expired: the ones the owner saw and decided (or let expire). */
  decided: number;
  /** Mean signed 30-minute return of the executed suggestions; null when none. */
  executedExpectancy: number | null;
};

/** ADR-0004: 20+ suggestions, 60%+ approved, positive expectancy on the executed ones. */
export function eligibleForAuto(s: SuggestRecord): boolean {
  if (s.suggested < 20 || s.decided === 0) return false;
  if (s.approved / s.decided < 0.6) return false;
  return s.executedExpectancy != null && s.executedExpectancy > 0;
}
