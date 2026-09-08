/**
 * Integration test against a real Postgres. Runs only when TEST_DATABASE_URL
 * is set (CI provides a TimescaleDB service; locally any Postgres 16 works,
 * the Timescale migration then reports itself skipped).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChainAdapter, SealedKeyHandle } from "@wick/core/chain";
import { createHot, fromB58, lockHotMem, signTxBytes } from "@wick/core/hot-wallet";
import { base32Decode, totp } from "@wick/core/totp";
import { Executor } from "../executor/executor.ts";
import { Vault } from "../executor/vault.ts";
import type { Snapshot } from "@wick/core/contracts";
import { funnelView, listIntents, realizedPnl } from "../api/queries.ts";
import { loadRisk, loadRules } from "../config.ts";
import { DecisionLoop } from "../decision/loop.ts";
import { FeatureBook } from "../ingest/features.ts";
import { migrate } from "./migrate.ts";
import { makePool } from "./pool.ts";
import { Collector } from "../ingest/collector.ts";

const url = process.env.TEST_DATABASE_URL;
const PASS = "correct horse battery";
const TOTP_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

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
        async signaturesSince() {
          return [];
        },
        async holders() {
          return [];
        },
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
        async blockHeight() {
          return null;
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
        "delete from outcomes where intent_id in (select id from intents where mint = $1)",
        [mint],
      );
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

test(
  "executor: buys, sells down to a close, fails a bad simulation, waits under a halt",
  { skip: !url },
  async () => {
    const db = makePool(url!);
    const dir = mkdtempSync(join(tmpdir(), "wick-exec-"));
    try {
      await migrate(db);
      const { vault: hot } = await createHot(PASS);
      lockHotMem();
      writeFileSync(join(dir, "vault.json"), JSON.stringify(hot));
      const vault = new Vault(join(dir, "vault.json"), base32Decode(TOTP_B32));
      await vault.unseal(PASS, await totp(base32Decode(TOTP_B32), Date.now()));
      const wallet = vault.wallet!;
      const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      for (const sql of [
        "delete from fills where execution_id in (select id from executions where intent_id like 'exec-%')",
        "delete from outcomes where intent_id like 'exec-%'",
        "delete from executions where intent_id like 'exec-%'",
        "delete from positions where intent_id like 'exec-%'",
        "delete from gate_results where intent_id like 'exec-%'",
        "delete from quotes where intent_id like 'exec-%'",
        "delete from intents where id like 'exec-%'",
      ])
        await db.query(sql);

      // A chain whose balances move when a transaction is sent: 1,000 tokens per 0.2 SOL, sells at 0.19.
      const chain = {
        native: 5_000_000_000n,
        token: 0n,
        simOk: true,
        lastReq: null as { side: "buy" | "sell"; amountRaw: string } | null,
        sends: 0,
        async quote(req: { side: "buy" | "sell"; amountRaw: string }) {
          this.lastReq = req;
          const out =
            req.side === "buy"
              ? (BigInt(req.amountRaw) * 5n).toString()
              : ((BigInt(req.amountRaw) * 190_000_000n) / 1_000_000_000n).toString();
          return {
            id: `q-${Date.now()}-${this.sends}`,
            at: Date.now(),
            inAmount: req.amountRaw,
            outAmount: out,
            impactPct: 1.2,
            route: { fake: true },
          };
        },
        async buildTx() {
          const pub = fromB58(wallet)!;
          const bytes = Uint8Array.from([
            1,
            ...new Uint8Array(64),
            1,
            0,
            0,
            1,
            ...pub,
            ...new Uint8Array(32).fill(7),
            0,
          ]);
          return { bytes, blockhash: "x", lastValidBlockHeight: 100 };
        },
        async simulate() {
          return this.simOk
            ? { ok: true, err: null, unitsConsumed: 1 }
            : { ok: false, err: "custom program error: 0x1771", unitsConsumed: null };
        },
        async sign(tx: { bytes: Uint8Array }, key: SealedKeyHandle) {
          const signed = signTxBytes(tx.bytes, key.sign, fromB58(key.wallet)!);
          return { bytes: signed, sig: `sig-${++this.sends}` };
        },
        async send(tx: { sig: string }) {
          const r = this.lastReq!;
          if (r.side === "buy") {
            this.native -= BigInt(r.amountRaw) + 5000n;
            this.token += BigInt(r.amountRaw) * 5n;
          } else {
            this.token -= BigInt(r.amountRaw);
            this.native += (BigInt(r.amountRaw) * 190_000_000n) / 1_000_000_000n - 5000n;
          }
          return tx.sig;
        },
        async confirm() {
          return { status: "confirmed" as const, slot: 1, err: null };
        },
        async blockHeight() {
          return 50;
        },
        async balances(_w: string, m: string) {
          return { native: this.native, token: m === mint ? this.token : 0n, decimals: 6 };
        },
      };
      let halted = false;
      const exec = new Executor(
        {
          db,
          chain: chain as unknown as ChainAdapter,
          vault,
          risk: loadRisk("config/risk.yaml"),
          halted: () => ({ halted, reason: halted ? "kill" : null }),
        },
        { tickMs: 1000, confirmTimeoutMs: 1000, balanceRefreshMs: 0 },
      );
      const features = { mint, priceUsd: 0.001, liqUsd: 8000 };
      const intent = async (id: string, side: "buy" | "sell", sizeSol: number, decidedAgoMs = 0) =>
        db.query(
          `insert into intents (id, chain, ts, kind, strategy, rule_id, mode, mint, side, size_sol, features, why, status, decided_by, decided_at, ttl_ms)
         values ($1, 'solana', now(), $2, $3, $4, 'suggest', $5, $6, $7, $8, 'test', 'approved', 'owner', now() - make_interval(secs => $9), 90000)`,
          [
            id,
            side === "buy" ? "entry" : "exit",
            side === "buy" ? "confirmed-entry" : "exit-policy",
            side === "buy" ? "confirmed-entry" : "exit-policy",
            mint,
            side,
            sizeSol,
            JSON.stringify(features),
            decidedAgoMs / 1000,
          ],
        );

      await intent("exec-buy", "buy", 0.2);
      await exec.tick();
      const buy = await db.query("select status from intents where id = 'exec-buy'");
      assert.equal(buy.rows[0]?.status, "executed");
      const ex = await db.query(
        "select status, sig, quote_id, err from executions where intent_id = 'exec-buy'",
      );
      assert.equal(ex.rows[0]?.status, "confirmed");
      assert.equal(ex.rows[0]?.sig, "sig-1");
      assert.ok(ex.rows[0]?.quote_id);
      const fill = await db.query(
        "select sol_delta, token_delta, realized_slippage_pct from fills f join executions e on e.id = f.execution_id where e.intent_id = 'exec-buy'",
      );
      assert.ok(Math.abs(Number(fill.rows[0]?.sol_delta) + 0.200005) < 1e-9);
      assert.equal(Number(fill.rows[0]?.token_delta), 1000);
      assert.ok(Number(fill.rows[0]?.realized_slippage_pct) < 0.01, "fees only");
      const pos = await db.query(
        "select qty, cost_sol, status, entry_price_usd, entry_liq_usd, intent_id from positions where wallet = $1",
        [wallet],
      );
      assert.equal(pos.rows.length, 1);
      assert.equal(Number(pos.rows[0]?.qty), 1000);
      assert.equal(pos.rows[0]?.status, "open");
      assert.equal(Number(pos.rows[0]?.entry_price_usd), 0.001);
      assert.equal(Number(pos.rows[0]?.entry_liq_usd), 8000);
      assert.equal(pos.rows[0]?.intent_id, "exec-buy");
      const gate = await db.query(
        "select passed, reason_code from gate_results where intent_id = 'exec-buy' and gate = 'execution'",
      );
      assert.deepEqual(gate.rows[0], { passed: true, reason_code: null });
      assert.ok(Math.abs(exec.state.sentTodaySol - 0.2) < 1e-9);
      assert.ok(
        Math.abs(exec.state.walletSol! - 4.799995) < 1e-9,
        "the wallet read after the fill",
      );

      await exec.tick();
      assert.equal(
        (await db.query("select count(*)::int as n from executions where wallet = $1", [wallet]))
          .rows[0]?.n,
        1,
        "nothing left to claim",
      );

      await intent("exec-sell-half", "sell", 0.1);
      await exec.tick();
      const sold = Number(chain.lastReq?.amountRaw);
      assert.ok(
        sold > 499_900_000 && sold <= 500_000_000,
        `half the cost (fees included) sells half the tokens: ${sold}`,
      );
      const half = await db.query(
        "select qty, cost_sol, status, realized_pnl_sol, exits from positions where wallet = $1",
        [wallet],
      );
      assert.ok(Math.abs(Number(half.rows[0]?.qty) - 500) < 0.1, `${half.rows[0]?.qty}`);
      assert.equal(half.rows[0]?.status, "open");
      assert.ok(Number(half.rows[0]?.realized_pnl_sol) < 0, "sold at 0.19 what cost 0.2");
      assert.equal((half.rows[0]?.exits as unknown[]).length, 1);

      await intent("exec-sell-rest", "sell", 0.5);
      await exec.tick();
      const closed = await db.query(
        "select qty, status, closed_at from positions where wallet = $1",
        [wallet],
      );
      assert.equal(closed.rows[0]?.status, "closed");
      assert.equal(Number(closed.rows[0]?.qty), 0);
      assert.ok(closed.rows[0]?.closed_at);
      const pnl = await realizedPnl(db, Date.now() - 60_000, Date.now() + 60_000);
      assert.ok(pnl != null && pnl < 0 && pnl > -0.02, `realized ${pnl}`);

      chain.simOk = false;
      await intent("exec-sim", "buy", 0.2);
      await exec.tick();
      assert.equal(
        (await db.query("select status from intents where id = 'exec-sim'")).rows[0]?.status,
        "failed",
      );
      const simEx = await db.query(
        "select status, err from executions where intent_id = 'exec-sim'",
      );
      assert.equal(simEx.rows[0]?.status, "failed");
      assert.match(simEx.rows[0]?.err, /0x1771/);
      assert.deepEqual(
        (
          await db.query(
            "select passed, reason_code from gate_results where intent_id = 'exec-sim' and gate = 'execution'",
          )
        ).rows[0],
        { passed: false, reason_code: "EXEC_SIM" },
      );
      chain.simOk = true;

      await intent("exec-cap", "buy", 0.9);
      await exec.tick();
      assert.match(
        (await db.query("select err from executions where intent_id = 'exec-cap'")).rows[0]?.err,
        /per-transaction cap/,
      );

      halted = true;
      await intent("exec-halted", "buy", 0.2);
      await exec.tick();
      assert.equal(
        (await db.query("select status from intents where id = 'exec-halted'")).rows[0]?.status,
        "approved",
        "an entry waits under a halt",
      );
      await intent("exec-halted-sell", "sell", 0.1);
      await exec.tick();
      assert.equal(
        (await db.query("select status from intents where id = 'exec-halted-sell'")).rows[0]
          ?.status,
        "failed",
        "an exit still runs under a halt (no position left, so it fails honestly)",
      );
      await intent("exec-stale", "buy", 0.2, 120_000);
      await exec.tick();
      assert.equal(
        (await db.query("select status from intents where id = 'exec-stale'")).rows[0]?.status,
        "expired",
        "an approval older than its TTL expires",
      );
      halted = false;

      vault.seal();
      await intent("exec-sealed", "buy", 0.2);
      await exec.tick();
      assert.equal(
        (await db.query("select status from intents where id = 'exec-sealed'")).rows[0]?.status,
        "approved",
        "nothing executes while sealed",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await db.end();
    }
  },
);

test(
  "evaluator on Postgres: outcomes from snapshots, a daily rule_stats row, and the operator's re-enable",
  { skip: !url },
  async () => {
    const { writeOutcomes } = await import("../evaluator/outcomes.ts");
    const { Evaluator } = await import("../evaluator/evaluator.ts");
    const db = makePool(url!);
    const mint = "EvALuat0r11111111111111111111111111111111111";
    const T0 = Date.UTC(2031, 0, 1, 12, 0, 0);
    const rulesFile = loadRules("config/rules.yaml");
    try {
      await migrate(db);
      await db.query("delete from outcomes where intent_id like 'eval-%'");
      await db.query("delete from intents where id like 'eval-%'");
      await db.query("delete from token_snapshots where mint = $1", [mint]);
      await db.query("delete from rule_stats where changed_at >= $1", [new Date(T0)]);
      // 25 buy intents at price 1, each followed by a +10% snapshot inside every horizon.
      for (let i = 0; i < 25; i++) {
        const ts = new Date(T0 + i * 1000);
        await db.query(
          `insert into intents (id, ts, kind, strategy, rule_id, mode, mint, side, size_sol, features, why, status)
           values ($1, $2, 'entry', 'confirmed-entry', 'confirmed-entry', 'shadow', $3, 'buy', 0.1, $4, 'test', 'shadow')`,
          [`eval-${i}`, ts, mint, JSON.stringify({ priceUsd: 1 })],
        );
      }
      for (const [off, price] of [
        [60_000, 1.2],
        [200_000, 0.9],
        [290_000, 1.1],
        [1_700_000, 1.1],
        [7_100_000, 1.1],
      ] as const)
        await db.query(
          "insert into token_snapshots (ts, mint, price, source) values ($1, $2, $3, 'test')",
          [new Date(T0 + off), mint, price],
        );
      const later = T0 + 8_000_000;
      const o = await writeOutcomes(db, later, 100);
      assert.ok(o.measured >= 75, "25 intents × 3 horizons (other tests' intents may join)");
      const mine = async () =>
        Number(
          (
            await db.query<{ n: string }>(
              "select count(*)::text as n from outcomes where intent_id like 'eval-%'",
            )
          ).rows[0]!.n,
        );
      assert.equal(await mine(), 75);
      const row = await db.query<{ ret_pct: number; max_ret_pct: number; min_ret_pct: number }>(
        "select ret_pct, max_ret_pct, min_ret_pct from outcomes where intent_id = 'eval-0' and horizon_sec = 300",
      );
      assert.deepEqual(row.rows[0], { ret_pct: 10, max_ret_pct: 20, min_ret_pct: -10 });
      assert.deepEqual(
        await writeOutcomes(db, later, 100),
        { measured: 0, empty: 0 },
        "idempotent",
      );

      const ev = new Evaluator(
        { db, rules: rulesFile.rules, now: () => later },
        { outcomesEveryMs: 60_000, statsEveryMs: 3_600_000 },
      );
      await ev.evaluate(later);
      const st = ev.state("confirmed-entry")!;
      assert.equal(st.stats?.n, 25);
      assert.equal(st.stats?.expectancy, 0.1, "a fraction: +10%");
      assert.equal(st.stats?.winRate, 1);
      assert.equal(st.weight, 1.1, "one step up on the first day");
      assert.equal(st.disabled, false);
      await ev.evaluate(later + 60_000);
      assert.equal(st.weight, 1.1, "no second move the same day");
      const view = ev.view().find((r) => r.id === "confirmed-entry")!;
      assert.match(view.stats!.changeReason, /weight 1 → 1.1/);
      assert.equal(await ev.enable("confirmed-entry", "owner"), false, "not disabled");
    } finally {
      await db.query("delete from outcomes where intent_id like 'eval-%'").catch(() => {});
      await db.query("delete from intents where id like 'eval-%'").catch(() => {});
      await db.query("delete from token_snapshots where mint = $1", [mint]).catch(() => {});
      await db
        .query("delete from rule_stats where changed_at >= $1", [new Date(T0)])
        .catch(() => {});
      await db.end();
    }
  },
);

test(
  "replay on Postgres: the production rules and gates over stored rows, fills from the model, outcomes and a labelled run",
  { skip: !url },
  async () => {
    const { replay } = await import("../replay/replay.ts");
    const { listIntents } = await import("../api/queries.ts");
    const db = makePool(url!);
    const mint = "RePLay111111111111111111111111111111111111";
    const T0 = Date.UTC(2032, 0, 1, 0, 0, 0);
    const risk = loadRisk("config/risk.yaml");
    const loaded = loadRules("config/rules.yaml");
    try {
      await migrate(db);
      await db.query(
        "delete from outcomes where intent_id in (select id from intents where mint = $1)",
        [mint],
      );
      await db.query(
        "delete from gate_results where intent_id in (select id from intents where mint = $1)",
        [mint],
      );
      await db.query("delete from intents where mint = $1", [mint]);
      await db.query("delete from rule_stats where replay_run_id like 'replay-%'");
      await db.query("delete from replay_runs where window_start = $1", [new Date(T0)]);
      for (const t of ["token_snapshots", "audits", "launch_txs", "tokens", "sol_price"])
        await db
          .query(
            `delete from ${t} where ${t === "sol_price" ? "ts >= $1 and ts < $2" : "mint = $3"}`,
            [new Date(T0 - 600_000), new Date(T0 + 7_200_000), mint],
          )
          .catch(() => {});
      // A bonding token ten minutes old at T0 that satisfies confirmed-entry, sampled once a second for 40 minutes.
      await db.query(
        `insert into tokens (mint, symbol, name, creator, created_at, stage) values ($1, 'RPL', 'Replay', 'Dev1111111111111111111111111111111111111111', $2, 'bonding')`,
        [mint, new Date(T0 - 600_000)],
      );
      await db.query(
        `insert into audits (mint, at, program, mint_auth, freeze_auth, extensions, lp_state, decimals, supply)
         values ($1, $2, 'token', false, false, $3, 'curve', 6, 1000000000)`,
        [
          mint,
          new Date(T0 - 500_000),
          JSON.stringify({
            transferFeeBps: 0,
            hook: false,
            permanentDelegate: false,
            defaultFrozen: false,
          }),
        ],
      );
      await db.query(
        `insert into launch_txs (mint, slot, creator, buyers, bundle_pct, sniper_pct) values ($1, 1, 'Dev1111111111111111111111111111111111111111', $2, 6, 6)`,
        [
          mint,
          JSON.stringify([
            { wallet: "Dev1111111111111111111111111111111111111111", slot: 1, sol: 2, pct: 6 },
          ]),
        ],
      );
      const snapValues: unknown[] = [];
      const tuples: string[] = [];
      let n = 0;
      for (let s = -300; s < 2400; s++) {
        const ts = T0 + s * 1000;
        // Liquidity climbs (positive net flow), price climbs 20% over the first half hour then holds.
        const liq = 6000 + Math.max(0, s + 300) * 1;
        const price = 0.001 * (1 + Math.min(0.2, (Math.max(0, s) / 1800) * 0.2));
        const k = n * 12;
        tuples.push(
          `($${k + 1},$${k + 2},$${k + 3},$${k + 4},$${k + 5},$${k + 6},$${k + 7},$${k + 8},$${k + 9},$${k + 10},$${k + 11},$${k + 12})`,
        );
        snapValues.push(new Date(ts), mint, price, 50_000, liq, 2000, null, null, 30, 10, 120, 20);
        n++;
        if (n === 500 || s === 2399) {
          await db.query(
            `insert into token_snapshots (ts, mint, price, mc, liq, vol5m, vol24, tx24, buys5m, sells5m, holders, top10, source) values ${tuples.map((t) => t.replace(")", ",'test')")).join(",")}`,
            snapValues,
          );
          snapValues.length = 0;
          tuples.length = 0;
          n = 0;
        }
      }
      for (let mnt = -10; mnt < 45; mnt++)
        await db.query("insert into sol_price (ts, usd) values ($1, 100) on conflict do nothing", [
          new Date(T0 + mnt * 60_000),
        ]);

      const view = await replay(db, {
        fromMs: T0,
        toMs: T0 + 600_000,
        rules: loaded.rules,
        rulesHash: loaded.hash,
        risk,
        equitySol: 15,
        codeVersion: "test",
      });
      assert.ok(view.id.startsWith("replay-"));
      assert.ok(view.finishedAt);
      assert.ok(view.summary, "a summary is written");
      assert.ok(view.summary!.intents >= 1, "the rule fired at least once in ten minutes");
      assert.ok(view.summary!.executed >= 1, "and the model filled it");
      assert.ok(
        view.summary!.expectancy != null && view.summary!.expectancy > 0,
        "the price rose after the fill",
      );
      const rows = await db.query<{
        status: string;
        replay_run_id: string;
        why: string;
        price_source: string;
      }>(
        "select status, replay_run_id, why, price_source from intents where mint = $1 order by ts",
        [mint],
      );
      assert.equal(rows.rows[0]!.replay_run_id, view.id);
      assert.equal(rows.rows[0]!.status, "executed");
      assert.equal(rows.rows[0]!.price_source, "replay");
      assert.match(rows.rows[0]!.why, /replay fill/);
      const oc = await db.query<{ n: string }>(
        "select count(*)::text as n from outcomes o join intents i on i.id = o.intent_id where i.mint = $1 and o.ret_pct is not null",
        [mint],
      );
      assert.ok(Number(oc.rows[0]!.n) >= 3, "three horizons per executed intent");
      const live = await listIntents(db, null, 500);
      assert.equal(
        live.some((v) => v.intent.mint === mint),
        false,
        "replay rows never reach the live list",
      );
      const rs = await db.query<{ n: string }>(
        "select count(*)::text as n from rule_stats where replay_run_id = $1",
        [view.id],
      );
      assert.equal(Number(rs.rows[0]!.n), 2, "one row per entry rule");
    } finally {
      await db
        .query("delete from outcomes where intent_id in (select id from intents where mint = $1)", [
          mint,
        ])
        .catch(() => {});
      await db
        .query(
          "delete from gate_results where intent_id in (select id from intents where mint = $1)",
          [mint],
        )
        .catch(() => {});
      await db.query("delete from intents where mint = $1", [mint]).catch(() => {});
      await db.query("delete from rule_stats where replay_run_id like 'replay-%'").catch(() => {});
      await db
        .query("delete from replay_runs where window_start = $1", [new Date(T0)])
        .catch(() => {});
      for (const t of ["token_snapshots", "audits", "launch_txs", "tokens"])
        await db.query(`delete from ${t} where mint = $1`, [mint]).catch(() => {});
      await db
        .query("delete from sol_price where ts >= $1 and ts < $2", [
          new Date(T0 - 600_000),
          new Date(T0 + 3_600_000),
        ])
        .catch(() => {});
      await db.end();
    }
  },
);

test(
  "followed wallets on Postgres: copies with their outcomes make the view, and the evaluator demotes a losing wallet",
  { skip: !url },
  async () => {
    const { followWallet, listWallets, removeWallet, walletCopies } =
      await import("../api/queries.ts");
    const { Evaluator } = await import("../evaluator/evaluator.ts");
    const db = makePool(url!);
    const pk = "UtqNfV56F4cph21o2DcV7masPXNWvHwdDDe3EeKQ7Gz";
    const mint = "MiRRorMint11111111111111111111111111111111";
    try {
      await migrate(db);
      await db.query(
        "delete from outcomes where intent_id in (select id from intents where mint = $1)",
        [mint],
      );
      await db.query("delete from intents where mint = $1", [mint]);
      await db.query("delete from events where msg = 'copy' and data ->> 'wallet' = $1", [pk]);
      await db.query("delete from wallets where pk = $1", [pk]);
      // Other tests leave followed wallets behind locally; the cap is relative to them.
      const others = Number(
        (
          await db.query<{ n: string }>(
            "select count(*)::text as n from wallets where kind = 'owner' and status = 'follow' and pk <> $1",
            [pk],
          )
        ).rows[0]!.n,
      );
      assert.equal(await followWallet(db, pk, "test", others), "full");
      assert.equal(await followWallet(db, pk, "test", others + 1), "ok");
      assert.equal(
        await followWallet(db, pk, null, others + 1),
        "ok",
        "re-following does not count itself",
      );
      let view = (await listWallets(db)).find((w) => w.pk === pk)!;
      assert.equal(view.status, "follow");
      assert.equal(view.label, "test");
      assert.equal(view.copies, 0);
      assert.equal(view.meanRetPct, null);
      assert.equal(view.lastCopyAt, null);
      // Eleven copied buys, the oldest a winner, the last ten losers; one sell copy without an outcome.
      for (let i = 0; i < 11; i++) {
        const id = `copy-${pk}-${i}`;
        await db.query(
          `insert into intents (id, ts, kind, strategy, rule_id, mode, mint, side, size_sol, features, why, status)
           values ($1, now() - make_interval(mins => $2), 'entry', 'mirror-follow', 'mirror-follow', 'shadow', $3, 'buy', 0.1, '{}', 'copy', 'shadow')`,
          [id, 120 - i * 10, mint],
        );
        await db.query(
          `insert into outcomes (intent_id, horizon_sec, ret_pct) values ($1, 1800, $2)`,
          [id, i === 0 ? 40 : -2],
        );
        await db.query(
          `insert into events (ts, level, component, msg, data) values (now() - make_interval(mins => $1), 'info', 'decision', 'copy', $2)`,
          [
            120 - i * 10,
            JSON.stringify({ wallet: pk, sig: `s${i}`, gapMs: 500, intentId: id, side: "buy" }),
          ],
        );
      }
      await db.query(
        `insert into events (ts, level, component, msg, data) values (now(), 'info', 'decision', 'copy', $1)`,
        [JSON.stringify({ wallet: pk, sig: "sell", gapMs: 700, intentId: "none", side: "sell" })],
      );
      const copies = await walletCopies(db, pk);
      assert.equal(copies.length, 12);
      assert.equal(copies[0]!.side, "sell");
      assert.equal(copies[0]!.retPct, null);
      view = (await listWallets(db)).find((w) => w.pk === pk)!;
      assert.equal(view.copies, 10, "the last ten measured buys");
      assert.equal(view.meanRetPct, -2);
      assert.ok(view.lastCopyAt != null);
      const evaluator = new Evaluator(
        { db, rules: loadRules("config/rules.yaml").rules },
        { outcomesEveryMs: 60_000, statsEveryMs: 3_600_000 },
      );
      await evaluator.demoteWallets();
      view = (await listWallets(db)).find((w) => w.pk === pk)!;
      assert.equal(view.status, "watch");
      assert.match(view.demotedReason ?? "", /mean -2% over the last 10 copies/);
      assert.equal(await followWallet(db, pk, null, others + 1), "ok");
      view = (await listWallets(db)).find((w) => w.pk === pk)!;
      assert.equal(view.status, "follow");
      assert.equal(view.demotedReason, null, "following again clears the reason");
      assert.equal(await removeWallet(db, pk), true);
      assert.equal(await removeWallet(db, pk), false);
    } finally {
      await db
        .query("delete from outcomes where intent_id like $1", [`copy-${pk}-%`])
        .catch(() => {});
      await db.query("delete from intents where mint = $1", [mint]).catch(() => {});
      await db
        .query("delete from events where msg = 'copy' and data ->> 'wallet' = $1", [pk])
        .catch(() => {});
      await db.query("delete from wallets where pk = $1", [pk]).catch(() => {});
      await db.end();
    }
  },
);
