/**
 * Integration test against a real Postgres. Runs only when TEST_DATABASE_URL
 * is set (CI provides a TimescaleDB service; locally any Postgres 16 works,
 * the Timescale migration then reports itself skipped).
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ChainAdapter } from "@wick/core/chain";
import type { Snapshot } from "@wick/core/contracts";
import { funnelView, listIntents } from "../api/queries.ts";
import { loadRisk, loadRules } from "../config.ts";
import { DecisionLoop } from "../decision/loop.ts";
import { FeatureBook } from "../ingest/features.ts";
import { migrate } from "./migrate.ts";
import { makePool } from "./pool.ts";
import { Collector } from "../ingest/collector.ts";

const url = process.env.TEST_DATABASE_URL;

test(
  "migrations apply twice without change and the collector round-trips rows",
  { skip: !url },
  async () => {
    const db = makePool(url!);
    try {
      await migrate(db);
      const second = await migrate(db);
      assert.equal(second.length, 0, "second run must be a no-op");
      const tables = await db.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema = 'public' order by 1",
      );
      const names = tables.rows.map((r) => r.table_name);
      for (const t of [
        "tokens",
        "token_snapshots",
        "audits",
        "intents",
        "gate_results",
        "events",
        "halts",
        "tiers",
      ]) {
        assert.ok(names.includes(t), `missing table ${t}`);
      }

      const mint = "So11111111111111111111111111111111111111112";
      const at = Date.now();
      const chain: ChainAdapter = {
        chain: "solana",
        async poll() {
          return [
            {
              source: "pump.fun",
              at,
              solUsd: 100,
              tokens: [
                {
                  mint,
                  symbol: "WSOL",
                  name: "Wrapped SOL",
                  creator: null,
                  createdAt: at - 60_000,
                  stage: "bonding",
                  pair: null,
                  snapshot: {
                    ts: at,
                    mint,
                    price: 1,
                    mc: 1000,
                    liq: 500,
                    vol5m: 10,
                    vol24: null,
                    tx24: null,
                    buys5m: 3,
                    sells5m: 1,
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
        async audit({ mint: m }) {
          return {
            mint: m,
            at,
            authorities: { mint: false, freeze: true, program: "token2022" },
            extensions: {
              transferFeeBps: 100,
              hook: false,
              permanentDelegate: false,
              defaultFrozen: false,
            },
            decimals: 9,
            supply: 1e9,
            lp: null,
            lpRead: null,
          };
        },
        async launchTx(m) {
          return {
            mint: m,
            slot: 5,
            sig: "createSig",
            ts: at - 120_000,
            creator: "Dev1111111111111111111111111111111111111111",
            buyers: [{ wallet: "B1", slot: 5, sol: 0.5, pct: 2.5 }],
            bundlePct: 2.5,
            sniperPct: 2.5,
            truncated: false,
          };
        },
        async trades() {
          return [];
        },
        async txSummary() {
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
          return [{ url: "a", slot: 1, ms: 1 }];
        },
      };
      for (const t of ["token_snapshots", "audits", "launch_txs", "chain_events", "tokens"]) {
        await db.query(`delete from ${t} where mint = $1`, [mint]);
      }
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
        migrationAuthority: "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg",
      });
      await c.tick();
      const tok = await db.query("select symbol, stage from tokens where mint = $1", [mint]);
      assert.equal(tok.rows[0]?.symbol, "WSOL");
      assert.equal(tok.rows[0]?.stage, "bonding");
      const snap = await db.query(
        "select price, mc, liq, vol5m, vol24, buys5m, source from token_snapshots where mint = $1 order by ts desc limit 1",
        [mint],
      );
      assert.equal(snap.rows[0]?.price, 1);
      assert.equal(snap.rows[0]?.vol24, null);
      assert.equal(snap.rows[0]?.buys5m, 3);
      assert.equal(snap.rows[0]?.source, "pump.fun");
      const aud = await db.query(
        "select program, mint_auth, freeze_auth, extensions from audits where mint = $1 order by at desc limit 1",
        [mint],
      );
      assert.equal(aud.rows[0]?.program, "token2022");
      assert.equal(aud.rows[0]?.freeze_auth, true);
      assert.equal(aud.rows[0]?.extensions?.transferFeeBps, 100);
      const launch = await db.query(
        "select slot, creator, buyers, bundle_pct from launch_txs where mint = $1",
        [mint],
      );
      assert.equal(launch.rows[0]?.slot, "5");
      assert.equal(launch.rows[0]?.buyers?.[0]?.wallet, "B1");
      assert.equal(launch.rows[0]?.bundle_pct, 2.5);
      const creator = await db.query("select creator from tokens where mint = $1", [mint]);
      assert.equal(creator.rows[0]?.creator, "Dev1111111111111111111111111111111111111111");
      const ev = await db.query(
        "select kind, sig, data from chain_events where mint = $1 order by ts",
        [mint],
      );
      assert.deepEqual(
        ev.rows.map((r) => [r.kind, r.sig]),
        [["create", "createSig"]],
      );
      assert.equal(ev.rows[0]?.data?.creator, "Dev1111111111111111111111111111111111111111");

      // The decision loop against the real tables: an intent with its fingerprint and six gate rows.
      await db.query(
        "delete from gate_results where intent_id in (select id from intents where mint = $1)",
        [mint],
      );
      await db.query("delete from intents where mint = $1", [mint]);
      const book = new FeatureBook();
      book.noteToken(mint, "bonding", at - 600_000);
      const snapAt = (ts: number, liq: number): Snapshot => ({
        ts,
        mint,
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
      });
      book.noteSnapshot(snapAt(at - 300_000, 6000), 100);
      book.noteSnapshot(snapAt(at, 8000), 100);
      book.noteAudit({
        mint,
        at: at - 1000,
        authorities: { mint: false, freeze: false, program: "token" },
        extensions: {
          transferFeeBps: 0,
          hook: false,
          permanentDelegate: false,
          defaultFrozen: false,
        },
        decimals: 6,
        supply: 1e9,
        lp: "curve",
        lpRead: null,
      });
      const loaded = loadRules("config/rules.yaml");
      const loop = new DecisionLoop(
        {
          db,
          chain,
          book,
          activeMints: () => [mint],
          rules: loaded.rules,
          rulesHash: loaded.hash,
          codeVersion: "test",
          risk: loadRisk("config/risk.yaml"),
          solUsd: () => 100,
          equitySol: () => 15,
          selfHalt: () => false,
          now: () => at,
        },
        { tickMs: 1000, quotesPerMinute: 30, bookRefreshMs: 5000 },
      );
      await loop.tick();
      assert.equal(loop.state.written, 1);
      const views = await listIntents(db, "shadow", 10);
      const view = views.find((v) => v.intent.mint === mint);
      assert.ok(view, "the shadow intent reads back through the API query");
      assert.equal(view.symbol, "WSOL");
      assert.equal(view.intent.ttlMs, loaded.rules.intentTtlMs);
      assert.equal(view.intent.sizing?.binding, "equity");
      assert.equal(view.gates.length, 6);
      assert.equal(view.adjustedMul, 1);
      const fp = await db.query(
        "select rules_hash, code_version, price_source, ttl_ms from intents where id = $1",
        [view.intent.id],
      );
      assert.deepEqual(fp.rows[0], {
        rules_hash: loaded.hash,
        code_version: "test",
        price_source: "pump.fun",
        ttl_ms: loaded.rules.intentTtlMs,
      });
      const funnel = await funnelView(db, [], at - 60_000);
      assert.deepEqual(funnel.rejections, []);
    } finally {
      await db.end();
    }
  },
);
