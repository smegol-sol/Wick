import { readFileSync } from "node:fs";
import { parse } from "yaml";

/** The capital ladder (ADR-0005). Tier and wallet cap must agree. */
export const TIERS = {
  1: { walletCapSol: 15, perTradePct: 1.5, maxOpenPositions: 6 },
  2: { walletCapSol: 40, perTradePct: 1.25, maxOpenPositions: 8 },
  3: { walletCapSol: 100, perTradePct: 1.0, maxOpenPositions: 12 },
} as const;
export type Tier = keyof typeof TIERS;

export type RiskConfig = {
  tier: Tier;
  executionWalletCapSol: number;
  perTradePct: number;
  poolSharePct: number;
  minTradeSol: number;
  maxOpenPositions: number;
  maxTokenExposurePct: number;
  youngTokenExposurePct: number;
  dailyHaltPct: number;
  weeklyHaltPct: number;
  losingStreakToSuggest: number;
  postLossDayMul: number;
  socialMulMin: number;
  socialMulMax: number;
  priorityFeeCapSol: number;
  feeReserveSol: number;
  quote: {
    maxAgeMs: number;
    maxImpactEntryPct: number;
    maxImpactExitPct: number;
    minHopLiquidityUsd: number;
  };
  health: {
    maxSlotLag: number;
    maxSourceAgeSec: number;
    decisionBudgetMs: number;
    budgetBreachMinutes: number;
  };
};

export type EngineConfig = {
  databaseUrl: string;
  redisUrl: string | null;
  solanaRpcUrl: string | null;
  /** wss endpoint for logsSubscribe; derived from the RPC URL when unset. */
  solanaWsUrl: string | null;
  /** The pump.fun migration authority; its transactions are the migrate events. */
  migrationAuthority: string;
  httpHost: string;
  httpPort: number;
  healthcheckUrl: string | null;
  logLevel: "debug" | "info" | "warn" | "error";
  riskFile: string;
  /** Ingest cadence (ADR-0007). */
  activeSampleMs: number;
  coolingSampleMs: number;
  activeWindowMs: number;
  coolingWindowMs: number;
  auditEveryMs: number;
  slotPollMs: number;
  /** How often the followed-wallet set is re-read from the database. */
  followRefreshMs: number;
};

/** pump.fun's migration authority on mainnet; override with PUMP_MIGRATION_AUTHORITY when it rotates. */
export const PUMP_MIGRATION_AUTHORITY = "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg";

function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function req(name: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new Error(`risk.yaml: ${name} must be a number`);
  return v;
}

