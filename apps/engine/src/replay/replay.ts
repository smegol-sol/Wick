/**
 * Replay (ADR-0007 §2): the production sieve, rules, sizing and gates run
 * over stored data at its original timestamps. There is no stored features
 * row (ENGINE §2); the same `FeatureBook` the live engine uses is fed the
 * stored snapshots, audits, launch parse, supply maps and prints in time
 * order, and asked for the row at every stored second. Fills come from the
 * conservative execution model in core; outcomes from the stored snapshots.
 * Everything written carries `replay_run_id`, and no live query reads it.
 *
 * What v1 measures: the entry rules, gated, filled by the model, scored at
 * the evaluator's horizon (30 minutes). The exit policy is not simulated
 * yet; a replayed position closes at the horizon. That is written on the run.
 */
import { randomUUID } from "node:crypto";
import type { LaunchTx, Trade } from "@wick/core/chain";
import type { Audit, Features, GateResult, Snapshot, Stage, SupplyMap } from "@wick/core/contracts";
import { evaluateEntry, sieve, type EntryRule } from "@wick/core/decide";
import { entryRules, type RulesFile } from "@wick/core/rules";
import { outcomeOf, ruleStats, HORIZONS_SEC, SCORING_HORIZON_SEC } from "@wick/core/evaluator";
import { runGates, type GateBook, type GateLimits } from "@wick/core/gates";
import { poolSolOf, replayFill, REPLAY_EXEC_MODEL } from "@wick/core/replay";
import { sizeEntry } from "@wick/core/sizing";
import type { ReplayRunView } from "@wick/core/api";
import type { RiskConfig } from "../config.ts";
import type { Db } from "../db/pool.ts";
import { FeatureBook } from "../ingest/features.ts";
import { errText, logger } from "../log.ts";
import * as m from "../metrics.ts";

const log = logger("replay");
const PRE_GATES = ["safety", "supply", "liquidity", "manipulation"] as const;
const WARMUP_MS = 5 * 60_000;

export type ReplayOptions = {
  fromMs: number;
  toMs: number;
  rules: RulesFile;
  rulesHash: string;
  risk: RiskConfig;
  /** Capital the sizing works with; the wallet cap by default. */
  equitySol: number;
  codeVersion: string | null;
};

type Event =
  | { ts: number; kind: "audit"; audit: Audit }
  | { ts: number; kind: "launch"; launch: LaunchTx }
  | { ts: number; kind: "supply"; map: SupplyMap }
  | { ts: number; kind: "print"; trade: Trade };

type OpenPos = { mint: string; openedAt: number; costSol: number; createdAt: number | null };

