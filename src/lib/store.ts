/**
 * Desk state. Everything that moves money goes through a chain job picked up
 * by `live-auto.ts`; this store only queues, tracks and records. There is no
 * simulated book: holdings are the wallet's on-chain bag, fills are signed
 * transactions, prints are the followed wallets' real swaps.
 */
import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";
import type { Locale, Msg } from "./i18n";
import { t } from "./i18n";
import {
  type FeedItem,
  type HolderInfo,
  type Side,
  type Token,
  isRug,
  mergeLiveToken,
} from "./market";
import { clampNum, isB58, isSig, sanitizeLabel } from "./guard";
import { RISK_DEFAULTS, shouldHalt, snipeEdge, type RiskLimits } from "./risk";
import { tokenPasses, type FilterSlice } from "./sieve";
import { commitLadderSlice, failLadderSlice, startLadder, tickLadders, type Ladder } from "./entry";
import {
  commitChainExit,
  failChainExit,
  isLiveDump,
  queueChainExits,
  slimChainExit,
  upsertChainExit,
  type ChainExit,
  type ExitBook,
} from "./exits";
import { lockHotMem, peekSecret, slimVault, type HotVault } from "./hot-wallet";
import {
  bumpConfirm,
  isFollowId,
  pickNews,
  priorConfirms,
  slimFollow,
  styleDelay,
  styleOf,
  styleSize,
  styleSkip,
  swapPrint,
  MAX_FOLLOWS,
  type CopyHit,
  type CopyStyle,
  type Follow,
} from "./live-copy";
import { liveSnipeOk } from "./snipe-live";
import { fraudOf, fraudSkip } from "./fraud";
import type { ChainHolding, ChainPrint } from "./solana-wallet";

export interface Exits {
  tpPct?: number | null;
  slPct?: number | null;
  tpScale?: number;
  trailOn?: boolean;
  devExit?: boolean;
}

export interface LiveFill {
  id: string;
  ts: number;
  sig: string;
  mint: string;
  tokenId: string;
  side: Side;
  sol: number;
  status: "sent" | "ok" | "fail";
}

export interface LimitOrder {
  id: string;
  tokenId: string;
  mint: string;
  side: Side;
  triggerMc: number;
  sol: number;
  status: "open" | "triggered" | "filled" | "cancelled";
  pendingSince: number;
}

export interface CopyRule {
  walletId: string;
  enabled: boolean;
  sizePct: number;
  maxSol: number;
  copySells: boolean;
  delaySec: number;
  noStack: boolean;
  style: CopyStyle;
}

export interface SnipeJob {
  id: string;
  tokenId: string;
  mint: string;
  sol: number;
  reason: "launch" | "migrate";
  pendingSince: number;
}

export interface CopyPending {
  id: string;
  walletId: string;
  tokenId: string;
  mint: string;
  side: Side;
  fireAt: number;
  sig?: string;
  srcSol: number;
  pendingSince: number;
}

export interface DcaPlan {
  id: string;
  tokenId: string;
  mint: string;
  sol: number;
  intervalMs: number;
  slices: number;
  done: number;
  nextAt: number;
  status: "live" | "done" | "stopped";
  pendingSol: number;
  pendingSince: number;
}

export type AlertKind = "launch" | "migrate" | "smart" | "stop" | "tp" | "dev" | "risk";

export interface Alert {
  id: string;
  ts: number;
  kind: AlertKind;
  text: string;
  textAr: string;
  tokenId?: string;
  walletId?: string;
  side?: Side;
  read: boolean;
}

export interface DeskSettings extends FilterSlice, RiskLimits {
  mev: boolean;
  slippage: number;
  priority: number;
  quickBuy: number;
  snipeMigrate: boolean;
  snipeLaunch: boolean;
  /** Auto snipes and copies only sign while this is on. Manual tickets always sign. */
  snipeLive: boolean;
  radarLaunch: boolean;
  radarMigrate: boolean;
  radarSmart: boolean;
  radarStop: boolean;
  radarDev: boolean;
  radarRisk: boolean;
  devExit: boolean;
  ladderOn: boolean;
  /** Ask before every manual buy or sell. */
  confirmLive: boolean;
}

interface DeskState {
  locale: Locale;
  hydrated: boolean;
  introSeen: boolean;
  tokens: Token[];
  solUsd: number | null;
  holderInfo: Record<string, HolderInfo>;
  limits: LimitOrder[];
  copyRules: CopyRule[];
  copyPending: CopyPending[];
  follows: Follow[];
  followCursor: Record<string, string>;
  followTape: Record<string, ChainPrint[]>;
  copyHits: CopyHit[];
  snipeJobs: SnipeJob[];
  dcaPlans: DcaPlan[];
  ladders: Ladder[];
  watch: string[];
  armedSnipes: string[];
  recentMigrated: Array<{ id: string; ts: number }>;
  recentSniped: Array<{ id: string; ts: number }>;
  feed: FeedItem[];
  alerts: Alert[];
  settings: DeskSettings;
  liveOk: boolean;
  liveAt: number;
  walletPk: string | null;
  watchPk: string | null;
  hotVault: HotVault | null;
  hotUnlocked: boolean;
  chainSol: number | null;
  chainHoldings: ChainHolding[];
  chainBagAt: number;
  chainTokensOk: boolean;
  chainTape: ChainPrint[];
  watchSol: number | null;
  watchHoldings: ChainHolding[];
  watchTape: ChainPrint[];
  watchBagAt: number;
  liveFills: LiveFill[];
  chainExits: ChainExit[];
  bagNonce: number;
  riskHalt: boolean;
  lossStreak: number;
  dayStart: number;
  now: number;
  tickN: number;
  dismissIntro: () => void;
  patchSettings: (patch: Partial<DeskSettings>) => void;
  toggleWatch: (id: string) => void;
  toggleArmSnipe: (id: string) => void;
  setCopy: (walletId: string, patch: Partial<CopyRule>) => void;
  cancelCopy: (id: string) => void;
  addFollow: (pk: string, label?: string) => Msg | null;
  removeFollow: (pk: string) => void;
  ingestFollowTape: (pk: string, prints: ChainPrint[]) => void;
  armCopyJob: (id: string) => void;
  finishCopyJob: (id: string, ok: boolean) => void;
  armSnipeJob: (id: string) => void;
  finishSnipeJob: (id: string, ok: boolean) => void;
  armLimitJob: (id: string) => void;
  finishLimitJob: (id: string, ok: boolean) => void;
  queueSnipe: (tokenId: string) => void;
  markRadarRead: () => void;
  setExits: (tokenId: string, exits: Exits) => void;
  placeLimit: (tokenId: string, side: Side, triggerMc: number, sol: number) => void;
  cancelLimit: (id: string) => void;
  armDca: (tokenId: string, sol: number, intervalMs: number, slices: number) => void;
  cancelDca: (tokenId: string) => void;
  armLadder: (tokenId: string, sol: number) => void;
  cancelLadder: (tokenId: string) => void;
  ingestLive: (rows: Token[], solUsd: number | null) => void;
  setHolderInfo: (info: HolderInfo) => void;
  setWallet: (pk: string | null) => void;
  setWatchPk: (pk: string | null) => void;
  setHotVault: (vault: HotVault | null) => void;
  markHotExported: () => void;
  unlockHotSession: () => void;
  lockHotSession: () => void;
  wipeHot: () => void;
  setChainBag: (sol: number | null, holdings: ChainHolding[], tokensOk?: boolean) => void;
  setChainTape: (prints: ChainPrint[]) => void;
  setWatchBag: (sol: number | null, holdings: ChainHolding[]) => void;
  setWatchTape: (prints: ChainPrint[]) => void;
  recordLiveFill: (fill: Omit<LiveFill, "id" | "ts">) => void;
  patchLiveFill: (sig: string, status: LiveFill["status"]) => void;
  finishChainSlice: (kind: "ladder" | "dca", tokenId: string, ok: boolean, px?: number) => void;
  finishChainExit: (tokenId: string, ok: boolean) => void;
  refreshBag: () => void;
  flattenAll: () => void;
  clearHalt: () => void;
  resetDay: () => void;
  tick: () => void;
  tokenById: (id: string) => Token | undefined;
  /** Wallet equity in SOL: cash plus holdings at last known prices. */
  equity: () => number;
  /** Holdings as risk-book positions, cost in SOL. */
  bookPositions: () => Array<{ tokenId: string; costSol: number; amount: number }>;
  msg: (key: Msg) => string;
}

