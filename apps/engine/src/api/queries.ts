/**
 * Read models for the API (ADR-0009 §2), built from the tables in ENGINE §14.
 * Every function returns exactly the contract shape from @wick/core/api and
 * leaves a field null when no row reports it.
 */
import type {
  Candle,
  FunnelView,
  HaltView,
  IntentStatus,
  IntentView,
  PositionView,
  ReplayRunView,
  TokenView,
} from "@wick/core/api";
import { adjustedMulOf } from "@wick/core/api";
import type { Audit, GateResult, Intent, Snapshot } from "@wick/core/contracts";
import type { Db } from "../db/pool.ts";

const ms = (d: Date | string | null | undefined): number | null =>
  d == null ? null : new Date(d).getTime();

type IntentRow = {
  id: string;
  chain: string;
  ts: Date;
  kind: Intent["kind"];
  strategy: Intent["strategy"];
  rule_id: string;
  mode: Intent["mode"];
  mint: string;
  side: Intent["side"];
  size_sol: number;
  sizing: Intent["sizing"];
  features: Intent["features"];
  why: string;
  status: string;
  decided_by: string | null;
  decided_at: Date | null;
  replay_run_id: string | null;
  symbol: string | null;
  ttl_ms: number | null;
};

type GateRow = {
  intent_id: string;
  gate: GateResult["gate"];
  passed: boolean;
  reason_code: GateResult["reasonCode"];
  adjustment: GateResult["adjustment"];
  ms: number;
};

const DEFAULT_TTL = 90_000;

function toView(row: IntentRow, gates: GateResult[]): IntentView {
  const ts = row.ts.getTime();
  const ttlMs = row.ttl_ms ?? DEFAULT_TTL;
  const intent: Intent = {
    id: row.id,
    chain: "solana",
    ts,
    kind: row.kind,
    strategy: row.strategy,
    ruleId: row.rule_id,
    mode: row.mode,
    mint: row.mint,
    side: row.side,
    sizeSol: Number(row.size_sol),
    sizing: row.sizing,
    features: row.features,
    why: row.why,
    ttlMs,
    replayRunId: row.replay_run_id,
  };
  const status = (
    row.status === "proposed" && Date.now() > ts + ttlMs ? "expired" : row.status
  ) as IntentStatus;
  return {
    intent,
    symbol: row.symbol ?? row.mint.slice(0, 4),
    status,
    gates,
    adjustedMul: adjustedMulOf(gates),
    expiresAt: ts + ttlMs,
    decidedBy: row.decided_by,
    decidedAt: ms(row.decided_at),
    execution: null,
    fill: null,
  };
}

async function gatesFor(db: Db, ids: string[]): Promise<Map<string, GateResult[]>> {
  const out = new Map<string, GateResult[]>();
  if (!ids.length) return out;
  const res = await db.query<GateRow>(
    "select intent_id, gate, passed, reason_code, adjustment, ms from gate_results where intent_id = any($1)",
    [ids],
  );
  for (const g of res.rows) {
    const list = out.get(g.intent_id) ?? [];
    list.push({
      gate: g.gate,
      passed: g.passed,
      reasonCode: g.reason_code,
      adjustment: g.adjustment,
      ms: Number(g.ms),
    });
    out.set(g.intent_id, list);
  }
  return out;
}

const INTENT_SELECT = `select i.*, t.symbol from intents i left join tokens t on t.mint = i.mint`;

export async function listIntents(
  db: Db,
  status: string | null,
  limit: number,
): Promise<IntentView[]> {
  const res = status
    ? await db.query<IntentRow>(
        `${INTENT_SELECT} where i.status = $1 order by i.ts desc limit $2`,
        [status, limit],
      )
    : await db.query<IntentRow>(`${INTENT_SELECT} order by i.ts desc limit $1`, [limit]);
  const gates = await gatesFor(
    db,
    res.rows.map((r) => r.id),
  );
  return res.rows.map((r) => toView(r, gates.get(r.id) ?? []));
}

