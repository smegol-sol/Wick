/**
 * The per-second features row (roadmap Phase 1; ENGINE §2 and §10).
 *
 * Kept in memory per active mint from what the collector already stores
 * (snapshots, audits, launch rows, chain events, stream counts) and
 * assembled on demand. Everything needed to rebuild a row later is on disk
 * (snapshots and the microstructure row every second, events as they come),
 * so the row itself is not stored: 50 tokens × 86,400 rows of JSON a day
 * would not fit the tier-1 host (ADR-0005). Unknown stays null.
 *
 * Microstructure from reserves, not from an order book: net flow is the
 * change in the pool's SOL side; depth is the constant-product size that
 * moves price 2% (ENGINE §10). Organic volume and unique buyers need the
 * wallet profiler and per-trade wallets, both later; they stay null.
 */
import type { LaunchTx, Trade } from "@wick/core/chain";
import type {
  Audit,
  Features,
  LpEvent,
  Microstructure,
  Snapshot,
  Stage,
} from "@wick/core/contracts";

/** The bonding curve carries a 30 SOL virtual offset over its real reserves. */
export const CURVE_VIRTUAL_SOL = 30;
const RING_MS = 5 * 60_000;
const SQRT_UP = Math.sqrt(1.02) - 1;
const SQRT_DOWN = 1 - Math.sqrt(1 / 1.02);

type LiqPoint = { ts: number; liqSol: number };
type Count = { ts: number; buys: number; sells: number };

type MintBook = {
  stage: Stage;
  createdAt: number;
  snapshot: Snapshot | null;
  solUsd: number | null;
  liq: LiqPoint[];
  counts: Count[];
  audit: Audit | null;
  launch: LaunchTx | null;
  lastLpEvent: LpEvent | null;
  holders: { ts: number; n: number }[];
};

function prune<T extends { ts: number }>(arr: T[], now: number, keepMs = RING_MS): void {
  const cut = now - keepMs;
  let i = 0;
  while (i < arr.length && arr[i]!.ts < cut) i++;
  if (i) arr.splice(0, i);
}

export class FeatureBook {
  private books = new Map<string, MintBook>();
  private prints: Trade[] = [];

  private book(mint: string, stage: Stage = "new", createdAt = Date.now()): MintBook {
    let b = this.books.get(mint);
    if (!b) {
      b = {
        stage,
        createdAt,
        snapshot: null,
        solUsd: null,
        liq: [],
        counts: [],
        audit: null,
        launch: null,
        lastLpEvent: null,
        holders: [],
      };
      this.books.set(mint, b);
    }
    return b;
  }

  forget(mint: string): void {
    this.books.delete(mint);
  }

  noteToken(mint: string, stage: Stage, createdAt: number): void {
    const b = this.book(mint, stage, createdAt);
    b.stage = stage;
    b.createdAt = createdAt;
  }

  /** Every snapshot; the SOL side of the pool is derived from USD liquidity at that moment's SOL price. */
  noteSnapshot(s: Snapshot, solUsd: number | null): void {
    const b = this.book(s.mint);
    b.snapshot = s;
    if (solUsd != null) b.solUsd = solUsd;
    if (s.liq != null && solUsd != null && solUsd > 0) {
      const poolSol = b.stage === "migrated" ? s.liq / 2 / solUsd : s.liq / solUsd;
      b.liq.push({ ts: s.ts, liqSol: poolSol });
      prune(b.liq, s.ts);
    }
    if (s.holders != null) {
      b.holders.push({ ts: s.ts, n: s.holders });
      prune(b.holders, s.ts, 30 * 60_000);
    }
  }

  noteAudit(a: Audit): void {
    const b = this.book(a.mint);
    const prev = b.audit;
    b.audit = a;
    if (prev && prev.lp !== a.lp && a.lp != null) {
      const kind = a.lp === "burned" ? "burn" : a.lp === "locked" ? "lock" : "add";
      b.lastLpEvent = { kind, pct: a.lpRead?.burnedPct ?? 0, ts: a.at };
    }
  }

  noteLaunch(l: LaunchTx): void {
    this.book(l.mint).launch = l;
  }

