/**
 * The engine's API contract (ADR-0009 §2, ADR-0010 §4). The engine serves
 * these shapes and the console consumes them; neither side has a private
 * copy. `null` still means "nobody reported it".
 */
import type {
  Audit,
  EngineChain,
  Execution,
  Fill,
  GateResult,
  Intent,
  Microstructure,
  Mode,
  Regime,
  Snapshot,
  Stage,
  Strategy,
  SupplyMap,
  WalletClass,
} from "./contracts.ts";

export const API_ROUTES = {
  state: "/api/state",
  intents: "/api/intents",
  intent: (id: string) => `/api/intents/${encodeURIComponent(id)}`,
  approve: (id: string) => `/api/intents/${encodeURIComponent(id)}/approve`,
  reject: (id: string) => `/api/intents/${encodeURIComponent(id)}/reject`,
  positions: "/api/positions",
  token: (mint: string) => `/api/tokens/${encodeURIComponent(mint)}`,
  funnel: "/api/funnel",
  rules: "/api/rules",
  replays: "/api/replays",
  halt: "/api/halt",
  haltClear: "/api/halt/clear",
  unseal: "/api/vault/unseal",
  ws: "/ws",
} as const;

export type HealthView = {
  ok: boolean;
  selfHalt: boolean;
  reasons: string[];
  sourceAges: Record<string, number | null>;
  slotLag: number | null;
  dbOk: boolean;
};

export type HaltView = {
  ts: number;
  kind: string;
  reason: string;
  clearedAt: number | null;
};

export type VaultState = "none" | "sealed" | "unsealed";

/** Everything the status strip needs, in one object. */
export type ApiState = {
  version: string;
  now: number;
  chain: EngineChain;
  tier: 1 | 2 | 3;
  walletCapSol: number;
  equitySol: number | null;
  solUsd: number | null;
  dayPnlSol: number | null;
  dayPnlPct: number | null;
  openPositions: number;
  pendingIntents: number;
  modes: Record<Mode, number>;
  regime: Regime | null;
  halts: HaltView[];
  health: HealthView;
  vault: VaultState;
  /** True when every number on this object is generated example data. */
  example?: boolean;
};

export type IntentStatus =
  "proposed" | "approved" | "rejected" | "expired" | "executed" | "failed" | "shadow";

export type IntentView = {
  intent: Intent;
  symbol: string;
  status: IntentStatus;
  gates: GateResult[];
  /** Product of gate adjustments, 1 when none. */
  adjustedMul: number;
  expiresAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  execution: Execution | null;
  fill: Fill | null;
};

export type IntentDecision = { decidedBy: string; note?: string };

export type PositionView = {
  mint: string;
  symbol: string;
  wallet: string;
  openedAt: number;
  costSol: number;
  qty: number;
  priceUsd: number | null;
  valueSol: number | null;
  pnlSol: number | null;
  pnlPct: number | null;
  trailStopPct: number | null;
  status: "open" | "closing" | "closed";
};

export type Candle = {
  t: number; // bucket start, ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
  samples: number;
};

export type HolderView = {
  wallet: string;
  pct: number;
  class: WalletClass | null;
  confidence: number | null;
};

export type TokenView = {
  mint: string;
  symbol: string;
  name: string;
  stage: Stage;
  createdAt: number | null;
  latest: Snapshot | null;
  audit: Audit | null;
  supply: SupplyMap | null;
  micro: Microstructure | null;
  holders: HolderView[];
  candles: Candle[];
  candleBucketSec: number;
  intents: IntentView[];
  example?: boolean;
};

export type FunnelLayer = {
  layer: "activity" | "sieve" | "regime" | "decision" | "gates" | "execution";
  entered: number;
  passed: number;
};

export type FunnelView = {
  sinceMs: number;
  layers: FunnelLayer[];
  rejections: { gate: string; reason: string; n: number }[];
  adjustments: { gate: string; n: number }[];
  example?: boolean;
};

export type RuleStatsView = {
  windowDays: number;
  n: number;
  winRate: number | null;
  expectancy: number | null;
  worstDd: number | null;
  changedAt: number;
  changeReason: string;
};

export type RuleView = {
  id: string;
  strategy: Strategy;
  mode: Mode;
  weight: number;
  stats: RuleStatsView | null;
  eligibleForAuto: boolean;
};

export type ReplayRunView = {
  id: string;
  rulesVersion: string;
  windowStart: number;
  windowEnd: number;
  startedAt: number;
  finishedAt: number | null;
  summary: {
    intents: number;
    executed: number;
    expectancy: number | null;
    winRate: number | null;
    worstDd: number | null;
  } | null;
};

export type ApiError = { error: string; status: number };

export type WsMessage =
  | { type: "state"; state: ApiState }
  | { type: "intent"; intent: IntentView }
  | { type: "position"; position: PositionView }
  | { type: "alert"; level: "info" | "warn" | "error"; msg: string; ts: number };

/** Milliseconds until an intent expires, never negative. Pure. */
export function ttlLeftMs(view: Pick<IntentView, "expiresAt">, now: number): number {
  return Math.max(0, view.expiresAt - now);
}

/** Product of every adjustment a gate applied. Pure. */
export function adjustedMulOf(gates: GateResult[]): number {
  let mul = 1;
  for (const g of gates) if (g.adjustment) mul *= g.adjustment.sizeMul;
  return mul;
}

/** The gate that rejected, if any. Pure. */
export function rejectedBy(gates: GateResult[]): GateResult | null {
  return gates.find((g) => !g.passed) ?? null;
}