function nearestAtOrBefore<T extends { ts: number }>(rows: T[], ts: number): T | null {
  let lo = 0;
  let hi = rows.length - 1;
  let best: T | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.ts <= ts) {
      best = rows[mid]!;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

export async function replay(db: Db, o: ReplayOptions): Promise<ReplayRunView> {
  const id = `replay-${randomUUID()}`;
  const startedAt = Date.now();
  const execModel = {
    ...REPLAY_EXEC_MODEL,
    horizonSec: SCORING_HORIZON_SEC,
    exits: "close at the horizon",
  };
  await db.query(
    `insert into replay_runs (id, rules_version, window_start, window_end, exec_model, started_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      o.rulesHash,
      new Date(o.fromMs),
      new Date(o.toMs),
      JSON.stringify(execModel),
      new Date(startedAt),
    ],
  );
  const rules = entryRules(o.rules);
  const limits = limitsOf(o.risk, o.equitySol);
  const [solRows, regimeRows, mints] = await Promise.all([
    db.query<{ ts: Date; usd: number }>(
      `select ts, usd from sol_price where ts >= $1 and ts < $2 order by ts`,
      [new Date(o.fromMs - WARMUP_MS), new Date(o.toMs)],
    ),
    db.query<{ at: Date; size_mul: number }>(
      `select at, size_mul from regime where at >= $1 and at < $2 order by at`,
      [new Date(o.fromMs - 120_000), new Date(o.toMs)],
    ),
    db.query<{ mint: string }>(
      `select distinct mint from token_snapshots where ts >= $1 and ts < $2 and price is not null`,
      [new Date(o.fromMs), new Date(o.toMs)],
    ),
  ]);
  const sol = solRows.rows.map((r) => ({ ts: r.ts.getTime(), usd: r.usd }));
  const regime = regimeRows.rows.map((r) => ({ ts: r.at.getTime(), mul: r.size_mul }));
  const cooldown = new Map<string, number>();
  const open: OpenPos[] = [];
  const scored: {
    side: "buy";
    retPct: number | null;
    minRetPct: number | null;
    maxRetPct: number | null;
    rule: string;
  }[] = [];
  let intents = 0;
  let executed = 0;
  try {
    for (const { mint } of mints.rows) {
      const r = await replayMint(db, id, mint, o, rules, limits, sol, regime, cooldown, open);
      intents += r.intents;
      executed += r.executed;
      scored.push(...r.scored);
    }
    const stats = ruleStats(scored);
    const summary: NonNullable<ReplayRunView["summary"]> = {
      intents,
      executed,
      expectancy: stats.expectancy == null ? null : stats.expectancy / 100,
      winRate: stats.winRate,
      worstDd: stats.worstDd == null ? null : stats.worstDd / 100,
    };
    const finishedAt = Date.now();
    await db.query(`update replay_runs set finished_at = $2, summary = $3 where id = $1`, [
      id,
      new Date(finishedAt),
      JSON.stringify(summary),
    ]);
    const days = Math.max(1, Math.round((o.toMs - o.fromMs) / 86_400_000));
    for (const rule of rules) {
      const rs = ruleStats(scored.filter((s) => s.rule === rule.id));
      await db.query(
        `insert into rule_stats (rule_id, window_days, n, win_rate, expectancy, worst_dd, weight, changed_at, change_reason, replay_run_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          rule.id,
          days,
          rs.n,
          rs.winRate,
          rs.expectancy == null ? null : rs.expectancy / 100,
          rs.worstDd == null ? null : rs.worstDd / 100,
          rule.weight,
          new Date(finishedAt),
          `replay ${id} over ${days} day(s): p25/p50/p75 ${rs.p25}/${rs.p50}/${rs.p75}%`,
          id,
        ],
      );
    }
    m.replayRuns.inc({ status: "finished" });
    log.info("replay finished", { id, mints: mints.rows.length, ...summary });
    return {
      id,
      rulesVersion: o.rulesHash,
      windowStart: o.fromMs,
      windowEnd: o.toMs,
      startedAt,
      finishedAt,
      summary,
    };
  } catch (e) {
    m.replayRuns.inc({ status: "failed" });
    log.error("replay failed", { id, err: errText(e) });
    throw e;
  }
}

function limitsOf(r: RiskConfig, equity: number): GateLimits {
  return {
    minTradeSol: r.minTradeSol,
    quoteMaxAgeMs: r.quote.maxAgeMs,
    maxImpactEntryPct: r.quote.maxImpactEntryPct,
    maxImpactExitPct: r.quote.maxImpactExitPct,
    maxOpenPositions: r.maxOpenPositions,
    tokenCapSol: (equity * r.maxTokenExposurePct) / 100,
    youngTokenExposurePct: r.youngTokenExposurePct,
    feeReserveSol: r.feeReserveSol,
    dailyHaltPct: r.dailyHaltPct,
    weeklyHaltPct: r.weeklyHaltPct,
    postLossDayMul: r.postLossDayMul,
  };
}

