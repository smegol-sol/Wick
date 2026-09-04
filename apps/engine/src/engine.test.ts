import assert from "node:assert/strict";
import test from "node:test";
import { parseEnv, parseRisk } from "./config.ts";
import { splitSql } from "./db/sql.ts";
import { requiredExtension } from "./db/migrate.ts";
import { evaluateHealth, slotLagOf } from "./health.ts";
import { Sampler } from "./ingest/sampler.ts";
import { readMint } from "./chains/solana/extensions.ts";
import { Collector } from "./ingest/collector.ts";
import type { ChainAdapter } from "@wick/core/chain";
import type { Db } from "./db/pool.ts";
import { REASON_CODES, REASON_CODE_CAP, GATES } from "@wick/core/contracts";

const RISK = `
tier: 1
executionWalletCapSol: 15
perTradePct: 1.5
poolSharePct: 1
minTradeSol: 0.05
maxOpenPositions: 6
maxTokenExposurePct: 3
youngTokenExposurePct: 50
dailyHaltPct: -5
weeklyHaltPct: -10
losingStreakToSuggest: 4
postLossDayMul: 0.5
socialMulMin: 0.8
socialMulMax: 1.2
priorityFeeCapSol: 0.002
feeReserveSol: 0.05
quote: { maxAgeMs: 3000, maxImpactEntryPct: 3, maxImpactExitPct: 5, minHopLiquidityUsd: 10000 }
health: { maxSlotLag: 20, maxSourceAgeSec: 30, decisionBudgetMs: 50, budgetBreachMinutes: 5 }
`;

test("risk.yaml is validated against the capital ladder", () => {
  const r = parseRisk(RISK);
  assert.equal(r.tier, 1);
  assert.equal(r.executionWalletCapSol, 15);
  assert.throws(
    () => parseRisk(RISK.replace("executionWalletCapSol: 15", "executionWalletCapSol: 40")),
    /exceeds the tier 1 cap/,
  );
  assert.throws(() => parseRisk(RISK.replace("tier: 1", "tier: 4")), /tier must be/);
  assert.throws(() => parseRisk(RISK.replace("dailyHaltPct: -5", "dailyHaltPct: 5")), /negative/);
  assert.throws(() => parseRisk(RISK.replace("perTradePct: 1.5", "perTradePct: 2")), /perTradePct/);
});

test("env parsing requires the database and refuses plain http", () => {
  assert.throws(() => parseEnv({}), /DATABASE_URL/);
  const c = parseEnv({ DATABASE_URL: "postgres://x", SOLANA_RPC_URL: "https://rpc.example" });
  assert.equal(c.httpHost, "127.0.0.1");
  assert.equal(c.httpPort, 9464);
  assert.equal(c.activeSampleMs, 1000);
  assert.equal(c.coolingSampleMs, 60_000);
  assert.throws(
    () => parseEnv({ DATABASE_URL: "postgres://x", SOLANA_RPC_URL: "http://rpc" }),
    /https/,
  );
  assert.throws(() => parseEnv({ DATABASE_URL: "postgres://x", LOG_LEVEL: "loud" }), /LOG_LEVEL/);
});

test("sql splitter respects comments, strings and $$ bodies", () => {
  const sql = `-- a comment; with a semicolon
create table t (a text default 'x;y');
select 1;
do $$ begin perform 1; end $$;
`;
  const parts = splitSql(sql);
  assert.equal(parts.length, 3);
  assert.equal(parts[0], "create table t (a text default 'x;y')");
  assert.ok(parts[2].startsWith("do $$"));
});

test("conditional migrations declare their extension", () => {
  assert.equal(requiredExtension("-- requires: timescaledb\nselect 1;"), "timescaledb");
  assert.equal(requiredExtension("-- plain\nselect 1;"), null);
});

test("sampler moves mints from active to cooling to dropped and paces samples", () => {
  const s = new Sampler({
    activeSampleMs: 1000,
    coolingSampleMs: 60_000,
    activeWindowMs: 7_200_000,
    coolingWindowMs: 86_400_000,
  });
  const t0 = 1_000_000;
  s.seen("A", t0);
  assert.deepEqual(s.due(t0), { active: ["A"], cooling: [] });
  s.sampled(["A"], t0);
  assert.deepEqual(s.due(t0 + 500), { active: [], cooling: [] });
  assert.deepEqual(s.due(t0 + 1000), { active: ["A"], cooling: [] });
  const t1 = t0 + 7_200_001;
  assert.equal(s.tierOf("A", t1), "cooling");
  assert.deepEqual(s.due(t1), { active: [], cooling: ["A"] });
  s.sampled(["A"], t1);
  assert.deepEqual(s.due(t1 + 30_000), { active: [], cooling: [] });
  assert.deepEqual(s.due(t1 + 60_000), { active: [], cooling: ["A"] });
  s.pin("A", true, t1);
  assert.equal(s.tierOf("A", t1), "active");
  s.pin("A", false, t1);
  const t2 = t0 + 86_400_001;
  assert.equal(s.tierOf("A", t2), "dropped");
  s.due(t2);
  assert.equal(s.mints.size, 0);
});

