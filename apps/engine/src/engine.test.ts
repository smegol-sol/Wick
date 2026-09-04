import assert from "node:assert/strict";
import test from "node:test";
import { parseEnv, parseRisk } from "./config.ts";
import { splitSql } from "./db/sql.ts";
import { requiredExtension } from "./db/migrate.ts";
import { evaluateHealth, slotLagOf } from "./health.ts";
import { Sampler } from "./ingest/sampler.ts";
import { readMint } from "./chains/solana/extensions.ts";
import { Collector } from "./ingest/collector.ts";
import type { ChainAdapter, LaunchTx, Trade, TxSummary } from "@wick/core/chain";
import type { Audit, Snapshot, Stage } from "@wick/core/contracts";
import { classifyLp, keyBytes, parsePool } from "./chains/solana/lp.ts";
import { parseLaunch, type ParsedTx, type SigInfo } from "./chains/solana/launch.ts";
import { summaryOf, tradesOf } from "./chains/solana/trades.ts";
import { FeatureBook } from "./ingest/features.ts";
import { LogStream, wsUrlOf, type LogEvent } from "./ingest/stream.ts";
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

type FakeChain = ChainAdapter & {
  audits: number;
  tradesBySig: Map<string, Trade[]>;
  summaries: Map<string, TxSummary>;
  launches: number;
  lp: Audit["lp"];
  launch: Omit<LaunchTx, "mint"> | null;
  stage: Stage;
};

