/**
 * The executor (ENGINE §12, ADR-0003): the only code that signs. Its order
 * is fixed: quote → build → simulate → sign with the key in memory → send →
 * confirm → read balances → write `Fill`. One approved intent at a time,
 * locked by moving its status to `executing` in the same statement that
 * reads it, and one `executions` row per intent (a unique index), so a
 * restart or a double tick cannot sign twice.
 *
 * It idles while the vault is sealed. While a halt is active (manual, kill
 * switch, health) entries wait and expire; exits keep running. Every
 * outcome is written: the execution row, the seventh gate's result, the
 * fill, the position, an `events` row, and `mev-suspect` when the fill was
 * worse than the quote by more than the slippage cap.
 */
import { randomUUID } from "node:crypto";
import type { IntentView, PositionView } from "@wick/core/api";
import type { ChainAdapter, Quote, UnsignedTx, WalletBalances } from "@wick/core/chain";
import type { Features, ReasonCode } from "@wick/core/contracts";
import { applyFill, fillOf, mevSuspect, type PositionRow } from "@wick/core/fills";
import { getIntent, listPositions } from "../api/queries.ts";
import type { RiskConfig } from "../config.ts";
import type { Db } from "../db/pool.ts";
import { errText, logger } from "../log.ts";
import * as m from "../metrics.ts";
import { checkCaps, dayKeyOf } from "./caps.ts";
import type { Vault } from "./vault.ts";

const log = logger("executor");
const WSOL = "So11111111111111111111111111111111111111112";
const SLIPPAGE_BPS = { buy: 300, sell: 500 } as const;
const UNCONFIRMED_GIVE_UP_MS = 10 * 60_000;

export type ExecutorDeps = {
  db: Db;
  chain: ChainAdapter;
  vault: Vault;
  risk: RiskConfig;
  /** Manual halt, P&L halt, kill switch or health self-halt; entries wait, exits run. */
  halted: () => { halted: boolean; reason: string | null };
  onIntent?: (view: IntentView) => void;
  onPosition?: (view: PositionView) => void;
  now?: () => number;
};

export type ExecutorConfig = {
  tickMs: number;
  confirmTimeoutMs: number;
  balanceRefreshMs: number;
};

export type ExecutorState = {
  walletSol: number | null;
  walletAt: number | null;
  sentTodaySol: number;
  dayKey: string;
  executing: string | null;
  /** Sent transactions still being polled, with what the wallet held before them. */
  pending: number;
  lastError: string | null;
};

type IntentRow = {
  id: string;
  kind: "entry" | "exit" | "add";
  mint: string;
  side: "buy" | "sell";
  size_sol: number;
  features: Features;
  ttl_ms: number | null;
  decided_at: Date | null;
};

type Pending = {
  executionId: string;
  intent: IntentRow;
  sig: string;
  quote: Quote;
  before: WalletBalances;
  sentAt: number;
  lastValidBlockHeight: number;
};

