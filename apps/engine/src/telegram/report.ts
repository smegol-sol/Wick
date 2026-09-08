/**
 * The texts the bot sends: `/status` from the API state, and the daily
 * report from the tables (ADR-0009 §4). Every number has a source or reads
 * n/a; the bot adds nothing the console does not show.
 */
import type { ApiState, RuleView } from "@wick/core/api";
import type { Db } from "../db/pool.ts";

const na = "n/a";
const sol = (v: number | null | undefined, d = 3) => (v == null ? na : `${v.toFixed(d)} SOL`);
const pct = (v: number | null | undefined, d = 1) => (v == null ? na : `${(v * 100).toFixed(d)}%`);

export function formatStatus(s: ApiState, rules: RuleView[]): string {
  const halts = s.halts.filter((h) => h.clearedAt == null);
  const lines = [
    `WICK ${s.version} · tier ${s.tier} · vault ${s.vault}`,
    `equity ${sol(s.equitySol)} · today ${sol(s.dayPnlSol)}${s.dayPnlPct == null ? "" : ` (${s.dayPnlPct.toFixed(1)}%)`}`,
    `positions ${s.openPositions} · waiting ${s.pendingIntents} · modes shadow ${s.modes.shadow} suggest ${s.modes.suggest} auto ${s.modes.auto}`,
    `health ${s.health.ok ? "ok" : "self-halt: " + s.health.reasons.join("; ")}`,
    `regime ${s.regime ? `×${s.regime.sizeMul} (${s.regime.reason})` : na}`,
    halts.length ? `HALTED: ${halts.map((h) => `${h.kind}: ${h.reason}`).join(" | ")}` : "no halt",
  ];
  for (const r of rules) {
    const st = r.stats;
    lines.push(
      `${r.id}: ${r.disabled ? "off" : r.mode} ×${r.weight}` +
        (st ? ` · n ${st.n} · win ${pct(st.winRate, 0)} · exp ${pct(st.expectancy)}` : ""),
    );
  }
  return lines.join("\n");
}

export type DailyReport = {
  day: string;
  intents: Record<string, number>;
  executed: number;
  realizedPnlSol: number | null;
  closed: number;
  openPositions: number;
  outcomesMeasured: number;
  halts: { kind: string; reason: string }[];
  regimeMinutes: { zero: number; half: number; total: number };
  rules: {
    id: string;
    n: number;
    winRate: number | null;
    expectancy: number | null;
    weight: number;
    disabled: boolean;
  }[];
};

/** Yesterday's numbers (UTC) out of the tables. */
export async function dailyReport(db: Db, dayStartMs: number): Promise<DailyReport> {
  const from = new Date(dayStartMs);
  const to = new Date(dayStartMs + 86_400_000);
  const [intents, pnl, open, outcomes, halts, regime, rules] = await Promise.all([
    db.query<{ status: string; n: string }>(
      `select status, count(*)::text as n from intents where ts >= $1 and ts < $2 and replay_run_id is null group by status`,
      [from, to],
    ),
    db.query<{ n: string; sum: number | null }>(
      `select count(*)::text as n, sum(realized_pnl_sol) as sum from positions where status = 'closed' and closed_at >= $1 and closed_at < $2`,
      [from, to],
    ),
    db.query<{ n: string }>(`select count(*)::text as n from positions where status = 'open'`),
    db.query<{ n: string }>(
      `select count(*)::text as n from outcomes o join intents i on i.id = o.intent_id where i.ts >= $1 and i.ts < $2 and o.ret_pct is not null`,
      [from, to],
    ),
    db.query<{ kind: string; reason: string }>(
      `select kind, reason from halts where ts >= $1 and ts < $2 order by ts`,
      [from, to],
    ),
    db.query<{ zero: string; half: string; total: string }>(
      `select count(*) filter (where size_mul = 0)::text as zero, count(*) filter (where size_mul = 0.5)::text as half, count(*)::text as total
         from regime where at >= $1 and at < $2`,
      [from, to],
    ),
    db.query<{
      rule_id: string;
      n: number;
      win_rate: number | null;
      expectancy: number | null;
      weight: number;
      disabled: boolean;
    }>(
      `select distinct on (rule_id) rule_id, n, win_rate, expectancy, weight, disabled from rule_stats order by rule_id, changed_at desc`,
    ),
  ]);
  const byStatus: Record<string, number> = {};
  for (const r of intents.rows) byStatus[r.status] = Number(r.n);
  const closed = Number(pnl.rows[0]?.n ?? 0);
  return {
    day: from.toISOString().slice(0, 10),
    intents: byStatus,
    executed: byStatus.executed ?? 0,
    realizedPnlSol: closed > 0 && pnl.rows[0]?.sum != null ? Number(pnl.rows[0].sum) : null,
    closed,
    openPositions: Number(open.rows[0]?.n ?? 0),
    outcomesMeasured: Number(outcomes.rows[0]?.n ?? 0),
    halts: halts.rows,
    regimeMinutes: {
      zero: Number(regime.rows[0]?.zero ?? 0),
      half: Number(regime.rows[0]?.half ?? 0),
      total: Number(regime.rows[0]?.total ?? 0),
    },
    rules: rules.rows.map((r) => ({
      id: r.rule_id,
      n: r.n,
      winRate: r.win_rate,
      expectancy: r.expectancy,
      weight: r.weight,
      disabled: r.disabled,
    })),
  };
}

export function formatReport(r: DailyReport): string {
  const total = Object.values(r.intents).reduce((a, b) => a + b, 0);
  const statuses = Object.entries(r.intents)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  const lines = [
    `WICK daily report · ${r.day} (UTC)`,
    `intents ${total}${total ? ` (${statuses})` : ""} · outcomes measured ${r.outcomesMeasured}`,
    `executed ${r.executed} · closed ${r.closed} · realized ${sol(r.realizedPnlSol)} · open now ${r.openPositions}`,
    r.regimeMinutes.total
      ? `regime: ×0 for ${r.regimeMinutes.zero} min, ×0.5 for ${r.regimeMinutes.half} min of ${r.regimeMinutes.total}`
      : "regime: no rows",
    r.halts.length
      ? `halts: ${r.halts.map((h) => `${h.kind}: ${h.reason}`).join(" | ")}`
      : "halts: none",
  ];
  for (const x of r.rules)
    lines.push(
      `${x.id}: ${x.disabled ? "off" : `×${x.weight}`} · n ${x.n} · win ${pct(x.winRate, 0)} · exp ${pct(x.expectancy)}`,
    );
  return lines.join("\n");
}

/** The UTC day start for "yesterday" relative to `now`. */
export function yesterdayStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 86_400_000;
}
