import assert from "node:assert/strict";
import test from "node:test";
import { loadRules } from "../config.ts";
import type { Db } from "../db/pool.ts";
import { Evaluator } from "./evaluator.ts";
import { writeOutcomes } from "./outcomes.ts";

const T = 1_700_000_000_000;
type Query = { sql: string; values: unknown[] };

/** A fake pool that answers by SQL shape; every statement is recorded. */
function fakeDb(answer: (sql: string, values: unknown[]) => unknown[]): {
  db: Db;
  queries: Query[];
} {
  const queries: Query[] = [];
  const db = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return { rows: answer(sql, values), rowCount: 0 };
    },
  } as unknown as Db;
  return { db, queries };
}

test("outcomes: a due intent gets its return, best and worst from the snapshots; no snapshots means an empty row", async () => {
  const { db, queries } = fakeDb((sql, values) => {
    if (sql.includes("from intents i") && sql.includes("not exists")) {
      // Only the 5-minute horizon has anything due; the others are empty.
      if (values[1] !== 300) return [];
      return [
        { id: "i1", ts: new Date(T), mint: "M1", price: 2 },
        { id: "i2", ts: new Date(T), mint: "M2", price: 2 },
      ];
    }
    if (sql.includes("from token_snapshots")) {
      if (values[0] === "M1")
        return [
          { ts: new Date(T + 30_000), price: 2.5 },
          { ts: new Date(T + 200_000), price: 1.5 },
          { ts: new Date(T + 290_000), price: 2.2 },
        ];
      return [];
    }
    return [];
  });
  const r = await writeOutcomes(db, T + 3_600_000);
  assert.deepEqual(r, { measured: 1, empty: 1 });
  const inserts = queries.filter((q) => q.sql.includes("insert into outcomes"));
  assert.equal(inserts.length, 2);
  assert.deepEqual(inserts[0]!.values, ["i1", 300, 10, 25, -25]);
  assert.deepEqual(inserts[1]!.values, ["i2", 300, null, null, null], "empty, never retried");
});

function rows(n: number, ret: number) {
  return Array.from({ length: n }, () => ({
    side: "buy",
    ret_pct: ret,
    min_ret_pct: ret - 5,
    max_ret_pct: ret + 5,
  }));
}

test("evaluator: one daily row per rule with the move and its reason; a second run the same day writes nothing", async () => {
  const loaded = loadRules("config/rules.yaml");
  let latest: Record<string, unknown>[] = [];
  const { db, queries } = fakeDb((sql) => {
    if (sql.includes("select distinct on (rule_id)")) return latest;
    if (sql.includes("join outcomes o on") && sql.includes("i.rule_id = $1")) return rows(25, 4);
    if (sql.includes("as suggested"))
      return [{ suggested: "0", approved: "0", decided: "0", executed_expectancy: null }];
    if (sql.includes("from rule_stats where rule_id")) return [];
    return [];
  });
  const ev = new Evaluator(
    { db, rules: loaded.rules, now: () => T },
    { outcomesEveryMs: 60_000, statsEveryMs: 3_600_000 },
  );
  assert.equal(
    ev.state("confirmed-entry")?.weight,
    1,
    "the file's weight until a row says otherwise",
  );
  await ev.evaluate(T);
  const writes = queries.filter((q) => q.sql.includes("insert into rule_stats"));
  assert.equal(writes.length, loaded.rules.rules.length, "one row per rule");
  const ce = writes.find((w) => w.values[0] === "confirmed-entry")!;
  assert.equal(ce.values[2], 25, "n");
  assert.equal(ce.values[4], 0.04, "expectancy stored as a fraction");
  assert.equal(ce.values[6], 1.1, "one step up");
  assert.equal(ce.values[9], false, "not disabled");
  assert.match(String(ce.values[8]), /weight 1 → 1.1; p25\/p50\/p75 4\/4\/4%/);
  // The next load sees today's row, so a second evaluation the same day is a no-op.
  latest = loaded.rules.rules.map((r) => ({
    rule_id: r.id,
    window_days: 14,
    n: 25,
    win_rate: 1,
    expectancy: 0.04,
    worst_dd: -0.01,
    weight: 1.1,
    changed_at: new Date(T),
    change_reason: "x",
    disabled: false,
  }));
  await ev.evaluate(T + 3_600_000);
  assert.equal(
    queries.filter((q) => q.sql.includes("insert into rule_stats")).length,
    writes.length,
  );
  assert.equal(ev.state("confirmed-entry")?.weight, 1.1, "the loop reads the moved weight");
  assert.equal(ev.view()[0]?.stats?.n, 25);
});

test("evaluator: seven negative days disable a rule; only the operator's enable brings it back at the floor", async () => {
  const loaded = loadRules("config/rules.yaml");
  let latest: Record<string, unknown>[] = [];
  const { db, queries } = fakeDb((sql, values) => {
    if (sql.includes("select distinct on (rule_id)")) return latest;
    if (sql.includes("join outcomes o on"))
      return values[0] === "confirmed-entry" ? rows(30, -3) : [];
    if (sql.includes("as suggested"))
      return [{ suggested: "0", approved: "0", decided: "0", executed_expectancy: null }];
    if (sql.includes("from rule_stats where rule_id"))
      return values[0] === "confirmed-entry"
        ? Array.from({ length: 6 }, () => ({ n: 30, expectancy: -0.03 }))
        : [];
    return [];
  });
  const ev = new Evaluator(
    { db, rules: loaded.rules, now: () => T },
    { outcomesEveryMs: 60_000, statsEveryMs: 3_600_000 },
  );
  await ev.evaluate(T);
  const ce = queries
    .filter((q) => q.sql.includes("insert into rule_stats"))
    .find((w) => w.values[0] === "confirmed-entry")!;
  assert.equal(ce.values[9], true, "disabled");
  assert.match(String(ce.values[8]), /disabled: expectancy negative on 7 consecutive days/);
  const other = queries
    .filter((q) => q.sql.includes("insert into rule_stats"))
    .find((w) => w.values[0] === "migration-snipe")!;
  assert.equal(other.values[9], false, "a rule with no outcomes is left alone");
  assert.match(String(other.values[8]), /under 20; weight held; no measured outcome/);
  // Loaded back, the loop sees it disabled and the console sees the reason.
  latest = [
    {
      rule_id: "confirmed-entry",
      window_days: 14,
      n: 30,
      win_rate: 0,
      expectancy: -0.03,
      worst_dd: -0.08,
      weight: 1,
      changed_at: new Date(T),
      change_reason: String(ce.values[8]),
      disabled: true,
    },
  ];
  await ev.load();
  assert.equal(ev.state("confirmed-entry")?.disabled, true);
  assert.match(ev.view()[0]!.disabledReason!, /only the operator re-enables/);
  assert.equal(await ev.enable("migration-snipe", "owner"), false, "not disabled: nothing to do");
  latest = [
    {
      ...latest[0]!,
      disabled: false,
      weight: 0.25,
      change_reason: "re-enabled by owner at weight 0.25",
    },
  ];
  assert.equal(await ev.enable("confirmed-entry", "owner"), true);
  const en = queries.filter((q) => q.sql.includes("insert into rule_stats")).at(-1)!;
  assert.equal(en.values[6], 0.25);
  assert.match(String(en.values[8]), /re-enabled by owner/);
  assert.equal(ev.state("confirmed-entry")?.disabled, false);
  assert.equal(ev.state("confirmed-entry")?.weight, 0.25);
});
