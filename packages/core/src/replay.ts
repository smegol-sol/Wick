/**
 * The replay execution model (ADR-0007 §2): explicit and conservative. A
 * fill is the constant-product price on the pool's liquidity at that
 * second, after a fixed latency, plus the fee. A rule that only works
 * with a zero-latency assumption is not a rule. Pure.
 */
import type { Stage } from "./contracts.ts";

export const REPLAY_EXEC_MODEL = {
  latencyMs: 1500,
  /** Network fee plus the tier-1 priority tip, in SOL, taken from the size. */
  feeSol: 0.0005,
  model: "constant-product on the pool's SOL side at the fill second",
} as const;

/** The pool's SOL side from USD liquidity, as the feature book derives it. */
export function poolSolOf(liqUsd: number, stage: Stage, solUsd: number): number | null {
  if (!(solUsd > 0) || !(liqUsd > 0)) return null;
  return stage === "migrated" ? liqUsd / 2 / solUsd : liqUsd / solUsd;
}

export type ReplayFill = {
  /** The average price paid, in USD per token. */
  fillPriceUsd: number;
  /** Price impact of the whole size on the pool, percent. */
  impactPct: number;
  /** SOL that buys tokens after the fee. */
  netSol: number;
};

/**
 * Buying `sizeSol` into a constant-product pool with `poolSol` on its SOL side moves the
 * price by (1 + x/R)² and fills on average at about (1 + x/R) times the quoted price.
 */
export function replayFill(
  priceUsd: number,
  sizeSol: number,
  poolSol: number,
  feeSol: number = REPLAY_EXEC_MODEL.feeSol,
): ReplayFill | null {
  if (!(priceUsd > 0) || !(poolSol > 0) || !(sizeSol > 0)) return null;
  const netSol = Math.max(0, sizeSol - feeSol);
  const x = netSol / poolSol;
  return {
    fillPriceUsd: priceUsd * (1 + x),
    impactPct: Math.round(((1 + x) ** 2 - 1) * 100 * 1000) / 1000,
    netSol,
  };
}
