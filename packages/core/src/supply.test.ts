import assert from "node:assert/strict";
import test from "node:test";
import { ed25519 } from "@noble/curves/ed25519";
import { fromB58 } from "@wick/core/base58";
import { bondingCurveOf, classifyWallet, pdaOf, supplyMapOf, trendOf } from "@wick/core/supply";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

test("pda: deterministic, off the curve, and the bonding curve is one of them", () => {
  const a = pdaOf(
    [new TextEncoder().encode("bonding-curve"), fromB58(MINT)!],
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  );
  const b = bondingCurveOf(MINT);
  assert.equal(a.address, b);
  assert.ok(a.bump <= 255 && a.bump >= 0);
  assert.throws(() => ed25519.ExtendedPoint.fromHex(fromB58(b)!), "a PDA has no private key");
  assert.notEqual(bondingCurveOf("So11111111111111111111111111111111111111112"), b);
});

test("wallet classes: snipers from create-slot buys, fresh from age and activity, organic otherwise", () => {
  assert.deepEqual(classifyWallet({ createSlotBuys: 4, txCount: 5, ageSec: 1e6 }), {
    class: "sniper-bot",
    confidence: 0.8,
    fresh: false,
  });
  assert.deepEqual(classifyWallet({ createSlotBuys: 0, txCount: 2, ageSec: 3600 }), {
    class: "unknown",
    confidence: 0.3,
    fresh: true,
  });
  assert.deepEqual(classifyWallet({ createSlotBuys: 0, txCount: 5, ageSec: 3600 }), {
    class: "organic",
    confidence: 0.5,
    fresh: false,
  });
  assert.deepEqual(classifyWallet({ createSlotBuys: 1, txCount: null, ageSec: null }), {
    class: "unknown",
    confidence: 0,
    fresh: null,
  });
});

test("supply map: pool excluded, dev and snipers from the launch, fresh share among the profiled, trend from the early share", () => {
  const launch = {
    creator: "Dev",
    slot: 100,
    buyers: [
      { wallet: "Dev", slot: 100 },
      { wallet: "Snipe1", slot: 102 },
      { wallet: "Snipe2", slot: 109 },
      { wallet: "Late", slot: 130 },
    ],
    bundlePct: 7.5,
  };
  const fresh = new Map<string, boolean | null>([
    ["Dev", false],
    ["Snipe1", true],
    ["Fresh", true],
    ["Whale", false],
  ]);
  const r = supplyMapOf({
    at: 1,
    supplyRaw: 1_000_000,
    decimals: 6,
    holders: [
      { account: "a", owner: "Curve", amount: 500_000 },
      { account: "b", owner: "Dev", amount: 60_000 },
      { account: "c", owner: "Snipe1", amount: 100_000 },
      { account: "d", owner: "Snipe2", amount: 50_000 },
      { account: "e", owner: "Late", amount: 40_000 },
      { account: "f", owner: "Fresh", amount: 20_000 },
      { account: "g", owner: "Whale", amount: 200_000 },
      { account: "h", owner: "Dev", amount: 10_000 }, // a second account of the dev
    ],
    poolOwners: ["Curve"],
    launch,
    fresh,
    earlyPctBefore: 25,
  })!;
  assert.equal(r.map.lpPct, 50);
  assert.equal(r.map.devPct, 7, "two accounts summed");
  assert.equal(r.map.sniperPct, 15, "first ten slots only; the late buyer is not a sniper");
  assert.equal(r.map.bundlePct, 7.5);
  assert.equal(r.map.freshWalletPct, 12, "Snipe1 10 + Fresh 2, over the profiled holders");
  assert.equal(r.earlyPct, 22);
  assert.equal(r.map.earlyHoldersTrend, "distributing", "25 → 22 is more than the two-point step");
  assert.deepEqual(r.holders.slice(0, 2), [
    { wallet: "Whale", pct: 20 },
    { wallet: "Snipe1", pct: 10 },
  ]);
  const noLaunch = supplyMapOf({
    at: 1,
    supplyRaw: 100,
    decimals: 0,
    holders: [{ account: "x", owner: "W", amount: 10 }],
    poolOwners: [],
    launch: null,
    fresh: new Map(),
    earlyPctBefore: null,
  })!;
  assert.equal(noLaunch.map.devPct, null);
  assert.equal(noLaunch.map.freshWalletPct, null, "nobody profiled");
  assert.equal(noLaunch.map.earlyHoldersTrend, null);
  assert.equal(
    supplyMapOf({
      at: 1,
      supplyRaw: 0,
      decimals: 0,
      holders: [],
      poolOwners: [],
      launch: null,
      fresh: new Map(),
      earlyPctBefore: null,
    }),
    null,
  );
  assert.equal(trendOf(10, 12.5), "accumulating");
  assert.equal(trendOf(10, 11), "flat");
});
