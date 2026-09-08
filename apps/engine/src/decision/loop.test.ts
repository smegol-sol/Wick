import assert from "node:assert/strict";
import test from "node:test";
import type { ChainAdapter, LaunchTx, Quote } from "@wick/core/chain";
import type { Audit, Snapshot } from "@wick/core/contracts";
import type { RulesFile } from "@wick/core/rules";
import { loadRisk, loadRules } from "../config.ts";
import type { Db } from "../db/pool.ts";
import { FeatureBook } from "../ingest/features.ts";
import { DecisionLoop, type LoopDeps } from "./loop.ts";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const CREATOR = "Dev1111111111111111111111111111111111111111";
const NOW = 1_700_000_000_000;

type Query = { sql: string; values: unknown[] };

function fakeDb(rows: (sql: string) => unknown[] = () => []): { db: Db; queries: Query[] } {
  const queries: Query[] = [];
  const db = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return { rows: rows(sql), rowCount: 0 };
    },
  } as unknown as Db;
  return { db, queries };
}

function snap(ts: number, liq: number): Snapshot {
  return {
    ts,
    mint: MINT,
    price: 0.001,
    mc: 50_000,
    liq,
    vol5m: 2000,
    vol24: null,
    tx24: null,
    buys5m: 30,
    sells5m: 10,
    holders: 120,
    top10: 20,
    source: "pump.fun",
    statsAt: null,
  };
}

/** A book with one bonding token that satisfies confirmed-entry, dev at 6% (a ×0.5 adjustment). */
function cleanBook(now = NOW): FeatureBook {
  const book = new FeatureBook();
  book.noteToken(MINT, "bonding", now - 600_000);
  book.noteSnapshot(snap(now - 300_000, 6000), 100);
  book.noteSnapshot(snap(now, 8000), 100);
  const audit: Audit = {
    mint: MINT,
    at: now - 1000,
    authorities: { mint: false, freeze: false, program: "token" },
    extensions: { transferFeeBps: 0, hook: false, permanentDelegate: false, defaultFrozen: false },
    decimals: 6,
    supply: 1e9,
    lp: "curve",
    lpRead: null,
  };
  book.noteAudit(audit);
  const launch: LaunchTx = {
    mint: MINT,
    slot: 1,
    sig: "create",
    ts: now - 600_000,
    creator: CREATOR,
    buyers: [{ wallet: CREATOR, slot: 1, sol: 2, pct: 6 }],
    bundlePct: 6,
    sniperPct: 6,
    truncated: false,
  };
  book.noteLaunch(launch);
  return book;
}

function withModes(rules: RulesFile, mode: "shadow" | "suggest" | "auto"): RulesFile {
  return { ...rules, rules: rules.rules.map((r) => ({ ...r, mode })) };
}

type Spy = { quotes: number; pinned: string[] };

function deps(over: Partial<LoopDeps> = {}): LoopDeps & { spy: Spy } {
  const loaded = loadRules("config/rules.yaml");
  const spy: Spy = { quotes: 0, pinned: [] };
  const chain = {
    async quote(): Promise<Quote | null> {
      spy.quotes++;
      return {
        id: "q1",
        at: NOW - 200,
        inAmount: "1",
        outAmount: "2",
        impactPct: 0.8,
        route: null,
      };
    },
  } as unknown as ChainAdapter;
  const d: LoopDeps = {
    db: fakeDb().db,
    chain,
    book: cleanBook(),
    activeMints: () => [MINT],
    rules: loaded.rules,
    rulesHash: loaded.hash,
    codeVersion: "abc1234",
    risk: loadRisk("config/risk.yaml"),
    solUsd: () => 100,
    equitySol: () => 15,
    selfHalt: () => false,
    pin: (m) => spy.pinned.push(m),
    now: () => NOW,
    ...over,
  };
  return Object.assign(d, { spy });
}

const CFG = { tickMs: 1000, quotesPerMinute: 30, bookRefreshMs: 5000 };

function intentRows(queries: Query[]): Query[] {
  return queries.filter((q) => q.sql.includes("insert into intents"));
}
function gateRows(queries: Query[]): unknown[][] {
  const q = queries.find((x) => x.sql.includes("insert into gate_results"));
  if (!q) return [];
  const out: unknown[][] = [];
  for (let i = 0; i < q.values.length; i += 6) out.push(q.values.slice(i, i + 6));
  return out;
}

