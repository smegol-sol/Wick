import { ed25519 } from "@noble/curves/ed25519";
import assert from "node:assert/strict";
import test from "node:test";
import {
  isB58,
  isSig,
  clampNum,
  slipBps,
  quoteLamportsOk,
  sanitizeLabel,
  uiToRaw,
  amountRawOk,
  liveSellRaw,
  liveSpendCap,
} from "./guard.ts";
import {
  canSignHot,
  createHot,
  fromB58,
  importHot,
  lockHotMem,
  openVault,
  passOk,
  peekSecret,
  parseSecret,
  sealSecret,
  signHotTx,
  slimVault,
  toB58,
  unlockHot,
  b64of,
  b64to,
} from "./hot-wallet.ts";
import { commitLadderSlice, failLadderSlice, makeLadder, tickLadders } from "./entry.ts";
import { hitExit, isLiveDump, queueChainExits, upsertChainExit } from "./exits.ts";
import { clusterHeat, pressureOf, setupKind } from "./lab.ts";
import { blendScore, moodOf, tapeScore, toneOf } from "./sentiment.ts";
import { flowBias, followPrints, nameFlowOf } from "./smart-flow.ts";
import { copySize, pickNews, styleDelay, styleSize, styleSkip, swapPrint } from "./live-copy.ts";
import { fraudOf, fraudSkip } from "./fraud.ts";
import { liveSnipeOk } from "./snipe-live.ts";
import { filterTape, tapeRank } from "./tape.ts";
import {
  FILTER_PRESETS,
  hitSieve,
  parseNum,
  parseSieve,
  tokenPasses,
  type FilterSlice,
} from "./sieve.ts";
import { riskScore, isRug } from "./market.ts";
import { impactPct } from "./jup.ts";
import type { Token } from "./market.ts";

test("guard rejects junk keys and scripts", () => {
  assert.equal(isB58("9WzDYwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"), true);
  assert.equal(isB58("not-a-key"), false);
  assert.equal(isB58("'; DROP TABLE"), false);
  assert.equal(clampNum("x", 0, 10, 3), 3);
  assert.equal(clampNum(99, 0, 8, 2), 8);
  assert.equal(slipBps(12, false), 1200);
  assert.equal(slipBps(40, true), 1800);
  assert.equal(quoteLamportsOk(1e5), false);
  assert.equal(quoteLamportsOk(5e8), true);
  assert.equal(sanitizeLabel("<script>x</script>", 20), "scriptxscript");
});

test("sig and raw amount guards", () => {
  assert.equal(isSig("2nYxZ9"), false);
  assert.equal(isSig("5".repeat(70)), true);
  assert.equal(isSig("5".repeat(90)), false);
  assert.equal(amountRawOk("1500000000"), true);
  assert.equal(amountRawOk("0"), false);
  assert.equal(amountRawOk("-1"), false);
  assert.equal(uiToRaw(1.5, 9), "1500000000");
  assert.equal(uiToRaw(0.5, 6), "500000");
  assert.equal(uiToRaw(0, 9), "0");
});

test("live size never spends paper cash", () => {
  assert.equal(liveSpendCap(2, null, 2), 0);
  assert.equal(liveSpendCap(2, 0.4, 2), 0.4);
  assert.equal(liveSpendCap(5, 40, 2), 2);
  assert.equal(liveSpendCap(0.02, 10, 2), 0);
  const raw = liveSellRaw(1000, 6, 0.5, 1);
  assert.equal(raw, "500000000");
  assert.equal(liveSellRaw(0, 6, 1, 1), null);
});

test("hot vault roundtrip and refuses junk persist", async () => {
  assert.equal(passOk("short"), false);
  assert.equal(passOk("aaaaaaaaaa"), false);
  assert.equal(passOk("longenough"), true);
  const secret = crypto.getRandomValues(new Uint8Array(64));
  const pub = "9WzDYwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const vault = await sealSecret(secret, "desk-pass-1", pub);
  assert.equal(vault.exported, false);
  assert.equal(vault.v, 2);
  assert.ok((vault.iter ?? 0) >= 400_000);
  assert.equal(slimVault({ ...vault, secret: "leak" })?.data, vault.data);
  assert.equal(
    slimVault({ ...vault, secret: "leak" }) &&
      "secret" in (slimVault({ ...vault, secret: "leak" }) as object),
    false,
  );
  assert.equal(slimVault({ pub, salt: "x", iv: "y", data: "<script>" }), null);
  const opened = await openVault(vault, "desk-pass-1");
  assert.deepEqual([...opened], [...secret]);
  await assert.rejects(() => openVault(vault, "desk-pass-2"));
  const swapped = { ...vault, pub: "11111111111111111111111111111111" };
  await assert.rejects(() => openVault(swapped, "desk-pass-1"));
  assert.ok(toB58(secret).length > 32);
});