function fakeChain(): FakeChain {
  const chain = {
    chain: "solana" as const,
    audits: 0,
    tradesBySig: new Map<string, Trade[]>(),
    summaries: new Map<string, TxSummary>(),
    launches: 0,
    lp: null as Audit["lp"],
    launch: null as Omit<LaunchTx, "mint"> | null,
    stage: "bonding" as Stage,
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
              stage: chain.stage,
              pair:
                chain.stage === "migrated" ? "Poo1111111111111111111111111111111111111111" : null,
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
    async audit({ mint }: { mint: string }) {
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
        lp: chain.lp,
        lpRead: null,
      };
    },
    async launchTx(mint: string) {
      chain.launches++;
      if (!chain.launch) return null;
      return { ...chain.launch, mint };
    },
    async trades(sig: string) {
      return chain.tradesBySig.get(sig) ?? [];
    },
    async txSummary(sig: string) {
      return chain.summaries.get(sig) ?? null;
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
    launchPerTick: 2,
    launchRetryMs: 60_000,
    followRefreshMs: 30_000,
    migrationAuthority: MIGRATOR,
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

const MINT = "So11111111111111111111111111111111111111112";
const MIGRATOR = "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const LP_MINT = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const CREATOR = "Dev1111111111111111111111111111111111111111";
const CURVE = "Curve11111111111111111111111111111111111111";

function raydiumPool(minted: number): Uint8Array {
  const b = new Uint8Array(752);
  b.set(keyBytes(MINT), 400);
  b.set(keyBytes("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), 432);
  b.set(keyBytes(LP_MINT), 464);
  new DataView(b.buffer).setBigUint64(720, BigInt(minted), true);
  return b;
}

function pumpswapPool(minted: number): Uint8Array {
  const b = new Uint8Array(243);
  b.set(keyBytes(MINT), 43);
  b.set(keyBytes(LP_MINT), 107);
  new DataView(b.buffer).setBigUint64(203, BigInt(minted), true);
  return b;
}

test("pool layouts parse and a wrong offset or program yields null", () => {
  const ray = parsePool(
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    raydiumPool(1_000_000),
    MINT,
  );
  assert.equal(ray?.dex, "raydium-v4");
  assert.equal(ray?.lpMint, LP_MINT);
  assert.equal(ray?.lpMinted, 1_000_000);
  const ps = parsePool("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", pumpswapPool(5_000), MINT);
  assert.equal(ps?.dex, "pumpswap");
  assert.equal(ps?.lpMinted, 5_000);
  assert.equal(
    parsePool("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", raydiumPool(1), MINT),
    null,
  );
  assert.equal(
    parsePool("SomeOtherProgram1111111111111111111111111111", raydiumPool(1), MINT),
    null,
  );
  assert.equal(
    parsePool("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", raydiumPool(1), "OtherMint"),
    null,
  );
});

test("LP state: burned, locked, deployer, and unknown without holders", () => {
  const pool = parsePool("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", raydiumPool(1000), MINT)!;
  assert.equal(classifyLp(pool, 40, [{ owner: CREATOR, amount: 40 }]).state, "burned");
  assert.equal(classifyLp(pool, 40, null).state, "burned");
  const locked = classifyLp(pool, 1000, [
    { owner: "LockrWmn6K5twhz3y9w1PDDgVWPqHqk5ApM4Xv5T6Pa", amount: 990 },
    { owner: CREATOR, amount: 10 },
  ]);
  assert.equal(locked.state, "locked");
  assert.equal(locked.topHolderPct, 99);
  assert.equal(classifyLp(pool, 1000, [{ owner: CREATOR, amount: 600 }]).state, "deployer");
  assert.equal(
    classifyLp(pool, 1000, [{ owner: "LockrWmn6K5twhz3y9w1PDDgVWPqHqk5ApM4Xv5T6Pa", amount: 600 }])
      .state,
    "deployer",
  );
  const unknown = classifyLp(pool, 1000, null);
  assert.equal(unknown.state, null);
  assert.equal(unknown.burnedPct, 0);
});

function tx(
  slot: number,
  keys: string[],
  balances: { account: string; owner: string; pre: number; post: number }[],
  lamports: Record<string, [number, number]> = {},
  mint = MINT,
): ParsedTx {
  const accountKeys = keys.map((pubkey, i) => ({ pubkey, signer: i === 0 }));
  const tb = (which: "pre" | "post") =>
    balances.map((b) => ({
      accountIndex: keys.indexOf(b.account),
      mint,
      owner: b.owner,
      uiTokenAmount: { amount: String(b[which]), decimals: 6 },
    }));
  return {
    slot,
    blockTime: 1_700_000_000 + slot,
    transaction: { message: { accountKeys } },
    meta: {
      err: null,
      preBalances: keys.map((k) => lamports[k]?.[0] ?? 0),
      postBalances: keys.map((k) => lamports[k]?.[1] ?? 0),
      preTokenBalances: tb("pre").filter((b) => b.uiTokenAmount.amount !== "0"),
      postTokenBalances: tb("post"),
    },
  };
}

test("launch parse: creator, supply, pools excluded, bundle and sniper shares by slot", () => {
  const S = 100;
  const txs = new Map<string, ParsedTx>([
    [
      "create",
      tx(
        S,
        [CREATOR, MINT, "curveAta", "devAta"],
        [
          { account: "curveAta", owner: CURVE, pre: 0, post: 800 },
          { account: "devAta", owner: CREATOR, pre: 0, post: 200 },
        ],
        { [CREATOR]: [10e9, 8e9] },
      ),
    ],
    [
      "b1",
      tx(
        S + 1,
        ["B1", "b1Ata", "curveAta"],
        [
          { account: "curveAta", owner: CURVE, pre: 800, post: 750 },
          { account: "b1Ata", owner: "B1", pre: 0, post: 50 },
        ],
        { B1: [5e9, 4.5e9] },
      ),
    ],
    [
      "sell",
      tx(
        S + 2,
        ["B1", "b1Ata", "curveAta"],
        [
          { account: "b1Ata", owner: "B1", pre: 50, post: 30 },
          { account: "curveAta", owner: CURVE, pre: 750, post: 770 },
        ],
      ),
    ],
    [
      "b2",
      tx(
        S + 5,
        ["B2", "b2Ata", "curveAta"],
        [
          { account: "curveAta", owner: CURVE, pre: 770, post: 760 },
          { account: "b2Ata", owner: "B2", pre: 0, post: 10 },
        ],
      ),
    ],
    [
      "late",
      tx(
        S + 11,
        ["B3", "b3Ata", "curveAta"],
        [
          { account: "curveAta", owner: CURVE, pre: 760, post: 700 },
          { account: "b3Ata", owner: "B3", pre: 0, post: 60 },
        ],
      ),
    ],
  ]);
  const sigs: SigInfo[] = [
    { signature: "create", slot: S, err: null },
    { signature: "b1", slot: S + 1, err: null },
    { signature: "sell", slot: S + 2, err: null },
    { signature: "b2", slot: S + 5, err: null },
    { signature: "late", slot: S + 11, err: null },
  ];
  const l = parseLaunch(MINT, sigs, txs, false)!;
  assert.equal(l.creator, CREATOR);
  assert.equal(l.slot, S);
  assert.equal(l.ts, (1_700_000_000 + S) * 1000);
  assert.deepEqual(
    l.buyers.map((b) => [b.wallet, b.slot, b.pct, b.sol]),
    [
      [CREATOR, S, 20, 2],
      ["B1", S + 1, 5, 0.5],
      ["B2", S + 5, 1, null],
    ],
  );
  assert.equal(l.bundlePct, 25);
  assert.equal(l.sniperPct, 26);
  assert.equal(parseLaunch(MINT, [], txs, false), null);
});

test("collector parses each launch once, and writes migrate and lp_state events on change", async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const db = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return { rows: [] };
    },
  } as unknown as Db;
  const chain = fakeChain();
  chain.lp = "curve";
  chain.launch = {
    slot: 5,
    sig: "createSig",
    ts: 1_700_000_000_000,
    creator: CREATOR,
    buyers: [],
    bundlePct: 12.5,
    sniperPct: 20,
    truncated: false,
  };
  const c = new Collector(db, chain, {
    activeSampleMs: 5,
    coolingSampleMs: 60_000,
    activeWindowMs: 7_200_000,
    coolingWindowMs: 86_400_000,
    auditEveryMs: 0,
    slotPollMs: 5000,
    launchPerTick: 2,
    launchRetryMs: 0,
    followRefreshMs: 0,
    migrationAuthority: MIGRATOR,
  });
  const tick = async () => {
    await new Promise((r) => setTimeout(r, 8));
    await c.tick();
  };
  await tick();
  const launch = queries.find((q) => q.sql.includes("insert into launch_txs"));
  assert.ok(launch);
  assert.deepEqual(launch.values.slice(1), [5, CREATOR, "[]", 12.5, 20]);
  const events = () =>
    queries.filter((q) => q.sql.includes("insert into chain_events")).map((q) => q.values[2]);
  assert.deepEqual(events(), ["create"]);
  await tick();
  assert.equal(chain.launches, 1, "a parsed launch is not parsed again");
  assert.equal(chain.audits, 2, "the mint was sampled and audited again");

  chain.stage = "migrated";
  chain.lp = "burned";
  await tick();
  assert.deepEqual(events(), ["create", "migrate", "lp_state"]);
  const lp = queries.filter((q) => q.sql.includes("insert into chain_events")).at(-1)!;
  assert.deepEqual(JSON.parse(lp.values[4] as string), {
    source: "poll",
    from: "curve",
    to: "burned",
  });
  assert.equal(
    queries.filter((q) => q.sql.includes("insert into audits")).length,
    2,
    "an LP change is an audit change",
  );
});

test("trades and summary come from balance deltas of signers only", () => {
  const t = tx(
    500,
    ["Trader", "traderAta", "curveAta"],
    [
      { account: "curveAta", owner: CURVE, pre: 900, post: 850 },
      { account: "traderAta", owner: "Trader", pre: 0, post: 50 },
    ],
    { Trader: [3e9, 2.5e9] },
    USDC,
  );
  const trades = tradesOf("sigA", t);
  assert.deepEqual(trades, [
    {
      sig: "sigA",
      slot: 500,
      ts: (1_700_000_000 + 500) * 1000,
      wallet: "Trader",
      mint: USDC,
      side: "buy",
      sol: 0.5,
      amount: 50 / 1e6,
    },
  ]);
  const sum = summaryOf("sigA", t)!;
  assert.deepEqual(sum.signers, ["Trader"]);
  assert.deepEqual(sum.mints, [USDC]);
  assert.equal(sum.holders[USDC], CURVE, "the largest non-signer holder is the pool");
  assert.equal(sum.ok, true);
  assert.deepEqual(tradesOf("x", { ...t, meta: { ...t.meta!, err: { some: 1 } } }), []);
  assert.equal(summaryOf("x", null), null);
});

function fakeSocket() {
  const handlers = new Map<string, ((...a: unknown[]) => void)[]>();
  const sent: { id: number; method: string; params: unknown[] }[] = [];
  const sock = {
    readyState: 1,
    send: (d: string) => sent.push(JSON.parse(d)),
    close: () => sock.emit("close"),
    on: (ev: string, cb: (...a: unknown[]) => void) => {
      handlers.set(ev, [...(handlers.get(ev) ?? []), cb]);
    },
    emit: (ev: string, ...a: unknown[]) => {
      for (const cb of handlers.get(ev) ?? []) cb(...a);
    },
    sent,
  };
  return sock;
}

test("log stream subscribes to the wanted set, maps notifications, and resubscribes after a drop", () => {
  const events: LogEvent[] = [];
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const stream = new LogStream("wss://rpc.example", {
    onEvent: (e) => events.push(e),
    connect: () => {
      const s = fakeSocket();
      sockets.push(s);
      return s;
    },
    backoffMs: 1,
  });
  stream.setAddresses(["A", "B"]);
  stream.start();
  const s1 = sockets[0]!;
  s1.emit("open");
  assert.deepEqual(
    s1.sent.map((m) => [m.method, (m.params[0] as { mentions: string[] }).mentions[0]]),
    [
      ["logsSubscribe", "A"],
      ["logsSubscribe", "B"],
    ],
  );
  stream.onMessage(JSON.stringify({ jsonrpc: "2.0", id: s1.sent[0]!.id, result: 11 }));
  stream.onMessage(JSON.stringify({ jsonrpc: "2.0", id: s1.sent[1]!.id, result: 12 }));
  assert.equal(stream.state.subscribed, 2);
  stream.onMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "logsNotification",
      params: {
        subscription: 12,
        result: { context: { slot: 77 }, value: { signature: "sigB", err: null, logs: ["x"] } },
      },
    }),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]!.address, "B");
  assert.equal(events[0]!.slot, 77);
  stream.setAddresses(["B", "C"]);
  const after = s1.sent.slice(2).map((m) => m.method);
  assert.deepEqual(after, ["logsSubscribe", "logsUnsubscribe"]);
  assert.equal(stream.state.subscribed, 1);
  s1.emit("close");
  assert.equal(stream.state.connected, false);
  stream.stop();
  assert.equal(
    wsUrlOf("https://mainnet.helius-rpc.com/?api-key=k"),
    "wss://mainnet.helius-rpc.com/?api-key=k",
  );
});

