import { clusterOf, type Cluster } from "./cluster";
import { fraudOf, fraudSkip } from "./fraud";
import type { Token } from "./market";
import { isRug } from "./market";
import { riskGrade, tokenQuality, type RiskGrade } from "./risk";

export type SieveOp = ">=" | "<=" | ">" | "<" | "=" | "!=";

export type SieveField =
  | "liq"
  | "mc"
  | "vol"
  | "vol5m"
  | "holders"
  | "tx"
  | "age"
  | "bond"
  | "top10"
  | "chg5m"
  | "chg1h"
  | "grade"
  | "freeze"
  | "mint"
  | "x"
  | "fraud"
  | "topic";

/** Fields that are only known once a source reported them. A rule on them fails when unknown. */
export const CHAIN_FIELDS: SieveField[] = ["vol", "vol5m", "holders", "tx", "top10", "chg1h"];

export type SieveRule = { field: SieveField; op: SieveOp; value: number | string };

export type FilterSlice = {
  hideRugs: boolean;
  guardMint: boolean;
  minLiq: number;
  minMc: number;
  maxMc: number;
  minHolders: number;
  maxAgeMin: number;
  keywords: string;
  exclude: string;
  hasX: boolean;
  skipFraud: boolean;
  minGrade: string;
  sieve: string;
};

export type SieveSpec = {
  rules: SieveRule[];
  include: string[];
  exclude: string[];
  slice: FilterSlice;
};

const FIELDS: Record<string, SieveField> = {
  liq: "liq",
  liquidity: "liq",
  mc: "mc",
  mcap: "mc",
  vol: "vol",
  vol24: "vol",
  vol5m: "vol5m",
  holders: "holders",
  h: "holders",
  tx: "tx",
  age: "age",
  min: "age",
  bond: "bond",
  bonding: "bond",
  top10: "top10",
  top: "top10",
  chg5m: "chg5m",
  chg: "chg5m",
  chg1h: "chg1h",
  grade: "grade",
  freeze: "freeze",
  mint: "mint",
  x: "x",
  twitter: "x",
  fraud: "fraud",
  topic: "topic",
  cluster: "topic",
};

const GRADE_N: Record<string, number> = { A: 4, B: 3, C: 2, D: 1, F: 0 };
const OP_RE = /^(>=|<=|!=|>|<|=)/;
const UNIT: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

export function parseNum(raw: string): number {
  const m = String(raw)
    .trim()
    .toLowerCase()
    .match(/^(-?\d+(?:\.\d+)?)([kmb])?$/);
  if (!m) return NaN;
  const n = Number(m[1]);
  return n * (m[2] ? UNIT[m[2]] : 1);
}

function parseBool(raw: string): number {
  const s = String(raw).trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes" || s === "on") return 1;
  if (s === "0" || s === "false" || s === "no" || s === "off") return 0;
  return NaN;
}

export function parseSieve(raw: string): { rules: SieveRule[]; include: string[]; exclude: string[] } {
  const rules: SieveRule[] = [];
  const include: string[] = [];
  const exclude: string[] = [];
  const parts = String(raw ?? "")
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  for (const part of parts) {
    if (part.startsWith("-") && part.length > 1 && !OP_RE.test(part.slice(1))) {
      exclude.push(part.slice(1).toLowerCase());
      continue;
    }
    const m = part.match(/^([a-z0-9]+)(>=|<=|!=|>|<|=)(.+)$/i);
    if (m) {
      const field = FIELDS[m[1].toLowerCase()];
      if (field) {
        const op = m[2] as SieveOp;
        if (field === "topic") {
          rules.push({ field, op: op === "!=" ? "!=" : "=", value: m[3].toLowerCase() });
          continue;
        }
        if (field === "grade") {
          const g = m[3].trim().toUpperCase();
          if (g in GRADE_N) rules.push({ field, op, value: GRADE_N[g]! });
          continue;
        }
        if (field === "freeze" || field === "mint" || field === "x" || field === "fraud") {
          const b = parseBool(m[3]);
          if (Number.isFinite(b)) rules.push({ field, op: "=", value: b });
          continue;
        }
        const n = parseNum(m[3]);
        if (Number.isFinite(n)) rules.push({ field, op, value: n });
        continue;
      }
    }
    include.push(part.toLowerCase());
  }
  return { rules, include, exclude };
}

function cmp(left: number, op: SieveOp, right: number): boolean {
  if (op === ">=") return left >= right;
  if (op === "<=") return left <= right;
  if (op === ">") return left > right;
  if (op === "<") return left < right;
  if (op === "!=") return left !== right;
  return left === right;
}

