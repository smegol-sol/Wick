/**
 * The evaluator (ADR-0004 level 2): outcomes every minute; once a day per
 * rule, the 14-day statistics, one bounded weight move, and the disable rule.
 * Every change is a `rule_stats` row with its reason and number, and the
 * decision loop reads the effective weight from here. The operator alone
 * re-enables a disabled rule.
 */
import type { RuleStatsView, RuleView } from "@wick/core/api";
import {
  eligibleForAuto,
  nextWeight,
  ruleStats,
  SCORING_HORIZON_SEC,
  shouldDisable,
  WEIGHT_RULES,
  type OutcomeRow,
  type RuleStats,
} from "@wick/core/evaluator";
import { mirrorDemotion } from "@wick/core/mirror";
import { mirrorRule, type RulesFile } from "@wick/core/rules";
import { walletCopies, watchWallet } from "../api/queries.ts";
import type { Db } from "../db/pool.ts";
import { errText, logger } from "../log.ts";
import * as m from "../metrics.ts";
import { writeOutcomes } from "./outcomes.ts";

const log = logger("evaluator");

export type RuleState = {
  weight: number;
  disabled: boolean;
  disabledReason: string | null;
  stats: RuleStatsView | null;
  eligibleForAuto: boolean;
};

type StatsRow = {
  rule_id: string;
  window_days: number;
  n: number;
  win_rate: number | null;
  expectancy: number | null;
  worst_dd: number | null;
  weight: number;
  changed_at: Date;
  change_reason: string;
  disabled: boolean;
};

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export type EvaluatorDeps = {
  db: Db;
  rules: RulesFile;
  now?: () => number;
  /** A line for the owner when a rule is disabled or its weight moves. */
  onChange?: (text: string) => void;
};
export type EvaluatorConfig = { outcomesEveryMs: number; statsEveryMs: number };

export class Evaluator {
  private readonly deps: EvaluatorDeps;
  private readonly cfg: EvaluatorConfig;
  private readonly now: () => number;
  private readonly states = new Map<string, RuleState>();
  private timers: NodeJS.Timeout[] = [];
  private busy = false;
  private lastStatsAt = 0;
  private walletsDay = "";

  constructor(deps: EvaluatorDeps, cfg: EvaluatorConfig) {
    this.deps = deps;
    this.cfg = cfg;
    this.now = deps.now ?? Date.now;
    for (const r of deps.rules.rules)
      this.states.set(r.id, {
        weight: r.weight,
        disabled: false,
        disabledReason: null,
        stats: null,
        eligibleForAuto: false,
      });
  }

  /** The effective state the loop and the API read; the rules file's weight until a row says otherwise. */
  state(ruleId: string): RuleState | null {
    return this.states.get(ruleId) ?? null;
  }

  view(): RuleView[] {
    return this.deps.rules.rules.map((r) => {
      const st = this.state(r.id);
      return {
        id: r.id,
        strategy: r.strategy,
        mode: r.mode,
        weight: st?.weight ?? r.weight,
        stats: st?.stats ?? null,
        eligibleForAuto: st?.eligibleForAuto ?? false,
        disabled: st?.disabled ?? false,
        disabledReason: st?.disabledReason ?? null,
      };
    });
  }

  /** Read the latest row per rule; called at boot and after every write. */
  async load(): Promise<void> {
    const res = await this.deps.db.query<StatsRow>(
      `select distinct on (rule_id) * from rule_stats
        where window_days = $1 and replay_run_id is null order by rule_id, changed_at desc`,
      [WEIGHT_RULES.windowDays],
    );
    for (const row of res.rows) {
      const st = this.states.get(row.rule_id);
      if (!st) continue; // a rule that left the rules file keeps its history, nothing else
      st.weight = row.weight;
      st.disabled = row.disabled;
      st.disabledReason = row.disabled ? row.change_reason : null;
      st.stats = {
        windowDays: row.window_days,
        n: row.n,
        winRate: row.win_rate,
        expectancy: row.expectancy,
        worstDd: row.worst_dd,
        changedAt: row.changed_at.getTime(),
        changeReason: row.change_reason,
      };
      m.ruleWeight.set({ rule: row.rule_id }, row.disabled ? 0 : row.weight);
    }
    for (const [id, st] of this.states)
      if (!res.rows.some((r) => r.rule_id === id)) m.ruleWeight.set({ rule: id }, st.weight);
  }

