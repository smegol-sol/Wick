/**
 * The supply writer and the wallet profiler (ENGINE §7 and §8, ADR-0008).
 *
 * The decision loop asks for a live map when a rule likes a candidate and the
 * map it has is the launch-time one or stale; this writer serves those
 * requests on two RPC budgets: holder lists per hour and wallet reads per
 * hour. Each served request reads the largest token accounts with their
 * owners, profiles the owners it has not profiled in seven days (create-slot
 * buys from our launch parses, age and activity from one signatures read),
 * computes the map in core, writes `supply_maps` and `wallet_profiles`, and
 * hands the map to the feature book. Everything the hot path reads is a row
 * with an age; nothing here is on the decision path.
 */
import type { ChainAdapter, HolderRead, LaunchTx } from "@wick/core/chain";
import type { Audit, SupplyMap, WalletClass } from "@wick/core/contracts";
import {
  bondingCurveOf,
  classifyWallet,
  supplyMapOf,
  FRESH_MAX_TX,
  type WalletStats,
} from "@wick/core/supply";
import type { Db } from "../db/pool.ts";
import { errText, logger } from "../log.ts";
import * as m from "../metrics.ts";

const log = logger("supply");

export type SupplyDeps = {
  db: Db;
  chain: Pick<ChainAdapter, "holders" | "signaturesSince">;
  /** The audit (supply, decimals) and the launch parse the book holds for a mint. */
  inputs: (mint: string) => { audit: Audit | null; launch: LaunchTx | null } | null;
  /** Stage and pool address from the last source read; the pool's owner is excluded from holders. */
  token: (mint: string) => { stage: string; pair: string | null } | null;
  onMap: (mint: string, map: SupplyMap) => void;
  now?: () => number;
};

export type SupplyConfig = {
  holderReadsPerHour: number;
  walletReadsPerHour: number;
  /** A mint is not re-read within this window; the gate's own age limit is 5 minutes. */
  minIntervalMs: number;
  /** Holders profiled per map, largest first; the rest count as not profiled. */
  profilePerMap: number;
};

const PROFILE_TTL_MS = 7 * 86_400_000;
const TREND_LOOKBACK_MS = 30 * 60_000;

type Profile = { class: WalletClass; confidence: number; fresh: boolean | null; at: number };

class HourBudget {
  private readonly perHour: number;
  private hour = -1;
  private used = 0;
  constructor(perHour: number) {
    this.perHour = perHour;
  }
  take(now: number): boolean {
    const h = Math.floor(now / 3_600_000);
    if (h !== this.hour) {
      this.hour = h;
      this.used = 0;
    }
    if (this.used >= this.perHour) return false;
    this.used++;
    return true;
  }
}

export class SupplyWriter {
  readonly state = { served: 0, skippedBudget: 0, queue: 0 };
  private readonly deps: SupplyDeps;
  private readonly cfg: SupplyConfig;
  private readonly now: () => number;
  private readonly queue = new Map<string, number>();
  private readonly lastRead = new Map<string, number>();
  private readonly profiles = new Map<string, Profile>();
  private readonly holderBudget: HourBudget;
  private readonly walletBudget: HourBudget;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(deps: SupplyDeps, cfg: SupplyConfig) {
    this.deps = deps;
    this.cfg = cfg;
    this.now = deps.now ?? Date.now;
    this.holderBudget = new HourBudget(cfg.holderReadsPerHour);
    this.walletBudget = new HourBudget(cfg.walletReadsPerHour);
  }

  /** The loop's request; deduplicated per mint and rate-limited per mint. */
  request(mint: string): void {
    const now = this.now();
    const last = this.lastRead.get(mint) ?? 0;
    if (now - last < this.cfg.minIntervalMs) return;
    if (!this.queue.has(mint)) this.queue.set(mint, now);
    this.state.queue = this.queue.size;
  }

  /** Serve the oldest request. Public for tests. */
  async tick(): Promise<void> {
    if (this.busy) return;
    const next = this.queue.keys().next();
    if (next.done) return;
    const mint = next.value;
    this.queue.delete(mint);
    this.state.queue = this.queue.size;
    this.busy = true;
    try {
      await this.serve(mint);
    } catch (e) {
      log.error("supply map failed", { err: errText(e), mint });
    } finally {
      this.busy = false;
    }
  }

