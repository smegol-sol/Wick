/**
 * Ingest v1: polls the chain adapter's sources every second, keeps the
 * active/cooling set (ADR-0007), writes `tokens`, `token_snapshots` and
 * `audits`, and feeds source heartbeats and slot lag to health and metrics.
 * It decides nothing.
 */
import type { ChainAdapter, SourceToken } from "@wick/core/chain";
import type { Audit, Snapshot } from "@wick/core/contracts";
import type { Db } from "../db/pool.ts";
import { slotLagOf } from "../health.ts";
import { errText, logger } from "../log.ts";
import * as m from "../metrics.ts";
import { Sampler, type SamplerConfig } from "./sampler.ts";

const log = logger("ingest");

export type CollectorConfig = SamplerConfig & { auditEveryMs: number; slotPollMs: number };

export type CollectorState = {
  lastOk: Record<string, number>;
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
  readonly state: CollectorState = { lastOk: {}, slotLag: null, lastSlotReadings: [] };
  readonly sampler: Sampler;
  private latest = new Map<string, SourceToken>();
  private auditedAt = new Map<string, { at: number; key: string }>();
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  private ticking = false;

  private readonly db: Db;
  private readonly chain: ChainAdapter;
  private readonly cfg: CollectorConfig;

  constructor(db: Db, chain: ChainAdapter, cfg: CollectorConfig) {
    this.db = db;
    this.chain = chain;
    this.cfg = cfg;
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
        if (b.solUsd != null) this.mark("jupiter-price", b.at);
        let dexFresh = 0;
        for (const tk of b.tokens) {
          this.latest.set(tk.mint, tk);
          this.sampler.seen(tk.mint, now);
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

      await this.upsertTokens([...this.latest.values()].filter((t) => due.active.includes(t.mint)));
      await this.writeSnapshots(rows);
      this.sampler.sampled([...due.active, ...due.cooling], now);
      await this.auditDue(due.active, now, ctrl.signal);

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
      try {
        audit = await this.chain.audit(mint, signal);
      } catch (e) {
        log.warn("audit failed", { err: errText(e) });
      }
      m.sourceCallDuration.observe({ source: "rpc" }, (performance.now() - t0) / 1000);
      if (!audit) continue;
      this.mark("rpc");
      const key = auditKey(audit);
      const prev = this.auditedAt.get(mint);
      this.auditedAt.set(mint, { at: now, key });
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