  /** A trade seen on the stream for an active mint: only its side and second are known. */
  noteTradeSeen(mint: string, side: "buy" | "sell", at: number): void {
    const b = this.book(mint);
    const sec = Math.floor(at / 1000) * 1000;
    const last = b.counts[b.counts.length - 1];
    const c = last && last.ts === sec ? last : { ts: sec, buys: 0, sells: 0 };
    if (c !== last) b.counts.push(c);
    if (side === "buy") c.buys++;
    else c.sells++;
    prune(b.counts, at);
  }

  /** A followed wallet's print, for the follow counts. */
  notePrint(t: Trade, at: number): void {
    this.prints.push({ ...t, ts: t.ts ?? at });
    const cut = at - 3 * 60_000;
    this.prints = this.prints.filter((p) => (p.ts ?? 0) >= cut);
  }

  /** Which source reported the price the features row carries; null before any snapshot. */
  priceSource(mint: string): string | null {
    return this.books.get(mint)?.snapshot?.source ?? null;
  }

  private liqAt(b: MintBook, ts: number): number | null {
    let best: LiqPoint | null = null;
    for (const p of b.liq) {
      if (p.ts <= ts) best = p;
      else break;
    }
    return best?.liqSol ?? null;
  }

  micro(mint: string, now: number): Microstructure | null {
    const b = this.books.get(mint);
    if (!b?.snapshot) return null;
    const cur = b.liq[b.liq.length - 1];
    const flow = (ms: number): number | null => {
      if (!cur) return null;
      const then = this.liqAt(b, now - ms);
      return then == null ? null : cur.liqSol - then;
    };
    const solUsd = b.solUsd;
    let depthBuy: number | null = null;
    let depthSell: number | null = null;
    if (cur && solUsd != null) {
      const x = b.stage === "migrated" ? cur.liqSol : cur.liqSol + CURVE_VIRTUAL_SOL;
      depthBuy = x * SQRT_UP * solUsd;
      depthSell = x * SQRT_DOWN * solUsd;
    }
    return {
      at: now,
      netFlowSol1m: flow(60_000),
      netFlowSol5m: flow(RING_MS),
      organicVolPct5m: null,
      depthBuy2PctUsd: depthBuy,
      depthSell2PctUsd: depthSell,
    };
  }

  /** Stream-counted trades over a window; null until the stream has seen the mint. */
  counts(mint: string, now: number, ms: number): { buys: number; sells: number } | null {
    const b = this.books.get(mint);
    if (!b || !b.counts.length) return null;
    const cut = now - ms;
    let buys = 0;
    let sells = 0;
    for (const c of b.counts) {
      if (c.ts < cut) continue;
      buys += c.buys;
      sells += c.sells;
    }
    return { buys, sells };
  }

  features(mint: string, now: number): Features | null {
    const b = this.books.get(mint);
    const s = b?.snapshot;
    if (!b || !s || s.price == null || s.mc == null || s.liq == null) return null;
    const holdersThen = b.holders.find((h) => h.ts <= now - 30 * 60_000);
    const follow = (side: "buy" | "sell") =>
      this.prints.filter((p) => p.mint === mint && p.side === side).length;
    return {
      chain: "solana",
      mint,
      ts: now,
      ageSec: Math.max(0, Math.floor((now - b.createdAt) / 1000)),
      stage: b.stage,
      priceUsd: s.price,
      mcUsd: s.mc,
      liqUsd: s.liq,
      vol5m: s.vol5m,
      vol24: s.vol24,
      tx24: s.tx24,
      buys5m: s.buys5m,
      sells5m: s.sells5m,
      uniqueBuyers5m: null,
      holders: s.holders,
      holdersDelta30m: s.holders != null && holdersThen ? s.holders - holdersThen.n : null,
      top10Pct: s.top10,
      authorities: b.audit?.authorities ?? null,
      extensions: b.audit?.extensions ?? null,
      lp: b.audit?.lp ?? null,
      lastLpEvent: b.lastLpEvent,
      supply: b.launch
        ? {
            at: b.launch.ts ?? now,
            devPct: b.launch.buyers.find((x) => x.wallet === b.launch!.creator)?.pct ?? 0,
            bundlePct: b.launch.bundlePct,
            sniperPct: b.launch.sniperPct,
            freshWalletPct: null,
            lpPct: null,
            clusterPct: null,
            earlyHoldersTrend: null,
          }
        : null,
      micro: this.micro(mint, now),
      washFlags: [],
      fundingFlags: [],
      followBuys3m: follow("buy"),
      followSells3m: follow("sell"),
      smartBuys3m: 0,
      social: null,
    };
  }
}