const COPY_DEFAULTS: Omit<CopyRule, "walletId"> = {
  enabled: false,
  sizePct: 10,
  maxSol: 2,
  copySells: false,
  delaySec: 0,
  noStack: true,
  style: "mirror",
};

export const DEFAULT_SETTINGS: DeskSettings = {
  mev: true,
  slippage: 12,
  priority: 0.001,
  quickBuy: 0.5,
  hideRugs: true,
  guardMint: true,
  minLiq: 0,
  minMc: 0,
  maxMc: 0,
  minHolders: 0,
  maxAgeMin: 0,
  keywords: "",
  exclude: "",
  hasX: false,
  skipFraud: false,
  minGrade: "",
  sieve: "",
  snipeMigrate: false,
  snipeLaunch: false,
  snipeLive: false,
  radarLaunch: true,
  radarMigrate: true,
  radarSmart: true,
  radarStop: true,
  radarDev: true,
  radarRisk: true,
  devExit: true,
  ladderOn: true,
  confirmLive: true,
  ...RISK_DEFAULTS,
};

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function slimLiveFills(raw: unknown): LiveFill[] {
  if (!Array.isArray(raw)) return [];
  const out: LiveFill[] = [];
  for (const f of raw) {
    if (!f || typeof f !== "object") continue;
    const row = f as LiveFill;
    if (typeof row.sig !== "string" || !isSig(row.sig)) continue;
    if (typeof row.mint !== "string" || !isB58(row.mint)) continue;
    if (row.side !== "buy" && row.side !== "sell") continue;
    const status = row.status === "ok" || row.status === "fail" ? row.status : "sent";
    out.push({
      id: typeof row.id === "string" ? row.id.slice(0, 32) : row.sig.slice(0, 12),
      ts: clampNum(row.ts, 0, Date.now() + 60_000, 0),
      sig: row.sig,
      mint: row.mint,
      tokenId: typeof row.tokenId === "string" ? row.tokenId.slice(0, 48) : row.mint,
      side: row.side,
      sol: clampNum(row.sol, 0, 50, 0),
      status,
    });
    if (out.length >= 40) break;
  }
  return out;
}

function slimIds(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw)) return fallback;
  return raw.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length < 80).slice(0, 40);
}

function normalizeCopy(r: Partial<CopyRule> & { walletId: string }): CopyRule {
  return {
    ...COPY_DEFAULTS,
    walletId: r.walletId,
    enabled: r.enabled === true,
    delaySec: Math.max(0, Math.min(30, Number(r.delaySec) || 0)),
    maxSol: Math.max(0.05, Number(r.maxSol) || COPY_DEFAULTS.maxSol),
    sizePct: Math.max(1, Math.min(100, Number(r.sizePct) || COPY_DEFAULTS.sizePct)),
    copySells: r.copySells ?? COPY_DEFAULTS.copySells,
    noStack: r.noStack ?? COPY_DEFAULTS.noStack,
    style: styleOf(r.style),
  };
}

function sanitizeDesk(patch: Partial<DeskSettings>): Partial<DeskSettings> {
  const out: Partial<DeskSettings> = { ...patch };
  if (patch.slippage != null) out.slippage = clampNum(patch.slippage, 0, 80, 12);
  if (patch.quickBuy != null) out.quickBuy = clampNum(patch.quickBuy, 0.05, 40, 0.5);
  if (patch.priority != null) out.priority = clampNum(patch.priority, 0, 0.05, 0.001);
  if (patch.minLiq != null) out.minLiq = clampNum(patch.minLiq, 0, 1_000_000, 0);
  if (patch.minMc != null) out.minMc = clampNum(patch.minMc, 0, 50_000_000, 0);
  if (patch.maxMc != null) out.maxMc = clampNum(patch.maxMc, 0, 50_000_000, 0);
  if (patch.minHolders != null) out.minHolders = Math.round(clampNum(patch.minHolders, 0, 50_000, 0));
  if (patch.maxAgeMin != null) out.maxAgeMin = Math.round(clampNum(patch.maxAgeMin, 0, 10_080, 0));
  if (patch.maxTradeSol != null) out.maxTradeSol = clampNum(patch.maxTradeSol, 0, 50, 2);
  if (patch.maxBookPct != null) out.maxBookPct = clampNum(patch.maxBookPct, 0, 100, 40);
  if (patch.maxPositions != null) out.maxPositions = Math.round(clampNum(patch.maxPositions, 0, 24, 6));
  if (patch.maxDayLoss != null) out.maxDayLoss = clampNum(patch.maxDayLoss, 0, 500, 15);
  if (patch.streakHalt != null) out.streakHalt = Math.round(clampNum(patch.streakHalt, 0, 20, 3));
  if (patch.maxCluster != null) out.maxCluster = Math.round(clampNum(patch.maxCluster, 0, 8, 2));
  if (patch.keywords != null) out.keywords = String(patch.keywords).slice(0, 80);
  if (patch.exclude != null) out.exclude = String(patch.exclude).slice(0, 80);
  if (patch.sieve != null) out.sieve = String(patch.sieve).slice(0, 160);
  if (patch.minGrade != null) {
    const g = String(patch.minGrade).trim().toUpperCase();
    out.minGrade = g === "A" || g === "B" || g === "C" || g === "D" ? g : "";
  }
  for (const key of [
    "mev",
    "hideRugs",
    "guardMint",
    "hasX",
    "skipFraud",
    "snipeMigrate",
    "snipeLaunch",
    "snipeLive",
    "radarLaunch",
    "radarMigrate",
    "radarSmart",
    "radarStop",
    "radarDev",
    "radarRisk",
    "devExit",
    "ladderOn",
    "confirmLive",
    "riskOn",
  ] as const) {
    if (patch[key] != null) out[key] = !!patch[key];
  }
  return out;
}

function mergeSettings(saved: unknown): DeskSettings {
  const p = saved && typeof saved === "object" ? (saved as Partial<DeskSettings>) : {};
  return { ...DEFAULT_SETTINGS, ...sanitizeDesk({ ...DEFAULT_SETTINGS, ...p }) };
}

function throttleStorage(ms: number): StateStorage {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { name: string; value: string } | null = null;
  const mem = new Map<string, string>();
  const flush = () => {
    timer = null;
    if (!pending) return;
    const { name, value } = pending;
    pending = null;
    mem.set(name, value);
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(name, value);
    } catch {
      /* quota */
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => {
      if (timer) clearTimeout(timer);
      flush();
    });
  }
  return {
    getItem: (name) => {
      if (mem.has(name)) return mem.get(name) ?? null;
      try {
        return typeof localStorage === "undefined" ? null : localStorage.getItem(name);
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      mem.set(name, value);
      pending = { name, value };
      if (timer != null) return;
      timer = setTimeout(flush, ms);
    },
    removeItem: (name) => {
      mem.delete(name);
      if (pending?.name === name) pending = null;
      try {
        if (typeof localStorage !== "undefined") localStorage.removeItem(name);
      } catch {
        /* ignore */
      }
    },
  };
}