test("decision loop: a shadow rule writes the intent, six gate rows and the fingerprint, then cools down", async () => {
  const { db, queries } = fakeDb();
  const d = deps({ db });
  const loop = new DecisionLoop(d, CFG);
  await loop.tick();
  const intents = intentRows(queries);
  assert.equal(intents.length, 1, "confirmed-entry fires; migration-snipe wants a migrated token");
  const v = intents[0]!.values;
  assert.equal(v[2], "entry");
  assert.equal(v[4], "confirmed-entry");
  assert.equal(v[5], "shadow");
  assert.equal(v[6], MINT);
  assert.equal(v[7], "buy");
  assert.equal(v[8], 0.1125, "0.225 SOL equity term × supply ×0.5");
  const sizing = JSON.parse(v[9] as string);
  assert.equal(sizing.binding, "equity");
  assert.match(v[11] as string, /supply ×0.5: dev holds 6.0%/);
  assert.equal(v[12], "shadow");
  assert.equal(v[13], null);
  assert.equal(v[15], d.rulesHash);
  assert.equal(v[16], "abc1234");
  assert.equal(v[17], "pump.fun");
  assert.equal(v[18], 90_000);
  const gates = gateRows(queries);
  assert.deepEqual(
    gates.map((g) => g[1]),
    ["safety", "supply", "liquidity", "manipulation", "quote", "risk"],
  );
  assert.ok(gates.every((g) => g[2] === true));
  assert.equal(JSON.parse(gates[1]![4] as string).sizeMul, 0.5);
  assert.equal(d.spy.quotes, 0, "shadow mode never pays for a quote");
  assert.deepEqual(d.spy.pinned, [], "only a pending intent pins its mint");
  assert.equal(loop.state.written, 1);
  await loop.tick();
  assert.equal(intentRows(queries).length, 1, "cooldown holds for the same mint and rule");
});

test("decision loop: suggest mode quotes once, proposes and pins; a failed quote rejects; the budget throttles", async () => {
  const one = fakeDb();
  const d = deps({ db: one.db, rules: withModes(loadRules("config/rules.yaml").rules, "suggest") });
  await new DecisionLoop(d, CFG).tick();
  assert.equal(d.spy.quotes, 1);
  const v = intentRows(one.queries)[0]!.values;
  assert.equal(v[12], "proposed");
  assert.deepEqual(d.spy.pinned, [MINT]);
  assert.ok(gateRows(one.queries).every((g) => g[2] === true));

  const two = fakeDb();
  const failing = deps({
    db: two.db,
    rules: withModes(loadRules("config/rules.yaml").rules, "suggest"),
    chain: {
      async quote() {
        return null;
      },
    } as unknown as ChainAdapter,
  });
  await new DecisionLoop(failing, CFG).tick();
  const rejected = intentRows(two.queries)[0]!.values;
  assert.equal(rejected[12], "rejected");
  assert.match(rejected[11] as string, /rejected by quote: QUOTE_STALE/);
  const rows = gateRows(two.queries);
  assert.equal(rows.length, 5, "the run stops at the quote gate");
  assert.equal(rows[4]![3], "QUOTE_STALE");

  const three = fakeDb();
  const throttled = deps({
    db: three.db,
    rules: withModes(loadRules("config/rules.yaml").rules, "suggest"),
  });
  const loop = new DecisionLoop(throttled, { ...CFG, quotesPerMinute: 0 });
  await loop.tick();
  assert.equal(
    intentRows(three.queries).length,
    0,
    "no quote budget: nothing written, no cooldown",
  );
  assert.equal(throttled.spy.quotes, 0);
});

test("decision loop: an active halt or the health self-halt rejects at the risk gate", async () => {
  const { db, queries } = fakeDb((sql) =>
    sql.includes("from halts") ? [{ kind: "manual", reason: "owner" }] : [],
  );
  await new DecisionLoop(deps({ db }), CFG).tick();
  const rows = gateRows(queries);
  assert.equal(rows[5]![1], "risk");
  assert.equal(rows[5]![3], "RISK_HALT");
  assert.equal(intentRows(queries)[0]!.values[12], "rejected");

  const health = fakeDb();
  await new DecisionLoop(deps({ db: health.db, selfHalt: () => true }), CFG).tick();
  assert.equal(gateRows(health.queries)[5]![3], "RISK_HALT");
});

