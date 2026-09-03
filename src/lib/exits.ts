export type ExitKind = "tp" | "sl" | "trail" | "dev";

export interface ExitBook {
  tpPct: number | null;
  slPct: number | null;
  tpScale: number;
  tpRung: number;
  tpNextAt: number;
  trailOn: boolean;
  peakPrice: number;
  devExit: boolean;
}

export interface ChainExit extends ExitBook {
  tokenId: string;
  mint: string;
  basisSol: number;
  pendingFrac: number;
  pendingKind: ExitKind | null;
  pendingSince: number;
}

const STALE_MS = 28_000;
const DEV_DUMP = -18;

export function clampScale(n: number | null | undefined): number {
  const s = Math.round(Number(n) || 1);
  return Math.max(1, Math.min(4, s));
}

export function exitPeak(peakPrice: number, price: number, avg: number): number {
  return Math.max(peakPrice || 0, price || 0, avg || 0);
}

/** A single-poll drop past the threshold reads as a dump. */
export function isLiveDump(token: { change1m: number }): boolean {
  return token.change1m <= DEV_DUMP;
}

export function hitExit(
  book: ExitBook,
  args: { price: number; avg: number; now: number; dump: boolean },
): { kind: ExitKind; frac: number; peak: number } | { kind: null; peak: number } {
  const peak = exitPeak(book.peakPrice, args.price, args.avg);
  if (book.devExit && args.dump) return { kind: "dev", frac: 1, peak };
  const pnlPct = ((args.price - args.avg) / Math.max(args.avg, 1e-12)) * 100;
  const slArmed = book.slPct != null && book.slPct > 0;
  const slHit = slArmed
    ? book.trailOn
      ? args.price <= peak * (1 - book.slPct! / 100)
      : pnlPct <= -book.slPct!
    : false;
  if (slHit) return { kind: book.trailOn ? "trail" : "sl", frac: 1, peak };
  const scale = clampScale(book.tpScale);
  const rung = book.tpRung ?? 0;
  const tpDue =
    book.tpPct != null &&
    book.tpPct > 0 &&
    pnlPct >= book.tpPct &&
    rung < scale &&
    args.now >= (book.tpNextAt ?? 0);
  if (!tpDue) return { kind: null, peak };
  const left = Math.max(1, scale - rung);
  return { kind: "tp", frac: left <= 1 ? 1 : 1 / left, peak };
}

export function upsertChainExit(
  rows: ChainExit[],
  args: {
    tokenId: string;
    mint: string;
    price: number;
    exits?: Partial<ExitBook>;
    addSol?: number;
  },
): ChainExit[] {
  const cur = rows.find((e) => e.tokenId === args.tokenId);
  const add = args.addSol && args.addSol > 0 ? args.addSol : 0;
  if (!cur) {
    if (!args.mint) return rows;
    const next: ChainExit = {
      tokenId: args.tokenId,
      mint: args.mint,
      tpPct: args.exits?.tpPct ?? null,
      slPct: args.exits?.slPct ?? 22,
      tpScale: clampScale(args.exits?.tpScale),
      tpRung: 0,
      tpNextAt: 0,
      trailOn: args.exits?.trailOn !== undefined ? !!args.exits.trailOn : true,
      peakPrice: args.price,
      devExit: !!args.exits?.devExit,
      basisSol: add,
      pendingFrac: 0,
      pendingKind: null,
      pendingSince: 0,
    };
    return [next, ...rows.filter((e) => e.tokenId !== args.tokenId)].slice(0, 24);
  }
  const patch = args.exits ?? {};
  const reset = patch.tpPct !== undefined || patch.tpScale !== undefined;
  return rows.map((e) =>
    e.tokenId !== args.tokenId
      ? e
      : {
          ...e,
          mint: args.mint || e.mint,
          tpPct: patch.tpPct !== undefined ? patch.tpPct : e.tpPct,
          slPct: patch.slPct !== undefined ? patch.slPct : e.slPct,
          tpScale: patch.tpScale !== undefined ? clampScale(patch.tpScale) : e.tpScale,
          tpRung: reset ? 0 : e.tpRung,
          tpNextAt: reset ? 0 : e.tpNextAt,
          trailOn: patch.trailOn !== undefined ? !!patch.trailOn : e.trailOn,
          peakPrice: Math.max(e.peakPrice || 0, args.price || 0),
          devExit: patch.devExit !== undefined ? !!patch.devExit : e.devExit,
          basisSol: e.basisSol + add,
        },
  );
}

