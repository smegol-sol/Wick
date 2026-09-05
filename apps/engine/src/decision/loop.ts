/**
 * The decision loop (ENGINE §3): once a second, every active mint's features
 * row goes through the sieve, the rules and the gates, and what comes out is
 * written as an `intents` row with its `gate_results`, whatever the outcome.
 * Nothing here signs or sends; an intent in suggest mode waits for the
 * owner, one in shadow mode is only recorded, and the executor (a later
 * slice) picks up what was approved.
 *
 * The pure parts live in @wick/core (decide, gates, sizing, rules); this
 * class is the wiring: the feature book, the quote budget, the book of open
 * positions and halts, the fingerprint, the tables and the metrics.
 */
import { randomUUID } from "node:crypto";
import type { ChainAdapter } from "@wick/core/chain";
import type { Features, GateResult, Mode } from "@wick/core/contracts";
import {
  evaluateEntry,
  evaluateExit,
  sieve,
  type EntryRule,
  type EntryVerdict,
  type PositionState,
} from "@wick/core/decide";
import { runGates, type GateBook, type GateLimits, type GateQuote } from "@wick/core/gates";
import { entryRules, exitRule, type RulesFile } from "@wick/core/rules";
import { sizeEntry } from "@wick/core/sizing";
import type { IntentView } from "@wick/core/api";
import { getIntent } from "../api/queries.ts";
import type { RiskConfig } from "../config.ts";
import type { Db } from "../db/pool.ts";
import type { FeatureBook } from "../ingest/features.ts";
import { errText, logger } from "../log.ts";
import * as m from "../metrics.ts";

const log = logger("decision");
const YOUNG_MS = 90 * 60_000;
const PRE_GATES = ["safety", "supply", "liquidity", "manipulation"] as const;

export type LoopDeps = {
  db: Db;
  chain: Pick<ChainAdapter, "quote">;
  book: FeatureBook;
  activeMints: () => string[];
  rules: RulesFile;
  rulesHash: string;
  codeVersion: string;
  risk: RiskConfig;
  solUsd: () => number | null;
  /** Capital the sizing works with. */
  equitySol: () => number;
  /** The engine's health self-halt (RISK_HALT reason "health"). */
  selfHalt: () => boolean;
  /** Keep a mint at the active cadence while it has an intent out. */
  pin?: (mint: string) => void;
  onIntent?: (view: IntentView) => void;
  now?: () => number;
};

export type LoopConfig = {
  tickMs: number;
  quotesPerMinute: number;
  /** How often open positions and halts are re-read. */
  bookRefreshMs: number;
};

export type LoopState = {
  lastTickAt: number | null;
  lastTickMs: number | null;
  evaluated: number;
  written: number;
  quotesThisMinute: number;
  quoteMinute: number;
  /** Mints skipped because SOL/USD was unknown: sizing has no pool term without it. */
  skippedNoSolUsd: number;
};

type OpenPosition = {
  mint: string;
  wallet: string;
  openedAt: number;
  costSol: number;
  createdAt: number | null;
};

type BookState = {
  at: number;
  positions: OpenPosition[];
  halt: { kind: string; reason: string } | null;
};