  /** Outcomes now; the daily statistics when `statsEveryMs` has passed. Public for tests. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const now = this.now();
    try {
      const o = await writeOutcomes(this.deps.db, now);
      if (o.measured || o.empty) log.info("outcomes", o);
      if (now - this.lastStatsAt >= this.cfg.statsEveryMs) {
        this.lastStatsAt = now;
        await this.evaluate(now);
      }
    } catch (e) {
      log.error("evaluator tick failed", { err: errText(e) });
    } finally {
      this.busy = false;
    }
  }

  /** The window's rows for one rule: every intent with its scoring-horizon outcome. */
  private async windowRows(ruleId: string, now: number): Promise<OutcomeRow[]> {
    const res = await this.deps.db.query<{
      side: "buy" | "sell";
      ret_pct: number | null;
      min_ret_pct: number | null;
      max_ret_pct: number | null;
    }>(
      `select i.side, o.ret_pct, o.min_ret_pct, o.max_ret_pct
         from intents i join outcomes o on o.intent_id = i.id and o.horizon_sec = $3
        where i.rule_id = $1 and i.ts >= $2 and i.replay_run_id is null`,
      [ruleId, new Date(now - WEIGHT_RULES.windowDays * 86_400_000), SCORING_HORIZON_SEC],
    );
    return res.rows.map((r) => ({
      side: r.side,
      retPct: r.ret_pct,
      minRetPct: r.min_ret_pct,
      maxRetPct: r.max_ret_pct,
    }));
  }

  private async suggestRecord(ruleId: string, now: number): Promise<boolean> {
    const res = await this.deps.db.query<{
      suggested: string;
      approved: string;
      decided: string;
      executed_expectancy: number | null;
    }>(
      `select count(*)::text as suggested,
              count(*) filter (where status in ('approved', 'executed', 'failed'))::text as approved,
              count(*) filter (where status in ('approved', 'executed', 'failed', 'rejected', 'expired'))::text as decided,
              avg(case when i.side = 'sell' then -o.ret_pct else o.ret_pct end)
                filter (where status = 'executed') as executed_expectancy
         from intents i left join outcomes o on o.intent_id = i.id and o.horizon_sec = $3
        where i.rule_id = $1 and i.mode = 'suggest' and i.ts >= $2 and i.replay_run_id is null`,
      [ruleId, new Date(now - WEIGHT_RULES.windowDays * 86_400_000), SCORING_HORIZON_SEC],
    );
    const r = res.rows[0];
    if (!r) return false;
    return eligibleForAuto({
      suggested: Number(r.suggested),
      approved: Number(r.approved),
      decided: Number(r.decided),
      executedExpectancy: r.executed_expectancy,
    });
  }

  /** The last `disableDays` daily rows, oldest first. */
  private async recentDays(ruleId: string): Promise<{ n: number; expectancy: number | null }[]> {
    const res = await this.deps.db.query<{ n: number; expectancy: number | null }>(
      `select n, expectancy from rule_stats where rule_id = $1 and window_days = $2 and replay_run_id is null
        order by changed_at desc limit $3`,
      [ruleId, WEIGHT_RULES.windowDays, WEIGHT_RULES.disableDays - 1],
    );
    return res.rows.reverse().map((r) => ({ n: r.n, expectancy: pctOf(r.expectancy) }));
  }

  /** One evaluation per rule per UTC day; a second call the same day changes nothing. */
  async evaluate(now: number): Promise<void> {
    await this.load();
    for (const rule of this.deps.rules.rules) {
      const st = this.states.get(rule.id)!;
      if (st.stats && dayKey(st.stats.changedAt) === dayKey(now)) continue;
      try {
        const stats = ruleStats(await this.windowRows(rule.id, now));
        const eligible = await this.suggestRecord(rule.id, now);
        st.eligibleForAuto = eligible;
        let weight = st.weight;
        let disabled = st.disabled;
        let reason: string;
        if (disabled) {
          reason = `disabled; ${st.disabledReason ?? "awaiting the operator"}`;
        } else {
          const move = nextWeight(st.weight, stats);
          weight = move.weight;
          reason = move.reason;
          const days = [
            ...(await this.recentDays(rule.id)),
            { n: stats.n, expectancy: stats.expectancy },
          ];
          if (shouldDisable(days)) {
            disabled = true;
            reason = `disabled: expectancy negative on ${WEIGHT_RULES.disableDays} consecutive days with ${WEIGHT_RULES.minN}+ intents (last ${stats.expectancy}% on ${stats.n}); only the operator re-enables`;
          }
        }
        reason += distributionNote(stats);
        await this.write(rule.id, stats, weight, disabled, reason, now);
        if (disabled && !st.disabled) {
          log.error("rule disabled", { rule: rule.id, reason });
          this.deps.onChange?.(`rule ${rule.id} disabled: ${reason}`);
        } else if (weight !== st.weight) {
          log.warn("rule weight moved", { rule: rule.id, reason });
          this.deps.onChange?.(`rule ${rule.id}: ${reason}`);
        } else
          log.info("rule evaluated", { rule: rule.id, n: stats.n, expectancy: stats.expectancy });
      } catch (e) {
        m.dbErrors.inc({ op: "rule_stats" });
        log.error("rule evaluation failed", { rule: rule.id, err: errText(e) });
      }
    }
    await this.load();
    if (this.walletsDay !== dayKey(now)) {
      this.walletsDay = dayKey(now);
      await this.demoteWallets();
    }
  }