async function loadEvents(db: Db, mint: string, toMs: number): Promise<Event[]> {
  const to = new Date(toMs);
  const [audits, launch, maps, prints] = await Promise.all([
    db.query<{
      at: Date;
      program: string | null;
      mint_auth: boolean | null;
      freeze_auth: boolean | null;
      extensions: Audit["extensions"];
      lp_state: Audit["lp"];
      decimals: number | null;
      supply: number | null;
    }>(`select * from audits where mint = $1 and at < $2 order by at`, [mint, to]),
    db.query<{
      slot: string;
      creator: string;
      buyers: LaunchTx["buyers"];
      bundle_pct: number;
      sniper_pct: number;
    }>(`select slot, creator, buyers, bundle_pct, sniper_pct from launch_txs where mint = $1`, [
      mint,
    ]),
    db.query<{
      at: Date;
      dev_pct: number | null;
      bundle_pct: number | null;
      sniper_pct: number | null;
      fresh_pct: number | null;
      lp_pct: number | null;
      cluster_pct: number | null;
      trend: SupplyMap["earlyHoldersTrend"];
    }>(`select * from supply_maps where mint = $1 and at < $2 order by at`, [mint, to]),
    db.query<{
      sig: string;
      wallet: string;
      ts: Date;
      side: "buy" | "sell";
      sol: number;
      amount: number;
    }>(
      `select sig, wallet, ts, side, sol, amount from wallet_prints where mint = $1 and ts < $2 order by ts`,
      [mint, to],
    ),
  ]);
  const created = await db.query<{ created_at: Date | null }>(
    `select created_at from tokens where mint = $1`,
    [mint],
  );
  const createdAt = created.rows[0]?.created_at?.getTime() ?? null;
  const events: Event[] = [];
  for (const a of audits.rows)
    events.push({
      ts: a.at.getTime(),
      kind: "audit",
      audit: {
        mint,
        at: a.at.getTime(),
        authorities:
          a.program == null
            ? null
            : {
                mint: a.mint_auth ?? false,
                freeze: a.freeze_auth ?? false,
                program: a.program as never,
              },
        extensions: a.extensions,
        decimals: a.decimals,
        supply: a.supply,
        lp: a.lp_state,
      },
    });
  const l = launch.rows[0];
  if (l)
    events.push({
      ts: createdAt ?? 0,
      kind: "launch",
      launch: {
        mint,
        slot: Number(l.slot),
        sig: "",
        ts: createdAt,
        creator: l.creator,
        buyers: l.buyers,
        bundlePct: l.bundle_pct,
        sniperPct: l.sniper_pct,
        truncated: false,
      },
    });
  for (const s of maps.rows)
    events.push({
      ts: s.at.getTime(),
      kind: "supply",
      map: {
        at: s.at.getTime(),
        devPct: s.dev_pct,
        bundlePct: s.bundle_pct,
        sniperPct: s.sniper_pct,
        freshWalletPct: s.fresh_pct,
        lpPct: s.lp_pct,
        clusterPct: s.cluster_pct,
        earlyHoldersTrend: s.trend,
      },
    });
  for (const p of prints.rows)
    events.push({
      ts: p.ts.getTime(),
      kind: "print",
      trade: {
        sig: p.sig,
        slot: 0,
        ts: p.ts.getTime(),
        wallet: p.wallet,
        mint,
        side: p.side,
        sol: p.sol,
        amount: p.amount,
      },
    });
  events.sort((a, b) => a.ts - b.ts);
  return events;
}

