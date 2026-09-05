/**
 * The decision layer (ENGINE §3 and §6) as pure functions: a cheap sieve, an
 * entry evaluation per rule, and an exit evaluation per open position. The
 * engine's loop feeds them the features row and writes what comes out; they
 * never touch a socket or a table.
 *
 * A rule refuses a candidate when an input it needs is missing; it never
 * substitutes a default. Two inputs the profiler will supply later are
 * noted instead of refused, so shadow mode can produce intents before the
 * profiler exists: unique buyers (counted per wallet) and organic volume
 * (raw volume is used with a note).
 */
import type { Features, SupplyMap } from "./contracts.ts";
import type { EntryParams, ExitParams, RuleDef } from "./rules.ts";

export type EntryRule = Extract<RuleDef, { params: EntryParams }>;

export type EntryVerdict =
  { ok: true; why: string; weight: number; notes: string[] } | { ok: false; reason: string };

/** The cheap pre-filter (funnel layer "sieve"): any rule's age window and the lowest liquidity floor. */
export function sieve(f: Features, rules: EntryRule[]): boolean {
  if (!rules.length) return false;
  const inWindow = rules.some(
    (r) => f.ageSec >= r.params.ageMinSec && f.ageSec <= r.params.ageMaxSec,
  );
  const minLiq = Math.min(...rules.map((r) => r.params.minLiqUsd));
  return inWindow && f.liqUsd >= minLiq;
}

function pct(n: number): string {
  return `${Math.round(n * 100) / 100}`;
}

export function evaluateEntry(rule: EntryRule, f: Features): EntryVerdict {
  const p = rule.params;
  const notes: string[] = [];
  const why: string[] = [];
  if (rule.strategy === "migration-snipe" && f.stage !== "migrated")
    return { ok: false, reason: "not migrated" };
  if (f.ageSec < p.ageMinSec || f.ageSec > p.ageMaxSec)
    return { ok: false, reason: `age ${f.ageSec}s outside ${p.ageMinSec}–${p.ageMaxSec}s` };
  why.push(`age ${Math.round(f.ageSec / 60)}m`);
  if (f.liqUsd < p.minLiqUsd)
    return { ok: false, reason: `liquidity ${Math.round(f.liqUsd)} USD under ${p.minLiqUsd}` };
  why.push(`liq ${Math.round(f.liqUsd)} USD`);
  if (!f.authorities) return { ok: false, reason: "authorities unknown" };
  if (f.authorities.mint || f.authorities.freeze)
    return { ok: false, reason: "authorities not revoked" };
  if (!f.extensions) return { ok: false, reason: "extensions unknown" };
  const x = f.extensions;
  if (x.hook || x.permanentDelegate || x.defaultFrozen || x.transferFeeBps > 0)
    return { ok: false, reason: "dangerous extension" };
  why.push("authorities revoked");
  if (f.buys5m == null || f.sells5m == null) return { ok: false, reason: "trade counts unknown" };
  const trades = f.buys5m + f.sells5m;
  if (trades < p.minTrades5m)
    return { ok: false, reason: `${trades} trades in 5m, need ${p.minTrades5m}` };
  const ratio = f.sells5m === 0 ? Infinity : f.buys5m / f.sells5m;
  if (ratio < p.minBuySellRatio)
    return { ok: false, reason: `buy/sell ${pct(ratio)} under ${p.minBuySellRatio}` };
  why.push(`buy/sell ${f.buys5m}/${f.sells5m} on ${trades} trades`);
  if (f.vol5m == null) return { ok: false, reason: "5m volume unknown" };
  const organic = f.micro?.organicVolPct5m ?? null;
  const vol = organic == null ? f.vol5m : (f.vol5m * organic) / 100;
  if (organic == null) notes.push("organic volume n/a, raw volume used");
  const volLiq = f.liqUsd > 0 ? vol / f.liqUsd : Infinity;
  if (volLiq < p.volLiqMin || volLiq > p.volLiqMax)
    return { ok: false, reason: `vol/liq ${pct(volLiq)} outside [${p.volLiqMin}, ${p.volLiqMax}]` };
  why.push(`vol/liq ${pct(volLiq)}`);
  if (f.uniqueBuyers5m == null) notes.push("unique buyers n/a");
  else if (f.uniqueBuyers5m < p.minUniqueBuyers)
    return { ok: false, reason: `${f.uniqueBuyers5m} unique buyers, need ${p.minUniqueBuyers}` };
  else why.push(`${f.uniqueBuyers5m} unique buyers`);
  const flow = f.micro?.netFlowSol5m ?? null;
  if (flow == null) return { ok: false, reason: "net flow unknown" };
  if (flow <= p.minNetFlowSol5m)
    return { ok: false, reason: `net flow 5m ${pct(flow)} SOL not above ${p.minNetFlowSol5m}` };
  why.push(`net flow 5m +${pct(flow)} SOL`);
  let weight = rule.weight;
  if (f.followBuys3m > 0) {
    weight *= p.followBoost;
    why.push(`${f.followBuys3m} follow buy${f.followBuys3m > 1 ? "s" : ""} in 3m`);
  }
  return { ok: true, why: why.join(", "), weight, notes };
}