function splitTerms(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

function gradeN(tk: Token): number {
  return GRADE_N[riskGrade(tokenQuality(tk.security, tk.liq))] ?? 0;
}

function flagN(on: boolean): number {
  return on ? 1 : 0;
}

/** `null` means the source never reported the field. */
function readField(tk: Token, field: SieveField, now: number): number | string | null {
  if (field === "liq") return tk.liq;
  if (field === "mc") return tk.mc;
  if (field === "vol") return tk.vol;
  if (field === "vol5m") return tk.vol5m;
  if (field === "holders") return tk.holders;
  if (field === "tx") return tk.tx;
  if (field === "age") return Math.max(0, (now - tk.createdAt) / 60_000);
  if (field === "bond") return tk.bonding;
  if (field === "top10") return tk.security.top10;
  if (field === "chg5m") return tk.change5m;
  if (field === "chg1h") return tk.change1h;
  if (field === "grade") return gradeN(tk);
  if (field === "freeze") return tk.security.onchain ? flagN(tk.security.freeze) : null;
  if (field === "mint") return tk.security.onchain ? flagN(tk.security.mintable) : null;
  if (field === "x") return flagN(!!tk.twitter);
  if (field === "fraud") return flagN(fraudSkip(fraudOf(tk)));
  return clusterOf(tk.symbol, tk.name);
}

export function compileSieve(slice: FilterSlice, query?: string): SieveSpec {
  const parsed = parseSieve(slice.sieve);
  const q = (query ?? "").trim().toLowerCase();
  return {
    rules: parsed.rules,
    include: [...parsed.include, ...splitTerms(slice.keywords), ...(q ? [q] : [])],
    exclude: [...parsed.exclude, ...splitTerms(slice.exclude)],
    slice,
  };
}

export function hitSieve(tk: Token, spec: SieveSpec, now = Date.now()): boolean {
  const s = spec.slice;
  if (s.hideRugs && isRug(tk.security)) return false;
  if (s.guardMint && tk.security.onchain) {
    if (tk.security.freeze) return false;
    if (tk.stage === "migrated" && tk.security.mintable) return false;
  }
  if (s.minLiq > 0 && tk.liq < s.minLiq) return false;
  if (s.minMc > 0 && tk.mc < s.minMc) return false;
  if (s.maxMc > 0 && tk.mc > s.maxMc) return false;
  if (s.minHolders > 0 && (tk.holders == null || tk.holders < s.minHolders)) return false;
  if (s.maxAgeMin > 0 && now - tk.createdAt > s.maxAgeMin * 60_000) return false;
  if (s.hasX && !tk.twitter) return false;
  if (s.skipFraud && fraudSkip(fraudOf(tk))) return false;
  const floor = GRADE_N[s.minGrade.trim().toUpperCase()];
  if (floor != null && gradeN(tk) < floor) return false;
  for (const rule of spec.rules) {
    const left = readField(tk, rule.field, now);
    if (left == null) return false;
    if (typeof left === "string") {
      const right = String(rule.value);
      const ok = rule.op === "!=" ? left !== right : left === right;
      if (!ok) return false;
      continue;
    }
    if (!cmp(left, rule.op, Number(rule.value))) return false;
  }
  const hay = `${tk.symbol} ${tk.name} ${tk.mint} ${tk.twitter ?? ""}`.toLowerCase();
  if (spec.include.length && !spec.include.some((w) => hay.includes(w))) return false;
  if (spec.exclude.some((w) => hay.includes(w))) return false;
  return true;
}

export function tokenPasses(tk: Token, settings: FilterSlice, query?: string, now = Date.now()): boolean {
  return hitSieve(tk, compileSieve(settings, query), now);
}

export function filteredTokens(state: {
  tokens: Token[];
  settings: FilterSlice;
  query?: string;
  now?: number;
}): Token[] {
  const now = state.now ?? Date.now();
  const spec = compileSieve(state.settings, state.query);
  const seen = new Set<string>();
  const out: Token[] = [];
  for (const tk of state.tokens) {
    if (!hitSieve(tk, spec, now)) continue;
    const k = tk.mint || tk.id;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(tk);
  }
  return out;
}

export function activeFilterCount(settings: FilterSlice): number {
  let n = 0;
  if (settings.minLiq > 0) n += 1;
  if (settings.minMc > 0) n += 1;
  if (settings.maxMc > 0) n += 1;
  if (settings.minHolders > 0) n += 1;
  if (settings.maxAgeMin > 0) n += 1;
  if (settings.keywords.trim()) n += 1;
  if (settings.exclude.trim()) n += 1;
  if (settings.hasX) n += 1;
  if (settings.skipFraud) n += 1;
  if (settings.minGrade.trim()) n += 1;
  if (settings.sieve.trim()) n += 1;
  return n;
}

export const FILTER_PRESETS = {
  off: {
    minLiq: 0,
    minMc: 0,
    maxMc: 0,
    minHolders: 0,
    maxAgeMin: 0,
    keywords: "",
    exclude: "",
    hasX: false,
    skipFraud: false,
    minGrade: "",
    sieve: "",
  },
  clean: {
    minLiq: 2500,
    minMc: 0,
    maxMc: 0,
    minHolders: 0,
    maxAgeMin: 240,
    keywords: "",
    exclude: "",
    hasX: false,
    skipFraud: true,
    minGrade: "C",
    sieve: "freeze=0",
  },
  tight: {
    minLiq: 4000,
    minMc: 8000,
    maxMc: 400000,
    minHolders: 0,
    maxAgeMin: 90,
    keywords: "",
    exclude: "",
    hasX: true,
    skipFraud: true,
    minGrade: "B",
    sieve: "freeze=0 mint=0",
  },
  snipe: {
    minLiq: 600,
    minMc: 0,
    maxMc: 120000,
    minHolders: 0,
    maxAgeMin: 18,
    keywords: "",
    exclude: "",
    hasX: false,
    skipFraud: true,
    minGrade: "C",
    sieve: "freeze=0 age<=18 bond>=8",
  },
} as const;

export type FilterPreset = keyof typeof FILTER_PRESETS;

const CLUSTERS: Cluster[] = ["dog", "cat", "frog", "ai", "tick", "politic", "cult", "other"];

export function sieveTopics(): Cluster[] {
  return CLUSTERS;
}

export type { RiskGrade };