export class DecisionLoop {
  readonly state: LoopState = {
    lastTickAt: null,
    lastTickMs: null,
    evaluated: 0,
    written: 0,
    quotesThisMinute: 0,
    quoteMinute: 0,
    skippedNoSolUsd: 0,
  };
  private readonly deps: LoopDeps;
  private readonly cfg: LoopConfig;
  private readonly entries: EntryRule[];
  private readonly cooldown = new Map<string, number>();
  private readonly positionStates = new Map<string, PositionState>();
  private bookState: BookState = { at: 0, positions: [], halt: null };
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(deps: LoopDeps, cfg: LoopConfig) {
    this.deps = deps;
    this.cfg = cfg;
    this.entries = entryRules(deps.rules);
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.cfg.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** One pass over the active mints and the open positions. Public for tests. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const now = this.now();
    const t0 = performance.now();
    try {
      await this.refreshBook(now);
      for (const mint of this.deps.activeMints()) {
        const f = this.deps.book.features(mint, now);
        if (!f) continue;
        this.state.evaluated++;
        m.funnel.inc({ layer: "activity", outcome: "in" });
        m.funnel.inc({ layer: "activity", outcome: "out" });
        m.funnel.inc({ layer: "sieve", outcome: "in" });
        if (!sieve(f, this.entries)) continue;
        m.funnel.inc({ layer: "sieve", outcome: "out" });
        // The regime layer lands later in Phase 2; until then every candidate passes at ×1.
        m.funnel.inc({ layer: "regime", outcome: "in" });
        m.funnel.inc({ layer: "regime", outcome: "out" });
        for (const rule of this.entries) {
          if (this.coolingDown(mint, rule.id, now)) continue;
          m.funnel.inc({ layer: "decision", outcome: "in" });
          const v = evaluateEntry(rule, f);
          if (!v.ok) continue;
          m.funnel.inc({ layer: "decision", outcome: "out" });
          await this.proposeEntry(rule, f, v, now);
        }
      }
      await this.checkExits(now);
    } catch (e) {
      log.error("decision tick failed", { err: errText(e) });
    } finally {
      this.state.lastTickAt = now;
      this.state.lastTickMs = performance.now() - t0;
      this.ticking = false;
    }
  }

  private coolingDown(mint: string, ruleId: string, now: number): boolean {
    const last = this.cooldown.get(`${mint}|${ruleId}`);
    return last != null && now - last < this.deps.rules.intentCooldownMs;
  }

