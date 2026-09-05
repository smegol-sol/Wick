/**
 * The rules file (ENGINE §6): every number a rule uses lives here, never in
 * code. `validateRules` takes the parsed YAML object and throws on anything
 * missing or out of range, so a bad file stops the engine at boot rather
 * than producing an intent with a default nobody chose.
 */
import type { Mode, Strategy } from "./contracts.ts";

export type EntryParams = {
  /** Age window for a candidate, seconds. */
  ageMinSec: number;
  ageMaxSec: number;
  minLiqUsd: number;
  /** buys5m / sells5m at least this, on at least `minTrades5m` trades. */
  minBuySellRatio: number;
  minTrades5m: number;
  /** vol5m / liq inside [min, max]; organic volume when known, raw volume with a note until then. */
  volLiqMin: number;
  volLiqMax: number;
  minUniqueBuyers: number;
  /** Net SOL flow over 5 minutes must exceed this (0 means positive). */
  minNetFlowSol5m: number;
  /** Weight multiplier when a followed wallet bought within 3 minutes. */
  followBoost: number;
  /** Rule-level size multiplier (migration-snipe runs at 0.5). */
  sizeMul: number;
};

export type ExitParams = {
  trailingStopPct: number;
  /** A drop of this much between two consecutive samples exits at once. */
  hardDropPct: number;
  timeExitSec: number;
  /** Exit when pool liquidity falls this much from entry. */
  liqDropPct: number;
  /** Ladder: at `atPct` gain sell `sellPct` of the remaining position. Ascending. */
  takeProfit: { atPct: number; sellPct: number }[];
};

export type RuleDef =
  | {
      id: string;
      strategy: "confirmed-entry" | "migration-snipe";
      mode: Mode;
      weight: number;
      params: EntryParams;
    }
  | { id: string; strategy: "exit-policy"; mode: Mode; weight: number; params: ExitParams };

export type RulesFile = {
  version: number;
  /** How long a proposed intent waits for the owner before it expires. */
  intentTtlMs: number;
  /** Minimum gap between two intents for the same mint and rule. */
  intentCooldownMs: number;
  rules: RuleDef[];
};

const MODES: Mode[] = ["shadow", "suggest", "auto"];
/** The strategies the first release runs from the rules file; mirror-follow and smart-copy come later. */
export type RuleStrategy = Extract<Strategy, "confirmed-entry" | "migration-snipe" | "exit-policy">;
const STRATEGIES: RuleStrategy[] = ["confirmed-entry", "migration-snipe", "exit-policy"];

function num(obj: Record<string, unknown>, key: string, where: string, min = -Infinity): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < min)
    throw new Error(
      `rules.yaml: ${where}.${key} must be a number${min > -Infinity ? ` ≥ ${min}` : ""}`,
    );
  return v;
}

function entryParams(raw: unknown, where: string): EntryParams {
  const p = (raw ?? {}) as Record<string, unknown>;
  const out: EntryParams = {
    ageMinSec: num(p, "ageMinSec", where, 0),
    ageMaxSec: num(p, "ageMaxSec", where, 0),
    minLiqUsd: num(p, "minLiqUsd", where, 0),
    minBuySellRatio: num(p, "minBuySellRatio", where, 0),
    minTrades5m: num(p, "minTrades5m", where, 0),
    volLiqMin: num(p, "volLiqMin", where, 0),
    volLiqMax: num(p, "volLiqMax", where, 0),
    minUniqueBuyers: num(p, "minUniqueBuyers", where, 0),
    minNetFlowSol5m: num(p, "minNetFlowSol5m", where),
    followBoost: num(p, "followBoost", where, 1),
    sizeMul: num(p, "sizeMul", where, 0),
  };
  if (out.ageMaxSec <= out.ageMinSec)
    throw new Error(`rules.yaml: ${where}: ageMaxSec must exceed ageMinSec`);
  if (out.volLiqMax <= out.volLiqMin)
    throw new Error(`rules.yaml: ${where}: volLiqMax must exceed volLiqMin`);
  if (out.sizeMul > 1) throw new Error(`rules.yaml: ${where}: sizeMul cannot exceed 1`);
  return out;
}