export class Executor {
  readonly state: ExecutorState = {
    walletSol: null,
    walletAt: null,
    sentTodaySol: 0,
    dayKey: "",
    executing: null,
    pending: 0,
    lastError: null,
  };
  private readonly deps: ExecutorDeps;
  private readonly cfg: ExecutorConfig;
  private readonly pending = new Map<string, Pending>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(deps: ExecutorDeps, cfg: ExecutorConfig) {
    this.deps = deps;
    this.cfg = cfg;
    this.state.dayKey = dayKeyOf(this.now());
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

  private wallet(): string | null {
    return this.deps.vault.wallet;
  }

  /** One pass: balances, expiries, pending confirmations, then at most one new intent. Public for tests. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const day = dayKeyOf(now);
      if (day !== this.state.dayKey) {
        this.state.dayKey = day;
        this.state.sentTodaySol = 0;
      }
      await this.expireStale();
      if (this.deps.vault.state !== "unsealed") return;
      await this.refreshBalance(now);
      await this.pollPending(now);
      const next = await this.claimNext(now);
      if (next) await this.execute(next, now);
    } catch (e) {
      this.state.lastError = errText(e);
      log.error("executor tick failed", { err: errText(e) });
    } finally {
      this.ticking = false;
    }
  }

  private async expireStale(): Promise<void> {
    const res = await this.deps.db.query<{ id: string }>(
      `update intents set status = 'expired'
        where status = 'approved'
          and decided_at is not null
          and decided_at + make_interval(secs => coalesce(ttl_ms, 90000) / 1000.0) < now()
        returning id`,
    );
    for (const r of res.rows) {
      await this.event("info", "approval expired before execution", { id: r.id });
      await this.notify(r.id);
    }
  }

  async refreshBalance(now = this.now(), force = false): Promise<void> {
    const wallet = this.wallet();
    if (!wallet) return;
    if (
      !force &&
      this.state.walletAt != null &&
      now - this.state.walletAt < this.cfg.balanceRefreshMs
    )
      return;
    const b = await this.deps.chain.balances(wallet, WSOL, AbortSignal.timeout(8000));
    this.state.walletSol = Number(b.native) / 1e9;
    this.state.walletAt = now;
    m.walletSol.set(this.state.walletSol);
  }

  private async claimNext(now: number): Promise<IntentRow | null> {
    const halt = this.deps.halted();
    const res = await this.deps.db.query<IntentRow>(
      `select i.id, i.kind, i.mint, i.side, i.size_sol, i.features, i.ttl_ms, i.decided_at
         from intents i
        where i.status = 'approved'
          and not exists (select 1 from executions e where e.intent_id = i.id)
          ${halt.halted ? "and i.side = 'sell'" : ""}
        order by i.ts asc limit 1`,
    );
    const row = res.rows[0];
    if (!row) return null;
    const lock = await this.deps.db.query(
      "update intents set status = 'executing' where id = $1 and status = 'approved'",
      [row.id],
    );
    if (lock.rowCount !== 1) return null; // someone else took it
    this.state.executing = row.id;
    log.info("intent claimed", {
      id: row.id,
      side: row.side,
      sizeSol: Number(row.size_sol),
      at: now,
    });
    return row;
  }

  private async execute(intent: IntentRow, now: number): Promise<void> {
    const wallet = this.wallet();
    const key = this.deps.vault.handle();
    if (!wallet || !key) {
      await this.giveBack(intent.id);
      return;
    }
    const sizeSol = Number(intent.size_sol);
    const capReason = checkCaps({
      side: intent.side,
      sizeSol,
      sentTodaySol: this.state.sentTodaySol,
      walletSol: this.state.walletSol,
    });
    if (capReason) {
      await this.fail(intent, null, "failed", `wallet cap: ${capReason}`, null, now);
      return;
    }
    const signal = AbortSignal.timeout(this.cfg.confirmTimeoutMs + 30_000);
    let before: WalletBalances;
    try {
      before = await this.deps.chain.balances(wallet, intent.mint, signal);
    } catch (e) {
      await this.fail(intent, null, "failed", `balance read: ${errText(e)}`, null, now);
      return;
    }
    const amount = await this.amountRaw(intent, before, wallet);
    if (typeof amount === "string" && amount.startsWith("!")) {
      await this.fail(intent, null, "failed", amount.slice(1), null, now);
      return;
    }
    const quote = await this.deps.chain.quote(
      {
        side: intent.side,
        mint: intent.mint,
        amountRaw: amount,
        slippageBps: SLIPPAGE_BPS[intent.side],
      },
      signal,
    );
    if (!quote) {
      await this.fail(intent, null, "failed", "no quote", null, now);
      return;
    }
    const cap =
      intent.side === "buy"
        ? this.deps.risk.quote.maxImpactEntryPct
        : this.deps.risk.quote.maxImpactExitPct;
    if (quote.impactPct != null && quote.impactPct > cap) {
      await this.fail(
        intent,
        quote,
        "failed",
        `quote impact ${quote.impactPct.toFixed(2)}% over ${cap}%`,
        null,
        now,
      );
      return;
    }
    await this.deps.db.query(
      `insert into quotes (id, intent_id, ts, in_amount, out_amount, impact_pct, slippage_bps, route)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        quote.id,
        intent.id,
        new Date(quote.at),
        quote.inAmount,
        quote.outAmount,
        quote.impactPct,
        SLIPPAGE_BPS[intent.side],
        JSON.stringify(quote.route ?? null),
      ],
    );
    let tx: UnsignedTx;
    try {
      tx = await this.deps.chain.buildTx(
        quote,
        wallet,
        { priorityFeeCapLamports: Math.round(this.deps.risk.priorityFeeCapSol * 1e9) },
        signal,
      );
    } catch (e) {
      await this.fail(intent, quote, "failed", `build: ${errText(e)}`, null, now);
      return;
    }
    const t0 = performance.now();
    const sim = await this.deps.chain.simulate(tx, signal);
    if (!sim.ok) {
      await this.fail(
        intent,
        quote,
        "failed",
        `simulation: ${sim.err ?? "failed"}`,
        "EXEC_SIM",
        now,
        performance.now() - t0,
      );
      return;
    }
    const height = await this.deps.chain.blockHeight(signal);
    if (height != null && height > tx.lastValidBlockHeight) {
      await this.fail(
        intent,
        quote,
        "expired",
        "blockhash expired before send",
        "EXEC_EXPIRED",
        now,
        performance.now() - t0,
      );
      return;
    }
    const executionId = randomUUID();
    await this.deps.db.query(
      `insert into executions (id, intent_id, quote_id, wallet, status, route) values ($1, $2, $3, $4, 'simulated', 'rpc')`,
      [executionId, intent.id, quote.id, wallet],
    );
    let sig: string;
    try {
      const signed = await this.deps.chain.sign(tx, key);
      sig = await this.deps.chain.send(signed, signal);
    } catch (e) {
      await this.finish(
        intent,
        executionId,
        "failed",
        `send: ${errText(e)}`,
        "EXEC_SIM",
        now,
        performance.now() - t0,
      );
      return;
    }
    const sentAt = this.now();
    await this.deps.db.query(
      "update executions set status = 'sent', sig = $2, sent_at = $3 where id = $1",
      [executionId, sig, new Date(sentAt)],
    );
    if (intent.side === "buy") this.state.sentTodaySol += sizeSol;
    const pending: Pending = {
      executionId,
      intent,
      sig,
      quote,
      before,
      sentAt,
      lastValidBlockHeight: tx.lastValidBlockHeight,
    };
    const conf = await this.deps.chain.confirm(
      sig,
      this.cfg.confirmTimeoutMs,
      tx.lastValidBlockHeight,
      signal,
    );
    await this.settle(pending, conf.status, conf.err, performance.now() - t0);
  }

  /** Buy: the size in lamports. Sell: the share of the open position the intent's size stands for. */
  private async amountRaw(
    intent: IntentRow,
    before: WalletBalances,
    wallet: string,
  ): Promise<string> {
    if (intent.side === "buy") return String(Math.round(Number(intent.size_sol) * 1e9));
    const pos = await this.openPosition(intent.mint, wallet);
    if (!pos) return "!no open position to sell";
    if (before.decimals == null) return "!token decimals unknown";
    const fraction = pos.costSol > 0 ? Math.min(1, Number(intent.size_sol) / pos.costSol) : 1;
    const raw = (before.token * BigInt(Math.round(fraction * 1e6))) / 1_000_000n;
    if (raw <= 0n) return "!nothing to sell";
    return raw.toString();
  }

  private async settle(
    p: Pending,
    status: "confirmed" | "failed" | "expired",
    err: string | null,
    ms: number,
  ): Promise<void> {
    const now = this.now();
    if (status === "confirmed") {
      const wallet = this.wallet()!;
      let after: WalletBalances;
      try {
        after = await this.deps.chain.balances(wallet, p.intent.mint, AbortSignal.timeout(8000));
      } catch (e) {
        // The trade landed; the fill is written on the next poll instead of guessed.
        this.pending.set(p.sig, p);
        this.state.pending = this.pending.size;
        log.warn("balance read after fill failed; will retry", { err: errText(e) });
        return;
      }
      await this.recordFill(p, after, now, ms);
      return;
    }
    if (status === "expired" && err && /not confirmed/.test(err)) {
      // Not seen yet, blockhash still valid: keep polling for a while before calling it lost.
      this.pending.set(p.sig, p);
      this.state.pending = this.pending.size;
      m.unconfirmed.set(this.pending.size);
      await this.deps.db.query("update executions set err = $2 where id = $1", [
        p.executionId,
        "EXEC_UNCONFIRMED: still polling",
      ]);
      await this.event("warn", "transaction unconfirmed after the timeout", {
        id: p.intent.id,
        sig: p.sig,
      });
      this.state.executing = null;
      return;
    }
    const code: ReasonCode = status === "expired" ? "EXEC_EXPIRED" : "EXEC_SIM";
    await this.finish(p.intent, p.executionId, status, err ?? status, code, now, ms);
  }

  private async pollPending(now: number): Promise<void> {
    for (const [sig, p] of this.pending) {
      const conf = await this.deps.chain.confirm(
        sig,
        0,
        p.lastValidBlockHeight,
        AbortSignal.timeout(8000),
      );
      if (conf.status === "confirmed") {
        this.pending.delete(sig);
        await this.settle(p, "confirmed", null, 0);
      } else if (conf.status === "failed" || now - p.sentAt > UNCONFIRMED_GIVE_UP_MS) {
        this.pending.delete(sig);
        const code: ReasonCode = conf.status === "failed" ? "EXEC_SIM" : "EXEC_UNCONFIRMED";
        await this.finish(
          p.intent,
          p.executionId,
          conf.status === "failed" ? "failed" : "expired",
          conf.err ?? `not confirmed in ${UNCONFIRMED_GIVE_UP_MS / 60_000} min`,
          code,
          now,
          0,
        );
      }
    }
    this.state.pending = this.pending.size;
    m.unconfirmed.set(this.pending.size);
  }

  private async recordFill(
    p: Pending,
    after: WalletBalances,
    now: number,
    ms: number,
  ): Promise<void> {
    const decimals = after.decimals ?? p.before.decimals ?? 0;
    const fill = fillOf({
      side: p.intent.side,
      before: p.before,
      after,
      decimals,
      quote: { inAmount: p.quote.inAmount, outAmount: p.quote.outAmount },
      feeLamports: null,
    });
    const wallet = this.wallet()!;
    await this.deps.db.query(
      "update executions set status = 'confirmed', landed_at = $2, err = null where id = $1",
      [p.executionId, new Date(now)],
    );
    await this.deps.db.query(
      `insert into fills (execution_id, chain, mint, side, sol_delta, token_delta, quoted_price, realized_price, realized_slippage_pct)
       values ($1, 'solana', $2, $3, $4, $5, $6, $7, $8)`,
      [
        p.executionId,
        p.intent.mint,
        p.intent.side,
        fill.solDelta,
        fill.tokenDelta,
        fill.quotedPrice,
        fill.realizedPrice,
        fill.realizedSlippagePct,
      ],
    );
    if (fill.realizedSlippagePct != null) m.fillSlippage.observe(fill.realizedSlippagePct);
    const prev = await this.openPosition(p.intent.mint, wallet);
    let pos: PositionRow | null = null;
    try {
      pos = applyFill(prev, fill, { mint: p.intent.mint, wallet, at: now });
    } catch (e) {
      log.warn("fill without a position", { err: errText(e), mint: p.intent.mint });
    }
    if (pos) await this.writePosition(pos, prev, p.intent);
    await this.gateRow(p.intent.id, true, null, ms);
    await this.deps.db.query("update intents set status = 'executed' where id = $1", [p.intent.id]);
    m.executions.inc({ status: "confirmed" });
    const cap =
      p.intent.side === "buy"
        ? this.deps.risk.quote.maxImpactEntryPct
        : this.deps.risk.quote.maxImpactExitPct;
    const suspect = mevSuspect(fill, cap);
    await this.event(suspect ? "warn" : "info", suspect ? "mev-suspect" : "executed", {
      id: p.intent.id,
      sig: p.sig,
      side: p.intent.side,
      solDelta: fill.solDelta,
      tokenDelta: fill.tokenDelta,
      realizedSlippagePct: fill.realizedSlippagePct,
    });
    this.state.walletSol = Number(after.native) / 1e9;
    this.state.walletAt = now;
    m.walletSol.set(this.state.walletSol);
    this.state.executing = null;
    log.info("executed", {
      id: p.intent.id,
      sig: p.sig,
      solDelta: fill.solDelta,
      slippagePct: fill.realizedSlippagePct,
    });
    await this.notify(p.intent.id);
    if (this.deps.onPosition && pos) {
      const views = await listPositions(this.deps.db);
      const view = views.find((v) => v.mint === pos!.mint && v.wallet === wallet);
      if (view) this.deps.onPosition(view);
    }
  }

  private async openPosition(mint: string, wallet: string): Promise<PositionRow | null> {
    const res = await this.deps.db.query<{
      opened_at: Date;
      cost_sol: number;
      qty: number;
      exits: PositionRow["exits"];
      realized_pnl_sol: number | null;
      status: PositionRow["status"];
    }>(
      "select opened_at, cost_sol, qty, exits, realized_pnl_sol, status from positions where mint = $1 and wallet = $2 and status = 'open' order by opened_at desc limit 1",
      [mint, wallet],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      mint,
      wallet,
      openedAt: new Date(r.opened_at).getTime(),
      costSol: Number(r.cost_sol),
      qty: Number(r.qty),
      exits: r.exits ?? [],
      realizedPnlSol: r.realized_pnl_sol == null ? null : Number(r.realized_pnl_sol),
      status: r.status,
    };
  }

  private async writePosition(
    pos: PositionRow,
    prev: PositionRow | null,
    intent: IntentRow,
  ): Promise<void> {
    if (!prev || prev.openedAt !== pos.openedAt) {
      await this.deps.db.query(
        `insert into positions (mint, wallet, opened_at, cost_sol, qty, exits, realized_pnl_sol, status, entry_price_usd, entry_liq_usd, intent_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          pos.mint,
          pos.wallet,
          new Date(pos.openedAt),
          pos.costSol,
          pos.qty,
          JSON.stringify(pos.exits),
          pos.realizedPnlSol,
          pos.status,
          intent.features?.priceUsd ?? null,
          intent.features?.liqUsd ?? null,
          intent.id,
        ],
      );
      return;
    }
    await this.deps.db.query(
      `update positions set cost_sol = $4, qty = $5, exits = $6, realized_pnl_sol = $7, status = $8,
              closed_at = case when $8 = 'closed' then now() else closed_at end
        where mint = $1 and wallet = $2 and opened_at = $3`,
      [
        pos.mint,
        pos.wallet,
        new Date(pos.openedAt),
        pos.costSol,
        pos.qty,
        JSON.stringify(pos.exits),
        pos.realizedPnlSol,
        pos.status,
      ],
    );
  }

  /** A failure before an execution row exists (caps, balances, quote, build, simulation, expiry). */
  private async fail(
    intent: IntentRow,
    quote: Quote | null,
    status: "failed" | "expired",
    err: string,
    code: ReasonCode | null,
    now: number,
    ms = 0,
  ): Promise<void> {
    const executionId = randomUUID();
    await this.deps.db.query(
      `insert into executions (id, intent_id, quote_id, wallet, status, err, route) values ($1, $2, $3, $4, $5, $6, 'rpc')`,
      [executionId, intent.id, quote?.id ?? null, this.wallet() ?? "", status, err.slice(0, 500)],
    );
    await this.finish(intent, executionId, status, err, code, now, ms, true);
  }

  private async finish(
    intent: IntentRow,
    executionId: string,
    status: "failed" | "expired",
    err: string,
    code: ReasonCode | null,
    now: number,
    ms: number,
    rowWritten = false,
  ): Promise<void> {
    if (!rowWritten)
      await this.deps.db.query("update executions set status = $2, err = $3 where id = $1", [
        executionId,
        status,
        err.slice(0, 500),
      ]);
    if (code) await this.gateRow(intent.id, false, code, ms);
    await this.deps.db.query("update intents set status = 'failed' where id = $1", [intent.id]);
    m.executions.inc({ status });
    if (code) m.rejections.inc({ gate: "execution", reason: code });
    await this.event("warn", "execution failed", { id: intent.id, status, err, code, at: now });
    this.state.executing = null;
    this.state.lastError = err;
    log.warn("execution failed", { id: intent.id, status, err, code });
    await this.notify(intent.id);
  }

  private async giveBack(id: string): Promise<void> {
    await this.deps.db.query(
      "update intents set status = 'approved' where id = $1 and status = 'executing'",
      [id],
    );
    this.state.executing = null;
  }

  private async gateRow(
    intentId: string,
    passed: boolean,
    code: ReasonCode | null,
    ms: number,
  ): Promise<void> {
    await this.deps.db.query(
      `insert into gate_results (intent_id, gate, passed, reason_code, adjustment, ms) values ($1, 'execution', $2, $3, null, $4)
       on conflict (intent_id, gate) do update set passed = excluded.passed, reason_code = excluded.reason_code, ms = excluded.ms`,
      [intentId, passed, code, Math.max(0, ms)],
    );
  }

  private async event(
    level: "info" | "warn",
    msg: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.db.query(
      "insert into events (ts, level, component, msg, data) values (now(), $1, 'executor', $2, $3)",
      [level, msg, JSON.stringify(data)],
    );
  }

  private async notify(id: string): Promise<void> {
    if (!this.deps.onIntent) return;
    const view = await getIntent(this.deps.db, id);
    if (view) this.deps.onIntent(view);
  }
}