function slimHeld(tokens: Token[], ids: string[]): Token[] {
  const keep = new Set(ids);
  return tokens.filter((t) => keep.has(t.id)).map((t) => ({ ...t, candles: t.candles.slice(-8) }));
}

function pushFeed(feed: FeedItem[], item: Omit<FeedItem, "id">): FeedItem[] {
  return [{ id: uid("feed"), ...item }, ...feed].slice(0, 120);
}

function pushAlert(alerts: Alert[], item: Omit<Alert, "read" | "id">, on: boolean): Alert[] {
  if (!on) return alerts;
  return [{ id: uid("al"), ...item, read: false }, ...alerts].slice(0, 60);
}

/** Trailing stop price for a chain exit book, given the mark and the average entry. */
export function trailStopPrice(book: Pick<ExitBook, "trailOn" | "slPct" | "peakPrice">, price: number, avg: number): number | null {
  if (!book.trailOn || book.slPct == null || book.slPct <= 0) return null;
  const peak = Math.max(book.peakPrice || 0, price, avg);
  return Math.max(0, peak * (1 - book.slPct / 100));
}

function holdingSol(h: ChainHolding, tokens: Token[], solUsd: number | null): number {
  if (solUsd == null || solUsd <= 0) return 0;
  const tk = tokens.find((t) => t.mint === h.mint);
  const usd = tk ? h.amount * tk.price : (h.usd ?? 0);
  return usd / solUsd;
}

export type BookSlice = Pick<DeskState, "chainSol" | "chainHoldings" | "chainExits" | "tokens" | "solUsd">;

/** Wallet equity in SOL: cash plus holdings at last known prices. Pure; safe in selectors via useMemo. */
export function equityOf(s: BookSlice): number {
  const cash = s.chainSol ?? 0;
  return Math.max(0, cash + s.chainHoldings.reduce((a, h) => a + holdingSol(h, s.tokens, s.solUsd), 0));
}

/** Holdings as risk-book positions, cost in SOL. Pure; returns a new array each call. */
export function bookPositionsOf(s: BookSlice): Array<{ tokenId: string; costSol: number; amount: number }> {
  return s.chainHoldings
    .filter((h) => h.amount > 0)
    .map((h) => {
      const ex = s.chainExits.find((e) => e.mint === h.mint);
      const tk = s.tokens.find((t) => t.mint === h.mint);
      return { tokenId: tk?.id ?? h.mint, costSol: ex?.basisSol || holdingSol(h, s.tokens, s.solUsd), amount: h.amount };
    });
}

function snipeJob(
  s: DeskState,
  tk: Token,
  reason: "launch" | "migrate",
  now: number,
): { jobs: SnipeJob[]; feed: FeedItem[]; fired: boolean } {
  const already = s.snipeJobs.some((j) => j.tokenId === tk.id) || s.chainHoldings.some((h) => h.mint === tk.mint);
  if (already || !liveSnipeOk(s.settings, tk) || !tokenPasses(tk, s.settings, undefined, now)) {
    return { jobs: s.snipeJobs, feed: s.feed, fired: false };
  }
  if (snipeEdge(tk, now) < 0.6) return { jobs: s.snipeJobs, feed: s.feed, fired: false };
  if (fraudSkip(fraudOf(tk))) {
    return {
      jobs: s.snipeJobs,
      feed: pushFeed(s.feed, {
        ts: now,
        kind: "risk",
        tokenId: tk.id,
        text: `Snipe skip fraud $${tk.symbol}`,
        textAr: `تخطي القنص — احتيال $${tk.symbol}`,
      }),
      fired: false,
    };
  }
  if ((s.settings.guardMint && tk.security.onchain && tk.security.freeze) || (s.settings.hideRugs && isRug(tk.security))) {
    return { jobs: s.snipeJobs, feed: s.feed, fired: false };
  }
  const spend = Math.min(Math.max(0.05, s.settings.quickBuy), s.settings.maxTradeSol || 2);
  const where = reason === "launch" ? "on launch" : "on migrate";
  const whereAr = reason === "launch" ? "عند الإطلاق" : "عند الهجرة";
  return {
    jobs: [{ id: uid("sq"), tokenId: tk.id, mint: tk.mint, sol: spend, reason, pendingSince: 0 } satisfies SnipeJob, ...s.snipeJobs].slice(0, 8),
    feed: pushFeed(s.feed, {
      ts: now,
      kind: "snipe",
      tokenId: tk.id,
      text: `Live snipe $${tk.symbol} ${where} · ${spend.toFixed(2)} SOL`,
      textAr: `قنص حي $${tk.symbol} ${whereAr} · ${spend.toFixed(2)} SOL`,
    }),
    fired: true,
  };
}

