/**
 * Engine health as a gate input (ADR-0009 §1, ENGINE §16). Pure functions
 * over timestamps and readings; the collector feeds them, the HTTP server
 * and the risk gate read them.
 */
import type { SlotReading } from "@wick/core/chain";

export type SourceAges = Record<string, number | null>; // seconds since last usable answer, null = never

export type HealthInputs = {
  now: number;
  lastOk: Record<string, number>; // source -> ms timestamp
  slotLag: number | null;
  decisionP99Ms: number | null;
  budgetBreachSince: number | null; // ms timestamp when p99 first exceeded the budget, null when inside
  dbOk: boolean;
};

export type HealthLimits = {
  maxSlotLag: number;
  maxSourceAgeSec: number;
  decisionBudgetMs: number;
  budgetBreachMinutes: number;
  /** Sources whose staleness halts entries. Others are informational. */
  requiredSources: string[];
};

export type Health = {
  ok: boolean;
  /** True when the engine must not open new positions (RISK_HALT reason "health"). */
  selfHalt: boolean;
  reasons: string[];
  sourceAges: SourceAges;
  slotLag: number | null;
  dbOk: boolean;
};

export function sourceAges(
  now: number,
  lastOk: Record<string, number>,
  sources: string[],
): SourceAges {
  const out: SourceAges = {};
  for (const s of sources) {
    const t = lastOk[s];
    out[s] = t == null ? null : Math.max(0, (now - t) / 1000);
  }
  return out;
}

/** Slot lag = highest slot any endpoint reports minus the primary's slot. */
export function slotLagOf(readings: SlotReading[]): number | null {
  const primary = readings[0]?.slot ?? null;
  if (primary == null) return null;
  let max = primary;
  for (const r of readings) if (r.slot != null && r.slot > max) max = r.slot;
  return max - primary;
}

export function evaluateHealth(input: HealthInputs, limits: HealthLimits): Health {
  const reasons: string[] = [];
  const ages = sourceAges(input.now, input.lastOk, limits.requiredSources);
  for (const s of limits.requiredSources) {
    const age = ages[s];
    if (age == null) reasons.push(`source ${s} never answered`);
    else if (age > limits.maxSourceAgeSec) reasons.push(`source ${s} stale ${age.toFixed(0)}s`);
  }
  if (input.slotLag != null && input.slotLag > limits.maxSlotLag) {
    reasons.push(`slot lag ${input.slotLag}`);
  }
  if (
    input.budgetBreachSince != null &&
    input.now - input.budgetBreachSince >= limits.budgetBreachMinutes * 60_000
  ) {
    reasons.push(
      `decision p99 over ${limits.decisionBudgetMs}ms for ${limits.budgetBreachMinutes}m`,
    );
  }
  if (!input.dbOk) reasons.push("database unreachable");
  return {
    ok: reasons.length === 0,
    selfHalt: reasons.length > 0,
    reasons,
    sourceAges: ages,
    slotLag: input.slotLag,
    dbOk: input.dbOk,
  };
}
