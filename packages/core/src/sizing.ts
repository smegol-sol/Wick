/**
 * Size as the minimum of three terms (ADR-0005, ENGINE §5), then the
 * regime and social multipliers. The binding term is recorded so the
 * evaluator can see which bound holds most often. Pure.
 */
import type { Sizing } from "./contracts.ts";

export type SizingInputs = {
  equitySol: number;
  perTradePct: number;
  poolLiqUsd: number;
  poolSharePct: number;
  solUsd: number;
  /** equity × maxTokenExposurePct, in SOL. */
  tokenCapSol: number;
  /** SOL already deployed in this mint. */
  openExposureSol: number;
  regimeMul: number;
  socialMul: number;
};

export type Sized = { sizing: Sizing; baseSol: number; sizeSol: number };

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function sizeEntry(i: SizingInputs): Sized {
  const equityTerm = (i.equitySol * i.perTradePct) / 100;
  const poolTerm = i.solUsd > 0 ? (i.poolLiqUsd * i.poolSharePct) / 100 / i.solUsd : 0;
  const capTerm = Math.max(0, i.tokenCapSol - i.openExposureSol);
  const baseSol = Math.max(0, Math.min(equityTerm, poolTerm, capTerm));
  const binding: Sizing["binding"] =
    baseSol === equityTerm ? "equity" : baseSol === poolTerm ? "pool" : "cap";
  const sizeSol = round(baseSol * i.regimeMul * i.socialMul);
  return {
    sizing: {
      equityTerm: round(equityTerm),
      poolTerm: round(poolTerm),
      capTerm: round(capTerm),
      binding,
      regimeMul: i.regimeMul,
      socialMul: i.socialMul,
    },
    baseSol: round(baseSol),
    sizeSol,
  };
}
