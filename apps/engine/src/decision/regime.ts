/**
 * The regime writer (ENGINE §11): every minute, the market-wide inputs out
 * of our own tables, one `regime` row with the multiplier and its reason,
 * and the SOL/USD sample the one-hour change needs. The loop reads the
 * current row; the API shows it next to every intent it touched.
 */
import type { Regime } from "@wick/core/contracts";
import { regimeOf } from "@wick/core/regime";
import type { Db } from "../db/pool.ts";
import { errText, logger } from "../log.ts";
import * as m from "../metrics.ts";

const log = logger("regime");

export type RegimeDeps = {
  db: Db;
  solUsd: () => number | null;
  activeMints: () => string[];
  now?: () => number;
};

const MIN_BREADTH_TOKENS = 10;
const MIN_SAFETY_ROWS = 10;
const MIN_MEDIAN_HOURS = 24;

export class RegimeWriter {
  private readonly deps: RegimeDeps;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private cur: Regime | null = null;

  constructor(deps: RegimeDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** The latest row, null before the first minute. */
  current(): Regime | null {
    return this.cur;
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const now = this.now();
    const db = this.deps.db;
    try {
      const sol = this.deps.solUsd();
      if (sol != null)
        await db.query(
          "insert into sol_price (ts, usd) values ($1, $2) on conflict (ts) do nothing",
          [new Date(now), sol],
        );
      const [solChange, breadth, launches, median, migrations, safety] = await Promise.all([
        this.solChange(now, sol),
        this.breadth(now),
        this.perHour(now, "create"),
        this.launchesMedian(now),
        this.perHour(now, "migrate"),
        this.safetyRejectRate(now),
      ]);
      const r = regimeOf({
        at: now,
        solChange1hPct: solChange,
        breadth5m: breadth,
        launchesPerHour: launches,
        launchesMedian7d: median,
        migrationsPerHour: migrations,
        safetyRejectRate1h: safety,
      });
      await db.query(
        `insert into regime (at, sol_change_1h, breadth_5m, launches_ph, migrations_ph, safety_reject_rate_1h, size_mul, reason)
         values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (at) do nothing`,
        [
          new Date(now),
          r.solChange1hPct,
          r.breadth5m,
          r.launchesPerHour,
          r.migrationsPerHour,
          r.safetyRejectRate1h,
          r.sizeMul,
          r.reason,
        ],
      );
      if (this.cur?.sizeMul !== r.sizeMul) {
        const line = { sizeMul: r.sizeMul, reason: r.reason };
        if (r.sizeMul === 1) log.info("regime", line);
        else log.warn("regime", line);
      }
      this.cur = r;
      m.regimeSizeMul.set(r.sizeMul);
    } catch (e) {
      m.dbErrors.inc({ op: "regime" });
      log.error("regime tick failed", { err: errText(e) });
    } finally {
      this.busy = false;
    }
  }

  private async solChange(now: number, sol: number | null): Promise<number | null> {
    if (sol == null) return null;
    const res = await this.deps.db.query<{ usd: number }>(
      `select usd from sol_price where ts <= $1 and ts >= $2 order by ts desc limit 1`,
      [new Date(now - 3_600_000), new Date(now - 4_500_000)],
    );
    const then = res.rows[0]?.usd;
    if (then == null || then <= 0) return null;
    return Math.round((sol / then - 1) * 1000) / 10;
  }

  /** Share of active tokens whose latest price is at or above their price five minutes ago. */
  private async breadth(now: number): Promise<number | null> {
    const mints = this.deps.activeMints();
    if (mints.length < MIN_BREADTH_TOKENS) return null;
    const res = await this.deps.db.query<{ up: string; n: string }>(
      `with a as (
         select distinct on (mint) mint, price from token_snapshots
          where mint = any($1) and ts > $2 and price is not null order by mint, ts desc),
       b as (
         select distinct on (mint) mint, price from token_snapshots
          where mint = any($1) and ts <= $3 and ts > $4 and price is not null order by mint, ts desc)
       select count(*) filter (where a.price >= b.price)::text as up, count(*)::text as n
         from a join b using (mint)`,
      [mints, new Date(now - 120_000), new Date(now - 300_000), new Date(now - 420_000)],
    );
    const n = Number(res.rows[0]?.n ?? 0);
    if (n < MIN_BREADTH_TOKENS) return null;
    return Math.round((Number(res.rows[0]!.up) / n) * 1000) / 1000;
  }

  private async perHour(now: number, kind: "create" | "migrate"): Promise<number | null> {
    const res = await this.deps.db.query<{ n: string }>(
      `select count(*)::text as n from chain_events where kind = $1 and ts > $2`,
      [kind, new Date(now - 3_600_000)],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  private async launchesMedian(now: number): Promise<number | null> {
    const res = await this.deps.db.query<{ median: number | null; hours: string }>(
      `with h as (
         select date_trunc('hour', ts) as hour, count(*) as n from chain_events
          where kind = 'create' and ts > $1 and ts < date_trunc('hour', $2::timestamptz) group by 1)
       select percentile_cont(0.5) within group (order by n) as median, count(*)::text as hours from h`,
      [new Date(now - 7 * 86_400_000), new Date(now)],
    );
    const r = res.rows[0];
    if (!r || Number(r.hours) < MIN_MEDIAN_HOURS || r.median == null) return null;
    return Math.round(Number(r.median));
  }

  private async safetyRejectRate(now: number): Promise<number | null> {
    const res = await this.deps.db.query<{ rejected: string; n: string }>(
      `select count(*) filter (where not g.passed)::text as rejected, count(*)::text as n
         from gate_results g join intents i on i.id = g.intent_id
        where g.gate = 'safety' and i.ts > $1 and i.replay_run_id is null`,
      [new Date(now - 3_600_000)],
    );
    const n = Number(res.rows[0]?.n ?? 0);
    if (n < MIN_SAFETY_ROWS) return null;
    return Math.round((Number(res.rows[0]!.rejected) / n) * 1000) / 1000;
  }

  start(everyMs = 60_000): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