  /**
   * mirror-follow (ENGINE §9): a followed wallet whose last ten measured copies lost money on
   * average goes back to watch; only the owner follows it again. Public for tests.
   */
  async demoteWallets(): Promise<void> {
    if (!mirrorRule(this.deps.rules)) return;
    try {
      const res = await this.deps.db.query<{ pk: string; label: string | null }>(
        `select pk, label from wallets where kind = 'owner' and status = 'follow'`,
      );
      for (const w of res.rows) {
        const copies = (await walletCopies(this.deps.db, w.pk))
          .reverse()
          .filter((c) => c.side === "buy");
        const d = mirrorDemotion(copies);
        if (!d.demote) continue;
        await watchWallet(this.deps.db, w.pk, d.reason);
        m.walletDemotions.inc();
        log.warn("wallet demoted", { wallet: w.pk, reason: d.reason });
        this.deps.onChange?.(`wallet ${w.label ?? w.pk} demoted to watch: ${d.reason}`);
      }
    } catch (e) {
      m.dbErrors.inc({ op: "wallets" });
      log.error("wallet demotion failed", { err: errText(e) });
    }
  }

  private async write(
    ruleId: string,
    stats: RuleStats,
    weight: number,
    disabled: boolean,
    reason: string,
    now: number,
  ): Promise<void> {
    await this.deps.db.query(
      `insert into rule_stats (rule_id, window_days, n, win_rate, expectancy, worst_dd, weight, changed_at, change_reason, disabled)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        ruleId,
        WEIGHT_RULES.windowDays,
        stats.n,
        stats.winRate,
        fractionOf(stats.expectancy),
        fractionOf(stats.worstDd),
        weight,
        new Date(now),
        reason.slice(0, 500),
        disabled,
      ],
    );
  }

  /** The operator's re-enable: a row with the reason, the weight back at the floor's safe side. */
  async enable(ruleId: string, by: string): Promise<boolean> {
    const st = this.states.get(ruleId);
    if (!st || !st.disabled) return false;
    const now = this.now();
    await this.deps.db.query(
      `insert into rule_stats (rule_id, window_days, n, win_rate, expectancy, worst_dd, weight, changed_at, change_reason, disabled)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, false)`,
      [
        ruleId,
        WEIGHT_RULES.windowDays,
        st.stats?.n ?? 0,
        st.stats?.winRate ?? null,
        st.stats?.expectancy ?? null,
        st.stats?.worstDd ?? null,
        WEIGHT_RULES.min,
        new Date(now),
        `re-enabled by ${by} at weight ${WEIGHT_RULES.min}`,
      ],
    );
    log.warn("rule re-enabled", { rule: ruleId, by });
    await this.load();
    return true;
  }

  start(): void {
    void this.load()
      .then(() => this.tick())
      .catch((e) => log.error("evaluator boot failed", { err: errText(e) }));
    const t = setInterval(() => void this.tick(), this.cfg.outcomesEveryMs);
    t.unref();
    this.timers.push(t);
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}

/** Core reports percent; the contract and the table carry fractions (the console formats ×100). */
function fractionOf(pct: number | null): number | null {
  return pct == null ? null : Math.round((pct / 100) * 1e6) / 1e6;
}
function pctOf(fraction: number | null): number | null {
  return fraction == null ? null : fraction * 100;
}

function distributionNote(s: RuleStats): string {
  if (s.n === 0) return "; no measured outcome in the window";
  return `; p25/p50/p75 ${s.p25}/${s.p50}/${s.p75}%, worst ${s.worstDd}%`;
}