test("toB58 leading zeros and solana pubkey", async () => {
  assert.equal(toB58(new Uint8Array(32)), "1".repeat(32));
  assert.equal(toB58(new Uint8Array([0])), "1");
  const { Keypair } = await import("@solana/web3.js");
  const kp = Keypair.generate();
  assert.equal(toB58(kp.publicKey.toBytes()), kp.publicKey.toBase58());
});

test("createHot holds secret, persist is sealed, signing needs export", async () => {
  lockHotMem();
  const { vault, secretB58 } = await createHot("desk-pass-1");
  assert.equal(vault.exported, false);
  assert.ok(isB58(vault.pub));
  assert.ok(secretB58.length > 80);
  assert.equal(peekSecret()?.length, 64);
  assert.equal(canSignHot(vault, true, vault.pub), false);
  assert.equal(canSignHot({ ...vault, exported: true }, true, vault.pub), true);
  const slim = slimVault({ ...vault, secret: secretB58 });
  assert.ok(slim);
  assert.equal((slim as { secret?: string }).secret, undefined);
  lockHotMem();
  assert.equal(peekSecret(), null);
  assert.equal(canSignHot({ ...vault, exported: true }, true, vault.pub), false);
  await unlockHot(vault, "desk-pass-1");
  assert.equal(peekSecret()?.length, 64);
  const secret = peekSecret()!;
  const pub = secret.subarray(32, 64);
  const msg = new Uint8Array(3 + 1 + 32 + 32 + 1);
  msg[0] = 1;
  msg[3] = 1;
  msg.set(pub, 4);
  const raw = new Uint8Array(1 + 64 + msg.length);
  raw[0] = 1;
  raw.set(msg, 65);
  const signed = b64to(await signHotTx(b64of(raw)));
  assert.equal(signed[0], 1);
  assert.equal(ed25519.verify(signed.subarray(1, 65), msg, pub), true);
  const foreign = new Uint8Array(raw);
  foreign.set(crypto.getRandomValues(new Uint8Array(32)), 69);
  await assert.rejects(() => signHotTx(b64of(foreign)));
  lockHotMem();
  const bad = { ...vault, pub: "11111111111111111111111111111111" };
  await assert.rejects(() => unlockHot(bad, "desk-pass-1"));
  lockHotMem();
});

test("importHot accepts seed, json and rejects junk", async () => {
  lockHotMem();
  const { Keypair } = await import("@solana/web3.js");
  const kp = Keypair.generate();
  const secret = kp.secretKey;
  assert.deepEqual([...fromB58(toB58(secret))!], [...secret]);
  assert.equal(toB58(fromB58(kp.publicKey.toBase58())!), kp.publicKey.toBase58());
  const seed = secret.subarray(0, 32);
  const parsedSeed = parseSecret(toB58(seed));
  assert.equal(toB58(parsedSeed!.subarray(32)), kp.publicKey.toBase58());
  const parsedJson = parseSecret(`[${[...secret].join(",")}]`);
  assert.deepEqual([...parsedJson!], [...secret]);
  const hex = [...seed].map((b) => b.toString(16).padStart(2, "0")).join("");
  assert.equal(parseSecret(`0x${hex}`)?.length, 64);
  assert.equal(parseSecret("not-a-secret"), null);
  assert.equal(parseSecret("[1,2,3]"), null);
  const bad64 = new Uint8Array(secret);
  bad64[63] ^= 1;
  assert.equal(parseSecret(toB58(bad64)), null);
  const made = await importHot(toB58(secret), "desk-pass-1");
  assert.equal(made.vault.exported, true);
  assert.equal(made.pub, kp.publicKey.toBase58());
  assert.equal(canSignHot(made.vault, true, made.pub), true);
  lockHotMem();
});