test("feature book: flow and depth from reserves, stream counts, follow prints, and null when unknown", () => {
  const book = new FeatureBook();
  const t0 = 1_700_000_000_000;
  const snap = (ts: number, liq: number): Snapshot => ({
    ts,
    mint: MINT,
    price: 0.001,
    mc: 1000,
    liq,
    vol5m: null,
    vol24: null,
    tx24: null,
    buys5m: 4,
    sells5m: 1,
    holders: 100,
    top10: null,
    source: "pump.fun",
    statsAt: null,
  });
  assert.equal(book.features(MINT, t0), null, "nothing known yet");
  book.noteToken(MINT, "bonding", t0 - 120_000);
  book.noteSnapshot(snap(t0 - 300_000, 1000), 100);
  book.noteSnapshot(snap(t0 - 70_000, 1500), 100);
  book.noteSnapshot(snap(t0, 2000), 100);
  const micro = book.micro(MINT, t0)!;
  assert.equal(micro.netFlowSol1m, 5, "1,500 to 2,000 USD at 100 USD/SOL");
  assert.equal(micro.netFlowSol5m, 10);
  assert.ok(Math.abs(micro.depthBuy2PctUsd! - (20 + 30) * (Math.sqrt(1.02) - 1) * 100) < 1e-9);
  assert.equal(micro.organicVolPct5m, null);
  book.noteTradeSeen(MINT, "buy", t0 - 500);
  book.noteTradeSeen(MINT, "buy", t0 - 400);
  book.noteTradeSeen(MINT, "sell", t0 - 90_000);
  assert.deepEqual(book.counts(MINT, t0, 60_000), { buys: 2, sells: 0 });
  assert.deepEqual(book.counts(MINT, t0, 300_000), { buys: 2, sells: 1 });
  assert.equal(book.counts("other", t0, 60_000), null);
  book.notePrint(
    { sig: "p1", slot: 1, ts: t0 - 1000, wallet: "W", mint: MINT, side: "buy", sol: 1, amount: 5 },
    t0,
  );
  const f = book.features(MINT, t0)!;
  assert.equal(f.ageSec, 120);
  assert.equal(f.stage, "bonding");
  assert.equal(f.followBuys3m, 1);
  assert.equal(f.uniqueBuyers5m, null);
  assert.equal(f.supply, null);
  assert.equal(f.micro?.netFlowSol1m, 5);
});