test("slot lag and health self-halt", () => {
  assert.equal(slotLagOf([]), null);
  assert.equal(
    slotLagOf([
      { url: "a", slot: 100, ms: 1 },
      { url: "b", slot: 130, ms: 1 },
    ]),
    30,
  );
  assert.equal(
    slotLagOf([
      { url: "a", slot: null, ms: 1 },
      { url: "b", slot: 130, ms: 1 },
    ]),
    null,
  );
  const limits = {
    maxSlotLag: 20,
    maxSourceAgeSec: 30,
    decisionBudgetMs: 50,
    budgetBreachMinutes: 5,
    requiredSources: ["pump.fun", "rpc"],
  };
  const now = 10_000_000;
  const ok = evaluateHealth(
    {
      now,
      lastOk: { "pump.fun": now - 5000, rpc: now - 1000 },
      slotLag: 3,
      decisionP99Ms: 10,
      budgetBreachSince: null,
      dbOk: true,
    },
    limits,
  );
  assert.equal(ok.selfHalt, false);
  const stale = evaluateHealth(
    {
      now,
      lastOk: { "pump.fun": now - 45_000, rpc: now - 1000 },
      slotLag: 3,
      decisionP99Ms: 10,
      budgetBreachSince: null,
      dbOk: true,
    },
    limits,
  );
  assert.equal(stale.selfHalt, true);
  assert.match(stale.reasons[0], /pump\.fun stale/);
  const lag = evaluateHealth(
    {
      now,
      lastOk: { "pump.fun": now, rpc: now },
      slotLag: 25,
      decisionP99Ms: 10,
      budgetBreachSince: null,
      dbOk: true,
    },
    limits,
  );
  assert.match(lag.reasons[0], /slot lag 25/);
  const slow = evaluateHealth(
    {
      now,
      lastOk: { "pump.fun": now, rpc: now },
      slotLag: 0,
      decisionP99Ms: 80,
      budgetBreachSince: now - 6 * 60_000,
      dbOk: true,
    },
    limits,
  );
  assert.match(slow.reasons[0], /decision p99/);
  const brief = evaluateHealth(
    {
      now,
      lastOk: { "pump.fun": now, rpc: now },
      slotLag: 0,
      decisionP99Ms: 80,
      budgetBreachSince: now - 60_000,
      dbOk: true,
    },
    limits,
  );
  assert.equal(brief.selfHalt, false);
  const never = evaluateHealth(
    { now, lastOk: {}, slotLag: null, decisionP99Ms: null, budgetBreachSince: null, dbOk: false },
    limits,
  );
  assert.equal(never.reasons.length, 3);
});

test("token-2022 extensions are read from a parsed mint account", () => {
  const plain = readMint({
    data: {
      program: "spl-token",
      parsed: {
        type: "mint",
        info: {
          mintAuthority: null,
          freezeAuthority: "F",
          decimals: 6,
          supply: "1000000000000000",
        },
      },
    },
  });
  assert.ok(plain);
  assert.deepEqual(plain.authorities, { mint: false, freeze: true, program: "token" });
  assert.equal(plain.supply, 1_000_000_000);
  assert.deepEqual(plain.extensions, {
    transferFeeBps: 0,
    hook: false,
    permanentDelegate: false,
    defaultFrozen: false,
  });
  const t22 = readMint({
    data: {
      program: "spl-token-2022",
      parsed: {
        type: "mint",
        info: {
          mintAuthority: "M",
          freezeAuthority: null,
          decimals: 9,
          supply: "5000000000",
          extensions: [
            {
              extension: "transferFeeConfig",
              state: {
                newerTransferFee: { transferFeeBasisPoints: 300 },
                olderTransferFee: { transferFeeBasisPoints: 100 },
              },
            },
            { extension: "transferHook", state: { programId: "H" } },
            { extension: "permanentDelegate", state: { delegate: "D" } },
            { extension: "defaultAccountState", state: { accountState: "frozen" } },
          ],
        },
      },
    },
  });
  assert.ok(t22);
  assert.equal(t22.authorities.program, "token2022");
  assert.deepEqual(t22.extensions, {
    transferFeeBps: 300,
    hook: true,
    permanentDelegate: true,
    defaultFrozen: true,
  });
  assert.equal(readMint({ data: { parsed: { type: "account" } } }), null);
  assert.equal(readMint(null), null);
});