test("chain ladder queues a slice without spending until commit", () => {
  const born = makeLadder({
    tokenId: "tok",
    now: 0,
    price: 1,
    budget: 1,
    source: "manual",
    chain: true,
  });
  const primed = { ...born, phase: "dip" as const, nextAt: 0, dipUntil: 80_000, markPx: 1 };
  const stepped = tickLadders([primed], {
    now: 1_000,
    priceOf: () => 0.97,
    edgeOk: () => true,
    alive: () => true,
  });
  assert.equal(stepped.slices.length, 1);
  assert.ok(stepped.slices[0].sol >= 0.05);
  assert.equal(stepped.ladders[0].spent, 0);
  assert.ok(stepped.ladders[0].pendingSol >= 0.05);
  assert.equal(stepped.ladders[0].dipDone, 0);
  const held = tickLadders(stepped.ladders, {
    now: 2_000,
    priceOf: () => 0.97,
    edgeOk: () => true,
    alive: () => true,
  });
  assert.equal(held.slices.length, 0);
  assert.equal(held.ladders[0].pendingSol, stepped.ladders[0].pendingSol);
  const filled = commitLadderSlice(stepped.ladders, "tok", 0.97, 2_000);
  assert.ok(filled[0].spent >= 0.05);
  assert.equal(filled[0].pendingSol, 0);
  assert.equal(filled[0].dipDone, 1);
  const missed = failLadderSlice(stepped.ladders, "tok", 2_000);
  assert.equal(missed[0].pendingSol, 0);
  assert.equal(missed[0].spent, 0);
});

test("hitExit covers stop, trail, tp slices and live dump", () => {
  const base = {
    tpPct: 20,
    slPct: 12,
    tpScale: 2,
    tpRung: 0,
    tpNextAt: 0,
    trailOn: false,
    peakPrice: 1,
    devExit: true,
  };
  const sl = hitExit(base, { price: 0.85, avg: 1, now: 1, dump: false });
  assert.equal(sl.kind, "sl");
  assert.equal(sl.frac, 1);
  const trail = hitExit(
    { ...base, trailOn: true, peakPrice: 1.4 },
    { price: 1.2, avg: 1, now: 1, dump: false },
  );
  assert.equal(trail.kind, "trail");
  const tp = hitExit(base, { price: 1.25, avg: 1, now: 1, dump: false });
  assert.equal(tp.kind, "tp");
  assert.ok(Math.abs(tp.frac - 0.5) < 1e-9);
  const dump = hitExit(base, { price: 1.1, avg: 1, now: 1, dump: true });
  assert.equal(dump.kind, "dev");
  assert.equal(isLiveDump({ change1m: -19 }), true);
  assert.equal(isLiveDump({ change1m: -2 }), false);
});

test("chain exit queues a sell without double-fire", () => {
  const rows = upsertChainExit([], {
    tokenId: "tok",
    mint: "So11111111111111111111111111111111111111112",
    price: 1,
    addSol: 1,
    exits: { tpPct: 20, slPct: 12, trailOn: false, tpScale: 1 },
  });
  const due = queueChainExits(rows, {
    now: 5_000,
    priceOf: () => 0.8,
    holdAmt: () => 1,
    dumpOf: () => false,
  });
  assert.equal(due[0].pendingKind, "sl");
  assert.equal(due[0].pendingFrac, 1);
  const held = queueChainExits(due, {
    now: 6_000,
    priceOf: () => 0.8,
    holdAmt: () => 1,
    dumpOf: () => false,
  });
  assert.equal(held[0].pendingKind, "sl");
});

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

test("sentiment buckets tape vs crowd", () => {
  assert.equal(moodOf(70), "euphoria");
  assert.equal(moodOf(30), "greed");
  assert.equal(moodOf(0), "neutral");
  assert.equal(moodOf(-30), "fear");
  assert.equal(moodOf(-80), "capitulation");
  assert.equal(toneOf(0.4, 0.2), "stealth");
  assert.equal(toneOf(-0.4, 0.6), "fade");
  assert.equal(toneOf(0.4, 0.6), "aligned");
  assert.equal(toneOf(-0.4, 0.1), "dead");
  assert.ok(tapeScore(40, 80) > 0.9);
  assert.ok(tapeScore(40, null) > 0.9);
  assert.ok(blendScore(0.8, 0.8, 0.8) > 50);
  assert.ok(blendScore(-0.8, 0.1, -0.8) < -40);
});