/** What the loop knows about an open position; nulls until the executor records fills. */
export type PositionState = {
  openedAt: number;
  entryPriceUsd: number | null;
  entryLiqUsd: number | null;
  /** Highest price seen since entry (or since the engine started watching). */
  peakPriceUsd: number | null;
  /** Price at the previous sample. */
  lastPriceUsd: number | null;
  /** Take-profit rungs already sold. */
  tpTaken: number;
};

export type ExitVerdict = { reason: string; sellPct: number; kind: "stop" | "take-profit" };

export function evaluateExit(
  p: ExitParams,
  pos: PositionState,
  f: Features,
  now: number,
): ExitVerdict | null {
  const price = f.priceUsd;
  const ev = f.lastLpEvent;
  if (ev && ev.kind === "remove" && now - ev.ts <= 10 * 60_000)
    return { reason: `LP removal ${pct(ev.pct)}%`, sellPct: 100, kind: "stop" };
  if (pos.entryLiqUsd != null && pos.entryLiqUsd > 0) {
    const drop = (1 - f.liqUsd / pos.entryLiqUsd) * 100;
    if (drop >= p.liqDropPct)
      return { reason: `liquidity down ${pct(drop)}% from entry`, sellPct: 100, kind: "stop" };
  }
  if (distributing(f.supply))
    return { reason: "dev cluster distributing", sellPct: 100, kind: "stop" };
  if (pos.lastPriceUsd != null && pos.lastPriceUsd > 0) {
    const drop = (1 - price / pos.lastPriceUsd) * 100;
    if (drop >= p.hardDropPct)
      return { reason: `down ${pct(drop)}% in one poll`, sellPct: 100, kind: "stop" };
  }
  if (pos.peakPriceUsd != null && pos.peakPriceUsd > 0) {
    const off = (1 - price / pos.peakPriceUsd) * 100;
    if (off >= p.trailingStopPct)
      return { reason: `${pct(off)}% off the peak`, sellPct: 100, kind: "stop" };
  }
  if (now - pos.openedAt >= p.timeExitSec * 1000)
    return {
      reason: `held ${Math.round((now - pos.openedAt) / 60_000)}m`,
      sellPct: 100,
      kind: "stop",
    };
  if (pos.entryPriceUsd != null && pos.entryPriceUsd > 0) {
    const gain = (price / pos.entryPriceUsd - 1) * 100;
    const rung = p.takeProfit[pos.tpTaken];
    if (rung && gain >= rung.atPct)
      return {
        reason: `take profit ${pos.tpTaken + 1}: up ${pct(gain)}%`,
        sellPct: rung.sellPct,
        kind: "take-profit",
      };
  }
  return null;
}

function distributing(s: SupplyMap | null): boolean {
  return s?.earlyHoldersTrend === "distributing";
}