export const useDesk = create<DeskState>()(
  persist(
    (set, get) => ({
      locale: "en",
      hydrated: false,
      introSeen: false,
      tokens: [],
      solUsd: null,
      holderInfo: {},
      limits: [],
      copyRules: [],
      copyPending: [],
      follows: [],
      followCursor: {},
      followTape: {},
      copyHits: [],
      snipeJobs: [],
      dcaPlans: [],
      ladders: [],
      watch: [],
      armedSnipes: [],
      recentMigrated: [],
      recentSniped: [],
      feed: [],
      alerts: [],
      settings: { ...DEFAULT_SETTINGS },
      liveOk: false,
      liveAt: 0,
      walletPk: null,
      watchPk: null,
      hotVault: null,
      hotUnlocked: false,
      chainSol: null,
      chainHoldings: [],
      chainBagAt: 0,
      chainTokensOk: true,
      chainTape: [],
      watchSol: null,
      watchHoldings: [],
      watchTape: [],
      watchBagAt: 0,
      liveFills: [],
      chainExits: [],
      bagNonce: 0,
      riskHalt: false,
      lossStreak: 0,
      dayStart: 0,
      now: Date.now(),
      tickN: 0,

      dismissIntro: () => set({ introSeen: true }),
      patchSettings: (patch) =>
        set((s) => {
          const settings = { ...s.settings, ...sanitizeDesk(patch) };
          return {
            settings,
            snipeJobs: settings.snipeLive ? s.snipeJobs : [],
            copyPending: settings.snipeLive ? s.copyPending : [],
          };
        }),
      toggleWatch: (id) =>
        set((s) => (s.watch.includes(id) ? { watch: s.watch.filter((x) => x !== id) } : { watch: [...s.watch, id].slice(-32) })),
      toggleArmSnipe: (id) =>
        set((s) => ({
          armedSnipes: s.armedSnipes.includes(id) ? s.armedSnipes.filter((x) => x !== id) : [...s.armedSnipes, id],
        })),
      setCopy: (walletId, patch) =>
        set((s) => {
          const existing = s.copyRules.find((r) => r.walletId === walletId);
          const copyRules = existing
            ? s.copyRules.map((r) => (r.walletId === walletId ? normalizeCopy({ ...r, ...patch }) : r))
            : [...s.copyRules, normalizeCopy({ walletId, ...patch })];
          return { copyRules };
        }),
      cancelCopy: (id) => set((s) => ({ copyPending: s.copyPending.filter((p) => p.id !== id) })),
      addFollow: (raw, label) => {
        const pk = raw.trim();
        if (!isB58(pk)) return "badPk";
        const s = get();
        if (s.walletPk === pk) return "followOwn";
        if (s.follows.some((f) => f.pk === pk)) return "followDup";
        if (s.follows.length >= MAX_FOLLOWS) return "followMax";
        const clean = sanitizeLabel(label, 24) || pk.slice(0, 4);
        set({
          follows: [...s.follows, { pk, label: clean }],
          copyRules: s.copyRules.some((r) => r.walletId === pk)
            ? s.copyRules
            : [...s.copyRules, normalizeCopy({ walletId: pk, enabled: false })],
        });
        return null;
      },
      removeFollow: (pk) =>
        set((s) => {
          const { [pk]: _c, ...followCursor } = s.followCursor;
          const { [pk]: _t, ...followTape } = s.followTape;
          return {
            follows: s.follows.filter((f) => f.pk !== pk),
            followCursor,
            followTape,
            copyRules: s.copyRules.map((r) => (r.walletId === pk ? { ...r, enabled: false } : r)),
            copyPending: s.copyPending.filter((p) => p.walletId !== pk),
          };
        }),
      ingestFollowTape: (pk, prints) =>
        set((s) => {
          if (!s.follows.some((f) => f.pk === pk)) return {};
          const { cursor, news } = pickNews(prints, s.followCursor[pk] ?? null);
          const followCursor = cursor ? { ...s.followCursor, [pk]: cursor } : s.followCursor;
          const followTape = { ...s.followTape, [pk]: prints.slice(0, 12) };
          const now = Date.now();
          let feed = s.feed;
          let alerts = s.alerts;
          const label = s.follows.find((f) => f.pk === pk)?.label || pk.slice(0, 4);
          for (const raw of news) {
            const p = swapPrint(raw);
            if (!p) continue;
            const tk = s.tokens.find((t) => t.mint === p.mint);
            const name = tk ? `$${tk.symbol}` : p.mint.slice(0, 6);
            feed = pushFeed(feed, {
              ts: now,
              kind: "smart",
              tokenId: tk?.id,
              walletId: pk,
              side: p.side,
              text: `${label} ${p.side === "buy" ? "bought" : "sold"} ${name} · ${p.sol.toFixed(2)} SOL`,
              textAr: `${label} ${p.side === "buy" ? "اشترى" : "باع"} ${name} · ${p.sol.toFixed(2)} SOL`,
            });
            alerts = pushAlert(
              alerts,
              {
                ts: now,
                kind: "smart",
                tokenId: tk?.id,
                walletId: pk,
                side: p.side,
                text: `${label} ${p.side === "buy" ? "bought" : "sold"} ${name}`,
                textAr: `${label} ${p.side === "buy" ? "اشترى" : "باع"} ${name}`,
              },
              s.settings.radarSmart,
            );
          }
          if (!news.length || pk === s.walletPk) return { followCursor, followTape, feed, alerts };
          const rule = s.copyRules.find((r) => r.walletId === pk && r.enabled);
          if (!rule || !s.settings.snipeLive) return { followCursor, followTape, feed, alerts };
          let copyPending = s.copyPending;
          let copyHits = s.copyHits;
          const style = styleOf(rule.style);
          for (const raw of news) {
            const p = swapPrint(raw);
            if (!p) continue;
            if (p.sig && (copyPending.some((x) => x.sig === p.sig) || s.liveFills.some((x) => x.sig === p.sig))) continue;
            const tk = s.tokens.find((t) => t.mint === p.mint);
            if (!tk) continue;
            if (p.side === "sell" && !rule.copySells) continue;
            if (s.settings.hideRugs && isRug(tk.security)) continue;
            if (p.side === "buy" && !tokenPasses(tk, s.settings, undefined, now)) continue;
            if (fraudSkip(fraudOf(tk))) {
              feed = pushFeed(feed, {
                ts: now,
                kind: "risk",
                tokenId: tk.id,
                text: `Copy skip fraud $${tk.symbol}`,
                textAr: `تخطي النسخ — احتيال $${tk.symbol}`,
              });
              continue;
            }
            if (p.side === "buy" && rule.noStack && s.chainHoldings.some((h) => h.mint === tk.mint && h.amount > 0)) continue;
            const confirms = priorConfirms(copyHits, pk, p.mint, now);
            if (p.side === "buy") copyHits = bumpConfirm(copyHits, pk, p.mint, now);
            const skip = styleSkip(style, { side: p.side, change5m: tk.change5m, srcSol: p.sol, confirms });
            if (skip) {
              feed = pushFeed(feed, {
                ts: now,
                kind: "smart",
                tokenId: tk.id,
                text: `Copy ${skip} $${tk.symbol}`,
                textAr: `نسخ ${skip} $${tk.symbol}`,
              });
              continue;
            }
            const size = styleSize(style, rule.sizePct, rule.maxSol, p.sol);
            if (size < 0.05) continue;
            const wait = styleDelay(style, rule.delaySec);
            copyPending = [
              {
                id: uid("cq"),
                walletId: pk,
                tokenId: tk.id,
                mint: tk.mint,
                side: p.side,
                fireAt: now + wait * 1000,
                sig: p.sig,
                srcSol: p.sol,
                pendingSince: 0,
              },
              ...copyPending,
            ].slice(0, 24);
            feed = pushFeed(feed, {
              ts: now,
              kind: "smart",
              tokenId: tk.id,
              side: p.side,
              text: `Copy queued ${p.side} $${tk.symbol} · ${size.toFixed(2)} SOL in ${wait}s`,
              textAr: `نسخ معلّق ${p.side === "buy" ? "شراء" : "بيع"} $${tk.symbol} · ${size.toFixed(2)} SOL خلال ${wait}ث`,
            });
          }
          return { followCursor, followTape, copyPending, feed, alerts, copyHits };
        }),
      armCopyJob: (id) =>
        set((s) => ({ copyPending: s.copyPending.map((p) => (p.id === id ? { ...p, pendingSince: Date.now() } : p)) })),
      finishCopyJob: (id, ok) =>
        set((s) => ({ copyPending: s.copyPending.filter((p) => p.id !== id), bagNonce: ok ? s.bagNonce + 1 : s.bagNonce })),
      armSnipeJob: (id) =>
        set((s) => ({ snipeJobs: s.snipeJobs.map((j) => (j.id === id ? { ...j, pendingSince: Date.now() } : j)) })),
      finishSnipeJob: (id, ok) =>
        set((s) => {
          const job = s.snipeJobs.find((j) => j.id === id);
          return {
            snipeJobs: s.snipeJobs.filter((j) => j.id !== id),
            recentSniped: ok && job ? [{ id: job.tokenId, ts: Date.now() }, ...s.recentSniped].slice(0, 12) : s.recentSniped,
            bagNonce: ok ? s.bagNonce + 1 : s.bagNonce,
          };
        }),
      armLimitJob: (id) =>
        set((s) => ({ limits: s.limits.map((o) => (o.id === id ? { ...o, pendingSince: Date.now() } : o)) })),
      finishLimitJob: (id, ok) =>
        set((s) => ({
          limits: s.limits.map((o) =>
            o.id !== id ? o : ok ? { ...o, status: "filled", pendingSince: 0 } : { ...o, status: "open", pendingSince: 0 },
          ),
          bagNonce: ok ? s.bagNonce + 1 : s.bagNonce,
        })),
      queueSnipe: (tokenId) => {
        const s = get();
        const tk = s.tokens.find((t) => t.id === tokenId);
        if (!tk || !isB58(tk.mint)) return;
        if (s.snipeJobs.some((j) => j.tokenId === tokenId)) return;
        const spend = Math.min(Math.max(0.05, s.settings.quickBuy), s.settings.maxTradeSol || 2);
        set({
          snipeJobs: [{ id: uid("sq"), tokenId, mint: tk.mint, sol: spend, reason: "migrate" as const, pendingSince: 0 }, ...s.snipeJobs].slice(0, 8),
        });
      },
      markRadarRead: () => set((s) => ({ alerts: s.alerts.map((a) => (a.read ? a : { ...a, read: true })) })),
      setExits: (tokenId, exits) =>
        set((s) => {
          const tk = s.tokens.find((t) => t.id === tokenId);
          const mint = tk?.mint || s.chainExits.find((e) => e.tokenId === tokenId)?.mint || "";
          if (!mint) return {};
          return {
            chainExits: upsertChainExit(s.chainExits, {
              tokenId,
              mint,
              price: tk?.price ?? 0,
              exits: {
                tpPct: exits.tpPct,
                slPct: exits.slPct,
                tpScale: exits.tpScale,
                trailOn: exits.trailOn,
                devExit: exits.devExit,
              },
            }),
          };
        }),
      placeLimit: (tokenId, side, triggerMc, solAmt) =>
        set((s) => {
          const tk = s.tokens.find((t) => t.id === tokenId);
          if (!tk || !(triggerMc > 0) || !(solAmt >= 0.05)) return {};
          return {
            limits: [
              { id: uid("lim"), tokenId, mint: tk.mint, side, triggerMc, sol: solAmt, status: "open" as const, pendingSince: 0 },
              ...s.limits,
            ].slice(0, 40),
          };
        }),
      cancelLimit: (id) =>
        set((s) => ({ limits: s.limits.map((o) => (o.id === id ? { ...o, status: "cancelled" } : o)) })),
      armDca: (tokenId, solAmt, intervalMs, slices) =>
        set((s) => {
          const tk = s.tokens.find((t) => t.id === tokenId);
          if (!tk) return {};
          const n = Math.max(2, Math.min(8, Math.round(slices)));
          const gap = Math.max(8_000, Math.min(60_000, intervalMs));
          const plan: DcaPlan = {
            id: uid("dca"),
            tokenId,
            mint: tk.mint,
            sol: Math.max(0.05, solAmt),
            intervalMs: gap,
            slices: n,
            done: 0,
            nextAt: s.now + 400,
            status: "live",
            pendingSol: 0,
            pendingSince: 0,
          };
          return { dcaPlans: [plan, ...s.dcaPlans.filter((p) => p.tokenId !== tokenId || p.status !== "live")].slice(0, 12) };
        }),
      cancelDca: (tokenId) =>
        set((s) => ({
          dcaPlans: s.dcaPlans.map((p) => (p.tokenId === tokenId && p.status === "live" ? { ...p, status: "stopped" } : p)),
        })),
      armLadder: (tokenId, solAmt) =>
        set((s) => {
          const tk = s.tokens.find((t) => t.id === tokenId);
          if (!tk) return {};
          const spend = Math.max(0.15, solAmt || s.settings.quickBuy);
          const next = startLadder(s.ladders, { tokenId, now: s.now, price: tk.price, budget: spend, source: "manual", chain: true });
          return {
            ladders: next.ladders,
            feed: pushFeed(s.feed, {
              ts: s.now,
              kind: "flow",
              tokenId,
              text: next.born ? `Ladder $${tk.symbol} · ${spend.toFixed(2)} SOL` : `Confirm +1 $${tk.symbol}`,
              textAr: next.born ? `سلّم $${tk.symbol} · ${spend.toFixed(2)} SOL` : `تأكيد +1 $${tk.symbol}`,
            }),
          };
        }),
      cancelLadder: (tokenId) =>
        set((s) => ({
          ladders: s.ladders.map((l) => (l.tokenId === tokenId && l.status === "live" ? { ...l, status: "stopped" } : l)),
        })),
      ingestLive: (rows, solUsd) =>
        set((s) => {
          if (!rows.length) return { solUsd: solUsd ?? s.solUsd };
          const now = Date.now();
          const prevById = new Map(s.tokens.map((t) => [t.id, t]));
          const keep = new Set([
            ...s.watch,
            ...s.armedSnipes,
            ...s.chainHoldings.map((h) => h.mint),
            ...s.ladders.filter((l) => l.status === "live").map((l) => l.tokenId),
            ...s.dcaPlans.filter((p) => p.status === "live").map((p) => p.tokenId),
            ...s.limits.filter((o) => o.status === "open" || o.status === "triggered").map((o) => o.tokenId),
            ...s.chainExits.map((e) => e.tokenId),
          ]);
          const seen = new Set<string>();
          const merged: Token[] = [];
          for (const row of rows) {
            if (!row.mint || seen.has(row.mint)) continue;
            seen.add(row.mint);
            const prev = prevById.get(row.id);
            const next = mergeLiveToken(prev, row, now);
            const hi = s.holderInfo[row.mint];
            if (hi && next.security.top10 == null) next.security = { ...next.security, top10: hi.top10 };
            if (hi && next.holders == null) next.holders = hi.holders;
            merged.push(next);
          }
          for (const old of s.tokens) {
            if (!keep.has(old.id) || seen.has(old.mint)) continue;
            merged.push(old);
            seen.add(old.mint);
          }
          let feed = s.feed;
          let alerts = s.alerts;
          let snipeJobs = s.snipeJobs;
          let recentMigrated = s.recentMigrated.filter((r) => now - r.ts < 8_000);
          const launches: Token[] = [];
          if (!s.liveOk) {
            feed = pushFeed(feed, {
              ts: now,
              kind: "flow",
              text: `Live SOL pulse · ${merged.length} pairs`,
              textAr: `نبض سولانا الحي · ${merged.length} زوج`,
            });
          }
          const draft = { ...s, feed, snipeJobs } as DeskState;
          for (const tk of merged) {
            const prev = prevById.get(tk.id);
            if (!prev && s.liveOk && now - tk.createdAt < 10 * 60_000) {
              launches.push(tk);
              feed = pushFeed(feed, {
                ts: now,
                kind: "snipe",
                tokenId: tk.id,
                text: `Launch $${tk.symbol} on SOL`,
                textAr: `إطلاق $${tk.symbol} على SOL`,
              });
              alerts = pushAlert(alerts, { ts: now, kind: "launch", tokenId: tk.id, text: `Launch $${tk.symbol}`, textAr: `إطلاق $${tk.symbol}` }, s.settings.radarLaunch);
            }
            if (prev && prev.stage !== "migrated" && tk.stage === "migrated") {
              recentMigrated = [{ id: tk.id, ts: now }, ...recentMigrated].slice(0, 12);
              feed = pushFeed(feed, {
                ts: now,
                kind: "snipe",
                tokenId: tk.id,
                text: `$${tk.symbol} migrated — curve complete`,
                textAr: `$${tk.symbol} هاجر — اكتمل المنحنى`,
              });
              alerts = pushAlert(alerts, { ts: now, kind: "migrate", tokenId: tk.id, text: `Migrated $${tk.symbol}`, textAr: `هاجر $${tk.symbol}` }, s.settings.radarMigrate);
              if (s.settings.snipeMigrate || s.armedSnipes.includes(tk.id)) {
                const fired = snipeJob({ ...draft, feed, snipeJobs }, tk, "migrate", now);
                snipeJobs = fired.jobs;
                feed = fired.feed;
              }
            }
          }
          if (s.settings.snipeLaunch && launches.length) {
            const ranked = [...launches].sort((a, b) => snipeEdge(b, now) - snipeEdge(a, now));
            for (const tk of ranked) {
              const fired = snipeJob({ ...draft, feed, snipeJobs }, tk, "launch", now);
              snipeJobs = fired.jobs;
              feed = fired.feed;
              if (fired.fired) break;
            }
          }
          const held = merged.filter((t) => keep.has(t.id));
          const rest = merged.filter((t) => !keep.has(t.id));
          return {
            tokens: [...held, ...rest].slice(0, Math.max(64, held.length)),
            solUsd: solUsd ?? s.solUsd,
            feed,
            alerts,
            snipeJobs,
            recentMigrated,
            armedSnipes: s.armedSnipes.filter((id) => !recentMigrated.some((r) => r.id === id)),
            liveOk: true,
            liveAt: now,
            now,
          };
        }),
      setHolderInfo: (info) =>
        set((s) => ({
          holderInfo: { ...s.holderInfo, [info.mint]: info },
          tokens: s.tokens.map((t) =>
            t.mint === info.mint
              ? { ...t, holders: info.holders ?? t.holders, security: { ...t.security, top10: info.top10 ?? t.security.top10 } }
              : t,
          ),
        })),
      setWallet: (pk) =>
        set({ walletPk: pk, chainSol: null, chainHoldings: [], chainBagAt: 0, chainTokensOk: true, chainTape: [] }),
      setWatchPk: (pk) => set({ watchPk: pk, watchSol: null, watchHoldings: [], watchTape: [], watchBagAt: 0 }),
      setHotVault: (vault) => set({ hotVault: vault, hotUnlocked: false }),
      markHotExported: () =>
        set((s) => {
          if (!s.hotVault) return {};
          return {
            hotVault: { ...s.hotVault, exported: true },
            hotUnlocked: !!peekSecret(),
            walletPk: s.hotVault.pub,
            chainSol: null,
            chainHoldings: [],
            chainBagAt: 0,
            chainTokensOk: true,
            chainTape: [],
          };
        }),
      unlockHotSession: () =>
        set((s) => {
          const v = s.hotVault;
          if (!v || !v.exported) return {};
          return {
            hotUnlocked: true,
            walletPk: v.pub,
            chainSol: s.walletPk === v.pub ? s.chainSol : null,
            chainHoldings: s.walletPk === v.pub ? s.chainHoldings : [],
            chainBagAt: s.walletPk === v.pub ? s.chainBagAt : 0,
          };
        }),
      lockHotSession: () => {
        lockHotMem();
        set({ hotUnlocked: false });
      },
      wipeHot: () => {
        lockHotMem();
        set({
          hotVault: null,
          hotUnlocked: false,
          walletPk: null,
          chainSol: null,
          chainHoldings: [],
          chainBagAt: 0,
          chainTokensOk: true,
          chainTape: [],
        });
      },
      setChainBag: (sol, holdings, tokensOk = true) =>
        set((s) => {
          const next = { chainSol: sol, chainHoldings: holdings.slice(0, 40), chainBagAt: Date.now(), chainTokensOk: tokensOk };
          if (s.dayStart > 0 || sol == null) return next;
          const eq = sol + holdings.reduce((a, h) => a + holdingSol(h, s.tokens, s.solUsd), 0);
          return { ...next, dayStart: eq };
        }),
      setChainTape: (prints) => set({ chainTape: prints.slice(0, 16) }),
      setWatchBag: (sol, holdings) => set({ watchSol: sol, watchHoldings: holdings.slice(0, 40), watchBagAt: Date.now() }),
      setWatchTape: (prints) => set({ watchTape: prints.slice(0, 16) }),
      recordLiveFill: (fill) =>
        set((s) => {
          const next: LiveFill = { id: uid("lf"), ts: s.now, ...fill };
          const token = s.tokens.find((t) => t.id === fill.tokenId);
          const label = token?.symbol ?? fill.mint.slice(0, 6);
          const text =
            fill.status === "fail" ? `Chain ${fill.side} failed $${label}` : `Chain ${fill.side} $${label} · ${fill.sol.toFixed(2)} SOL`;
          const textAr =
            fill.status === "fail"
              ? `فشل ${fill.side === "buy" ? "شراء" : "بيع"} السلسلة $${label}`
              : `${fill.side === "buy" ? "شراء" : "بيع"} سلسلة $${label} · ${fill.sol.toFixed(2)} SOL`;
          const chainExits =
            fill.side === "buy" && fill.status !== "fail" && token?.mint
              ? upsertChainExit(s.chainExits, {
                  tokenId: fill.tokenId,
                  mint: fill.mint || token.mint,
                  price: token.price,
                  addSol: fill.sol,
                  exits: s.chainExits.some((e) => e.tokenId === fill.tokenId)
                    ? undefined
                    : { slPct: 22, trailOn: true, devExit: s.settings.devExit },
                })
              : s.chainExits;
          return {
            liveFills: [next, ...s.liveFills.filter((x) => x.sig !== fill.sig)].slice(0, 40),
            chainExits,
            feed: pushFeed(s.feed, { ts: s.now, kind: "flow", tokenId: fill.tokenId, side: fill.side, text, textAr }),
            bagNonce: fill.status === "ok" || fill.status === "sent" ? s.bagNonce + 1 : s.bagNonce,
          };
        }),
      patchLiveFill: (sig, status) =>
        set((s) => ({ liveFills: s.liveFills.map((f) => (f.sig === sig ? { ...f, status } : f)) })),
      finishChainSlice: (kind, tokenId, ok, px) =>
        set((s) => {
          const now = Date.now();
          const tk = s.tokens.find((t) => t.id === tokenId);
          const label = tk ? `$${tk.symbol}` : "";
          const feed = ok
            ? s.feed
            : pushFeed(s.feed, {
                ts: now,
                kind: "risk",
                tokenId,
                text: `Chain slice missed ${label}`.trim(),
                textAr: `فاتت شريحة السلسلة ${label}`.trim(),
              });
          if (kind === "ladder") {
            return {
              ladders: ok ? commitLadderSlice(s.ladders, tokenId, px ?? 0, now) : failLadderSlice(s.ladders, tokenId, now),
              feed,
            };
          }
          return {
            dcaPlans: s.dcaPlans.map((p) => {
              if (p.tokenId !== tokenId || p.status !== "live" || p.pendingSol < 0.05) return p;
              if (!ok) return { ...p, pendingSol: 0, pendingSince: 0, nextAt: now + Math.max(p.intervalMs, 12_000) };
              const done = p.done + 1;
              if (done >= p.slices) return { ...p, done, pendingSol: 0, pendingSince: 0, status: "done" as const };
              return { ...p, done, pendingSol: 0, pendingSince: 0, nextAt: now + p.intervalMs };
            }),
            feed,
          };
        }),
      finishChainExit: (tokenId, ok) =>
        set((s) => {
          const now = Date.now();
          const before = s.chainExits.find((e) => e.tokenId === tokenId);
          const chainExits = ok ? commitChainExit(s.chainExits, tokenId, now) : failChainExit(s.chainExits, tokenId, now);
          const gone = ok && before && !chainExits.some((e) => e.tokenId === tokenId);
          const kind = before?.pendingKind;
          const tk = s.tokens.find((t) => t.id === tokenId);
          const label = tk ? `$${tk.symbol}` : tokenId.slice(0, 6);
          let lossStreak = s.lossStreak;
          let alerts = s.alerts;
          if (ok && kind) {
            lossStreak = kind === "tp" ? 0 : lossStreak + 1;
            const en =
              kind === "tp" ? `Take-profit ${label}` : kind === "trail" ? `Trail stopped ${label}` : kind === "dev" ? `Dump exit ${label}` : `Stop broken ${label}`;
            const ar =
              kind === "tp" ? `جني ربح ${label}` : kind === "trail" ? `أُوقف المتحرّك ${label}` : kind === "dev" ? `خروج هبوط ${label}` : `كُسر الوقف ${label}`;
            alerts = pushAlert(alerts, { ts: now, kind: kind === "tp" ? "tp" : kind === "dev" ? "dev" : "stop", tokenId, side: "sell", text: en, textAr: ar }, kind === "tp" ? s.settings.radarStop : kind === "dev" ? s.settings.radarDev : s.settings.radarStop);
          }
          return {
            chainExits,
            alerts,
            lossStreak,
            ladders: gone
              ? s.ladders.map((l) => (l.tokenId === tokenId && l.status === "live" ? { ...l, status: "stopped" as const } : l))
              : s.ladders,
            dcaPlans: gone
              ? s.dcaPlans.map((p) => (p.tokenId === tokenId && p.status === "live" ? { ...p, status: "stopped" as const } : p))
              : s.dcaPlans,
            bagNonce: ok ? s.bagNonce + 1 : s.bagNonce,
          };
        }),
      refreshBag: () => set((s) => ({ bagNonce: s.bagNonce + 1 })),
      flattenAll: () => {
        const s = get();
        const now = Date.now();
        const chainExits = s.chainHoldings
          .filter((h) => h.amount > 0 && isB58(h.mint))
          .map((h) => {
            const cur = s.chainExits.find((e) => e.mint === h.mint);
            return {
              tokenId: cur?.tokenId ?? h.mint,
              mint: h.mint,
              basisSol: cur?.basisSol ?? 0,
              tpPct: null as number | null,
              slPct: null as number | null,
              tpScale: 1,
              tpRung: 0,
              tpNextAt: 0,
              trailOn: false,
              peakPrice: cur?.peakPrice ?? 0,
              devExit: false,
              pendingFrac: 1,
              pendingKind: "sl" as const,
              pendingSince: now,
            };
          });
        const text = "Flatten — auto buys frozen";
        const textAr = "تفريغ — الشراء التلقائي مجمّد";
        set({
          riskHalt: true,
          chainExits,
          dcaPlans: s.dcaPlans.map((p) => (p.status === "live" ? { ...p, status: "stopped" } : p)),
          ladders: s.ladders.map((l) => (l.status === "live" ? { ...l, status: "stopped" } : l)),
          limits: s.limits.map((o) => (o.status === "open" || o.status === "triggered" ? { ...o, status: "cancelled" } : o)),
          copyPending: [],
          snipeJobs: [],
          feed: pushFeed(s.feed, { ts: now, kind: "risk", text, textAr }),
          alerts: pushAlert(s.alerts, { ts: now, kind: "risk", text, textAr }, s.settings.radarRisk),
        });
      },
      clearHalt: () => set({ riskHalt: false, lossStreak: 0 }),
      resetDay: () => set({ dayStart: get().equity(), lossStreak: 0, riskHalt: false }),
      tick: () => {
        const state = get();
        const now = Date.now();
        const tokens = state.tokens;
        let feed = state.feed;
        let alerts = state.alerts;
        let ladders = state.ladders;
        let dcaPlans = state.dcaPlans;
        let limits = state.limits;
        let chainExits = state.chainExits;
        let riskHalt = state.riskHalt;
        const recentSniped = state.recentSniped.filter((r) => now - r.ts < 8_000);
        const recentMigrated = state.recentMigrated.filter((r) => now - r.ts < 8_000);

        const stepped = tickLadders(ladders, {
          now,
          priceOf: (id) => tokens.find((t) => t.id === id)?.price ?? null,
          edgeOk: (id) => {
            const tk = tokens.find((t) => t.id === id);
            return !!tk && snipeEdge(tk, now) >= 0.35;
          },
          alive: (id) => {
            const tk = tokens.find((t) => t.id === id);
            return !!tk && tokenPasses(tk, state.settings, undefined, now);
          },
        });
        ladders = stepped.ladders;
        for (const note of stepped.notes) {
          const tk = tokens.find((t) => t.id === note.tokenId);
          const mark = tk ? `$${tk.symbol}` : "";
          feed = pushFeed(feed, { ts: now, kind: note.kind, tokenId: note.tokenId, text: `${mark} ${note.en}`.trim(), textAr: `${mark} ${note.ar}`.trim() });
          if (note.kind === "risk") {
            alerts = pushAlert(alerts, { ts: now, kind: "risk", tokenId: note.tokenId, text: `${mark} ${note.en}`.trim(), textAr: `${mark} ${note.ar}`.trim() }, state.settings.radarRisk);
          }
        }

        dcaPlans = dcaPlans.map((plan) => {
          if (plan.status !== "live" || now < plan.nextAt) return plan;
          if (ladders.some((l) => l.tokenId === plan.tokenId && l.status === "live")) return plan;
          const tk = tokens.find((tkn) => tkn.id === plan.tokenId);
          if (!tk || (state.settings.hideRugs && isRug(tk.security))) {
            return { ...plan, status: "stopped" as const, pendingSol: 0, pendingSince: 0 };
          }
          if (plan.pendingSol >= 0.05) {
            if (now - plan.pendingSince > 28_000) return { ...plan, pendingSol: 0, pendingSince: 0 };
            return plan;
          }
          return { ...plan, pendingSol: plan.sol, pendingSince: now, nextAt: now + plan.intervalMs };
        });

        limits = limits.map((o) => {
          if (o.status === "triggered" && o.pendingSince > 0 && now - o.pendingSince > 28_000) {
            return { ...o, status: "open" as const, pendingSince: 0 };
          }
          if (o.status !== "open") return o;
          const tk = tokens.find((tkn) => tkn.id === o.tokenId);
          if (!tk) return o;
          const hit = o.side === "buy" ? tk.mc <= o.triggerMc : tk.mc >= o.triggerMc;
          if (!hit) return o;
          feed = pushFeed(feed, {
            ts: now,
            kind: "flow",
            tokenId: tk.id,
            side: o.side,
            text: `Limit triggered ${o.side} $${tk.symbol}`,
            textAr: `تفعّل الأمر المحدود ${o.side === "buy" ? "شراء" : "بيع"} $${tk.symbol}`,
          });
          return { ...o, status: "triggered" as const, pendingSince: 0 };
        });

        chainExits = queueChainExits(chainExits, {
          now,
          priceOf: (id) => tokens.find((t) => t.id === id)?.price ?? null,
          holdAmt: (mint) => state.chainHoldings.find((h) => h.mint === mint)?.amount ?? 0,
          dumpOf: (id) => {
            const tk = tokens.find((t) => t.id === id);
            return !!tk && isLiveDump(tk);
          },
        });

        if (!riskHalt && state.settings.riskOn) {
          const why = shouldHalt(state.settings, {
            riskHalt,
            lossStreak: state.lossStreak,
            dayStart: state.dayStart,
            sol: state.chainSol ?? 0,
            positions: state.bookPositions(),
            marks: Math.max(0, state.equity() - (state.chainSol ?? 0)),
          });
          if (why) {
            riskHalt = true;
            const text = why === "loss" ? "Day loss halt — auto buys frozen" : "Loss streak halt — auto buys frozen";
            const textAr = why === "loss" ? "وقف خسارة اليوم — الشراء التلقائي مجمّد" : "وقف سلسلة الخسائر — الشراء التلقائي مجمّد";
            feed = pushFeed(feed, { ts: now, kind: "risk", text, textAr });
            alerts = pushAlert(alerts, { ts: now, kind: "risk", text, textAr }, state.settings.radarRisk);
          }
        }

        set({
          now,
          tickN: state.tickN + 1,
          feed,
          alerts,
          ladders,
          dcaPlans,
          limits,
          chainExits,
          riskHalt,
          recentSniped,
          recentMigrated,
          liveOk: state.liveOk && now - state.liveAt < 45_000,
        });
      },
      tokenById: (id) => get().tokens.find((tkn) => tkn.id === id),
      equity: () => equityOf(get()),
      bookPositions: () => bookPositionsOf(get()),
      msg: (key) => t("en", key),
    }),
    {
      name: "wick-desk-v2",
      skipHydration: true,
      storage: createJSONStorage(() => throttleStorage(2000)),
      partialize: (s) => ({
        introSeen: s.introSeen,
        liveFills: s.liveFills.slice(0, 40),
        chainExits: s.chainExits.slice(0, 24).map((e) => ({ ...e, pendingFrac: 0, pendingKind: null, pendingSince: 0 })),
        limits: s.limits.filter((o) => o.status === "open" || o.status === "triggered").slice(0, 24),
        copyRules: s.copyRules.filter((r) => isFollowId(r.walletId)),
        follows: s.follows.slice(0, MAX_FOLLOWS),
        followCursor: s.followCursor,
        dcaPlans: s.dcaPlans.filter((p) => p.status === "live"),
        ladders: s.ladders.filter((l) => l.status === "live").slice(0, 12),
        watch: s.watch,
        armedSnipes: s.armedSnipes,
        settings: s.settings,
        walletPk: s.hotVault?.pub ?? null,
        watchPk: s.watchPk && s.watchPk !== s.hotVault?.pub ? s.watchPk : null,
        hotVault: s.hotVault,
        riskHalt: s.riskHalt,
        lossStreak: s.lossStreak,
        dayStart: s.dayStart,
        tokens: slimHeld(s.tokens, [
          ...s.watch,
          ...s.armedSnipes,
          ...s.ladders.filter((l) => l.status === "live").map((l) => l.tokenId),
          ...s.chainHoldings.map((h) => h.mint),
        ]),
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<DeskState>;
        const vault = slimVault(p.hotVault);
        const hot = vault?.pub;
        const savedWallet = typeof p.walletPk === "string" && isB58(p.walletPk) ? p.walletPk : null;
        const watch = typeof p.watchPk === "string" && isB58(p.watchPk) ? p.watchPk : null;
        return {
          ...current,
          introSeen: p.introSeen === true,
          liveFills: slimLiveFills(p.liveFills),
          chainExits: Array.isArray(p.chainExits)
            ? p.chainExits.map(slimChainExit).filter((e): e is ChainExit => !!e).slice(0, 24)
            : [],
          limits: Array.isArray(p.limits)
            ? p.limits
                .filter(
                  (o) =>
                    o &&
                    typeof o.tokenId === "string" &&
                    typeof o.mint === "string" &&
                    isB58(o.mint) &&
                    (o.side === "buy" || o.side === "sell") &&
                    Number.isFinite(o.triggerMc) &&
                    Number.isFinite(o.sol),
                )
                .map((o) => ({ ...o, status: "open" as const, pendingSince: 0 }))
                .slice(0, 40)
            : [],
          copyRules: Array.isArray(p.copyRules)
            ? p.copyRules.filter((r) => r && typeof r.walletId === "string" && isFollowId(r.walletId)).map((r) => normalizeCopy(r))
            : [],
          follows: Array.isArray(p.follows) ? p.follows.map(slimFollow).filter((f): f is Follow => !!f).slice(0, MAX_FOLLOWS) : [],
          followCursor:
            p.followCursor && typeof p.followCursor === "object"
              ? Object.fromEntries(
                  Object.entries(p.followCursor as Record<string, unknown>)
                    .filter((e): e is [string, string] => isB58(e[0]) && typeof e[1] === "string" && isSig(e[1]))
                    .slice(0, MAX_FOLLOWS),
                )
              : {},
          dcaPlans: Array.isArray(p.dcaPlans)
            ? p.dcaPlans
                .filter((d) => d && typeof d.tokenId === "string" && typeof d.mint === "string" && d.status === "live")
                .slice(0, 12)
                .map((d) => ({ ...d, pendingSol: 0, pendingSince: 0 }))
            : [],
          ladders: Array.isArray(p.ladders)
            ? p.ladders
                .filter((l) => l && typeof l.tokenId === "string" && l.status === "live")
                .slice(0, 12)
                .map((l) => ({ ...l, chain: true, pendingSol: 0, pendingSrc: null, pendingSince: 0 }))
            : [],
          watch: slimIds(p.watch, []),
          armedSnipes: slimIds(p.armedSnipes, []),
          settings: mergeSettings(p.settings),
          tokens: (() => {
            const byId = new Map<string, Token>();
            if (Array.isArray(p.tokens)) {
              for (const t of p.tokens) {
                if (!t?.id || typeof t.id !== "string" || t.id.length > 48 || !isB58(t.mint ?? "")) continue;
                if (byId.has(t.id)) continue;
                byId.set(t.id, {
                  ...t,
                  symbol: sanitizeLabel(t.symbol, 12) || "???",
                  name: sanitizeLabel(t.name, 28) || "???",
                  candles: Array.isArray(t.candles) ? t.candles.slice(-8) : [],
                  vol: typeof t.vol === "number" ? t.vol : null,
                  vol5m: typeof t.vol5m === "number" ? t.vol5m : null,
                  tx: typeof t.tx === "number" ? t.tx : null,
                  buys5m: typeof t.buys5m === "number" ? t.buys5m : null,
                  sells5m: typeof t.sells5m === "number" ? t.sells5m : null,
                  holders: typeof t.holders === "number" ? t.holders : null,
                  change1h: typeof t.change1h === "number" ? t.change1h : null,
                  statsAt: typeof t.statsAt === "number" ? t.statsAt : null,
                  pair: typeof t.pair === "string" ? t.pair : null,
                  security: {
                    mintable: !!t.security?.mintable,
                    freeze: !!t.security?.freeze,
                    lpBurned: !!t.security?.lpBurned,
                    renounced: !!t.security?.renounced,
                    top10: typeof t.security?.top10 === "number" ? t.security.top10 : null,
                    onchain: !!t.security?.onchain,
                  },
                });
              }
            }
            return [...byId.values()];
          })(),
          feed: [],
          now: Date.now(),
          walletPk: hot ?? null,
          watchPk: watch && watch !== hot ? watch : savedWallet && savedWallet !== hot ? savedWallet : null,
          hotVault: vault,
          hotUnlocked: false,
          chainSol: null,
          chainHoldings: [],
          chainBagAt: 0,
          chainTokensOk: true,
          chainTape: [],
          riskHalt: p.riskHalt === true,
          lossStreak: typeof p.lossStreak === "number" ? p.lossStreak : 0,
          dayStart: typeof p.dayStart === "number" && p.dayStart > 0 ? p.dayStart : 0,
        };
      },
    },
  ),
);

export { filteredTokens, activeFilterCount, FILTER_PRESETS } from "./sieve";
