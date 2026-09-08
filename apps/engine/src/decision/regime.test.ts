import assert from "node:assert/strict";
import test from "node:test";
import type { Db } from "../db/pool.ts";
import { RegimeWriter } from "./regime.ts";

const T = 1_700_000_000_000;

test("regime writer: samples SOL, reads the six inputs, writes one row a minute and exposes the current one", async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const db = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes("from sol_price")) return { rows: [{ usd: 104 }] };
      if (sql.includes("from token_snapshots")) return { rows: [{ up: "4", n: "12" }] };
      if (sql.includes("percentile_cont")) return { rows: [{ median: 90, hours: "48" }] };
      if (sql.includes("from chain_events where kind = $1"))
        return { rows: [{ n: values[0] === "create" ? "20" : "3" }] };
      if (sql.includes("g.gate = 'safety'")) return { rows: [{ rejected: "3", n: "20" }] };
      return { rows: [] };
    },
  } as unknown as Db;
  const w = new RegimeWriter({
    db,
    solUsd: () => 100,
    activeMints: () => Array.from({ length: 12 }, (_, i) => `M${i}`),
    now: () => T,
  });
  assert.equal(w.current(), null);
  await w.tick();
  const r = w.current()!;
  assert.equal(r.solChange1hPct, -3.8, "100 against 104 an hour ago");
  assert.equal(r.breadth5m, 0.333);
  assert.equal(r.launchesPerHour, 20);
  assert.equal(r.migrationsPerHour, 3);
  assert.equal(r.safetyRejectRate1h, 0.15);
  assert.equal(r.sizeMul, 0.5);
  assert.match(
    r.reason,
    /^half size: SOL -3\.8% in 1h; breadth 33%; launches 20\/h under a third of the 7d median 90/,
  );
  const sample = queries.find((q) => q.sql.includes("insert into sol_price"))!;
  assert.deepEqual(sample.values, [new Date(T), 100]);
  const row = queries.find((q) => q.sql.includes("insert into regime"))!;
  assert.equal(row.values[6], 0.5);
  assert.equal(row.values[7], r.reason);
});

test("regime writer: under ten active tokens breadth is unknown and nothing halves on it", async () => {
  const db = {
    query: async (sql: string) => {
      if (sql.includes("from sol_price")) return { rows: [] };
      if (sql.includes("percentile_cont")) return { rows: [{ median: null, hours: "3" }] };
      if (sql.includes("from chain_events where kind = $1")) return { rows: [{ n: "0" }] };
      if (sql.includes("g.gate = 'safety'")) return { rows: [{ rejected: "0", n: "2" }] };
      return { rows: [] };
    },
  } as unknown as Db;
  const w = new RegimeWriter({ db, solUsd: () => null, activeMints: () => ["a"], now: () => T });
  await w.tick();
  const r = w.current()!;
  assert.equal(r.sizeMul, 1);
  assert.equal(r.breadth5m, null);
  assert.equal(r.solChange1hPct, null);
  assert.match(r.reason, /SOL 1h, breadth, safety rejects unknown/);
});