test("reason codes stay inside the ADR-0008 budget", () => {
  assert.equal(GATES.length, 7);
  assert.ok(
    REASON_CODES.length <= REASON_CODE_CAP + 2,
    "24 codes documented; the constant list must not grow past the cap",
  );
  assert.equal(new Set(REASON_CODES).size, REASON_CODES.length);
});

function fakeChain(): ChainAdapter & { audits: number } {
  const chain = {
    chain: "solana" as const,
    audits: 0,
    async poll() {
      const at = Date.now();
      return [
        {
          source: "pump.fun",
          at,
          solUsd: 100,
          tokens: [
            {
              mint: "So11111111111111111111111111111111111111112",
              symbol: "WSOL",
              name: "Wrapped SOL",
              creator: null,
              createdAt: at - 60_000,
              stage: "bonding" as const,
              snapshot: {
                ts: at,
                mint: "So11111111111111111111111111111111111111112",
                price: 1,
                mc: 1000,
                liq: 500,
                vol5m: null,
                vol24: null,
                tx24: null,
                buys5m: null,
                sells5m: null,
                holders: null,
                top10: null,
                source: "pump.fun",
                statsAt: null,
              },
            },
          ],
        },
      ];
    },
    async stats() {
      return [];
    },
    async audit(mint: string) {
      chain.audits++;
      return {
        mint,
        at: Date.now(),
        authorities: { mint: false, freeze: false, program: "token" as const },
        extensions: {
          transferFeeBps: 0,
          hook: false,
          permanentDelegate: false,
          defaultFrozen: false,
        },
        decimals: 9,
        supply: 1e9,
        lp: null,
      };
    },
    async launchTx() {
      return null;
    },
    async quote() {
      return null;
    },
    async buildTx(): Promise<never> {
      throw new Error("no");
    },
    async simulate(): Promise<never> {
      throw new Error("no");
    },
    async sign(): Promise<never> {
      throw new Error("no");
    },
    async send(): Promise<never> {
      throw new Error("no");
    },
    async confirm(): Promise<never> {
      throw new Error("no");
    },
    async balances(): Promise<never> {
      throw new Error("no");
    },
    async slots() {
      return [
        { url: "primary", slot: 1000, ms: 1 },
        { url: "public", slot: 1004, ms: 1 },
      ];
    },
  };
  return chain;
}

test("collector writes tokens, snapshots and one audit per change, and feeds health", async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const db = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return { rows: [] };
    },
  } as unknown as Db;
  const chain = fakeChain();
  const c = new Collector(db, chain, {
    activeSampleMs: 1000,
    coolingSampleMs: 60_000,
    activeWindowMs: 7_200_000,
    coolingWindowMs: 86_400_000,
    auditEveryMs: 600_000,
    slotPollMs: 5000,
  });
  await c.tick();
  await c.pollSlots();
  const kinds = queries.map((q) => q.sql.trim().slice(0, 30));
  assert.ok(kinds.some((k) => k.startsWith("insert into tokens")));
  const snap = queries.find((q) => q.sql.includes("insert into token_snapshots"));
  assert.ok(snap);
  assert.equal(snap.values.length, 14);
  assert.equal(snap.values[1], "So11111111111111111111111111111111111111112");
  assert.equal(snap.values[12], "pump.fun");
  assert.equal(queries.filter((q) => q.sql.includes("insert into audits")).length, 1);
  await c.tick();
  assert.equal(chain.audits, 1, "second tick inside auditEveryMs must not re-audit");
  assert.equal(queries.filter((q) => q.sql.includes("insert into audits")).length, 1);
  assert.equal(c.state.slotLag, 4);
  assert.ok(c.state.lastOk["pump.fun"]);
  assert.ok(c.state.lastOk["jupiter-price"]);
  assert.ok(c.state.lastOk.rpc);
  assert.deepEqual(c.sampler.counts(Date.now()), { active: 1, cooling: 0 });
});
