import assert from "node:assert/strict";
import test from "node:test";
import { poolSolOf, replayFill, REPLAY_EXEC_MODEL } from "@wick/core/replay";

test("replay fill: constant product on the pool's SOL side, fee off the top, impact from the squared move", () => {
  assert.equal(poolSolOf(8000, "bonding", 100), 80, "the curve's liquidity is its SOL side");
  assert.equal(poolSolOf(8000, "migrated", 100), 40, "a pool holds half in SOL");
  assert.equal(poolSolOf(0, "bonding", 100), null);
  assert.equal(poolSolOf(8000, "bonding", 0), null);
  const f = replayFill(0.001, 0.2, 80, 0)!;
  assert.ok(
    Math.abs(f.fillPriceUsd - 0.001 * 1.0025) < 1e-12,
    "0.2 of 80 SOL is a 0.25% average premium",
  );
  assert.equal(f.impactPct, 0.501, "(1.0025)² − 1");
  assert.equal(f.netSol, 0.2);
  const withFee = replayFill(0.001, 0.2, 80)!;
  assert.equal(withFee.netSol, 0.2 - REPLAY_EXEC_MODEL.feeSol);
  assert.ok(withFee.fillPriceUsd < f.fillPriceUsd, "less SOL buys with less impact");
  const big = replayFill(0.001, 4, 80, 0)!;
  assert.equal(big.impactPct, 10.25, "5% of the pool moves price 10.25%");
  assert.equal(replayFill(0, 1, 80), null);
  assert.equal(REPLAY_EXEC_MODEL.latencyMs, 1500);
});