export function queueChainExits(
  rows: ChainExit[],
  ctx: {
    now: number;
    priceOf: (id: string) => number | null;
    holdAmt: (mint: string) => number;
    dumpOf: (id: string) => boolean;
  },
): ChainExit[] {
  return rows.map((raw) => {
    if (raw.pendingFrac >= 0.05) {
      if (ctx.now - raw.pendingSince > STALE_MS) {
        return { ...raw, pendingFrac: 0, pendingKind: null, pendingSince: 0 };
      }
      return raw;
    }
    const px = ctx.priceOf(raw.tokenId);
    const amt = ctx.holdAmt(raw.mint);
    if (px == null || amt <= 0) return raw;
    const sol = amt * px;
    const avg = raw.basisSol > 0 ? raw.basisSol / amt : px;
    const hit = hitExit(raw, { price: px, avg, now: ctx.now, dump: ctx.dumpOf(raw.tokenId) });
    if (!hit.kind) return { ...raw, peakPrice: hit.peak };
    if (sol * hit.frac < 0.05) return { ...raw, peakPrice: hit.peak };
    return {
      ...raw,
      peakPrice: hit.peak,
      pendingFrac: hit.frac,
      pendingKind: hit.kind,
      pendingSince: ctx.now,
    };
  });
}

export function commitChainExit(rows: ChainExit[], tokenId: string, now: number): ChainExit[] {
  return rows.flatMap((e) => {
    if (e.tokenId !== tokenId || e.pendingFrac < 0.05) return [e];
    const last = e.pendingKind !== "tp" || e.pendingFrac >= 1 - 1e-9 || e.tpRung + 1 >= clampScale(e.tpScale);
    if (last) return [];
    return [
      {
        ...e,
        basisSol: Math.max(0, e.basisSol * (1 - e.pendingFrac)),
        tpRung: e.tpRung + 1,
        tpNextAt: now + 2_000,
        pendingFrac: 0,
        pendingKind: null,
        pendingSince: 0,
      },
    ];
  });
}

export function failChainExit(rows: ChainExit[], tokenId: string, now: number): ChainExit[] {
  return rows.map((e) =>
    e.tokenId === tokenId && e.pendingFrac >= 0.05
      ? { ...e, pendingFrac: 0, pendingKind: null, pendingSince: 0, tpNextAt: now + 12_000 }
      : e,
  );
}

export function slimChainExit(raw: unknown): ChainExit | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.tokenId !== "string" || v.tokenId.length > 80) return null;
  if (typeof v.mint !== "string" || v.mint.length < 32) return null;
  return {
    tokenId: v.tokenId,
    mint: v.mint,
    tpPct: typeof v.tpPct === "number" ? v.tpPct : null,
    slPct: typeof v.slPct === "number" ? v.slPct : null,
    tpScale: clampScale(typeof v.tpScale === "number" ? v.tpScale : 1),
    tpRung: typeof v.tpRung === "number" ? v.tpRung : 0,
    tpNextAt: typeof v.tpNextAt === "number" ? v.tpNextAt : 0,
    trailOn: !!v.trailOn,
    peakPrice: typeof v.peakPrice === "number" ? v.peakPrice : 0,
    devExit: !!v.devExit,
    basisSol: typeof v.basisSol === "number" && v.basisSol > 0 ? v.basisSol : 0,
    pendingFrac: 0,
    pendingKind: null,
    pendingSince: 0,
  };
}