test("smart flow comes from followed wallets' chain tapes only", () => {
  assert.equal(flowBias(2, 3), "accumulate");
  assert.equal(flowBias(-2, 3), "distribute");
  assert.equal(flowBias(0.1, 3), "mixed");
  assert.equal(flowBias(1, 0.1), "idle");
  const pk = "9WzDYwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const mint = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  const prints = followPrints(
    [{ pk, label: "whale" }],
    {
      [pk]: [
        { sig: "S".repeat(64), ts: 5, side: "buy", sol: 2, mint, amount: 1000 },
        { sig: "T".repeat(64), ts: 4, side: "in", sol: 1 },
      ],
    },
    100,
  );
  assert.equal(prints.length, 1);
  assert.equal(prints[0].wallet, "whale");
  assert.equal(prints[0].price, 0.2);
  const flow = nameFlowOf(sampleToken({ mint }), prints);
  assert.equal(flow.desks, 1);
  assert.equal(flow.buySol, 2);
  assert.equal(followPrints([], {}, 100).length, 0);
});

test("follow tape copies only new swaps", () => {
  const a = {
    sig: "A".repeat(64),
    ts: 2,
    side: "buy" as const,
    sol: 1.2,
    mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  };
  const b = {
    sig: "B".repeat(64),
    ts: 3,
    side: "sell" as const,
    sol: 0.8,
    mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  };
  const tip = pickNews([b, a], null);
  assert.equal(tip.news.length, 0);
  assert.equal(tip.cursor, b.sig);
  const next = pickNews([b, a], b.sig);
  assert.equal(next.news.length, 0);
  const c = { sig: "C".repeat(64), ts: 4, side: "buy" as const, sol: 2, mint: a.mint };
  const news = pickNews([c, b, a], b.sig);
  assert.equal(news.news.map((p) => p.sig).join(), c.sig);
  assert.equal(swapPrint({ sig: "x", ts: 1, side: "in", sol: 1, mint: a.mint }), null);
  assert.equal(swapPrint({ sig: "x", ts: 1, side: "buy", sol: 0.01, mint: a.mint }), null);
  assert.ok(swapPrint(a));
  assert.equal(copySize(10, 2, 5), 0.5);
  assert.equal(copySize(100, 0.2, 5), 0.2);
  assert.ok(Math.abs(styleSize("shadow", 10, 2, 5) - 0.225) < 1e-9);
  assert.equal(styleSize("scale", 10, 2, 0.2), 0);
  assert.ok(styleSize("scale", 10, 2, 8) > styleSize("scale", 10, 2, 1));
  assert.equal(styleDelay("shadow", 0), 2);
  assert.equal(styleSkip("shadow", { side: "buy", change5m: 40, srcSol: 2, confirms: 0 }), "chase");
  assert.equal(
    styleSkip("confirm", { side: "buy", change5m: 0, srcSol: 2, confirms: 0 }),
    "confirm",
  );
  assert.equal(styleSkip("confirm", { side: "buy", change5m: 0, srcSol: 2, confirms: 1 }), null);
});

test("fraud only scores checks that have data", () => {
  const sec = {
    mintable: false,
    freeze: false,
    lpBurned: true,
    renounced: true,
    top10: 20,
    onchain: true,
  };
  const clean = fraudOf({
    vol: 20,
    vol5m: 1,
    mc: 200,
    holders: 400,
    tx: 80,
    change5m: 4,
    mentions: 2,
    twitter: "x",
    candles: [{ t: 1, o: 1, h: 1.04, l: 0.98, c: 1.02, v: 2 }],
    security: sec,
    stage: "migrated",
  });
  assert.equal(clean.tag, "clean");
  assert.ok(clean.checked >= 4);
  const wash = fraudOf({
    vol: 900,
    vol5m: 40,
    mc: 100,
    holders: 20,
    tx: 400,
    change5m: 0.4,
    mentions: 1,
    twitter: "x",
    candles: Array.from({ length: 8 }, (_, i) => ({ t: i, o: 1, h: 1.004, l: 0.997, c: 1, v: 80 })),
    security: sec,
    stage: "migrated",
  });
  assert.equal(wash.tag, "wash");
  assert.ok(wash.score >= 30);
  assert.equal(fraudSkip({ ...wash, score: 60 }), true);
  const trap = fraudOf({
    vol: 10,
    vol5m: 1,
    mc: 80,
    holders: 200,
    tx: 40,
    change5m: 5,
    mentions: 0,
    twitter: "x",
    candles: [],
    security: { ...sec, freeze: true, mintable: true },
    stage: "bonding",
  });
  assert.equal(trap.tag, "trap");
  const unknown = fraudOf({
    vol: null,
    vol5m: null,
    mc: 80,
    holders: null,
    tx: null,
    change5m: 0,
    mentions: 0,
    twitter: null,
    candles: [],
    security: { ...sec, onchain: false, top10: null },
    stage: "new",
  });
  assert.equal(unknown.tag, "clean");
  assert.equal(unknown.checked, 1);
  assert.equal(unknown.score, 0);
  assert.equal(isRug({ ...sec, onchain: false, freeze: true }), false);
  assert.equal(isRug({ ...sec, freeze: true }), true);
  assert.ok(riskScore({ ...sec, freeze: true }) > riskScore(sec));
  assert.equal(riskScore({ ...sec, onchain: false, freeze: true, mintable: true, top10: null }), 0);
});