export async function getIntent(db: Db, id: string): Promise<IntentView | null> {
  const res = await db.query<IntentRow>(`${INTENT_SELECT} where i.id = $1`, [id]);
  const row = res.rows[0];
  if (!row) return null;
  const gates = await gatesFor(db, [id]);
  return toView(row, gates.get(id) ?? []);
}

/** Approve or reject a proposed, unexpired intent. Returns null when nothing changed. */
export async function decideIntent(
  db: Db,
  id: string,
  decision: "approved" | "rejected",
  decidedBy: string,
): Promise<IntentView | null> {
  const res = await db.query(
    `update intents set status = $2, decided_by = $3, decided_at = now()
     where id = $1 and status = 'proposed' and ts + make_interval(secs => coalesce(ttl_ms, ${DEFAULT_TTL}) / 1000.0) > now()`,
    [id, decision, decidedBy],
  );
  if (res.rowCount === 0) return null;
  await db.query(
    "insert into events (ts, level, component, msg, data) values (now(), 'info', 'api', $1, $2)",
    [`intent ${decision}`, JSON.stringify({ id, decidedBy })],
  );
  return getIntent(db, id);
}

export async function listPositions(db: Db): Promise<PositionView[]> {
  const res = await db.query<{
    mint: string;
    symbol: string | null;
    wallet: string;
    opened_at: Date;
    cost_sol: number;
    qty: number;
    status: string;
    price: number | null;
  }>(
    `select p.mint, t.symbol, p.wallet, p.opened_at, p.cost_sol, p.qty, p.status,
            (select price from token_snapshots s where s.mint = p.mint order by ts desc limit 1) as price
       from positions p left join tokens t on t.mint = p.mint
      where p.status = 'open' order by p.opened_at desc`,
  );
  return res.rows.map((r) => ({
    mint: r.mint,
    symbol: r.symbol ?? r.mint.slice(0, 4),
    wallet: r.wallet,
    openedAt: r.opened_at.getTime(),
    costSol: Number(r.cost_sol),
    qty: Number(r.qty),
    priceUsd: r.price == null ? null : Number(r.price),
    valueSol: null, // needs SOL/USD and qty in the executor's units (Phase 2)
    pnlSol: null,
    pnlPct: null,
    trailStopPct: null,
    status: r.status as PositionView["status"],
  }));
}

export async function activeHalts(db: Db): Promise<HaltView[]> {
  const res = await db.query<{ ts: Date; kind: string; reason: string; cleared_at: Date | null }>(
    "select ts, kind, reason, cleared_at from halts where cleared_at is null order by ts desc",
  );
  return res.rows.map((r) => ({
    ts: r.ts.getTime(),
    kind: r.kind,
    reason: r.reason,
    clearedAt: ms(r.cleared_at),
  }));
}

export async function addHalt(db: Db, kind: string, reason: string): Promise<void> {
  await db.query(
    "insert into halts (ts, kind, reason) values (now(), $1, $2) on conflict do nothing",
    [kind, reason],
  );
  await db.query(
    "insert into events (ts, level, component, msg, data) values (now(), 'warn', 'api', 'halt', $1)",
    [JSON.stringify({ kind, reason })],
  );
}

export async function countOpenPositions(db: Db): Promise<number> {
  const res = await db.query<{ n: string }>(
    "select count(*)::text as n from positions where status = 'open'",
  );
  return Number(res.rows[0]?.n ?? 0);
}

export async function countPending(db: Db): Promise<number> {
  const res = await db.query<{ n: string }>(
    `select count(*)::text as n from intents where status = 'proposed' and ts + make_interval(secs => coalesce(ttl_ms, ${DEFAULT_TTL}) / 1000.0) > now()`,
  );
  return Number(res.rows[0]?.n ?? 0);
}

