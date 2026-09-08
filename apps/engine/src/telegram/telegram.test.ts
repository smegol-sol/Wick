import assert from "node:assert/strict";
import test from "node:test";
import type { ApiState } from "@wick/core/api";
import type { Db } from "../db/pool.ts";
import { split, TelegramBot } from "./bot.ts";
import { dailyReport, formatReport, formatStatus, yesterdayStart } from "./report.ts";

function fakeFetch() {
  const calls: { url: string; body: unknown }[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) };
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

test("telegram bot: answers /status and /halt from the owner's chat only, tracks the offset, splits long texts", async () => {
  const { fetch, calls } = fakeFetch();
  const halts: string[] = [];
  const bot = new TelegramBot({
    token: "T",
    chatId: "42",
    fetch,
    status: async () => "status text",
    halt: async (reason) => {
      halts.push(reason);
      return `halted: ${reason}`;
    },
  });
  await bot.handle({
    update_id: 10,
    message: { message_id: 1, date: 0, text: "/status", chat: { id: 42 } },
  });
  assert.equal(bot.state.offset, 11);
  assert.equal(calls.at(-1)?.body && (calls.at(-1)!.body as { text: string }).text, "status text");
  assert.equal((calls.at(-1)!.body as { chat_id: string }).chat_id, "42");
  await bot.handle({
    update_id: 11,
    message: { message_id: 2, date: 0, text: "/halt@wick_bot going out", chat: { id: 42 } },
  });
  assert.deepEqual(halts, ["going out"]);
  assert.match((calls.at(-1)!.body as { text: string }).text, /^halted: going out/);
  await bot.handle({
    update_id: 12,
    message: { message_id: 3, date: 0, text: "/halt", chat: { id: 99 } },
  });
  assert.deepEqual(halts, ["going out"], "another chat is ignored");
  assert.equal(bot.state.ignored, 1);
  assert.equal(bot.state.offset, 13, "the offset still advances past ignored updates");
  await bot.handle({
    update_id: 13,
    message: { message_id: 4, date: 0, text: "/approve x", chat: { id: 42 } },
  });
  assert.match((calls.at(-1)!.body as { text: string }).text, /Commands: \/status, \/halt/);
  assert.equal(bot.state.handled, 3);
  const long = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const parts = split(long);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => p.length <= 4000));
  assert.equal(parts.join("\n"), long, "nothing lost in the split");
});

test("telegram texts: status from the API state, the daily report from the tables, n/a where nothing reports", async () => {
  const state = {
    version: "0.1.0",
    now: 0,
    chain: "solana",
    tier: 1,
    walletCapSol: 15,
    equitySol: null,
    solUsd: 100,
    dayPnlSol: null,
    dayPnlPct: null,
    openPositions: 0,
    pendingIntents: 2,
    modes: { shadow: 3, suggest: 0, auto: 0 },
    regime: {
      at: 0,
      solChange1hPct: -1,
      breadth5m: 0.5,
      launchesPerHour: 10,
      migrationsPerHour: 1,
      safetyRejectRate1h: 0.1,
      sizeMul: 1 as const,
      reason: "normal",
    },
    halts: [{ ts: 1, kind: "manual", reason: "lunch", clearedAt: null }],
    health: { ok: true, selfHalt: false, reasons: [], sourceAges: {}, slotLag: 0, dbOk: true },
    vault: "sealed" as const,
  } satisfies ApiState;
  const text = formatStatus(state, [
    {
      id: "confirmed-entry",
      strategy: "confirmed-entry",
      mode: "shadow",
      weight: 1.1,
      stats: {
        windowDays: 14,
        n: 25,
        winRate: 0.52,
        expectancy: 0.031,
        worstDd: -0.1,
        changedAt: 0,
        changeReason: "",
      },
      eligibleForAuto: false,
      disabled: false,
      disabledReason: null,
    },
  ]);
  assert.match(text, /equity n\/a · today n\/a/);
  assert.match(text, /HALTED: manual: lunch/);
  assert.match(text, /confirmed-entry: shadow ×1.1 · n 25 · win 52% · exp 3.1%/);
  const T0 = Date.UTC(2026, 8, 8, 0, 0, 0);
  assert.equal(yesterdayStart(T0 + 3_600_000), T0 - 86_400_000);
  const db = {
    query: async (sql: string) => {
      if (sql.includes("group by status"))
        return {
          rows: [
            { status: "shadow", n: "40" },
            { status: "executed", n: "2" },
          ],
        };
      if (sql.includes("sum(realized_pnl_sol)")) return { rows: [{ n: "0", sum: null }] };
      if (sql.includes("status = 'open'")) return { rows: [{ n: "1" }] };
      if (sql.includes("ret_pct is not null")) return { rows: [{ n: "38" }] };
      if (sql.includes("from halts")) return { rows: [] };
      if (sql.includes("from regime")) return { rows: [{ zero: "12", half: "30", total: "1440" }] };
      if (sql.includes("from rule_stats"))
        return {
          rows: [
            {
              rule_id: "confirmed-entry",
              n: 25,
              win_rate: 0.5,
              expectancy: -0.01,
              weight: 0.9,
              disabled: false,
            },
          ],
        };
      return { rows: [] };
    },
  } as unknown as Db;
  const r = await dailyReport(db, T0 - 86_400_000);
  assert.equal(r.day, "2026-09-07");
  assert.equal(r.realizedPnlSol, null, "no closed position, no number");
  const rep = formatReport(r);
  assert.match(rep, /intents 42 \(executed 2, shadow 40\) · outcomes measured 38/);
  assert.match(rep, /realized n\/a · open now 1/);
  assert.match(rep, /×0 for 12 min, ×0.5 for 30 min of 1440/);
  assert.match(rep, /confirmed-entry: ×0.9 · n 25 · win 50% · exp -1.0%/);
});