/** Parse and validate a risk file's contents. Pure; throws on a bad file. */
export function parseRisk(text: string): RiskConfig {
  const raw = parse(text) as Record<string, unknown>;
  if (!raw || typeof raw !== "object") throw new Error("risk.yaml: not an object");
  const tier = raw.tier as Tier;
  if (!(tier in TIERS))
    throw new Error(`risk.yaml: tier must be 1, 2 or 3, got ${String(raw.tier)}`);
  const cap = req("executionWalletCapSol", raw.executionWalletCapSol);
  if (cap > TIERS[tier].walletCapSol) {
    throw new Error(
      `risk.yaml: executionWalletCapSol ${cap} exceeds the tier ${tier} cap ${TIERS[tier].walletCapSol} (ADR-0005)`,
    );
  }
  const perTradePct = req("perTradePct", raw.perTradePct);
  if (perTradePct > TIERS[tier].perTradePct) {
    throw new Error(`risk.yaml: perTradePct ${perTradePct} exceeds the tier ${tier} value`);
  }
  const maxOpenPositions = req("maxOpenPositions", raw.maxOpenPositions);
  if (maxOpenPositions > TIERS[tier].maxOpenPositions) {
    throw new Error(
      `risk.yaml: maxOpenPositions ${maxOpenPositions} exceeds the tier ${tier} value`,
    );
  }
  const quote = (raw.quote ?? {}) as Record<string, unknown>;
  const health = (raw.health ?? {}) as Record<string, unknown>;
  const dailyHaltPct = req("dailyHaltPct", raw.dailyHaltPct);
  const weeklyHaltPct = req("weeklyHaltPct", raw.weeklyHaltPct);
  if (dailyHaltPct >= 0 || weeklyHaltPct >= 0)
    throw new Error("risk.yaml: halts are negative percents");
  return {
    tier,
    executionWalletCapSol: cap,
    perTradePct,
    poolSharePct: req("poolSharePct", raw.poolSharePct),
    minTradeSol: req("minTradeSol", raw.minTradeSol),
    maxOpenPositions,
    maxTokenExposurePct: req("maxTokenExposurePct", raw.maxTokenExposurePct),
    youngTokenExposurePct: req("youngTokenExposurePct", raw.youngTokenExposurePct),
    dailyHaltPct,
    weeklyHaltPct,
    losingStreakToSuggest: req("losingStreakToSuggest", raw.losingStreakToSuggest),
    postLossDayMul: req("postLossDayMul", raw.postLossDayMul),
    socialMulMin: req("socialMulMin", raw.socialMulMin),
    socialMulMax: req("socialMulMax", raw.socialMulMax),
    priorityFeeCapSol: req("priorityFeeCapSol", raw.priorityFeeCapSol),
    feeReserveSol: req("feeReserveSol", raw.feeReserveSol),
    quote: {
      maxAgeMs: req("quote.maxAgeMs", quote.maxAgeMs),
      maxImpactEntryPct: req("quote.maxImpactEntryPct", quote.maxImpactEntryPct),
      maxImpactExitPct: req("quote.maxImpactExitPct", quote.maxImpactExitPct),
      minHopLiquidityUsd: req("quote.minHopLiquidityUsd", quote.minHopLiquidityUsd),
    },
    health: {
      maxSlotLag: req("health.maxSlotLag", health.maxSlotLag),
      maxSourceAgeSec: req("health.maxSourceAgeSec", health.maxSourceAgeSec),
      decisionBudgetMs: req("health.decisionBudgetMs", health.decisionBudgetMs),
      budgetBreachMinutes: req("health.budgetBreachMinutes", health.budgetBreachMinutes),
    },
  };
}

export function loadRisk(file: string): RiskConfig {
  return parseRisk(readFileSync(file, "utf8"));
}

/** Read the engine's environment. Pure over the given map; throws on a missing must-have. */
export function parseEnv(env: Record<string, string | undefined>): EngineConfig {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const level = (env.LOG_LEVEL ?? "info").toLowerCase();
  if (!["debug", "info", "warn", "error"].includes(level))
    throw new Error(`LOG_LEVEL ${level} unknown`);
  const rpc = env.SOLANA_RPC_URL?.trim();
  if (rpc && !/^https:\/\//.test(rpc)) throw new Error("SOLANA_RPC_URL must be https");
  const ws = env.SOLANA_WS_URL?.trim();
  if (ws && !/^wss:\/\//.test(ws)) throw new Error("SOLANA_WS_URL must be wss");
  const hc = env.HEALTHCHECK_URL?.trim();
  if (hc && !/^https:\/\//.test(hc)) throw new Error("HEALTHCHECK_URL must be https");
  return {
    databaseUrl,
    redisUrl: env.REDIS_URL?.trim() || null,
    solanaRpcUrl: rpc || null,
    solanaWsUrl: ws || null,
    migrationAuthority: env.PUMP_MIGRATION_AUTHORITY?.trim() || PUMP_MIGRATION_AUTHORITY,
    httpHost: env.ENGINE_HTTP_HOST?.trim() || "127.0.0.1",
    httpPort: num(env.ENGINE_HTTP_PORT, 9464),
    healthcheckUrl: hc || null,
    logLevel: level as EngineConfig["logLevel"],
    riskFile: env.RISK_FILE?.trim() || "config/risk.yaml",
    activeSampleMs: num(env.ACTIVE_SAMPLE_MS, 1000),
    coolingSampleMs: num(env.COOLING_SAMPLE_MS, 60_000),
    activeWindowMs: num(env.ACTIVE_WINDOW_MS, 2 * 3600_000),
    coolingWindowMs: num(env.COOLING_WINDOW_MS, 24 * 3600_000),
    auditEveryMs: num(env.AUDIT_EVERY_MS, 10 * 60_000),
    slotPollMs: num(env.SLOT_POLL_MS, 5000),
    followRefreshMs: num(env.FOLLOW_REFRESH_MS, 30_000),
  };
}