/** Pick a bucket so a range renders as roughly 180 candles. */
export function candleBucketSec(rangeSec: number): number {
  const target = rangeSec / 180;
  const steps = [10, 30, 60, 300, 900, 3600];
  return steps.find((s) => s >= target) ?? 3600;
}

export async function candlesFor(
  db: Db,
  mint: string,
  rangeSec: number,
): Promise<{ candles: Candle[]; bucketSec: number }> {
  const bucketSec = candleBucketSec(rangeSec);
  // date_bin is plain Postgres; the Timescale continuous aggregate is a later optimisation.
  const res = await db.query<{
    b: Date;
    o: number;
    h: number;
    l: number;
    c: number;
    v: number | null;
    n: string;
  }>(
    `with rows as (
       select date_bin(make_interval(secs => $3), ts, timestamptz '2000-01-01') as b, ts, price, vol5m
         from token_snapshots where mint = $1 and ts > now() - make_interval(secs => $2) and price is not null)
     select b,
            (array_agg(price order by ts asc))[1] as o,
            max(price) as h, min(price) as l,
            (array_agg(price order by ts desc))[1] as c,
            max(vol5m) as v, count(*)::text as n
       from rows group by b order by b asc`,
    [mint, rangeSec, bucketSec],
  );
  return {
    bucketSec,
    candles: res.rows.map((r) => ({
      t: r.b.getTime(),
      o: Number(r.o),
      h: Number(r.h),
      l: Number(r.l),
      c: Number(r.c),
      v: r.v == null ? null : Number(r.v),
      samples: Number(r.n),
    })),
  };
}

export async function tokenView(db: Db, mint: string): Promise<TokenView | null> {
  const tok = await db.query<{
    mint: string;
    symbol: string;
    name: string;
    stage: TokenView["stage"];
    created_at: Date | null;
  }>("select mint, symbol, name, stage, created_at from tokens where mint = $1", [mint]);
  const t = tok.rows[0];
  if (!t) return null;
  const [snap, audit, supply, micro, cand, intents] = await Promise.all([
    db.query<Snapshot & { ts: Date; stats_at: Date | null }>(
      "select * from token_snapshots where mint = $1 order by ts desc limit 1",
      [mint],
    ),
    db.query<{
      at: Date;
      program: string | null;
      mint_auth: boolean | null;
      freeze_auth: boolean | null;
      extensions: Audit["extensions"];
      lp_state: Audit["lp"];
      decimals: number | null;
      supply: number | null;
    }>("select * from audits where mint = $1 order by at desc limit 1", [mint]),
    db.query<{
      at: Date;
      dev_pct: number | null;
      bundle_pct: number | null;
      sniper_pct: number | null;
      fresh_pct: number | null;
      lp_pct: number | null;
      cluster_pct: number | null;
      trend: "distributing" | "accumulating" | "flat" | null;
    }>("select * from supply_maps where mint = $1 order by at desc limit 1", [mint]),
    db.query<{
      at: Date;
      net_flow_1m: number | null;
      net_flow_5m: number | null;
      organic_vol_pct_5m: number | null;
      depth_buy_2pct: number | null;
      depth_sell_2pct: number | null;
    }>("select * from microstructure where mint = $1 order by at desc limit 1", [mint]),
    candlesFor(db, mint, 6 * 3600),
    db.query<IntentRow>(`${INTENT_SELECT} where i.mint = $1 order by i.ts desc limit 20`, [mint]),
  ]);
  const s = snap.rows[0];
  const a = audit.rows[0];
  const sm = supply.rows[0];
  const mi = micro.rows[0];
  const gates = await gatesFor(
    db,
    intents.rows.map((r) => r.id),
  );
  return {
    mint,
    symbol: t.symbol,
    name: t.name,
    stage: t.stage,
    createdAt: ms(t.created_at),
    latest: s
      ? {
          ts: s.ts.getTime(),
          mint,
          price: s.price == null ? null : Number(s.price),
          mc: s.mc == null ? null : Number(s.mc),
          liq: s.liq == null ? null : Number(s.liq),
          vol5m: s.vol5m == null ? null : Number(s.vol5m),
          vol24: s.vol24 == null ? null : Number(s.vol24),
          tx24: s.tx24,
          buys5m: s.buys5m,
          sells5m: s.sells5m,
          holders: s.holders,
          top10: s.top10 == null ? null : Number(s.top10),
          source: s.source,
          statsAt: ms(s.stats_at),
        }
      : null,
    audit: a
      ? {
          mint,
          at: a.at.getTime(),
          authorities:
            a.mint_auth == null || a.freeze_auth == null
              ? null
              : {
                  mint: a.mint_auth,
                  freeze: a.freeze_auth,
                  program: a.program === "token2022" ? "token2022" : "token",
                },
          extensions: a.extensions,
          decimals: a.decimals,
          supply: a.supply == null ? null : Number(a.supply),
          lp: a.lp_state,
        }
      : null,
    supply: sm
      ? {
          at: sm.at.getTime(),
          devPct: sm.dev_pct,
          bundlePct: sm.bundle_pct,
          sniperPct: sm.sniper_pct,
          freshWalletPct: sm.fresh_pct,
          lpPct: sm.lp_pct,
          clusterPct: sm.cluster_pct,
          earlyHoldersTrend: sm.trend,
        }
      : null,
    micro: mi
      ? {
          at: mi.at.getTime(),
          netFlowSol1m: mi.net_flow_1m,
          netFlowSol5m: mi.net_flow_5m,
          organicVolPct5m: mi.organic_vol_pct_5m,
          depthBuy2PctUsd: mi.depth_buy_2pct,
          depthSell2PctUsd: mi.depth_sell_2pct,
        }
      : null,
    holders: [], // holder shares land with the profiler (Phase 2)
    candles: cand.candles,
    candleBucketSec: cand.bucketSec,
    intents: intents.rows.map((r) => toView(r, gates.get(r.id) ?? [])),
  };
}