test("decision loop: an open position past the time exit gets a sell intent through the quote gate only", async () => {
  const { db, queries } = fakeDb((sql) =>
    sql.includes("from positions")
      ? [
          {
            mint: MINT,
            wallet: "W",
            opened_at: new Date(NOW - 5 * 3600_000),
            cost_sol: 0.3,
            created_at: new Date(NOW - 6 * 3600_000),
          },
        ]
      : [],
  );
  const d = deps({ db });
  await new DecisionLoop(d, CFG).tick();
  const intents = intentRows(queries);
  const exit = intents.find((q) => q.values[2] === "exit");
  assert.ok(exit, "an exit intent is written");
  assert.equal(exit.values[7], "sell");
  assert.equal(exit.values[8], 0.3);
  assert.equal(exit.values[4], "exit-policy");
  assert.match(exit.values[11] as string, /stop: held 300m; sell 100%/);
  assert.equal(exit.values[9], null, "no sizing on an exit");
  const exitGates = queries.filter(
    (q) => q.sql.includes("insert into gate_results") && q.values[0] === exit.values[0],
  );
  assert.equal(exitGates.length, 1);
  assert.deepEqual(exitGates[0]!.values.slice(1, 4), ["quote", true, null]);
  assert.equal(exitGates[0]!.values.length, 6, "only the quote gate runs for a sell");
  // The entry side is unaffected: RISK_TOKEN_CAP would need 0.45 SOL; 0.3 + 0.1125 stays under it.
  const entry = intents.find((q) => q.values[2] === "entry")!;
  assert.equal(entry.values[12], "shadow");
});

test("decision loop: no SOL price means no sizing and nothing written", async () => {
  const { db, queries } = fakeDb();
  const loop = new DecisionLoop(deps({ db, solUsd: () => null }), CFG);
  await loop.tick();
  assert.equal(intentRows(queries).length, 0);
  assert.equal(loop.state.skippedNoSolUsd, 1);
  assert.equal(loop.state.evaluated, 1);
});

test("decision loop: a rule the evaluator disabled is skipped, and its weight scales the equity term", async () => {
  const offDb = fakeDb();
  const off = deps({
    db: offDb.db,
    ruleState: (id) => ({ weight: 1, disabled: id === "confirmed-entry" }),
  });
  await new DecisionLoop(off, CFG).tick();
  assert.equal(intentRows(offDb.queries).length, 0, "no intent from a disabled rule");

  const fake = fakeDb();
  const heavy = deps({
    db: fake.db,
    ruleState: (id) => (id === "confirmed-entry" ? { weight: 1.21, disabled: false } : null),
  });
  await new DecisionLoop(heavy, CFG).tick();
  const rows = intentRows(fake.queries);
  assert.equal(rows.length, 1);
  const sizing = JSON.parse(String(rows[0]!.values[9])) as {
    weightMul: number;
    equityTerm: number;
  };
  assert.equal(sizing.weightMul, 1.21);
  assert.ok(Math.abs(sizing.equityTerm - 15 * 0.015 * 1.21) < 1e-9, "equity term × weight");
  assert.match(String(rows[0]!.values[11]), /weight ×1.21/);
});

test("decision loop: regime ×0.5 halves the size and says so; regime ×0 proposes no entry", async () => {
  const half = fakeDb();
  const regime = (sizeMul: 0 | 0.5 | 1) => ({
    at: NOW,
    solChange1hPct: -3,
    breadth5m: 0.5,
    launchesPerHour: 100,
    migrationsPerHour: 5,
    safetyRejectRate1h: 0.1,
    sizeMul,
    reason: "test",
  });
  await new DecisionLoop(deps({ db: half.db, regime: () => regime(0.5) }), CFG).tick();
  const rows = intentRows(half.queries);
  assert.equal(rows.length, 1);
  const sizing = JSON.parse(String(rows[0]!.values[9])) as { regimeMul: number };
  assert.equal(sizing.regimeMul, 0.5);
  assert.match(String(rows[0]!.values[11]), /regime ×0.5/);
  const none = fakeDb();
  await new DecisionLoop(deps({ db: none.db, regime: () => regime(0) }), CFG).tick();
  assert.equal(intentRows(none.queries).length, 0, "no new entries under regime ×0");
});