function exitParams(raw: unknown, where: string): ExitParams {
  const p = (raw ?? {}) as Record<string, unknown>;
  const tp = Array.isArray(p.takeProfit) ? p.takeProfit : null;
  if (!tp) throw new Error(`rules.yaml: ${where}.takeProfit must be a list`);
  const takeProfit = tp.map((row, i) => {
    const r = (row ?? {}) as Record<string, unknown>;
    return {
      atPct: num(r, "atPct", `${where}.takeProfit[${i}]`, 0),
      sellPct: num(r, "sellPct", `${where}.takeProfit[${i}]`, 0),
    };
  });
  for (let i = 1; i < takeProfit.length; i++)
    if (takeProfit[i]!.atPct <= takeProfit[i - 1]!.atPct)
      throw new Error(`rules.yaml: ${where}.takeProfit must ascend`);
  if (takeProfit.some((t) => t.sellPct > 100))
    throw new Error(`rules.yaml: ${where}.takeProfit sellPct over 100`);
  return {
    trailingStopPct: num(p, "trailingStopPct", where, 0),
    hardDropPct: num(p, "hardDropPct", where, 0),
    timeExitSec: num(p, "timeExitSec", where, 0),
    liqDropPct: num(p, "liqDropPct", where, 0),
    takeProfit,
  };
}

/** Pure; throws with the offending path. */
export function validateRules(raw: unknown): RulesFile {
  const r = (raw ?? {}) as Record<string, unknown>;
  const version = num(r, "version", "top", 1);
  const intentTtlMs = num(r, "intentTtlMs", "top", 1000);
  const intentCooldownMs = num(r, "intentCooldownMs", "top", 0);
  const list = r.rules;
  if (!list || typeof list !== "object")
    throw new Error("rules.yaml: rules must be a map of id to rule");
  const rules: RuleDef[] = [];
  const ids = new Set<string>();
  for (const [id, body] of Object.entries(list as Record<string, unknown>)) {
    if (!/^[a-z0-9-]{2,40}$/.test(id))
      throw new Error(`rules.yaml: rule id ${id} must be kebab-case`);
    if (ids.has(id)) throw new Error(`rules.yaml: duplicate rule ${id}`);
    ids.add(id);
    const b = (body ?? {}) as Record<string, unknown>;
    const strategy = b.strategy as RuleStrategy;
    if (!STRATEGIES.includes(strategy))
      throw new Error(`rules.yaml: ${id}.strategy must be one of ${STRATEGIES.join(", ")}`);
    const mode = b.mode as Mode;
    if (!MODES.includes(mode))
      throw new Error(`rules.yaml: ${id}.mode must be shadow, suggest or auto`);
    const weight = num(b, "weight", id, 0);
    if (strategy === "exit-policy")
      rules.push({ id, strategy, mode, weight, params: exitParams(b.params, id) });
    else rules.push({ id, strategy, mode, weight, params: entryParams(b.params, id) });
  }
  if (!rules.length) throw new Error("rules.yaml: no rules");
  return { version, intentTtlMs, intentCooldownMs, rules };
}

export function entryRules(file: RulesFile): Extract<RuleDef, { params: EntryParams }>[] {
  return file.rules.filter(
    (r): r is Extract<RuleDef, { params: EntryParams }> => r.strategy !== "exit-policy",
  );
}

export function exitRule(file: RulesFile): Extract<RuleDef, { params: ExitParams }> | null {
  return (
    file.rules.find(
      (r): r is Extract<RuleDef, { params: ExitParams }> => r.strategy === "exit-policy",
    ) ?? null
  );
}