export async function funnelView(
  db: Db,
  layers: FunnelView["layers"],
  sinceMs: number,
): Promise<FunnelView> {
  const [rej, adj] = await Promise.all([
    db.query<{ gate: string; reason: string; n: string }>(
      `select g.gate, g.reason_code as reason, count(*)::text as n from gate_results g join intents i on i.id = g.intent_id
        where g.passed = false and i.ts > $1 group by g.gate, g.reason_code order by count(*) desc`,
      [new Date(sinceMs)],
    ),
    db.query<{ gate: string; n: string }>(
      `select g.gate, count(*)::text as n from gate_results g join intents i on i.id = g.intent_id
        where g.adjustment is not null and i.ts > $1 group by g.gate order by count(*) desc`,
      [new Date(sinceMs)],
    ),
  ]);
  return {
    sinceMs,
    layers,
    rejections: rej.rows.map((r) => ({ gate: r.gate, reason: r.reason, n: Number(r.n) })),
    adjustments: adj.rows.map((r) => ({ gate: r.gate, n: Number(r.n) })),
  };
}

export async function listReplays(db: Db): Promise<ReplayRunView[]> {
  const res = await db.query<{
    id: string;
    rules_version: string;
    window_start: Date;
    window_end: Date;
    started_at: Date;
    finished_at: Date | null;
    summary: ReplayRunView["summary"];
  }>("select * from replay_runs order by started_at desc limit 20");
  return res.rows.map((r) => ({
    id: r.id,
    rulesVersion: r.rules_version,
    windowStart: r.window_start.getTime(),
    windowEnd: r.window_end.getTime(),
    startedAt: r.started_at.getTime(),
    finishedAt: ms(r.finished_at),
    summary: r.summary,
  }));
}
