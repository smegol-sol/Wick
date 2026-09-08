import assert from "node:assert/strict";
import test from "node:test";
import type { LaunchTx } from "@wick/core/chain";
import type { Audit } from "@wick/core/contracts";
import { bondingCurveOf } from "@wick/core/supply";
import type { Db } from "../db/pool.ts";
import { SupplyWriter } from "./supply.ts";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const T = 1_700_000_000_000;

function fixture(over: { budgetHolders?: number; budgetWallets?: number } = {}) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const profiles = new Map<
    string,
    { class: string; confidence: number; stats: unknown; profiled_at: Date }
  >();
  const db = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes("from wallet_profiles")) {
        const p = profiles.get(String(values[0]));
        return { rows: p ? [p] : [] };
      }
      if (sql.includes("insert into wallet_profiles"))
        profiles.set(String(values[0]), {
          class: String(values[1]),
          confidence: Number(values[2]),
          stats: JSON.parse(String(values[3])),
          profiled_at: values[4] as Date,
        });
      if (sql.includes("from launch_txs"))
        return { rows: [{ n: values[0] === "Snipe" ? "4" : "0" }] };
      if (sql.includes("select inputs from supply_maps"))
        return { rows: [{ inputs: { earlyPct: 40 } }] };
      return { rows: [] };
    },
  } as unknown as Db;
  const curve = bondingCurveOf(MINT);
  const reads = { holders: 0, sigs: [] as string[] };
  const chain = {
    async holders() {
      reads.holders++;
      return [
        { account: "a", owner: curve, amount: 700_000 },
        { account: "b", owner: "Dev", amount: 80_000 },
        { account: "c", owner: "Snipe", amount: 100_000 },
        { account: "d", owner: "New", amount: 20_000 },
        { account: "e", owner: "Old", amount: 100_000 },
      ];
    },
    async signaturesSince(wallet: string) {
      reads.sigs.push(wallet);
      if (wallet === "New")
        return [{ signature: "s1", slot: 1, err: null, blockTime: T / 1000 - 600 }];
      return Array.from({ length: 5 }, (_, i) => ({
        signature: `s${i}`,
        slot: i,
        err: null,
        blockTime: T / 1000 - 1e6,
      }));
    },
  };
  const audit: Audit = {
    mint: MINT,
    at: T,
    authorities: null,
    extensions: null,
    decimals: 6,
    supply: 1_000_000,
    lp: "curve",
  };
  const launch: LaunchTx = {
    mint: MINT,
    slot: 100,
    sig: "create",
    ts: T - 600_000,
    creator: "Dev",
    buyers: [
      { wallet: "Dev", slot: 100, sol: 1, pct: 8 },
      { wallet: "Snipe", slot: 105, sol: 1, pct: 10 },
    ],
    bundlePct: 8,
    sniperPct: 18,
    truncated: false,
  };
  const maps: { mint: string; devPct: number | null }[] = [];
  const w = new SupplyWriter(
    {
      db,
      chain,
      inputs: () => ({ audit, launch }),
      token: () => ({ stage: "bonding", pair: null }),
      onMap: (mint, map) => maps.push({ mint, devPct: map.devPct }),
      now: () => T,
    },
    {
      holderReadsPerHour: over.budgetHolders ?? 10,
      walletReadsPerHour: over.budgetWallets ?? 10,
      minIntervalMs: 240_000,
      profilePerMap: 10,
    },
  );
  return { w, queries, reads, maps, profiles };
}

test("supply writer: serves a request with one holder read, profiles the owners, writes the map and hands it to the book", async () => {
  const { w, queries, reads, maps, profiles } = fixture();
  w.request(MINT);
  w.request(MINT);
  assert.equal(w.state.queue, 1, "deduplicated");
  await w.tick();
  assert.equal(reads.holders, 1);
  assert.deepEqual(reads.sigs.sort(), ["Dev", "New", "Old", "Snipe"], "the curve is not a wallet");
  const row = queries.find((q) => q.sql.includes("insert into supply_maps"))!;
  assert.equal(row.values[2], 8, "dev 80k of 1M");
  assert.equal(row.values[4], 10, "the sniper's current share");
  assert.equal(row.values[5], 2, "the fresh wallet holds 2% of supply");
  assert.equal(row.values[6], 70, "the curve holds 70%");
  assert.equal(row.values[8], "distributing", "40% early before, 18% now");
  const inputs = JSON.parse(String(row.values[9])) as {
    holders: { wallet: string; class: string | null }[];
    profiled: number;
  };
  assert.equal(inputs.profiled, 4);
  assert.equal(inputs.holders.find((h) => h.wallet === "Snipe")?.class, "sniper-bot");
  assert.equal(inputs.holders.find((h) => h.wallet === "New")?.class, "unknown");
  assert.equal(profiles.get("Old")?.class, "organic");
  assert.deepEqual(maps, [{ mint: MINT, devPct: 8 }]);
  w.request(MINT);
  assert.equal(w.state.queue, 0, "not re-read inside the minimum interval");
});

test("supply writer: the wallet budget leaves holders unprofiled, the holder budget defers the request", async () => {
  const thin = fixture({ budgetWallets: 2 });
  thin.w.request(MINT);
  await thin.w.tick();
  assert.equal(thin.reads.sigs.length, 2, "two wallet reads, then the budget");
  const row = thin.queries.find((q) => q.sql.includes("insert into supply_maps"))!;
  assert.equal((JSON.parse(String(row.values[9])) as { profiled: number }).profiled, 2);
  const none = fixture({ budgetHolders: 0 });
  none.w.request(MINT);
  await none.w.tick();
  assert.equal(none.reads.holders, 0);
  assert.equal(none.w.state.skippedBudget, 1);
  assert.equal(none.w.state.queue, 1, "kept for the next hour");
  assert.equal(none.maps.length, 0);
});
