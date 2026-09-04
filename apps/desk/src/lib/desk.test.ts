import assert from "node:assert/strict";
import test from "node:test";
import { clusterHeat, pressureOf, setupKind } from "./lab.ts";
import type { Token } from "@wick/core/market";
import {
  FILTER_PRESETS,
  hitSieve,
  parseNum,
  parseSieve,
  tokenPasses,
  type FilterSlice,
} from "./sieve.ts";

function sampleToken(over: Partial<Token> = {}): Token {
  return {
    id: "t1",
    mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    symbol: "DOG",
    name: "dog coin",
    chain: "sol",
    stage: "bonding",
    createdAt: 1_000_000,
    price: 1,
    mc: 20_000,
    liq: 3_000,
    vol: 1_000,
    vol5m: 400,
    tx: 40,
    buys5m: 6,
    sells5m: 2,
    holders: 90,
    change1m: 2,
    change5m: 5,
    change1h: 12,
    bonding: 40,
    mentions: 2,
    twitter: "@dogs",
    security: {
      mintable: false,
      freeze: false,
      lpBurned: true,
      renounced: true,
      top10: 18,
      onchain: true,
    },
    candles: [],
    supply: 1e9,
    statsAt: 1,
    pair: null,
    ...over,
  };
}

function slice(over: Partial<FilterSlice> = {}): FilterSlice {
  return { hideRugs: true, guardMint: true, ...FILTER_PRESETS.off, ...over };
}

test("lab classifies setup, chase, toxic and cluster heat", () => {
  assert.equal(
    setupKind({ quality: 0.7, edge: 1.2, dd: 0.2, change5m: 8, freeze: false, top10: 20 }),
    "setup",
  );
  assert.equal(
    setupKind({ quality: 0.6, edge: 0.2, dd: 0.02, change5m: 40, freeze: false, top10: null }),
    "heat",
  );
  assert.equal(
    setupKind({ quality: 0.1, edge: 2, dd: 0.3, change5m: 0, freeze: false, top10: null }),
    "toxic",
  );
  assert.equal(
    setupKind({ quality: 0.5, edge: 1, dd: 0.2, change5m: 0, freeze: true, top10: null }),
    "toxic",
  );
  assert.equal(
    setupKind({ quality: 0.7, edge: 1.2, dd: 0.2, change5m: 8, freeze: false, top10: 75 }),
    "toxic",
  );
  assert.ok(pressureOf({ buys5m: 30, sells5m: 10, change5m: -50 }) > 0);
  assert.ok(pressureOf({ buys5m: null, sells5m: null, change5m: -20 }) < 0);
  const heat = clusterHeat([
    { cluster: "dog", change5m: 30 } as never,
    { cluster: "dog", change5m: 20 } as never,
    { cluster: "dog", change5m: 22 } as never,
    { cluster: "ai", change5m: -4 } as never,
  ]);
  const dog = heat.find((c) => c.cluster === "dog");
  assert.equal(dog?.hot, true);
  assert.equal(dog?.n, 3);
});

test("sieve query parses units, freeze, topic and exclude", () => {
  assert.equal(parseNum("2k"), 2000);
  assert.equal(parseNum("80k"), 80_000);
  const q = parseSieve("liq>=2k mc<=80k age<20 freeze=0 topic!=ai -agent pepe");
  assert.equal(
    q.rules.some((r) => r.field === "liq" && r.value === 2000),
    true,
  );
  assert.equal(
    q.rules.some((r) => r.field === "freeze" && r.value === 0),
    true,
  );
  assert.equal(q.exclude.includes("agent"), true);
  assert.equal(q.include.includes("pepe"), true);
  const now = 1_000_000 + 10 * 60_000;
  const dog = sampleToken();
  const spec = {
    rules: q.rules,
    include: [],
    exclude: q.exclude,
    slice: slice({ sieve: "liq>=2k freeze=0 topic!=ai" }),
  };
  assert.equal(hitSieve(dog, spec, now), true);
  const frozen = sampleToken({ security: { ...dog.security, freeze: true } });
  assert.equal(tokenPasses(frozen, slice({ sieve: "freeze=0" }), undefined, now), false);
  const ai = sampleToken({ symbol: "GPT", name: "ai agent" });
  assert.equal(tokenPasses(ai, slice({ sieve: "topic!=ai" }), undefined, now), false);
  assert.equal(tokenPasses(dog, slice(FILTER_PRESETS.snipe), undefined, now), true);
  const old = sampleToken({ createdAt: now - 40 * 60_000 });
  assert.equal(tokenPasses(old, slice({ maxAgeMin: 18 }), undefined, now), false);
});

test("unknown fields never pass a threshold", () => {
  const now = 1_000_000 + 10 * 60_000;
  const blind = sampleToken({
    vol: null,
    holders: null,
    tx: null,
    security: { ...sampleToken().security, top10: null, onchain: false },
  });
  assert.equal(tokenPasses(blind, slice({ minHolders: 10 }), undefined, now), false);
  assert.equal(tokenPasses(blind, slice({ sieve: "vol>=1" }), undefined, now), false);
  assert.equal(tokenPasses(blind, slice({ sieve: "top10<=90" }), undefined, now), false);
  assert.equal(tokenPasses(blind, slice({ sieve: "freeze=0" }), undefined, now), false);
  assert.equal(tokenPasses(blind, slice(), undefined, now), true);
  assert.equal(
    tokenPasses(sampleToken(), slice({ sieve: "top10<=30 holders>=50 vol>=500" }), undefined, now),
    true,
  );
});
