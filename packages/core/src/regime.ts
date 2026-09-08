/**
 * The regime (ENGINE §11): one multiplier for the whole engine from
 * market-wide state out of our own data. It never rejects a token. An input
 * that is unknown does not trigger anything and is named in the reason
 * (ADR-0001: no number without a source).
 */
import type { Regime } from "./contracts.ts";

export type RegimeInputs = {
  at: number;
  /** SOL/USD change over the last hour, in percent; null without an hour of prices. */
  solChange1hPct: number | null;
  /** Share of active tokens whose price is up over 5 minutes, 0..1; null under 10 tokens. */
  breadth5m: number | null;
  launchesPerHour: number | null;
  /** Median hourly launches over 7 days; null under a day of data. */
  launchesMedian7d: number | null;
  migrationsPerHour: number | null;
  /** Share of safety-gate rows rejected in the last hour, 0..1; null under 10 rows. */
  safetyRejectRate1h: number | null;
};

export const REGIME_LIMITS = {
  solHaltPct: -5,
  solHalfPct: -2,
  breadthHalt: 0.3,
  breadthHalf: 0.45,
  safetyRejectHalt: 0.8,
  /** Launches under this share of the 7-day median halve the size. */
  launchesShareHalf: 1 / 3,
} as const;

const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
const share = (v: number) => `${Math.round(v * 100)}%`;

export function regimeOf(i: RegimeInputs, l = REGIME_LIMITS): Regime {
  const halt: string[] = [];
  const half: string[] = [];
  const unknown: string[] = [];
  const parts: string[] = [];

  if (i.solChange1hPct == null) unknown.push("SOL 1h");
  else {
    parts.push(`SOL ${pct(i.solChange1hPct)} 1h`);
    if (i.solChange1hPct <= l.solHaltPct) halt.push(`SOL ${pct(i.solChange1hPct)} in 1h`);
    else if (i.solChange1hPct <= l.solHalfPct) half.push(`SOL ${pct(i.solChange1hPct)} in 1h`);
  }
  if (i.breadth5m == null) unknown.push("breadth");
  else {
    parts.push(`breadth ${share(i.breadth5m)}`);
    if (i.breadth5m < l.breadthHalt) halt.push(`breadth ${share(i.breadth5m)}`);
    else if (i.breadth5m < l.breadthHalf) half.push(`breadth ${share(i.breadth5m)}`);
  }
  if (i.safetyRejectRate1h == null) unknown.push("safety rejects");
  else {
    parts.push(`safety rejects ${share(i.safetyRejectRate1h)}`);
    if (i.safetyRejectRate1h > l.safetyRejectHalt)
      halt.push(`safety rejects ${share(i.safetyRejectRate1h)} in 1h`);
  }
  if (i.launchesPerHour == null) unknown.push("launches");
  else if (i.launchesMedian7d == null)
    parts.push(`launches ${i.launchesPerHour}/h (no 7d median yet)`);
  else {
    parts.push(`launches ${i.launchesPerHour}/h (median ${i.launchesMedian7d})`);
    if (i.launchesMedian7d > 0 && i.launchesPerHour < i.launchesMedian7d * l.launchesShareHalf)
      half.push(
        `launches ${i.launchesPerHour}/h under a third of the 7d median ${i.launchesMedian7d}`,
      );
  }
  if (i.migrationsPerHour != null) parts.push(`migrations ${i.migrationsPerHour}/h`);

  const sizeMul: Regime["sizeMul"] = halt.length ? 0 : half.length ? 0.5 : 1;
  const head =
    sizeMul === 0
      ? `no new entries: ${halt.join("; ")}`
      : sizeMul === 0.5
        ? `half size: ${half.join("; ")}`
        : parts.length
          ? "normal"
          : "normal, nothing measured yet";
  const tail = [parts.join(", "), unknown.length ? `${unknown.join(", ")} unknown` : ""]
    .filter(Boolean)
    .join("; ");
  return {
    at: i.at,
    solChange1hPct: i.solChange1hPct,
    breadth5m: i.breadth5m,
    launchesPerHour: i.launchesPerHour,
    migrationsPerHour: i.migrationsPerHour,
    safetyRejectRate1h: i.safetyRejectRate1h,
    sizeMul,
    reason: tail ? `${head} (${tail})` : head,
  };
}
