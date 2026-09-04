/**
 * Ingest v1: polls the chain adapter's sources every second, keeps the
 * active/cooling set (ADR-0007), writes `tokens`, `token_snapshots`,
 * `audits`, `launch_txs` and the `chain_events` polling can see (create,
 * migrate, LP state), and feeds source heartbeats and slot lag to health and
 * metrics. It decides nothing.
 */
import type { ChainAdapter, LaunchTx, SourceToken, Trade } from "@wick/core/chain";
import type { Audit, Snapshot, Stage } from "@wick/core/contracts";
import type { Db } from "../db/pool.ts";
import { slotLagOf } from "../health.ts";
import { errText, logger } from "../log.ts";
import * as m from "../metrics.ts";
import { FeatureBook } from "./features.ts";
import { Sampler, type SamplerConfig } from "./sampler.ts";
import type { LogEvent, LogStream } from "./stream.ts";

const log = logger("ingest");

export type CollectorConfig = SamplerConfig & {
  auditEveryMs: number;
  slotPollMs: number;
  /** Launch parses started per tick, and how long to wait before retrying one that found nothing. */
  launchPerTick: number;
  launchRetryMs: number;
  /** How often the followed-wallet set is re-read, and whose transactions count as migrations. */
  followRefreshMs: number;
  migrationAuthority: string;
};

const LAUNCH_TRIES = 3;
/** A poll-side migrate event is skipped when the stream reported the same mint within this window. */
const STREAM_MIGRATE_GRACE_MS = 10 * 60_000;
const SEEN_SIGS_CAP = 5000;

export type CollectorState = {
  lastOk: Record<string, number>;
  solUsd: number | null;
  slotLag: number | null;
  lastSlotReadings: { url: string; slot: number | null; ms: number }[];
};

function ts(ms: number | null): Date | null {
  return ms == null ? null : new Date(ms);
}

function auditKey(a: Audit): string {
  return JSON.stringify([a.authorities, a.extensions, a.lp, a.decimals]);
}

export class Collector {
  readonly state: CollectorState = {
    lastOk: {},
    solUsd: null,
    slotLag: null,
    lastSlotReadings: [],
  };
  readonly sampler: Sampler;
  readonly book = new FeatureBook();
  private latest = new Map<string, SourceToken>();
  private followed = new Set<string>();
  private followedAt = 0;
  private streamMigrated = new Map<string, number>();
  private seenSigs = new Set<string>();
  private stages = new Map<string, Stage>();
  private auditedAt = new Map<string, { at: number; key: string; lp: Audit["lp"] }>();
  private launches = new Map<string, { tries: number; at: number; done: boolean }>();
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  private ticking = false;

  private readonly db: Db;
  private readonly chain: ChainAdapter;
  private readonly cfg: CollectorConfig;
  private readonly stream: LogStream | null;

  constructor(db: Db, chain: ChainAdapter, cfg: CollectorConfig, stream: LogStream | null = null) {
    this.db = db;
    this.chain = chain;
    this.cfg = cfg;
    this.stream = stream;
    this.sampler = new Sampler(cfg);
  }

  start(): void {
    this.timers.push(setInterval(() => void this.tick(), this.cfg.activeSampleMs));
    this.timers.push(setInterval(() => void this.pollSlots(), this.cfg.slotPollMs));
    void this.pollSlots();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
  }

  private mark(source: string, at = Date.now()): void {
    this.state.lastOk[source] = at;
  }