async function replayMint(
  db: Db,
  runId: string,
  mint: string,
  o: ReplayOptions,
  rules: EntryRule[],
  limits: GateLimits,
  sol: { ts: number; usd: number }[],
  regime: { ts: number; mul: number }[],
  cooldown: Map<string, number>,
  open: OpenPos[],
): Promise<{
  intents: number;
  executed: number;
  scored: {
    side: "buy";
    retPct: number | null;
    minRetPct: number | null;
    maxRetPct: number | null;
    rule: string;
  }[];
}> {
  const horizonMs = Math.max(...HORIZONS_SEC) * 1000;
  const [token, migrated, snaps] = await Promise.all([
    db.query<{ created_at: Date | null; symbol: string }>(
      `select created_at, symbol from tokens where mint = $1`,
      [mint],
    ),
    db.query<{ ts: Date }>(
      `select min(ts) as ts from chain_events where mint = $1 and kind = 'migrate'`,
      [mint],
    ),
    db.query<Record<string, unknown> & { ts: Date; price: number | null }>(
      `select * from token_snapshots where mint = $1 and ts >= $2 and ts < $3 order by ts`,
      [mint, new Date(o.fromMs - WARMUP_MS), new Date(o.toMs + horizonMs)],
    ),
  ]);
  const createdAt = token.rows[0]?.created_at?.getTime() ?? null;
  const migratedAt = migrated.rows[0]?.ts?.getTime() ?? null;
  if (createdAt == null || !snaps.rows.length) return { intents: 0, executed: 0, scored: [] };
  const events = await loadEvents(db, mint, o.toMs);
  const book = new FeatureBook();
  const series = snaps.rows.map((r) => ({ ts: r.ts.getTime(), price: r.price }));
  let ei = 0;
  const out = {
    intents: 0,
    executed: 0,
    scored: [] as {
      side: "buy";
      retPct: number | null;
      minRetPct: number | null;
      maxRetPct: number | null;
      rule: string;
    }[],
  };
  for (const row of snaps.rows) {
    const ts = row.ts.getTime();
    if (ts >= o.toMs) break;
    const stage: Stage = migratedAt != null && ts >= migratedAt ? "migrated" : "bonding";
    book.noteToken(mint, stage, createdAt);
    while (ei < events.length && events[ei]!.ts <= ts) {
      const ev = events[ei++]!;
      if (ev.kind === "audit") book.noteAudit(ev.audit);
      else if (ev.kind === "launch") book.noteLaunch(ev.launch);
      else if (ev.kind === "supply") book.noteSupply(mint, ev.map);
      else book.notePrint(ev.trade, ev.ts);
    }
    const solUsd =
      nearestAtOrBefore(
        sol.map((s) => ({ ts: s.ts, usd: s.usd })),
        ts,
      )?.usd ?? null;
    book.noteSnapshot(rowToSnapshot(row, mint), solUsd);
    if (ts < o.fromMs) continue;
    const f = book.features(mint, ts);
    if (!f || solUsd == null) continue;
    if (!sieve(f, rules)) continue;
    for (const rule of rules) {
      const key = `${mint}|${rule.id}`;
      const last = cooldown.get(key);
      if (last != null && ts - last < o.rules.intentCooldownMs) continue;
      const v = evaluateEntry(rule, f);
      if (!v.ok) continue;
      cooldown.set(key, ts);
      // Close replayed positions at the horizon before the book is read.
      for (let i = open.length - 1; i >= 0; i--)
        if (ts - open[i]!.openedAt >= SCORING_HORIZON_SEC * 1000) open.splice(i, 1);
      const regimeMul = (nearestAtOrBefore(regime, ts)?.mul ?? 1) as 0 | 0.5 | 1;
      if (regimeMul === 0) continue;
      const sized = sizeEntry({
        equitySol: o.equitySol,
        perTradePct: o.risk.perTradePct,
        poolLiqUsd: f.liqUsd,
        poolSharePct: o.risk.poolSharePct,
        solUsd,
        tokenCapSol: (o.equitySol * o.risk.maxTokenExposurePct) / 100,
        openExposureSol: open.filter((p) => p.mint === mint).reduce((a, p) => a + p.costSol, 0),
        regimeMul,
        socialMul: 1,
        weightMul: v.weight,
      });
      const sizeSol = Math.round(sized.sizeSol * rule.params.sizeMul * 1e6) / 1e6;
      const gateBook = bookOf(open, mint, ts, o.equitySol);
      const base = {
        features: f,
        mode: rule.mode,
        side: "buy" as const,
        sizeSol,
        solUsd,
        book: gateBook,
        limits,
        now: ts,
      };
      let run = runGates({ ...base, quote: undefined, only: [...PRE_GATES] });
      let fill: ReturnType<typeof replayFill> = null;
      if (!run.rejected) {
        const poolSol = poolSolOf(f.liqUsd, f.stage, solUsd);
        const latencyRow =
          series.find((s) => s.ts >= ts + REPLAY_EXEC_MODEL.latencyMs && s.price != null) ?? null;
        const priceAtFill = latencyRow?.price ?? f.priceUsd;
        fill = poolSol == null ? null : replayFill(priceAtFill, run.sizeSol, poolSol);
        run = runGates({ ...base, quote: fill ? { ageMs: 0, impactPct: fill.impactPct } : null });
      }
      const why = [v.why, ...v.notes];
      if (sized.sizing.weightMul != null && sized.sizing.weightMul !== 1)
        why.push(`weight ×${sized.sizing.weightMul}`);
      if (regimeMul !== 1) why.push(`regime ×${regimeMul}`);
      for (const g of run.results)
        if (g.adjustment) why.push(`${g.gate} ×${g.adjustment.sizeMul}: ${g.adjustment.reason}`);
      if (run.rejected) why.push(`rejected by ${run.rejected.gate}: ${run.rejected.reasonCode}`);
      else if (fill)
        why.push(`replay fill ${fill.fillPriceUsd.toPrecision(4)} (impact ${fill.impactPct}%)`);
      const intentId = await writeIntent(
        db,
        runId,
        rule,
        f,
        run.sizeSol,
        sized.sizing,
        why.join(", "),
        run.results,
        ts,
        o,
      );
      out.intents++;
      if (run.rejected || !fill) continue;
      out.executed++;
      open.push({ mint, openedAt: ts, costSol: run.sizeSol, createdAt });
      const samples = series.filter((s) => s.price != null) as { ts: number; price: number }[];
      const scoringOutcome = outcomeOf(fill.fillPriceUsd, samples, ts, SCORING_HORIZON_SEC);
      for (const h of HORIZONS_SEC) {
        const oc = outcomeOf(fill.fillPriceUsd, samples, ts, h);
        await db.query(
          `insert into outcomes (intent_id, horizon_sec, ret_pct, max_ret_pct, min_ret_pct) values ($1, $2, $3, $4, $5) on conflict do nothing`,
          [intentId, h, oc?.retPct ?? null, oc?.maxRetPct ?? null, oc?.minRetPct ?? null],
        );
      }
      out.scored.push({
        side: "buy",
        retPct: scoringOutcome?.retPct ?? null,
        minRetPct: scoringOutcome?.minRetPct ?? null,
        maxRetPct: scoringOutcome?.maxRetPct ?? null,
        rule: rule.id,
      });
    }
  }
  return out;
}