test("jupiter price impact is a fraction and is converted to percent once", () => {
  assert.equal(impactPct("0.025091569871611154"), 2.5091569871611154);
  assert.equal(impactPct("0.000633988901675635"), 0.0633988901675635);
  assert.equal(impactPct(0.5), 50);
  assert.equal(impactPct("2"), 100);
  assert.equal(impactPct("abc"), null);
  assert.equal(impactPct(undefined), null);
  assert.equal(impactPct(-0.1), null);
  // The swap gate compares percent against 18: a 25% impact must trip it, 2.5% must not.
  assert.ok((impactPct("0.25") ?? 0) >= 18);
  assert.ok((impactPct("0.025") ?? 0) < 18);
});

test("live snipe is opt-in", () => {
  const tk = { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" };
  assert.equal(liveSnipeOk({ snipeLive: false }, tk), false);
  assert.equal(liveSnipeOk({ snipeLive: true }, tk), true);
  assert.equal(liveSnipeOk({ snipeLive: true }, { mint: "w1" }), false);
});

test("tape signal drops skip noise", () => {
  const feed = [
    { id: "1", ts: 1, kind: "smart" as const, text: "Copy skip — mint not on pulse", textAr: "" },
    { id: "3", ts: 3, kind: "smart" as const, text: "Copy dust $DOG", textAr: "" },
    {
      id: "5",
      ts: 5,
      kind: "smart" as const,
      text: "whale bought $DOG · 1.20 SOL",
      textAr: "",
      tokenId: "t1",
      side: "buy" as const,
    },
    {
      id: "6",
      ts: 6,
      kind: "smart" as const,
      text: "Copy queued buy $DOG · 0.20 SOL in 4s",
      textAr: "",
      tokenId: "t1",
      side: "buy" as const,
    },
    {
      id: "7",
      ts: 7,
      kind: "risk" as const,
      text: "Dump exit $DOG",
      textAr: "",
      tokenId: "t1",
      side: "sell" as const,
    },
    {
      id: "8",
      ts: 8,
      kind: "snipe" as const,
      text: "Live snipe $DOG on migrate · 0.15 SOL",
      textAr: "",
      tokenId: "t1",
    },
    {
      id: "9",
      ts: 9,
      kind: "flow" as const,
      text: "Limit triggered buy $DOG",
      textAr: "",
      tokenId: "t1",
    },
  ];
  assert.equal(tapeRank(feed[0]!), "noise");
  assert.equal(tapeRank(feed[1]!), "noise");
  assert.equal(tapeRank(feed[2]!), "signal");
  assert.equal(tapeRank(feed[3]!), "signal");
  assert.equal(tapeRank(feed[4]!), "signal");
  const signal = filterTape(feed, { grade: "signal", kind: "all", tokens: [], hideRugs: true });
  assert.deepEqual(
    signal.map((f) => f.id),
    ["5", "6", "7", "8", "9"],
  );
  const desk = filterTape(feed, { grade: "desk", kind: "all", tokens: [], hideRugs: true });
  assert.equal(
    desk.some((f) => f.id === "1"),
    false,
  );
  const raw = filterTape(feed, { grade: "raw", kind: "snipe", tokens: [], hideRugs: true });
  assert.deepEqual(
    raw.map((f) => f.id),
    ["8"],
  );
});

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