  private limits(equity: number): GateLimits {
    const r = this.deps.risk;
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

  private gateBook(mint: string, equity: number, now: number): GateBook {
    const b = this.bookState;
    let openExposureSol = 0;
    let youngExposureSol = 0;
    let deployedSol = 0;
    for (const p of b.positions) {
      deployedSol += p.costSol;
      if (p.mint === mint) openExposureSol += p.costSol;
      // A position whose token has no known creation time counts as young: the safer reading.
      if (p.createdAt == null || now - p.createdAt < YOUNG_MS) youngExposureSol += p.costSol;
    }
    const selfHalt = this.deps.selfHalt();
    return {
      halted: b.halt != null || selfHalt,
      haltReason: b.halt ? `${b.halt.kind}: ${b.halt.reason}` : selfHalt ? "health" : null,
      dayPnlPct: null, // P&L needs fills (executor slice)
      weekPnlPct: null,
      openPositions: b.positions.length,
      openExposureSol,
      youngExposureSol,
      equitySol: equity,
      deployedSol,
      cashSol: null, // the executor reads balances
      clusterOpen: 0, // narrative clusters are phase 4 data
      lostYesterday: false, // needs fills
    };
  }

  private async proposeEntry(
    rule: EntryRule,
    f: Features,
    v: Extract<EntryVerdict, { ok: true }>,
    now: number,
  ): Promise<void> {
    const t0 = performance.now();
    const solUsd = this.deps.solUsd();
    if (solUsd == null || solUsd <= 0) {
      this.state.skippedNoSolUsd++;
      return;
    }
    const equity = this.deps.equitySol();
    const r = this.deps.risk;
    const book = this.gateBook(f.mint, equity, now);
    const sized = sizeEntry({
      equitySol: equity,
      perTradePct: r.perTradePct,
      poolLiqUsd: f.liqUsd,
      poolSharePct: r.poolSharePct,
      solUsd,
      tokenCapSol: (equity * r.maxTokenExposurePct) / 100,
      openExposureSol: book.openExposureSol,
      regimeMul: 1,
      socialMul: 1,
    });
    const sizeSol = round(sized.sizeSol * rule.params.sizeMul);
    const base = {
      features: f,
      mode: rule.mode,
      side: "buy" as const,
      sizeSol,
      solUsd,
      book,
      limits: this.limits(equity),
      now,
    };
    m.funnel.inc({ layer: "gates", outcome: "in" });
    let run = runGates({ ...base, quote: undefined, only: [...PRE_GATES] });
    if (!run.rejected) {
      let quote: GateQuote | null | undefined;
      if (rule.mode !== "shadow") {
        const q = await this.quoteFor(f.mint, run.sizeSol, now);
        if (q === "throttled") return; // try again next tick; no cooldown, nothing written
        quote = q;
      }
      run = runGates({ ...base, quote });
    }
    if (!run.rejected) m.funnel.inc({ layer: "gates", outcome: "out" });
    const why = [v.why, ...v.notes];
    if (rule.params.sizeMul < 1) why.push(`rule size ×${rule.params.sizeMul}`);
    for (const g of run.results)
      if (g.adjustment) why.push(`${g.gate} ×${g.adjustment.sizeMul}: ${g.adjustment.reason}`);
    if (run.rejected) why.push(`rejected by ${run.rejected.gate}: ${run.rejected.reasonCode}`);
    await this.writeIntent({
      kind: "entry",
      rule: { id: rule.id, strategy: rule.strategy, mode: rule.mode },
      f,
      side: "buy",
      sizeSol: run.rejected ? sizeSol : run.sizeSol,
      sizing: sized.sizing,
      why: why.join("; "),
      results: run.results,
      now,
    });
    m.decisionDuration.observe((performance.now() - t0) / 1000);
  }

  /** One quote per candidate, inside the per-minute budget; `null` when the quote failed. */
  private async quoteFor(
    mint: string,
    sizeSol: number,
    now: number,
  ): Promise<GateQuote | null | "throttled"> {
    const minute = Math.floor(now / 60_000);
    if (minute !== this.state.quoteMinute) {
      this.state.quoteMinute = minute;
      this.state.quotesThisMinute = 0;
    }
    if (this.state.quotesThisMinute >= this.cfg.quotesPerMinute) return "throttled";
    this.state.quotesThisMinute++;
    try {
      const q = await this.deps.chain.quote(
        { side: "buy", mint, amountRaw: String(Math.round(sizeSol * 1e9)), slippageBps: 100 },
        AbortSignal.timeout(4000),
      );
      if (!q) return null;
      return { ageMs: Math.max(0, this.now() - q.at), impactPct: q.impactPct };
    } catch (e) {
      log.warn("quote failed", { err: errText(e) });
      return null;
    }
  }

  private async checkExits(now: number): Promise<void> {
    const rule = exitRule(this.deps.rules);
    if (!rule) return;
    const seen = new Set<string>();
    for (const p of this.bookState.positions) {
      const key = `${p.mint}|${p.wallet}|${p.openedAt}`;
      seen.add(key);
      const f = this.deps.book.features(p.mint, now);
      if (!f) continue;
      let st = this.positionStates.get(key);
      if (!st) {
        st = {
          openedAt: p.openedAt,
          entryPriceUsd: null, // fills land with the executor
          entryLiqUsd: null,
          peakPriceUsd: f.priceUsd,
          lastPriceUsd: null,
          tpTaken: 0,
        };
        this.positionStates.set(key, st);
      }
      const verdict = this.coolingDown(p.mint, rule.id, now)
        ? null
        : evaluateExit(rule.params, st, f, now);
      st.peakPriceUsd = Math.max(st.peakPriceUsd ?? 0, f.priceUsd);
      st.lastPriceUsd = f.priceUsd;
      if (!verdict) continue;
      const sizeSol = round((p.costSol * verdict.sellPct) / 100);
      const equity = this.deps.equitySol();
      const base = {
        features: f,
        mode: rule.mode,
        side: "sell" as const,
        sizeSol,
        solUsd: this.deps.solUsd(),
        book: this.gateBook(p.mint, equity, now),
        limits: this.limits(equity),
        now,
      };
      let quote: GateQuote | null | undefined;
      if (rule.mode !== "shadow") {
        const q = await this.quoteFor(p.mint, sizeSol, now);
        if (q === "throttled") continue;
        quote = q;
      }
      const run = runGates({ ...base, quote, only: ["quote"] });
      const why = [`${verdict.kind}: ${verdict.reason}`, `sell ${verdict.sellPct}%`];
      if (run.rejected) why.push(`rejected by ${run.rejected.gate}: ${run.rejected.reasonCode}`);
      await this.writeIntent({
        kind: "exit",
        rule: { id: rule.id, strategy: rule.strategy, mode: rule.mode },
        f,
        side: "sell",
        sizeSol,
        sizing: null,
        why: why.join("; "),
        results: run.results,
        now,
      });
      if (verdict.kind === "take-profit" && !run.rejected) st.tpTaken++;
    }
    for (const key of this.positionStates.keys())
      if (!seen.has(key)) this.positionStates.delete(key);
  }

  private async writeIntent(x: {
    kind: "entry" | "exit";
    rule: { id: string; strategy: string; mode: Mode };
    f: Features;
    side: "buy" | "sell";
    sizeSol: number;
    sizing: unknown;
    why: string;
    results: GateResult[];
    now: number;
  }): Promise<void> {
    const rejected = x.results.find((g) => !g.passed) ?? null;
    const status = rejected
      ? "rejected"
      : x.rule.mode === "shadow"
        ? "shadow"
        : x.rule.mode === "suggest"
          ? "proposed"
          : "approved";
    const id = randomUUID();
    const ttl = this.deps.rules.intentTtlMs;
    await this.deps.db.query(
      `insert into intents (id, chain, ts, kind, strategy, rule_id, mode, mint, side, size_sol, sizing, features, why,
                            status, decided_by, decided_at, rules_hash, code_version, price_source, ttl_ms)
       values ($1, 'solana', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        id,
        new Date(x.now),
        x.kind,
        x.rule.strategy,
        x.rule.id,
        x.rule.mode,
        x.f.mint,
        x.side,
        x.sizeSol,
        x.sizing == null ? null : JSON.stringify(x.sizing),
        JSON.stringify(x.f),
        x.why,
        status,
        status === "approved" ? "auto" : null,
        status === "approved" ? new Date(x.now) : null,
        this.deps.rulesHash,
        this.deps.codeVersion,
        this.deps.book.priceSource(x.f.mint),
        ttl,
      ],
    );
    if (x.results.length) {
      const values: unknown[] = [];
      const rows = x.results.map((g, i) => {
        const o = i * 6;
        values.push(
          id,
          g.gate,
          g.passed,
          g.reasonCode,
          g.adjustment && JSON.stringify(g.adjustment),
          g.ms,
        );
        return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6})`;
      });
      await this.deps.db.query(
        `insert into gate_results (intent_id, gate, passed, reason_code, adjustment, ms) values ${rows.join(", ")}`,
        values,
      );
    }
    this.cooldown.set(`${x.f.mint}|${x.rule.id}`, x.now);
    this.state.written++;
    m.intents.inc({ mode: x.rule.mode, status });
    if (rejected) m.rejections.inc({ gate: rejected.gate, reason: rejected.reasonCode ?? "none" });
    if (status === "proposed" || status === "approved") this.deps.pin?.(x.f.mint);
    log.info("intent", {
      id,
      rule: x.rule.id,
      mode: x.rule.mode,
      status,
      side: x.side,
      sizeSol: x.sizeSol,
      reason: rejected?.reasonCode ?? null,
    });
    if (this.deps.onIntent) {
      const view = await getIntent(this.deps.db, id);
      if (view) this.deps.onIntent(view);
    }
  }

  private async refreshBook(now: number): Promise<void> {
    if (now - this.bookState.at < this.cfg.bookRefreshMs) return;
    const [pos, halt] = await Promise.all([
      this.deps.db.query<{
        mint: string;
        wallet: string;
        opened_at: Date;
        cost_sol: number;
        created_at: Date | null;
      }>(
        `select p.mint, p.wallet, p.opened_at, p.cost_sol, t.created_at
           from positions p left join tokens t on t.mint = p.mint where p.status = 'open'`,
      ),
      this.deps.db.query<{ kind: string; reason: string }>(
        "select kind, reason from halts where cleared_at is null order by ts desc limit 1",
      ),
    ]);
    this.bookState = {
      at: now,
      positions: pos.rows.map((r) => ({
        mint: r.mint,
        wallet: r.wallet,
        openedAt: new Date(r.opened_at).getTime(),
        costSol: Number(r.cost_sol),
        createdAt: r.created_at == null ? null : new Date(r.created_at).getTime(),
      })),
      halt: halt.rows[0] ?? null,
    };
  }
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