function bookOf(open: OpenPos[], mint: string, now: number, equity: number): GateBook {
  let openExposureSol = 0;
  let youngExposureSol = 0;
  let deployedSol = 0;
  for (const p of open) {
    deployedSol += p.costSol;
    if (p.mint === mint) openExposureSol += p.costSol;
    if (p.createdAt == null || now - p.createdAt < 90 * 60_000) youngExposureSol += p.costSol;
  }
  return {
    halted: false,
    haltReason: null,
    dayPnlPct: null,
    weekPnlPct: null,
    openPositions: open.length,
    openExposureSol,
    youngExposureSol,
    equitySol: equity,
    deployedSol,
    cashSol: null,
    clusterOpen: 0,
    lostYesterday: false,
  };
}

function rowToSnapshot(r: Record<string, unknown>, mint: string): Snapshot {
  const n = (k: string) => (r[k] == null ? null : Number(r[k]));
  return {
    ts: (r.ts as Date).getTime(),
    mint,
    price: n("price"),
    mc: n("mc"),
    liq: n("liq"),
    vol5m: n("vol5m"),
    vol24: n("vol24"),
    tx24: n("tx24"),
    buys5m: n("buys5m"),
    sells5m: n("sells5m"),
    holders: n("holders"),
    top10: n("top10"),
    source: String(r.source ?? "replay"),
    statsAt: r.stats_at == null ? null : (r.stats_at as Date).getTime(),
  };
}

async function writeIntent(
  db: Db,
  runId: string,
  rule: EntryRule,
  f: Features,
  sizeSol: number,
  sizing: unknown,
  why: string,
  results: GateResult[],
  ts: number,
  o: ReplayOptions,
): Promise<string> {
  const rejected = results.some((g) => !g.passed);
  const id = randomUUID();
  await db.query(
    `insert into intents (id, chain, ts, kind, strategy, rule_id, mode, mint, side, size_sol, sizing, features, why,
                          status, replay_run_id, rules_hash, code_version, price_source, ttl_ms)
     values ($1, 'solana', $2, 'entry', $3, $4, $5, $6, 'buy', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [
      id,
      new Date(ts),
      rule.strategy,
      rule.id,
      rule.mode,
      f.mint,
      sizeSol,
      JSON.stringify(sizing),
      JSON.stringify(f),
      why,
      rejected ? "rejected" : "executed",
      runId,
      o.rulesHash,
      o.codeVersion,
      "replay",
      o.rules.intentTtlMs,
    ],
  );
  if (results.length) {
    const values: unknown[] = [];
    const rows = results.map((g, i) => {
      const k = i * 6;
      values.push(
        id,
        g.gate,
        g.passed,
        g.reasonCode,
        g.adjustment && JSON.stringify(g.adjustment),
        g.ms,
      );
      return `($${k + 1}, $${k + 2}, $${k + 3}, $${k + 4}, $${k + 5}, $${k + 6})`;
    });
    await db.query(
      `insert into gate_results (intent_id, gate, passed, reason_code, adjustment, ms) values ${rows.join(",")}`,
      values,
    );
  }
  return id;
}