test("collector: prints from followed wallets, migrations from the authority, trade counts into microstructure", async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const db = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes("from wallets")) return { rows: [{ pk: "Follower" }] };
      return { rows: [] };
    },
  } as unknown as Db;
  const chain = fakeChain();
  chain.tradesBySig.set("printSig", [
    {
      sig: "printSig",
      slot: 9,
      ts: 1_700_000_000_000,
      wallet: "Follower",
      mint: "M2",
      side: "sell",
      sol: 0.7,
      amount: 12,
    },
    {
      sig: "printSig",
      slot: 9,
      ts: 1_700_000_000_000,
      wallet: "Other",
      mint: "M2",
      side: "buy",
      sol: 0.7,
      amount: 12,
    },
  ]);
  chain.summaries.set("migSig", {
    sig: "migSig",
    slot: 20,
    ts: 1_700_000_000_000,
    ok: true,
    signers: [MIGRATOR],
    mints: [MINT],
    holders: { [MINT]: "PoolPda" },
  });
  const c = new Collector(db, chain, {
    activeSampleMs: 5,
    coolingSampleMs: 60_000,
    activeWindowMs: 7_200_000,
    coolingWindowMs: 86_400_000,
    auditEveryMs: 600_000,
    slotPollMs: 5000,
    launchPerTick: 0,
    launchRetryMs: 60_000,
    followRefreshMs: 0,
    migrationAuthority: MIGRATOR,
  });
  await c.tick();
  const at = Date.now();
  await c.onLog({ address: "Follower", signature: "printSig", slot: 9, err: null, logs: [], at });
  const print = queries.find((q) => q.sql.includes("insert into wallet_prints"));
  assert.ok(print, "one print for the followed wallet only");
  assert.equal(print.values[1], "Follower");
  assert.equal(print.values[5], "sell");
  assert.equal(queries.filter((q) => q.sql.includes("insert into wallet_prints")).length, 1);

  await c.onLog({
    address: MIGRATOR,
    signature: "migSig",
    slot: 20,
    err: null,
    logs: ["Program log: Instruction: Migrate"],
    at,
  });
  const mig = queries.find(
    (q) => q.sql.includes("insert into chain_events") && q.values[2] === "migrate",
  );
  assert.ok(mig);
  assert.equal(mig.values[3], "migSig");
  assert.equal(JSON.parse(mig.values[4] as string).pair, "PoolPda");
  await c.onLog({ address: MIGRATOR, signature: "migSig", slot: 20, err: null, logs: ["x"], at });
  assert.equal(
    queries.filter((q) => q.values[2] === "migrate").length,
    1,
    "a signature is handled once",
  );

  await c.onLog({
    address: MINT,
    signature: "t1",
    slot: 21,
    err: null,
    logs: ["Program log: Instruction: Buy"],
    at,
  });
  await c.onLog({
    address: MINT,
    signature: "t2",
    slot: 21,
    err: null,
    logs: ["Program log: Instruction: Sell"],
    at,
  });
  await c.onLog({
    address: MINT,
    signature: "t3",
    slot: 21,
    err: { failed: 1 },
    logs: ["Program log: Instruction: Buy"],
    at,
  });
  await new Promise((r) => setTimeout(r, 8));
  await c.tick();
  const micro = queries.filter((q) => q.sql.includes("insert into microstructure")).at(-1)!;
  assert.ok(micro);
  assert.equal(micro.values[1], MINT);
  assert.equal(micro.values[7], 1, "buys_1m counts the successful buy");
  assert.equal(micro.values[8], 1, "sells_1m");
  assert.equal(micro.values[11], null, "unique buyers stay unknown");
  assert.ok(c.book.features(MINT, Date.now()), "features assemble for the active mint");
});