test("decision loop: a candidate a rule likes asks for a live supply map when the map is launch-time or stale", async () => {
  const asked: string[] = [];
  const d = deps({ refreshSupply: (mint) => asked.push(mint) });
  await new DecisionLoop(d, CFG).tick();
  assert.deepEqual(asked, [MINT], "the launch-time map is older than four minutes");
});

const WALLET = "FoLLow11111111111111111111111111111111111111";
function trade(
  side: "buy" | "sell",
  ts: number | null = NOW - 800,
): import("@wick/core/chain").Trade {
  return {
    sig: `sig-${side}`,
    slot: 9,
    ts,
    wallet: WALLET,
    mint: MINT,
    side,
    sol: 0.4,
    amount: 1e6,
  };
}
const copyRows = (queries: Query[]) =>
  queries.filter((q) => q.sql.includes("insert into events") && q.sql.includes("'copy'"));

test("mirror-follow: a followed wallet's buy becomes an entry at half size with a copy event; a stale print is not copied", async () => {
  const { db, queries } = fakeDb();
  const d = deps({ db });
  const loop = new DecisionLoop(d, CFG);
  await loop.onPrint(trade("buy"), NOW);
  const rows = intentRows(queries);
  assert.equal(rows.length, 1);
  const v = rows[0]!.values;
  assert.equal(v[3], "mirror-follow");
  assert.equal(v[4], "mirror-follow");
  assert.equal(v[7], "buy");
  assert.equal(v[12], "shadow");
  assert.match(String(v[11]), /copy FoLL…1111 buy 0\.400 SOL, gap 800 ms/);
  assert.match(String(v[11]), /rule size ×0\.5/);
  assert.equal(gateRows(queries).length, 6, "the full gate chain runs on a copy");
  const copies = copyRows(queries);
  assert.equal(copies.length, 1);
  const data = JSON.parse(String(copies[0]!.values[1])) as Record<string, unknown>;
  assert.equal(data.wallet, WALLET);
  assert.equal(data.sig, "sig-buy");
  assert.equal(data.gapMs, 800);
  assert.equal(data.intentId, v[0]);
  assert.equal(data.side, "buy");

  await loop.onPrint(trade("buy"), NOW);
  assert.equal(intentRows(queries).length, 1, "the cooldown holds for the same mint and rule");

  const stale = fakeDb();
  await new DecisionLoop(deps({ db: stale.db }), CFG).onPrint(trade("buy", NOW - 31_000), NOW);
  assert.equal(intentRows(stale.queries).length, 0, "older than maxCopyGapMs is not copied");

  const noTs = fakeDb();
  await new DecisionLoop(deps({ db: noTs.db }), CFG).onPrint(trade("buy", null), NOW);
  assert.equal(
    intentRows(noTs.queries).length,
    1,
    "a print without a block time is copied with gap n/a",
  );
  assert.match(String(intentRows(noTs.queries)[0]!.values[11]), /gap n\/a/);
});

test("mirror-follow: a followed wallet's sell closes our position through the quote gate; no position, nothing", async () => {
  const { db, queries } = fakeDb((sql) =>
    sql.includes("from positions")
      ? [
          {
            mint: MINT,
            wallet: "W",
            opened_at: new Date(NOW - 60_000),
            cost_sol: 0.3,
            created_at: new Date(NOW - 600_000),
          },
        ]
      : [],
  );
  const loop = new DecisionLoop(deps({ db }), CFG);
  await loop.tick();
  const before = intentRows(queries).length;
  await loop.onPrint(trade("sell"), NOW);
  const exit = intentRows(queries)
    .slice(before)
    .find((q) => q.values[2] === "exit");
  assert.ok(exit, "an exit intent is written");
  assert.equal(exit.values[3], "mirror-follow");
  assert.equal(exit.values[7], "sell");
  assert.equal(exit.values[8], 0.3);
  assert.match(String(exit.values[11]), /copy FoLL…1111 sell 0\.400 SOL, gap 800 ms; sell 100%/);
  const gates = queries.filter(
    (q) => q.sql.includes("insert into gate_results") && q.values[0] === exit.values[0],
  );
  assert.equal(gates.length, 1);
  assert.equal(gates[0]!.values.length, 6, "only the quote gate runs for a sell");
  assert.equal(copyRows(queries).length, 1);

  const flat = fakeDb();
  await new DecisionLoop(deps({ db: flat.db }), CFG).onPrint(trade("sell"), NOW);
  assert.equal(intentRows(flat.queries).length, 0, "no position in that mint, no exit");
});
