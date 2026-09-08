/**
 * Outcomes for every intent, executed or rejected (ADR-0004 level 1): the
 * price return at 5, 30 and 120 minutes from the price the decision saw, out
 * of our own snapshots. An intent whose token left the sampled set gets an
 * empty row, so it is counted as unmeasured and never retried.
 */
import { HORIZONS_SEC, outcomeOf, type HorizonSec } from "@wick/core/evaluator";
import type { Db } from "../db/pool.ts";
import { errText, logger } from "../log.ts";
import * as m from "../metrics.ts";

const log = logger("evaluator");

type Due = { id: string; ts: Date; mint: string; price: number | null };

/** Intents older than the horizon with no outcome row for it yet. */
async function dueFor(db: Db, horizonSec: number, now: number, limit: number): Promise<Due[]> {
  const res = await db.query<Due>(
    `select i.id, i.ts, i.mint, (i.features->>'priceUsd')::double precision as price
       from intents i
      where i.ts <= $1 and i.replay_run_id is null
        and not exists (select 1 from outcomes o where o.intent_id = i.id and o.horizon_sec = $2)
      order by i.ts
      limit $3`,
    [new Date(now - horizonSec * 1000), horizonSec, limit],
  );
  return res.rows;
}

export type OutcomeBatch = { measured: number; empty: number };

/** One pass over every horizon; bounded by `limit` intents per horizon. */
export async function writeOutcomes(db: Db, now: number, limit = 200): Promise<OutcomeBatch> {
  const out: OutcomeBatch = { measured: 0, empty: 0 };
  for (const horizon of HORIZONS_SEC) {
    let due: Due[];
    try {
      due = await dueFor(db, horizon, now, limit);
    } catch (e) {
      m.dbErrors.inc({ op: "outcomes" });
      log.error("outcomes read failed", { err: errText(e), horizon });
      continue;
    }
    for (const d of due) {
      const intentTs = d.ts.getTime();
      let o: ReturnType<typeof outcomeOf>;
      try {
        const samples = await db.query<{ ts: Date; price: number }>(
          `select ts, price from token_snapshots
            where mint = $1 and ts > $2 and ts <= $3 and price is not null
            order by ts`,
          [d.mint, d.ts, new Date(intentTs + horizon * 1000)],
        );
        o = outcomeOf(
          d.price ?? 0,
          samples.rows.map((s) => ({ ts: s.ts.getTime(), price: s.price })),
          intentTs,
          horizon,
        );
        await db.query(
          `insert into outcomes (intent_id, horizon_sec, ret_pct, max_ret_pct, min_ret_pct)
           values ($1, $2, $3, $4, $5) on conflict do nothing`,
          [d.id, horizon, o?.retPct ?? null, o?.maxRetPct ?? null, o?.minRetPct ?? null],
        );
      } catch (e) {
        m.dbErrors.inc({ op: "outcomes" });
        log.error("outcome write failed", { err: errText(e), intent: d.id, horizon });
        continue;
      }
      if (o) out.measured++;
      else out.empty++;
      m.outcomes.inc({ horizon: String(horizon as HorizonSec), measured: o ? "yes" : "no" });
    }
  }
  return out;
}