  private async serve(mint: string): Promise<void> {
    const now = this.now();
    const inputs = this.deps.inputs(mint);
    const audit = inputs?.audit ?? null;
    if (!audit || audit.supply == null || audit.decimals == null) {
      log.info("supply map skipped: no audit yet", { mint });
      return;
    }
    if (!this.holderBudget.take(now)) {
      this.state.skippedBudget++;
      m.supplyReads.inc({ outcome: "budget" });
      // Put it back for the next hour rather than losing the request.
      this.queue.set(mint, now);
      this.state.queue = this.queue.size;
      return;
    }
    this.lastRead.set(mint, now);
    const ctrl = new AbortController();
    const kill = setTimeout(() => ctrl.abort(), 8000);
    let holders: HolderRead[];
    try {
      holders = await this.deps.chain.holders(mint, ctrl.signal);
    } finally {
      clearTimeout(kill);
    }
    if (!holders.length) {
      m.supplyReads.inc({ outcome: "empty" });
      return;
    }
    const token = this.deps.token(mint);
    const poolOwners: string[] = [];
    if (token?.pair) poolOwners.push(token.pair);
    if (!token || token.stage !== "migrated") {
      try {
        poolOwners.push(bondingCurveOf(mint));
      } catch {
        /* a mint that is not a valid key has no curve */
      }
    }
    const pool = new Set(poolOwners);
    const owners = [...new Set(holders.filter((h) => !pool.has(h.owner)).map((h) => h.owner))];
    const fresh = new Map<string, boolean | null>();
    const classes = new Map<string, Profile>();
    for (const owner of owners.slice(0, this.cfg.profilePerMap)) {
      const p = await this.profile(owner, now);
      if (!p) continue;
      fresh.set(owner, p.fresh);
      classes.set(owner, p);
    }
    const launch = inputs?.launch ?? null;
    const before = await this.earlyPctBefore(mint, now);
    const result = supplyMapOf({
      at: now,
      supplyRaw: audit.supply,
      decimals: audit.decimals,
      holders,
      poolOwners,
      launch: launch
        ? {
            creator: launch.creator,
            slot: launch.slot,
            buyers: launch.buyers.map((b) => ({ wallet: b.wallet, slot: b.slot })),
            bundlePct: launch.bundlePct,
          }
        : null,
      fresh,
      earlyPctBefore: before,
    });
    if (!result) {
      m.supplyReads.inc({ outcome: "empty" });
      return;
    }
    const holderRows = result.holders.map((h) => {
      const c = classes.get(h.wallet);
      return {
        wallet: h.wallet,
        pct: h.pct,
        class: c?.class ?? null,
        confidence: c?.confidence ?? null,
      };
    });
    await this.deps.db.query(
      `insert into supply_maps (mint, at, dev_pct, bundle_pct, sniper_pct, fresh_pct, lp_pct, cluster_pct, trend, inputs)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict (mint, at) do nothing`,
      [
        mint,
        new Date(now),
        result.map.devPct,
        result.map.bundlePct,
        result.map.sniperPct,
        result.map.freshWalletPct,
        result.map.lpPct,
        result.map.clusterPct,
        result.map.earlyHoldersTrend,
        JSON.stringify({
          earlyPct: result.earlyPct,
          holders: holderRows,
          poolOwners,
          accounts: holders.length,
          profiled: classes.size,
        }),
      ],
    );
    this.deps.onMap(mint, result.map);
    this.state.served++;
    m.supplyReads.inc({ outcome: "written" });
    log.info("supply map", {
      mint,
      dev: result.map.devPct,
      snipers: result.map.sniperPct,
      fresh: result.map.freshWalletPct,
      lp: result.map.lpPct,
      trend: result.map.earlyHoldersTrend,
      profiled: classes.size,
    });
  }

  /** The early share about 30 minutes ago, from our own rows. */
  private async earlyPctBefore(mint: string, now: number): Promise<number | null> {
    const res = await this.deps.db.query<{ inputs: { earlyPct?: number } | null }>(
      `select inputs from supply_maps where mint = $1 and at <= $2 order by at desc limit 1`,
      [mint, new Date(now - TREND_LOOKBACK_MS)],
    );
    const v = res.rows[0]?.inputs?.earlyPct;
    return typeof v === "number" ? v : null;
  }

  /** A profile from memory, then the table, then a fresh read on the wallet budget. */
  async profile(wallet: string, now: number): Promise<Profile | null> {
    const cached = this.profiles.get(wallet);
    if (cached && now - cached.at < PROFILE_TTL_MS) return cached;
    const stored = await this.deps.db.query<{
      class: WalletClass;
      confidence: number;
      stats: { fresh?: boolean | null };
      profiled_at: Date;
    }>("select class, confidence, stats, profiled_at from wallet_profiles where wallet = $1", [
      wallet,
    ]);
    const row = stored.rows[0];
    if (row && now - row.profiled_at.getTime() < PROFILE_TTL_MS) {
      const p: Profile = {
        class: row.class,
        confidence: row.confidence,
        fresh: row.stats?.fresh ?? null,
        at: row.profiled_at.getTime(),
      };
      this.profiles.set(wallet, p);
      return p;
    }
    if (!this.walletBudget.take(now)) {
      m.walletReads.inc({ outcome: "budget" });
      return null;
    }
    const stats = await this.walletStats(wallet, now);
    const c = classifyWallet(stats);
    const p: Profile = { ...c, at: now };
    this.profiles.set(wallet, p);
    await this.deps.db.query(
      `insert into wallet_profiles (wallet, class, confidence, stats, profiled_at)
       values ($1, $2, $3, $4, $5)
       on conflict (wallet) do update set class = excluded.class, confidence = excluded.confidence,
         stats = excluded.stats, profiled_at = excluded.profiled_at`,
      [wallet, c.class, c.confidence, JSON.stringify({ ...stats, fresh: c.fresh }), new Date(now)],
    );
    m.walletReads.inc({ outcome: "profiled" });
    return p;
  }

  private async walletStats(wallet: string, now: number): Promise<WalletStats> {
    const launches = await this.deps.db.query<{ n: string }>(
      `select count(*)::text as n from launch_txs l
        where exists (select 1 from jsonb_array_elements(l.buyers) b
                       where b->>'wallet' = $1 and (b->>'slot')::bigint <= l.slot + 3)`,
      [wallet],
    );
    const createSlotBuys = Number(launches.rows[0]?.n ?? 0);
    const ctrl = new AbortController();
    const kill = setTimeout(() => ctrl.abort(), 8000);
    try {
      const sigs = await this.deps.chain.signaturesSince(wallet, null, FRESH_MAX_TX, ctrl.signal);
      const oldest = sigs.at(-1)?.blockTime ?? null;
      return {
        createSlotBuys,
        txCount: sigs.length,
        ageSec:
          oldest != null && sigs.length < FRESH_MAX_TX ? Math.max(0, now / 1000 - oldest) : null,
      };
    } catch (e) {
      log.warn("wallet read failed", { err: errText(e) });
      return { createSlotBuys, txCount: null, ageSec: null };
    } finally {
      clearTimeout(kill);
    }
  }

  start(everyMs = 5000): void {
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