  /** One second: poll sources, refresh cooling stats when due, write rows. */
  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    const end = m.ingestCycle.startTimer();
    const now = Date.now();
    const ctrl = new AbortController();
    const kill = setTimeout(() => ctrl.abort(), this.cfg.activeSampleMs * 8);
    try {
      const t0 = performance.now();
      const batches = await this.chain.poll(ctrl.signal);
      for (const b of batches) {
        m.sourceCallDuration.observe({ source: b.source }, (performance.now() - t0) / 1000);
        if (b.tokens.length) this.mark(b.source, b.at);
        if (b.solUsd != null) {
          this.mark("jupiter-price", b.at);
          this.state.solUsd = b.solUsd;
        }
        let dexFresh = 0;
        for (const tk of b.tokens) {
          this.latest.set(tk.mint, tk);
          this.sampler.seen(tk.mint, now);
          this.book.noteToken(tk.mint, tk.stage, tk.createdAt);
          await this.noteStage(tk, now);
          if (tk.snapshot.statsAt != null && now - tk.snapshot.statsAt < 15_000) dexFresh++;
        }
        if (dexFresh) this.mark("dexscreener", now);
      }

      const due = this.sampler.due(now);
      const rows: Snapshot[] = [];
      for (const mint of due.active) {
        const tk = this.latest.get(mint);
        if (tk) rows.push({ ...tk.snapshot, ts: now });
      }
      if (due.cooling.length) {
        try {
          const cooled = await this.chain.stats(due.cooling, ctrl.signal);
          if (cooled.length) this.mark("dexscreener", now);
          for (const s of cooled) rows.push({ ...s, ts: now });
        } catch (e) {
          log.warn("cooling stats failed", { err: errText(e), n: due.cooling.length });
        }
      }

      for (const r of rows) this.book.noteSnapshot(r, this.state.solUsd);
      await this.upsertTokens([...this.latest.values()].filter((t) => due.active.includes(t.mint)));
      await this.writeSnapshots(rows);
      this.sampler.sampled([...due.active, ...due.cooling], now);
      await this.auditDue(due.active, now, ctrl.signal);
      await this.launchDue(due.active, now, ctrl.signal);
      await this.refreshFollowed(now);
      this.syncStream(due.active);
      await this.writeMicro(due.active, now);

      const counts = this.sampler.counts(now);
      m.activeTokens.set({ state: "active" }, counts.active);
      m.activeTokens.set({ state: "cooling" }, counts.cooling);
      for (const [source, at] of Object.entries(this.state.lastOk)) {
        m.sourceHeartbeatAge.set({ source }, (Date.now() - at) / 1000);
      }
    } catch (e) {
      log.error("tick failed", { err: errText(e) });
    } finally {
      clearTimeout(kill);
      end();
      this.ticking = false;
    }
  }

  private async upsertTokens(tokens: SourceToken[]): Promise<void> {
    if (!tokens.length) return;
    const values: unknown[] = [];
    const tuples: string[] = [];
    tokens.forEach((t, i) => {
      const o = i * 6;
      tuples.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6})`);
      values.push(t.mint, t.symbol, t.name, t.creator, ts(t.createdAt), t.stage);
    });
    try {
      await this.db.query(
        `insert into tokens (mint, symbol, name, creator, created_at, stage) values ${tuples.join(",")}
         on conflict (mint) do update set symbol = excluded.symbol, name = excluded.name,
           creator = coalesce(excluded.creator, tokens.creator), stage = excluded.stage, last_seen = now()`,
        values,
      );
    } catch (e) {
      m.dbErrors.inc({ op: "tokens" });
      log.error("tokens upsert failed", { err: errText(e) });
    }
  }

  private async writeSnapshots(rows: Snapshot[]): Promise<void> {
    if (!rows.length) return;
    const cols = 14;
    const values: unknown[] = [];
    const tuples: string[] = [];
    rows.forEach((r, i) => {
      const o = i * cols;
      tuples.push(`(${Array.from({ length: cols }, (_, k) => `$${o + k + 1}`).join(",")})`);
      values.push(
        ts(r.ts),
        r.mint,
        r.price,
        r.mc,
        r.liq,
        r.vol5m,
        r.vol24,
        r.tx24,
        r.buys5m,
        r.sells5m,
        r.holders,
        r.top10,
        r.source,
        ts(r.statsAt),
      );
    });
    try {
      await this.db.query(
        `insert into token_snapshots (ts, mint, price, mc, liq, vol5m, vol24, tx24, buys5m, sells5m, holders, top10, source, stats_at)
         values ${tuples.join(",")}`,
        values,
      );
      const bySource = new Map<string, number>();
      for (const r of rows) bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1);
      for (const [source, n] of bySource) m.snapshotsWritten.inc({ source }, n);
    } catch (e) {
      m.dbErrors.inc({ op: "snapshots" });
      log.error("snapshot insert failed", { err: errText(e), rows: rows.length });
    }
  }

  /** Audit new mints at once and every `auditEveryMs`; write only when something changed. */
  private async auditDue(active: string[], now: number, signal: AbortSignal): Promise<void> {
    const todo = active.filter((mint) => {
      const a = this.auditedAt.get(mint);
      return !a || now - a.at >= this.cfg.auditEveryMs;
    });
    // Keep the RPC budget flat: a few audits per tick, oldest first.
    for (const mint of todo.slice(0, 5)) {
      let audit: Audit | null = null;
      const t0 = performance.now();
      const tk = this.latest.get(mint);
      try {
        audit = await this.chain.audit(
          { mint, stage: tk?.stage ?? "new", pair: tk?.pair ?? null },
          signal,
        );
      } catch (e) {
        log.warn("audit failed", { err: errText(e) });
      }
      m.sourceCallDuration.observe({ source: "rpc" }, (performance.now() - t0) / 1000);
      if (!audit) continue;
      this.mark("rpc");
      this.book.noteAudit(audit);
      const key = auditKey(audit);
      const prev = this.auditedAt.get(mint);
      this.auditedAt.set(mint, { at: now, key, lp: audit.lp });
      if (prev && prev.lp !== audit.lp && audit.lp != null) {
        await this.writeEvent(now, mint, "lp_state", null, {
          source: "poll",
          from: prev.lp,
          to: audit.lp,
          ...(audit.lpRead ?? {}),
        });
      }
      if (prev?.key === key) continue;
      try {
        await this.db.query(
          `insert into audits (mint, at, program, mint_auth, freeze_auth, extensions, lp_state, decimals, supply)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing`,
          [
            mint,
            ts(audit.at),
            audit.authorities?.program ?? null,
            audit.authorities?.mint ?? null,
            audit.authorities?.freeze ?? null,
            audit.extensions ? JSON.stringify(audit.extensions) : null,
            audit.lp,
            audit.decimals,
            audit.supply,
          ],
        );
        m.auditsWritten.inc();
      } catch (e) {
        m.dbErrors.inc({ op: "audits" });
        log.error("audit insert failed", { err: errText(e) });
      }
    }
  }

  /** A stage change seen by polling is a chain event too, until the webhooks carry it. */
  private async noteStage(tk: SourceToken, now: number): Promise<void> {
    const prev = this.stages.get(tk.mint);
    this.stages.set(tk.mint, tk.stage);
    if (prev && prev !== "migrated" && tk.stage === "migrated") {
      const fromStream = this.streamMigrated.get(tk.mint);
      if (fromStream != null && now - fromStream < STREAM_MIGRATE_GRACE_MS) return;
      await this.writeEvent(now, tk.mint, "migrate", null, {
        source: "poll",
        from: prev,
        pair: tk.pair,
      });
    }
  }

  /** Parse each active mint's launch once; retry a few times when the history is not readable yet. */
  private async launchDue(active: string[], now: number, signal: AbortSignal): Promise<void> {
    const tries = (mint: string) => this.launches.get(mint)?.tries ?? 0;
    const todo = active
      .filter((mint) => {
        const l = this.launches.get(mint);
        return !l || (!l.done && l.tries < LAUNCH_TRIES && now - l.at >= this.cfg.launchRetryMs);
      })
      .sort((a, b) => tries(a) - tries(b));
    for (const mint of todo.slice(0, this.cfg.launchPerTick)) {
      const l = this.launches.get(mint) ?? { tries: 0, at: 0, done: false };
      l.tries++;
      l.at = now;
      this.launches.set(mint, l);
      let launch: LaunchTx | null = null;
      const t0 = performance.now();
      try {
        launch = await this.chain.launchTx(mint, signal);
      } catch (e) {
        log.warn("launch parse failed", { err: errText(e), mint });
      }
      m.sourceCallDuration.observe({ source: "rpc" }, (performance.now() - t0) / 1000);
      if (!launch) {
        if (l.tries >= LAUNCH_TRIES) log.warn("launch not parsed, giving up", { mint });
        continue;
      }
      this.mark("rpc");
      l.done = true;
      this.book.noteLaunch(launch);
      await this.writeLaunch(launch);
    }
  }

  private async writeLaunch(l: LaunchTx): Promise<void> {
    try {
      await this.db.query(
        `insert into launch_txs (mint, slot, creator, buyers, bundle_pct, sniper_pct)
         values ($1,$2,$3,$4,$5,$6) on conflict (mint) do nothing`,
        [l.mint, l.slot, l.creator, JSON.stringify(l.buyers), l.bundlePct, l.sniperPct],
      );
      await this.db.query(`update tokens set creator = $2 where mint = $1 and creator is null`, [
        l.mint,
        l.creator,
      ]);
      m.launchTxsParsed.inc();
    } catch (e) {
      m.dbErrors.inc({ op: "launch_txs" });
      log.error("launch insert failed", { err: errText(e), mint: l.mint });
      return;
    }
    await this.writeEvent(l.ts ?? Date.now(), l.mint, "create", l.sig, {
      source: "rpc",
      slot: l.slot,
      creator: l.creator,
      buyers: l.buyers.length,
      bundlePct: l.bundlePct,
      sniperPct: l.sniperPct,
      truncated: l.truncated,
    });
  }

  private async writeEvent(
    at: number,
    mint: string,
    kind: string,
    sig: string | null,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.db.query(
        `insert into chain_events (ts, mint, kind, sig, data) values ($1,$2,$3,$4,$5)`,
        [ts(at), mint, kind, sig, JSON.stringify(data)],
      );
      m.chainEvents.inc({ kind });
    } catch (e) {
      m.dbErrors.inc({ op: "chain_events" });
      log.error("chain event insert failed", { err: errText(e), kind, mint });
    }
  }

  /** The owner's followed wallets: `wallets` rows with kind owner and status follow. */
  private async refreshFollowed(now: number): Promise<void> {
    if (now - this.followedAt < this.cfg.followRefreshMs) return;
    this.followedAt = now;
    try {
      const res = await this.db.query<{ pk: string }>(
        `select pk from wallets where kind = 'owner' and status = 'follow'`,
      );
      this.followed = new Set(res.rows.map((r) => r.pk));
    } catch (e) {
      m.dbErrors.inc({ op: "wallets" });
      log.error("followed wallets read failed", { err: errText(e) });
    }
  }

  /** Subscriptions: every active mint, every followed wallet, the migration authority. */
  private syncStream(active: string[]): void {
    if (!this.stream) return;
    this.stream.setAddresses([...active, ...this.followed, this.cfg.migrationAuthority]);
    const st = this.stream.state;
    m.streamConnected.set(st.connected ? 1 : 0);
    m.streamSubscriptions.set(st.subscribed);
    if (st.connected && st.lastMessageAt != null) this.mark("stream", st.lastMessageAt);
  }

  /** One notification from the log stream. Never throws; the stream must stay up. */
  async onLog(e: LogEvent): Promise<void> {
    if (e.err != null) return;
    const key = `${e.address}:${e.signature}`;
    if (this.seenSigs.has(key)) return;
    this.seenSigs.add(key);
    if (this.seenSigs.size > SEEN_SIGS_CAP) {
      const first = this.seenSigs.values().next().value;
      if (first) this.seenSigs.delete(first);
    }
    try {
      if (this.followed.has(e.address)) await this.handlePrint(e);
      else if (e.address === this.cfg.migrationAuthority) await this.handleMigrate(e);
      else if (this.latest.has(e.address)) this.handleTradeLog(e);
      else m.streamEvents.inc({ kind: "ignored" });
    } catch (err) {
      log.warn("stream event failed", { err: errText(err), sig: e.signature });
    }
  }

  private handleTradeLog(e: LogEvent): void {
    let seen = false;
    for (const line of e.logs) {
      const mm = /Instruction: (Buy|Sell)\b/.exec(line);
      if (!mm) continue;
      this.book.noteTradeSeen(e.address, mm[1] === "Buy" ? "buy" : "sell", e.at);
      seen = true;
    }
    m.streamEvents.inc({ kind: seen ? "trade" : "other" });
  }

  private async handlePrint(e: LogEvent): Promise<void> {
    const ctrl = new AbortController();
    const kill = setTimeout(() => ctrl.abort(), 8000);
    let trades: Trade[] = [];
    try {
      trades = await this.chain.trades(e.signature, ctrl.signal);
    } finally {
      clearTimeout(kill);
    }
    const mine = trades.filter((t) => t.wallet === e.address);
    if (!mine.length) {
      m.streamEvents.inc({ kind: "other" });
      return;
    }
    for (const t of mine) {
      this.book.notePrint(t, e.at);
      try {
        await this.db.query(
          `insert into wallet_prints (sig, wallet, ts, seen_at, mint, side, sol, amount)
           values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (sig) do nothing`,
          [t.sig, t.wallet, ts(t.ts ?? e.at), ts(e.at), t.mint, t.side, t.sol, t.amount],
        );
        m.walletPrints.inc();
      } catch (err) {
        m.dbErrors.inc({ op: "wallet_prints" });
        log.error("wallet print insert failed", { err: errText(err) });
      }
    }
    m.streamEvents.inc({ kind: "print" });
  }

  private async handleMigrate(e: LogEvent): Promise<void> {
    if (!e.logs.some((l) => /migrat/i.test(l))) {
      m.streamEvents.inc({ kind: "other" });
      return;
    }
    const ctrl = new AbortController();
    const kill = setTimeout(() => ctrl.abort(), 8000);
    let summary = null;
    try {
      summary = await this.chain.txSummary(e.signature, ctrl.signal);
    } finally {
      clearTimeout(kill);
    }
    if (!summary?.ok || !summary.mints.length) {
      m.streamEvents.inc({ kind: "other" });
      return;
    }
    for (const mint of summary.mints) {
      this.streamMigrated.set(mint, e.at);
      const tk = this.latest.get(mint);
      if (tk) this.book.noteToken(mint, "migrated", tk.createdAt);
      await this.writeEvent(summary.ts ?? e.at, mint, "migrate", e.signature, {
        source: "stream",
        slot: summary.slot,
        pair: summary.holders[mint] ?? null,
        seenAt: e.at,
      });
    }
    m.streamEvents.inc({ kind: "migrate" });
  }

  /** One microstructure row per active mint per tick (ENGINE §10 from reserves; counts from the stream). */
  private async writeMicro(active: string[], now: number): Promise<void> {
    const values: unknown[] = [];
    const tuples: string[] = [];
    const cols = 12;
    let n = 0;
    for (const mint of active) {
      const micro = this.book.micro(mint, now);
      if (!micro) continue;
      const c1 = this.book.counts(mint, now, 60_000);
      const c5 = this.book.counts(mint, now, 5 * 60_000);
      const o = n * cols;
      tuples.push(`(${Array.from({ length: cols }, (_, k) => `$${o + k + 1}`).join(",")})`);
      values.push(
        ts(now),
        mint,
        micro.netFlowSol1m,
        micro.netFlowSol5m,
        micro.organicVolPct5m,
        micro.depthBuy2PctUsd,
        micro.depthSell2PctUsd,
        c1?.buys ?? null,
        c1?.sells ?? null,
        c5?.buys ?? null,
        c5?.sells ?? null,
        null,
      );
      n++;
    }
    if (!n) return;
    try {
      await this.db.query(
        `insert into microstructure (at, mint, net_flow_1m, net_flow_5m, organic_vol_pct_5m, depth_buy_2pct, depth_sell_2pct, buys_1m, sells_1m, buys_5m, sells_5m, unique_buyers_5m)
         values ${tuples.join(",")}`,
        values,
      );
      m.microRows.inc(n);
    } catch (e) {
      m.dbErrors.inc({ op: "microstructure" });
      log.error("microstructure insert failed", { err: errText(e), rows: n });
    }
  }

  async pollSlots(): Promise<void> {
    if (this.stopped) return;
    const ctrl = new AbortController();
    const kill = setTimeout(() => ctrl.abort(), this.cfg.slotPollMs - 200);
    try {
      const readings = await this.chain.slots(ctrl.signal);
      this.state.lastSlotReadings = readings;
      const lag = slotLagOf(readings);
      this.state.slotLag = lag;
      if (lag != null) {
        m.slotLag.set(lag);
        this.mark("rpc");
      }
    } catch (e) {
      log.warn("slot poll failed", { err: errText(e) });
    } finally {
      clearTimeout(kill);
    }
  }
}
