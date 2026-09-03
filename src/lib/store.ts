import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";
import type { Locale, Msg } from "./i18n";
import { t } from "./i18n";
import {
  type Chain,
  type FeedItem,
  type FillSource,
  type Side,
  type Token,
  type Wallet,
  type Kol,
  isRug,
  maybeDumpDev,
  mergeLiveToken,
  nextTweet,
  seedWorld,
  spawnToken,
  tickToken,
} from "./market";
import { hashString, mulberry32 } from "./format";
import { clampNum, isB58, isSig, sanitizeLabel } from "./guard";
import {
  nextStreak,
  openMark,
  RISK_DEFAULTS,
  shouldHalt,
  sizeAutoBuy,
  snipeEdge,
  type RiskWhy,
} from "./risk";
import { clusterNames, clusterOf } from "./cluster";
import { tokenPasses } from "./sieve";
import { confirmLadder, commitLadderSlice, failLadderSlice, startLadder, tickLadders, type Ladder } from "./entry";
import {
  commitChainExit,
  failChainExit,
  isLiveDump,
  queueChainExits,
  slimChainExit,
  upsertChainExit,
  type ChainExit,
} from "./exits";
import { canSignHot, lockHotMem, peekSecret, slimVault, type HotVault } from "./hot-wallet";
import { copySize, isFollowId, pickNews, priorConfirms, bumpConfirm, slimFollow, styleDelay, styleOf, styleSize, styleSkip, swapPrint, MAX_FOLLOWS, type CopyHit, type CopyStyle, type Follow } from "./live-copy";
import { liveSnipeOk } from "./snipe-live";
import { fraudOf, fraudSkip } from "./fraud";
import type { ChainHolding, ChainPrint } from "./solana-wallet";

export interface Position {
  tokenId: string;
  amount: number;
  costSol: number;
  tpPct: number | null;
  slPct: number | null;
  tpScale: number;
  tpRung: number;
  tpNextAt: number;
  trailOn: boolean;
  peakPrice: number;
  devExit: boolean;
}

export interface Exits {
  tpPct?: number | null;
  slPct?: number | null;
  tpScale?: number;
  trailOn?: boolean;
  devExit?: boolean;
}

export interface Fill {
  id: string;
  ts: number;
  tokenId: string;
  side: Side;
  sol: number;
  amount: number;
  price: number;
  source: FillSource;
  pnl?: number;
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
  side: Side;
  triggerMc: number;
  sol: number;
  status: "open" | "filled" | "cancelled";
}

export interface CopyRule {
  walletId: string;
  enabled: boolean;
  sizePct: number;
  maxSol: number;
  copySells: boolean;
  delaySec: number;
  skipBundled: boolean;
  noStack: boolean;
  skipWeak: boolean;
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
  side: Side;
  fireAt: number;
  sig?: string;
  mint?: string;
  srcSol?: number;
  chain?: boolean;
  pendingSince?: number;
}

export interface DcaPlan {
  id: string;
  tokenId: string;
  sol: number;
  intervalMs: number;
  slices: number;
  done: number;
  nextAt: number;
  status: "live" | "done" | "stopped";
  chain: boolean;
  pendingSol: number;
  pendingSince: number;
}

export type AlertKind = "launch" | "migrate" | "smart" | "stop" | "tp" | "dev" | "social" | "risk";

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

export interface DeskSettings {
  chain: Chain | "all";
  mev: boolean;
  slippage: number;
  priority: number;
  quickBuy: number;
  hideRugs: boolean;
  minLiq: number;
  minMc: number;
  maxMc: number;
  maxBundled: number;
  maxDev: number;
  maxSnipers: number;
  minHolders: number;
  maxAgeMin: number;
  keywords: string;
  exclude: string;
  hasX: boolean;
  skipFraud: boolean;
  minGrade: string;
  sieve: string;
  snipeMigrate: boolean;
  snipeLaunch: boolean;
  radarLaunch: boolean;
  radarMigrate: boolean;
  radarSmart: boolean;
  radarStop: boolean;
  radarDev: boolean;
  devExit: boolean;
  socialSol: number;
  socialNoStack: boolean;
  radarSocial: boolean;
  liveOn: boolean;
  guardMint: boolean;
  riskOn: boolean;
  maxTradeSol: number;
  maxBookPct: number;
  maxPositions: number;
  maxDayLoss: number;
  streakHalt: number;
  radarRisk: boolean;
  ladderOn: boolean;
  maxCluster: number;
  execLive: boolean;
  snipeLive: boolean;
}

interface DeskState {
  locale: Locale;
  hydrated: boolean;
  intro: boolean;
  sol: number;
  realized: number;
  tokens: Token[];
  wallets: Wallet[];
  kols: Kol[];
  positions: Position[];
  fills: Fill[];
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
  walletInjected: boolean;
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
  setLocale: (locale: Locale) => void;
  dismissIntro: () => void;
  patchSettings: (patch: Partial<DeskSettings>) => void;
  toggleWatch: (id: string) => void;
  toggleArmSnipe: (id: string) => void;
  toggleTrackWallet: (id: string) => void;
  toggleTrackKol: (id: string) => void;
  toggleKolTrade: (id: string) => void;
  setCopy: (walletId: string, patch: Partial<CopyRule>) => void;
  cancelCopy: (id: string) => void;
  addFollow: (pk: string) => string | null;
  removeFollow: (pk: string) => void;
  ingestFollowTape: (pk: string, prints: ChainPrint[]) => void;
  armCopyJob: (id: string) => void;
  finishCopyJob: (id: string, ok: boolean) => void;
  armSnipeJob: (id: string) => void;
  finishSnipeJob: (id: string, ok: boolean) => void;
  queueSnipe: (tokenId: string) => void;
  markRadarRead: () => void;
  buy: (tokenId: string, sol: number, source?: FillSource, exits?: Exits) => string | null;
  sell: (tokenId: string, sol: number, source?: FillSource) => string | null;
  setExits: (tokenId: string, exits: Exits) => void;
  placeLimit: (tokenId: string, side: Side, triggerMc: number, sol: number) => void;
  cancelLimit: (id: string) => void;
  armDca: (tokenId: string, sol: number, intervalMs: number, slices: number) => void;
  cancelDca: (tokenId: string) => void;
  armLadder: (tokenId: string, sol: number) => void;
  cancelLadder: (tokenId: string) => void;
  ingestLive: (rows: Token[]) => void;
  armLive: (on: boolean) => void;
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
  equity: () => number;
  msg: (key: Msg) => string;
}

const world0 = seedWorld();

const COPY_DEFAULTS: Omit<CopyRule, "walletId"> = {
  enabled: false,
  sizePct: 10,
  maxSol: 2,
  copySells: false,
  delaySec: 0,
  skipBundled: true,
  noStack: true,
  skipWeak: true,
  style: "mirror",
};

function slimFills(raw: unknown, fallback: Fill[]): Fill[] {
  if (!Array.isArray(raw)) return fallback;
  const out: Fill[] = [];
  for (const f of raw) {
    if (!f || typeof f !== "object") continue;
    const row = f as Fill;
    if (typeof row.tokenId !== "string" || row.tokenId.length > 80) continue;
    if (row.side !== "buy" && row.side !== "sell") continue;
    if (!Number.isFinite(row.sol) || !Number.isFinite(row.price) || row.sol < 0 || row.price < 0) continue;
    out.push({
      id: typeof row.id === "string" ? row.id.slice(0, 32) : uid("f"),
      ts: Number.isFinite(row.ts) ? row.ts : 0,
      tokenId: row.tokenId,
      side: row.side,
      sol: row.sol,
      amount: Number.isFinite(row.amount) ? row.amount : 0,
      price: row.price,
      source: row.source || "manual",
      pnl: typeof row.pnl === "number" && Number.isFinite(row.pnl) ? row.pnl : undefined,
    });
    if (out.length >= 200) break;
  }
  return out;
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
    if (out.length >= 24) break;
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
    ...r,
    walletId: r.walletId,
    delaySec: Math.max(0, Math.min(30, Number(r.delaySec) || 0)),
    maxSol: Math.max(0.05, Number(r.maxSol) || COPY_DEFAULTS.maxSol),
    sizePct: Math.max(1, Math.min(100, Number(r.sizePct) || COPY_DEFAULTS.sizePct)),
    copySells: r.copySells ?? COPY_DEFAULTS.copySells,
    skipBundled: r.skipBundled ?? COPY_DEFAULTS.skipBundled,
    noStack: r.noStack ?? COPY_DEFAULTS.noStack,
    skipWeak: r.skipWeak ?? COPY_DEFAULTS.skipWeak,
    style: styleOf(r.style),
  };
}

function copyCap(rule: CopyRule, quickBuy: number, sol: number): number {
  const cap = Math.min(rule.maxSol, Math.max(0.05, quickBuy * (rule.sizePct / 100)));
  return Math.min(cap, sol * 0.15);
}

function copySkipReason(
  tk: Token,
  rule: CopyRule,
  side: Side,
  hideRugs: boolean,
  positions: Position[],
  wallet?: Wallet,
): "weak" | "rug" | "bundle" | "stack" | "sell" | null {
  if (!tk.live && hideRugs && isRug(tk.security)) return "rug";
  if (rule.skipWeak && wallet?.hands === "paper") return "weak";
  if (rule.skipBundled && tk.security.bundled > 20) return "bundle";
  if (side === "sell" && !rule.copySells) return "sell";
  if (side === "buy" && rule.noStack && positions.some((p) => p.tokenId === tk.id)) return "stack";
  return null;
}

function clipAuto(
  settings: DeskSettings,
  bag: {
    riskHalt: boolean;
    lossStreak: number;
    dayStart: number;
    sol: number;
    positions: Position[];
    tokens: Token[];
  },
  tokenId: string,
  want: number,
  auto = true,
): { spend: number; why: RiskWhy | null } {
  const tk = bag.tokens.find((t) => t.id === tokenId);
  const cluster = tk ? clusterOf(tk.symbol, tk.name) : "other";
  return sizeAutoBuy(
    settings,
    {
      riskHalt: bag.riskHalt,
      lossStreak: bag.lossStreak,
      dayStart: bag.dayStart,
      sol: bag.sol,
      positions: bag.positions,
      marks: openMark(bag.positions, bag.tokens),
    },
    tokenId,
    want,
    {
      auto,
      token: tk ? { security: tk.security, liq: tk.liq, live: !!tk.live } : null,
      clusterNames: tk ? clusterNames(bag.positions, bag.tokens, cluster) : 0,
    },
  );
}

function applyHalt(
  settings: DeskSettings,
  bag: {
    riskHalt: boolean;
    lossStreak: number;
    dayStart: number;
    sol: number;
    positions: Position[];
    tokens: Token[];
  },
  alerts: Alert[],
  feed: FeedItem[],
  now: number,
): { riskHalt: boolean; alerts: Alert[]; feed: FeedItem[] } {
  if (bag.riskHalt || !settings.riskOn) {
    return { riskHalt: bag.riskHalt, alerts, feed };
  }
  const why = shouldHalt(settings, {
    riskHalt: bag.riskHalt,
    lossStreak: bag.lossStreak,
    dayStart: bag.dayStart,
    sol: bag.sol,
    positions: bag.positions,
    marks: openMark(bag.positions, bag.tokens),
  });
  if (!why) return { riskHalt: false, alerts, feed };
  const text = why === "loss" ? "Day loss halt — auto buys frozen" : "Loss streak halt — auto buys frozen";
  const textAr = why === "loss" ? "وقف خسارة اليوم — الشراء التلقائي مجمّد" : "وقف سلسلة الخسائر — الشراء التلقائي مجمّد";
  return {
    riskHalt: true,
    alerts: pushAlert(
      alerts,
      { id: uid("al"), ts: now, kind: "risk", text, textAr },
      settings.radarRisk,
    ),
    feed: [
      { id: uid("feed"), ts: now, kind: "risk" as const, text, textAr },
      ...feed,
    ].slice(0, 80),
  };
}

function fillSlip(settings: DeskSettings): number {
  const raw = clampNum(settings.slippage, 0, 80, 12);
  return settings.mev ? Math.min(raw, 18) : raw;
}

function sanitizeDesk(patch: Partial<DeskSettings>): Partial<DeskSettings> {
  const out: Partial<DeskSettings> = { ...patch };
  if (patch.slippage != null) out.slippage = clampNum(patch.slippage, 0, 80, 12);
  if (patch.quickBuy != null) out.quickBuy = clampNum(patch.quickBuy, 0.05, 40, 0.5);
  if (patch.priority != null) out.priority = clampNum(patch.priority, 0, 0.05, 0.001);
  if (patch.socialSol != null) out.socialSol = clampNum(patch.socialSol, 0.05, 20, 0.5);
  if (patch.minLiq != null) out.minLiq = clampNum(patch.minLiq, 0, 1_000_000, 0);
  if (patch.minMc != null) out.minMc = clampNum(patch.minMc, 0, 50_000_000, 0);
  if (patch.maxMc != null) out.maxMc = clampNum(patch.maxMc, 0, 50_000_000, 0);
  if (patch.maxBundled != null) out.maxBundled = clampNum(patch.maxBundled, 0, 100, 0);
  if (patch.maxDev != null) out.maxDev = clampNum(patch.maxDev, 0, 100, 0);
  if (patch.maxSnipers != null) out.maxSnipers = clampNum(patch.maxSnipers, 0, 100, 0);
  if (patch.minHolders != null) out.minHolders = Math.round(clampNum(patch.minHolders, 0, 50_000, 0));
  if (patch.maxAgeMin != null) out.maxAgeMin = Math.round(clampNum(patch.maxAgeMin, 0, 10_080, 0));
  if (patch.maxTradeSol != null) out.maxTradeSol = clampNum(patch.maxTradeSol, 0, 50, 2);
  if (patch.maxBookPct != null) out.maxBookPct = clampNum(patch.maxBookPct, 0, 100, 40);
  if (patch.maxPositions != null) out.maxPositions = Math.round(clampNum(patch.maxPositions, 0, 24, 6));
  if (patch.maxDayLoss != null) out.maxDayLoss = clampNum(patch.maxDayLoss, 0, 500, 15);
  if (patch.streakHalt != null) out.streakHalt = Math.round(clampNum(patch.streakHalt, 0, 20, 3));
  if (patch.maxCluster != null) out.maxCluster = Math.round(clampNum(patch.maxCluster, 0, 8, 2));
  if (patch.execLive != null) out.execLive = true;
  if (patch.snipeLive != null) out.snipeLive = !!patch.snipeLive;
  if (patch.liveOn != null) out.liveOn = true;
  if (patch.keywords != null) out.keywords = String(patch.keywords).slice(0, 80);
  if (patch.exclude != null) out.exclude = String(patch.exclude).slice(0, 80);
  if (patch.sieve != null) out.sieve = String(patch.sieve).slice(0, 160);
  if (patch.minGrade != null) {
    const g = String(patch.minGrade).trim().toUpperCase();
    out.minGrade = g === "A" || g === "B" || g === "C" || g === "D" ? g : "";
  }
  if (patch.skipFraud != null) out.skipFraud = !!patch.skipFraud;
  return out;
}

function clampScale(n: number | null | undefined): number {
  const s = Math.round(Number(n) || 1);
  return Math.max(1, Math.min(4, s));
}

type SnipeBag = {
  sol: number;
  positions: Position[];
  fills: Fill[];
  feed: FeedItem[];
  tokens: Token[];
  riskHalt: boolean;
  lossStreak: number;
  dayStart: number;
  ladders: Ladder[];
  snipeJobs: SnipeJob[];
};

function snipeBuy(
  bag: SnipeBag,
  tk: Token,
  settings: DeskSettings,
  now: number,
  reason: "launch" | "migrate",
): boolean {
  const already = bag.positions.some((p) => p.tokenId === tk.id) || bag.snipeJobs.some((j) => j.tokenId === tk.id);
  if (already || !tokenPasses(tk, settings)) return false;
  if (snipeEdge(tk, now) < 0.6) return false;
  if (liveSnipeOk(settings, tk)) {
    if (fraudSkip(fraudOf(tk))) {
      bag.feed = [
        {
          id: uid("feed"),
          ts: now,
          kind: "risk" as const,
          tokenId: tk.id,
          text: `Snipe skip fraud $${tk.symbol}`,
          textAr: `تخطي القنص — احتيال $${tk.symbol}`,
        },
        ...bag.feed,
      ].slice(0, 80);
      return false;
    }
    if ((settings.guardMint && tk.security.onchain && tk.security.freeze) || (settings.hideRugs && isRug(tk.security))) {
      return false;
    }
    const spend = Math.min(Math.max(0.05, settings.quickBuy), settings.maxTradeSol || 2);
    if (spend < 0.05) return false;
    const where = reason === "launch" ? "on launch" : "on migrate";
    const whereAr = reason === "launch" ? "عند الإطلاق" : "عند الهجرة";
    bag.snipeJobs = [
      { id: uid("sq"), tokenId: tk.id, mint: tk.mint, sol: spend, reason, pendingSince: 0 },
      ...bag.snipeJobs,
    ].slice(0, 8);
    bag.feed = [
      {
        id: uid("feed"),
        ts: now,
        kind: "snipe" as const,
        tokenId: tk.id,
        text: `Live snipe $${tk.symbol} ${where} · ${spend.toFixed(2)} SOL`,
        textAr: `قنص حي $${tk.symbol} ${whereAr} · ${spend.toFixed(2)} SOL`,
      },
      ...bag.feed,
    ].slice(0, 80);
    return true;
  }
  return false;
}

function autoExits(settings: DeskSettings): Exits {
  return { slPct: 22, trailOn: true, devExit: settings.devExit };
}

export function trailStopPrice(pos: Position, price: number, avg: number): number | null {
  if (!pos.trailOn || pos.slPct == null || pos.slPct <= 0) return null;
  const peak = Math.max(pos.peakPrice || 0, price, avg);
  return Math.max(0, peak * (1 - pos.slPct / 100));
}

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
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
  return tokens
    .filter((t) => keep.has(t.id))
    .map((t) => ({ ...t, candles: t.candles.slice(-8) }));
}

function upsertBuy(
  positions: Position[],
  tokenId: string,
  amount: number,
  spend: number,
  exits?: Exits,
): Position[] {
  const existing = positions.find((p) => p.tokenId === tokenId);
  if (existing) {
    const scale =
      exits?.tpScale !== undefined ? clampScale(exits.tpScale) : existing.tpScale || 1;
    const reset = exits?.tpPct !== undefined || exits?.tpScale !== undefined;
    return positions.map((p) =>
      p.tokenId === tokenId
        ? {
            ...p,
            amount: p.amount + amount,
            costSol: p.costSol + spend,
            tpPct: exits?.tpPct !== undefined ? exits.tpPct : p.tpPct,
            slPct: exits?.slPct !== undefined ? exits.slPct : p.slPct,
            tpScale: scale,
            tpRung: reset ? 0 : p.tpRung,
            tpNextAt: reset ? 0 : p.tpNextAt,
            trailOn: exits?.trailOn !== undefined ? !!exits.trailOn : p.trailOn,
            peakPrice: p.peakPrice || 0,
            devExit: exits?.devExit !== undefined ? !!exits.devExit : p.devExit,
          }
        : p,
    );
  }
  return [
    ...positions,
    {
      tokenId,
      amount,
      costSol: spend,
      tpPct: exits?.tpPct ?? null,
      slPct: exits?.slPct ?? null,
      tpScale: clampScale(exits?.tpScale),
      tpRung: 0,
      tpNextAt: 0,
      trailOn: !!exits?.trailOn,
      peakPrice: 0,
      devExit: !!exits?.devExit,
    },
  ];
}

function applyExits(ledger: {
  tokens: Token[];
  positions: Position[];
  fills: Fill[];
  sol: number;
  realized: number;
  feed: FeedItem[];
  alerts: Alert[];
  now: number;
  radarStop: boolean;
  lossStreak: number;
}): {
  positions: Position[];
  fills: Fill[];
  sol: number;
  realized: number;
  feed: FeedItem[];
  alerts: Alert[];
  lossStreak: number;
} {
  let { positions, fills, sol, realized, feed, alerts, lossStreak } = ledger;
  const kept: Position[] = [];
  for (const pos of positions) {
    const tk = ledger.tokens.find((tkn) => tkn.id === pos.tokenId);
    if (!tk) {
      kept.push(pos);
      continue;
    }
    if (pos.amount <= 0) continue;
    const avg = pos.costSol / Math.max(pos.amount, 1e-12);
    const pnlPct = ((tk.price - avg) / Math.max(avg, 1e-12)) * 100;
    const peak = Math.max(pos.peakPrice || tk.price, tk.price);
    const trailOn = !!pos.trailOn;
    const slArmed = pos.slPct != null && pos.slPct > 0;
    const slHit = slArmed
      ? trailOn
        ? tk.price <= peak * (1 - pos.slPct! / 100)
        : pnlPct <= -pos.slPct!
      : false;
    const scale = clampScale(pos.tpScale);
    const rung = pos.tpRung ?? 0;
    const tpDue =
      !slHit &&
      pos.tpPct != null &&
      pos.tpPct > 0 &&
      pnlPct >= pos.tpPct &&
      rung < scale &&
      ledger.now >= (pos.tpNextAt ?? 0);
    if (!slHit && !tpDue) {
      kept.push({
        ...pos,
        tpScale: scale,
        tpRung: rung,
        tpNextAt: pos.tpNextAt ?? 0,
        trailOn,
        peakPrice: peak,
      });
      continue;
    }
    const leftRungs = slHit ? 1 : Math.max(1, scale - rung);
    const sliceAmt = slHit || leftRungs <= 1 ? pos.amount : pos.amount / leftRungs;
    const last = slHit || pos.amount - sliceAmt < 1e-9 || leftRungs <= 1;
    const soldAmt = last ? pos.amount : sliceAmt;
    const fraction = soldAmt / Math.max(pos.amount, 1e-12);
    const proceeds = soldAmt * tk.price;
    const costCut = pos.costSol * fraction;
    sol += proceeds;
    realized += proceeds - costCut;
    lossStreak = nextStreak(lossStreak, proceeds - costCut);
    const source: FillSource = slHit ? (trailOn ? "trail" : "sl") : "tp";
    const sliceN = slHit ? 0 : rung + 1;
    fills = [
      {
        id: uid("f"),
        ts: ledger.now,
        tokenId: tk.id,
        side: "sell" as const,
        sol: proceeds,
        amount: soldAmt,
        price: tk.price,
        source,
        pnl: proceeds - costCut,
      },
      ...fills,
    ].slice(0, 200);
    const sliceLabel =
      source === "tp" && scale > 1
        ? `TWAP ${sliceN}/${scale} $${tk.symbol} · ${proceeds.toFixed(2)} SOL`
        : source === "tp"
          ? `Take-profit $${tk.symbol} · ${proceeds.toFixed(2)} SOL`
          : source === "trail"
            ? `Trail stop $${tk.symbol} · ${proceeds.toFixed(2)} SOL`
            : `Stop-loss $${tk.symbol} · ${proceeds.toFixed(2)} SOL`;
    const sliceLabelAr =
      source === "tp" && scale > 1
        ? `جني ${sliceN}/${scale} $${tk.symbol} · ${proceeds.toFixed(2)} SOL`
        : source === "tp"
          ? `جني ربح $${tk.symbol} · ${proceeds.toFixed(2)} SOL`
          : source === "trail"
            ? `وقف متحرّك $${tk.symbol} · ${proceeds.toFixed(2)} SOL`
            : `وقف خسارة $${tk.symbol} · ${proceeds.toFixed(2)} SOL`;
    feed = [
      {
        id: uid("feed"),
        ts: ledger.now,
        kind: "flow" as const,
        tokenId: tk.id,
        side: "sell" as const,
        text: sliceLabel,
        textAr: sliceLabelAr,
      },
      ...feed,
    ].slice(0, 80);
    alerts = pushAlert(
      alerts,
      {
        id: uid("al"),
        ts: ledger.now,
        kind: source === "tp" ? "tp" : "stop",
        tokenId: tk.id,
        side: "sell",
        text:
          source === "tp" && scale > 1
            ? `TWAP ${sliceN}/${scale} $${tk.symbol}`
            : source === "tp"
              ? `Take-profit hit $${tk.symbol}`
              : source === "trail"
                ? `Trail stopped $${tk.symbol}`
                : `Stop broken $${tk.symbol}`,
        textAr:
          source === "tp" && scale > 1
            ? `جني ${sliceN}/${scale} $${tk.symbol}`
            : source === "tp"
              ? `جُني الربح على $${tk.symbol}`
              : source === "trail"
                ? `أُوقف المتحرّك على $${tk.symbol}`
                : `كُسر الوقف على $${tk.symbol}`,
      },
      ledger.radarStop,
    );
    if (!last) {
      const delay = 1800 + (hashString(`${tk.id}:${rung}`) % 1600);
      kept.push({
        ...pos,
        amount: pos.amount - soldAmt,
        costSol: pos.costSol - costCut,
        tpScale: scale,
        tpRung: rung + 1,
        tpNextAt: ledger.now + delay,
        trailOn,
        peakPrice: peak,
      });
    }
  }
  return { positions: kept, fills, sol, realized, feed, alerts, lossStreak };
}

function applyFill(state: DeskState, fill: Fill, exits?: Exits): Partial<DeskState> | null {
  const token = state.tokens.find((tkn) => tkn.id === fill.tokenId);
  if (!token) return null;
  if (fill.side === "buy") {
    if (state.sol < fill.sol) return null;
    return {
      sol: state.sol - fill.sol,
      positions: upsertBuy(state.positions, fill.tokenId, fill.amount, fill.sol, exits),
      fills: [fill, ...state.fills].slice(0, 200),
    };
  }
  const existing = state.positions.find((p) => p.tokenId === fill.tokenId);
  if (!existing || existing.amount <= 0) return null;
  const fraction = Math.min(1, fill.sol / Math.max(0.0001, existing.amount * token.price));
  const soldAmt = existing.amount * fraction;
  const proceeds = soldAmt * token.price;
  const costCut = existing.costSol * fraction;
  const realizedAdd = proceeds - costCut;
  const leftAmt = existing.amount - soldAmt;
  const positions =
    leftAmt < 1e-9
      ? state.positions.filter((p) => p.tokenId !== fill.tokenId)
      : state.positions.map((p) =>
          p.tokenId === fill.tokenId ? { ...p, amount: leftAmt, costSol: existing.costSol - costCut } : p,
        );
  return {
    sol: state.sol + proceeds,
    realized: state.realized + realizedAdd,
    positions,
    fills: [{ ...fill, sol: proceeds, amount: soldAmt, price: token.price, pnl: realizedAdd }, ...state.fills].slice(0, 200),
  };
}

function pushFeed(state: DeskState, item: FeedItem): FeedItem[] {
  return [item, ...state.feed].slice(0, 80);
}

function pushAlert(alerts: Alert[], item: Omit<Alert, "read">, on: boolean): Alert[] {
  if (!on) return alerts;
  return [{ ...item, read: false }, ...alerts].slice(0, 60);
}

function ping(
  feed: FeedItem[],
  alerts: Alert[],
  now: number,
  radar: boolean,
  spec: {
    kind: AlertKind;
    feedKind?: FeedItem["kind"];
    tokenId?: string;
    side?: Side;
    feedEn: string;
    feedAr: string;
    alertEn: string;
    alertAr: string;
  },
): { feed: FeedItem[]; alerts: Alert[] } {
  return {
    feed: [
      {
        id: uid("feed"),
        ts: now,
        kind: spec.feedKind ?? "snipe",
        tokenId: spec.tokenId,
        side: spec.side,
        text: spec.feedEn,
        textAr: spec.feedAr,
      },
      ...feed,
    ].slice(0, 80),
    alerts: pushAlert(
      alerts,
      {
        id: uid("al"),
        ts: now,
        kind: spec.kind,
        tokenId: spec.tokenId,
        side: spec.side,
        text: spec.alertEn,
        textAr: spec.alertAr,
      },
      radar,
    ),
  };
}

function fireSnipe(
  bag: SnipeBag,
  tk: Token,
  settings: DeskSettings,
  now: number,
  reason: "launch" | "migrate",
  recentSniped: Array<{ id: string; ts: number }>,
): Array<{ id: string; ts: number }> {
  if (!snipeBuy(bag, tk, settings, now, reason)) return recentSniped;
  return [{ id: tk.id, ts: now }, ...recentSniped].slice(0, 12);
}

function fireBestLaunch(
  bag: SnipeBag,
  launches: Token[],
  settings: DeskSettings,
  now: number,
  recentSniped: Array<{ id: string; ts: number }>,
): Array<{ id: string; ts: number }> {
  if (!settings.snipeLaunch || !launches.length) return recentSniped;
  const ranked = [...launches].sort((a, b) => snipeEdge(b, now) - snipeEdge(a, now));
  for (const tk of ranked) {
    const next = fireSnipe(bag, tk, settings, now, "launch", recentSniped);
    if (next !== recentSniped) return next;
  }
  return recentSniped;
}

function fireMigrate(
  bag: SnipeBag,
  tk: Token,
  settings: DeskSettings,
  now: number,
  armed: boolean,
  recentSniped: Array<{ id: string; ts: number }>,
  alerts: Alert[],
): { recentSniped: Array<{ id: string; ts: number }>; alerts: Alert[] } {
  const noted = ping(bag.feed, alerts, now, settings.radarMigrate, {
    kind: "migrate",
    tokenId: tk.id,
    feedEn: `$${tk.symbol} migrated — curve complete`,
    feedAr: `$${tk.symbol} هاجر — اكتمل المنحنى`,
    alertEn: `Migrated $${tk.symbol}`,
    alertAr: `هاجر $${tk.symbol}`,
  });
  bag.feed = noted.feed;
  if (armed) recentSniped = fireSnipe(bag, tk, settings, now, "migrate", recentSniped);
  return { recentSniped, alerts: noted.alerts };
}

export const useDesk = create<DeskState>()(
  persist(
    (set, get) => ({
      locale: "en",
      hydrated: false,
      intro: false,
      sol: 0,
      realized: 0,
      tokens: [],
      wallets: [],
      kols: world0.kols,
      positions: [],
      fills: [],
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
      settings: {
        chain: "sol",
        mev: true,
        slippage: 12,
        priority: 0.001,
        quickBuy: 0.5,
        hideRugs: true,
        minLiq: 0,
        minMc: 0,
        maxMc: 0,
        maxBundled: 0,
        maxDev: 0,
        maxSnipers: 0,
        minHolders: 0,
        maxAgeMin: 0,
        keywords: "",
        exclude: "",
        hasX: false,
        skipFraud: false,
        minGrade: "",
        sieve: "",
        snipeMigrate: true,
        snipeLaunch: false,
        radarLaunch: true,
        radarMigrate: true,
        radarSmart: true,
        radarStop: true,
        radarDev: true,
        devExit: true,
        socialSol: 0.5,
        socialNoStack: true,
        radarSocial: true,
        liveOn: true,
        guardMint: true,
        ladderOn: true,
        execLive: true,
        snipeLive: false,
        ...RISK_DEFAULTS,
        radarRisk: true,
      },
      liveOk: false,
      liveAt: 0,
      walletPk: null,
      walletInjected: false,
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
      setLocale: () => set({ locale: "en" }),
      dismissIntro: () => set({ intro: false }),
      patchSettings: (patch) =>
        set((s) => {
          const settings = { ...s.settings, ...sanitizeDesk(patch), execLive: true, liveOn: true };
          return {
            settings,
            snipeJobs: settings.snipeLive === false ? [] : s.snipeJobs,
          };
        }),
      toggleWatch: (id) =>
        set(() => {
          const cur = get().watch;
          if (cur.includes(id)) return { watch: cur.filter((x) => x !== id) };
          return { watch: [...cur, id].slice(-32) };
        }),
      toggleArmSnipe: (id) =>
        set({
          armedSnipes: get().armedSnipes.includes(id)
            ? get().armedSnipes.filter((x) => x !== id)
            : [...get().armedSnipes, id],
        }),
      toggleTrackWallet: (id) =>
        set({
          wallets: get().wallets.map((w) => (w.id === id ? { ...w, tracked: !w.tracked } : w)),
        }),
      toggleTrackKol: (id) =>
        set({
          kols: get().kols.map((k) => (k.id === id ? { ...k, tracked: !k.tracked, tradeOn: k.tracked ? false : k.tradeOn } : k)),
        }),
      toggleKolTrade: (id) =>
        set({
          kols: get().kols.map((k) =>
            k.id === id ? { ...k, tradeOn: !k.tradeOn, tracked: !k.tradeOn ? true : k.tracked } : k,
          ),
        }),
      setCopy: (walletId, patch) =>
        set((s) => {
          const existing = s.copyRules.find((r) => r.walletId === walletId);
          const copyRules = existing
            ? s.copyRules.map((r) =>
                r.walletId === walletId ? normalizeCopy({ ...r, ...patch }) : r,
              )
            : [...s.copyRules, normalizeCopy({ walletId, ...patch })];
          const wallets =
            patch.enabled === true
              ? s.wallets.map((w) => (w.id === walletId ? { ...w, tracked: true } : w))
              : s.wallets;
          return { copyRules, wallets };
        }),
      cancelCopy: (id) =>
        set((s) => ({ copyPending: s.copyPending.filter((p) => p.id !== id) })),
      addFollow: (raw) => {
        const pk = raw.trim();
        if (!isB58(pk)) return "badPk";
        const s = get();
        if (s.walletPk === pk) return "followOwn";
        if (s.follows.some((f) => f.pk === pk)) return "followDup";
        if (s.follows.length >= MAX_FOLLOWS) return "followMax";
        const label = pk.slice(0, 4);
        set({
          follows: [...s.follows, { pk, label }],
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
          const followTape = { ...s.followTape, [pk]: prints.slice(0, 8) };
          if (!news.length || pk === s.walletPk) return { followCursor, followTape };
          const rule = s.copyRules.find((r) => r.walletId === pk && r.enabled);
          if (!rule) return { followCursor, followTape };
          let copyPending = s.copyPending;
          let feed = s.feed;
          let copyHits = s.copyHits;
          const now = Date.now();
          const style = styleOf(rule.style);
          for (const raw of news) {
            const p = swapPrint(raw);
            if (!p) continue;
            if (p.sig && (copyPending.some((x) => x.sig === p.sig) || s.liveFills.some((x) => x.sig === p.sig))) continue;
            const tk = s.tokens.find((t) => t.mint === p.mint || t.id === p.mint);
            if (!tk) continue;
            const why = copySkipReason(tk, { ...rule, skipWeak: false }, p.side, s.settings.hideRugs, s.positions, undefined);
            if (why) continue;
            if (fraudSkip(fraudOf(tk))) {
              feed = pushFeed({ ...s, feed, now } as DeskState, {
                id: uid("feed"),
                ts: now,
                kind: "risk",
                tokenId: tk.id,
                text: `Copy skip fraud $${tk.symbol}`,
                textAr: `تخطي النسخ — احتيال $${tk.symbol}`,
              });
              continue;
            }
            if (rule.noStack && s.chainHoldings.some((h) => h.mint === tk.mint && h.amount > 0)) continue;
            const confirms = priorConfirms(copyHits, pk, p.mint, now);
            if (p.side === "buy") copyHits = bumpConfirm(copyHits, pk, p.mint, now);
            const skip = styleSkip(style, { side: p.side, change5m: tk.change5m, srcSol: p.sol, confirms });
            if (skip) continue;
            const size = styleSize(style, rule.sizePct, rule.maxSol, p.sol);
            if (size < 0.05) continue;
            const wait = styleDelay(style, rule.delaySec);
            copyPending = [
              {
                id: uid("cq"),
                walletId: pk,
                tokenId: tk.id,
                side: p.side,
                fireAt: now + wait * 1000,
                sig: p.sig,
                mint: tk.mint,
                srcSol: p.sol,
                chain: true,
                pendingSince: 0,
              },
              ...copyPending,
            ].slice(0, 24);
            feed = pushFeed({ ...s, feed, now } as DeskState, {
              id: uid("feed"),
              ts: now,
              kind: "smart",
              tokenId: tk.id,
              side: p.side,
              text: `${style} ${p.side} $${tk.symbol} · ${size.toFixed(2)} SOL in ${wait}s`,
              textAr: `${style} ${p.side === "buy" ? "شراء" : "بيع"} $${tk.symbol} · ${size.toFixed(2)} SOL خلال ${wait}ث`,
            });
          }
          return { followCursor, followTape, copyPending, feed, copyHits };
        }),
      armCopyJob: (id) =>
        set((s) => ({
          copyPending: s.copyPending.map((p) => (p.id === id ? { ...p, pendingSince: Date.now() } : p)),
        })),
      finishCopyJob: (id, ok) =>
        set((s) => ({
          copyPending: s.copyPending.filter((p) => p.id !== id),
          bagNonce: ok ? s.bagNonce + 1 : s.bagNonce,
        })),
      armSnipeJob: (id) =>
        set((s) => ({
          snipeJobs: s.snipeJobs.map((j) => (j.id === id ? { ...j, pendingSince: Date.now() } : j)),
        })),
      finishSnipeJob: (id, ok) =>
        set((s) => ({
          snipeJobs: s.snipeJobs.filter((j) => j.id !== id),
          bagNonce: ok ? s.bagNonce + 1 : s.bagNonce,
        })),
      queueSnipe: (tokenId) => {
        const s = get();
        const tk = s.tokens.find((t) => t.id === tokenId);
        if (!tk) return;
        if (liveSnipeOk(s.settings, tk)) {
          if (s.snipeJobs.some((j) => j.tokenId === tokenId)) return;
          const spend = Math.min(Math.max(0.05, s.settings.quickBuy), s.settings.maxTradeSol || 2);
          set({
            snipeJobs: [
              { id: uid("sq"), tokenId, mint: tk.mint, sol: spend, reason: "migrate" as const, pendingSince: 0 },
              ...s.snipeJobs,
            ].slice(0, 8),
          });
        }
      },
      markRadarRead: () =>
        set((s) => ({ alerts: s.alerts.map((a) => (a.read ? a : { ...a, read: true })) })),
      buy: (_tokenId, _solAmt, _source = "manual", _exits) => {
        return "wallet";
      },
      sell: (_tokenId, _solAmt, _source = "manual") => {
        return "wallet";
      },
      setExits: (tokenId, exits) =>
        set((s) => {
          const positions = s.positions.map((p) =>
            p.tokenId === tokenId
              ? {
                  ...p,
                  tpPct: exits.tpPct !== undefined ? exits.tpPct : p.tpPct,
                  slPct: exits.slPct !== undefined ? exits.slPct : p.slPct,
                  tpScale: exits.tpScale !== undefined ? clampScale(exits.tpScale) : p.tpScale || 1,
                  tpRung:
                    exits.tpPct !== undefined || exits.tpScale !== undefined ? 0 : p.tpRung,
                  tpNextAt:
                    exits.tpPct !== undefined || exits.tpScale !== undefined ? 0 : p.tpNextAt,
                  trailOn: exits.trailOn !== undefined ? !!exits.trailOn : p.trailOn,
                  peakPrice:
                    exits.trailOn === true
                      ? Math.max(
                          p.peakPrice || 0,
                          s.tokens.find((t) => t.id === tokenId)?.price ?? 0,
                        )
                      : p.peakPrice || 0,
                  devExit: exits.devExit !== undefined ? !!exits.devExit : p.devExit,
                }
              : p,
          );
          const closed = applyExits({
            tokens: s.tokens,
            positions,
            fills: s.fills,
            sol: s.sol,
            realized: s.realized,
            feed: s.feed,
            alerts: s.alerts,
            now: s.now,
            radarStop: s.settings.radarStop,
            lossStreak: s.lossStreak,
          });
          const halted = applyHalt(
            s.settings,
            {
              riskHalt: s.riskHalt,
              lossStreak: closed.lossStreak,
              dayStart: s.dayStart,
              sol: closed.sol,
              positions: closed.positions,
              tokens: s.tokens,
            },
            closed.alerts,
            closed.feed,
            s.now,
          );
          const tk = s.tokens.find((t) => t.id === tokenId);
          const mint = tk?.mint || s.chainExits.find((e) => e.tokenId === tokenId)?.mint || "";
          const chainExits =
            s.settings.execLive && mint
              ? upsertChainExit(s.chainExits, {
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
                })
              : s.chainExits;
          return {
            positions: closed.positions,
            fills: closed.fills,
            sol: closed.sol,
            realized: closed.realized,
            feed: halted.feed,
            alerts: halted.alerts,
            lossStreak: closed.lossStreak,
            riskHalt: halted.riskHalt,
            chainExits,
          };
        }),
      placeLimit: (tokenId, side, triggerMc, solAmt) =>
        set((s) => ({
          limits: [
            { id: uid("lim"), tokenId, side, triggerMc, sol: solAmt, status: "open" },
            ...s.limits,
          ],
        })),
      cancelLimit: (id) =>
        set((s) => ({
          limits: s.limits.map((o) => (o.id === id ? { ...o, status: "cancelled" } : o)),
        })),
      armDca: (tokenId, solAmt, intervalMs, slices) =>
        set((s) => {
          const n = Math.max(2, Math.min(8, Math.round(slices)));
          const gap = Math.max(8_000, Math.min(60_000, intervalMs));
          const spend = Math.max(0.05, solAmt);
          const chain = true;
          const plan: DcaPlan = {
            id: uid("dca"),
            tokenId,
            sol: spend,
            intervalMs: gap,
            slices: n,
            done: chain ? 0 : 1,
            nextAt: s.now + (chain ? 400 : gap),
            status: "live",
            chain,
            pendingSol: 0,
            pendingSince: 0,
          };
          return {
            dcaPlans: [plan, ...s.dcaPlans.filter((p) => p.tokenId !== tokenId || p.status !== "live")],
          };
        }),
      cancelDca: (tokenId) =>
        set((s) => ({
          dcaPlans: s.dcaPlans.map((p) =>
            p.tokenId === tokenId && p.status === "live" ? { ...p, status: "stopped" } : p,
          ),
        })),
      armLadder: (tokenId, solAmt) =>
        set((s) => {
          const tk = s.tokens.find((t) => t.id === tokenId);
          if (!tk) return {};
          const spend = Math.max(0.15, solAmt || s.settings.quickBuy);
          const next = startLadder(s.ladders, {
            tokenId,
            now: s.now,
            price: tk.price,
            budget: spend,
            source: "manual",
            chain: true,
          });
          const { en, ar } = next.born
            ? { en: `Confirm $${tk.symbol} · ${spend.toFixed(2)} SOL`, ar: `تأكيد $${tk.symbol} · ${spend.toFixed(2)} SOL` }
            : { en: `Confirm +1 $${tk.symbol}`, ar: `تأكيد +1 $${tk.symbol}` };
          return {
            ladders: next.ladders,
            feed: [
              { id: uid("feed"), ts: s.now, kind: "flow" as const, tokenId, text: en, textAr: ar },
              ...s.feed,
            ].slice(0, 80),
          };
        }),
      cancelLadder: (tokenId) =>
        set((s) => ({
          ladders: s.ladders.map((l) =>
            l.tokenId === tokenId && l.status === "live" ? { ...l, status: "stopped" } : l,
          ),
        })),
      ingestLive: (rows) =>
        set((s) => {
          if (!s.settings.liveOn || !rows.length) return {};
          const now = Date.now();
          const prevById = new Map(s.tokens.map((t) => [t.id, t]));
          const keep = new Set([
            ...s.positions.map((p) => p.tokenId),
            ...s.watch,
            ...s.armedSnipes,
            ...s.chainHoldings.map((h) => h.mint),
          ]);
          const uniq: Token[] = [];
          const mints = new Set<string>();
          for (const row of rows) {
            const k = row.mint || row.id;
            if (!k || mints.has(k)) continue;
            mints.add(k);
            uniq.push(row);
          }
          const merged: Token[] = uniq.map((row) => mergeLiveToken(prevById.get(row.id), row, now));
          const seen = new Set(merged.map((t) => t.id));
          for (const old of s.tokens) {
            if (!keep.has(old.id) || seen.has(old.id) || (old.mint && mints.has(old.mint))) continue;
            merged.push(old);
            seen.add(old.id);
          }
          let feed = s.feed;
          let alerts = s.alerts;
          let positions = s.positions;
          let fills = s.fills;
          let sol = s.sol;
          let recentMigrated = s.recentMigrated;
          let recentSniped = s.recentSniped.filter((r) => now - r.ts < 8_000);
          const launches: Token[] = [];
          if (!s.liveOk) {
            feed = pushFeed({ ...s, feed, now } as DeskState, {
              id: uid("feed"),
              ts: now,
              kind: "flow",
              text: `Live SOL pulse · ${merged.length} pairs`,
              textAr: `نبض سولانا الحي · ${merged.length} زوج`,
            });
          }
          const bag: SnipeBag = {
            sol,
            positions,
            fills,
            feed,
            tokens: merged,
            riskHalt: s.riskHalt,
            lossStreak: s.lossStreak,
            dayStart: s.dayStart,
            ladders: s.ladders,
            snipeJobs: s.snipeJobs,
          };
          for (const tk of merged) {
            const prev = prevById.get(tk.id);
            if (!prev && tk.live && s.liveOk) {
              launches.push(tk);
              const noted = ping(bag.feed, alerts, now, s.settings.radarLaunch, {
                kind: "launch",
                tokenId: tk.id,
                feedEn: `Launch $${tk.symbol} on SOL`,
                feedAr: `إطلاق $${tk.symbol} على SOL`,
                alertEn: `Launch $${tk.symbol}`,
                alertAr: `إطلاق $${tk.symbol}`,
              });
              bag.feed = noted.feed;
              alerts = noted.alerts;
            }
            if (prev && prev.stage !== "migrated" && tk.stage === "migrated") {
              recentMigrated = [{ id: tk.id, ts: now }, ...recentMigrated].slice(0, 12);
              const next = fireMigrate(
                bag,
                tk,
                s.settings,
                now,
                s.settings.snipeMigrate || s.armedSnipes.includes(tk.id),
                recentSniped,
                alerts,
              );
              recentSniped = next.recentSniped;
              alerts = next.alerts;
            }
          }
          recentSniped = fireBestLaunch(bag, launches, s.settings, now, recentSniped);
          sol = bag.sol;
          positions = bag.positions;
          fills = bag.fills;
          feed = bag.feed;
          const halted = applyHalt(
            s.settings,
            {
              riskHalt: s.riskHalt,
              lossStreak: s.lossStreak,
              dayStart: s.dayStart,
              sol,
              positions,
              tokens: merged,
            },
            alerts,
            feed,
            now,
          );
          return {
            tokens: (() => {
              const held = merged.filter((t) => keep.has(t.id));
              const rest = merged.filter((t) => t.live && !keep.has(t.id));
              return [...held, ...rest].slice(0, Math.max(56, held.length));
            })(),
            feed: halted.feed,
            alerts: halted.alerts,
            positions,
            fills,
            sol,
            recentMigrated,
            recentSniped,
            liveOk: true,
            liveAt: now,
            now,
            riskHalt: halted.riskHalt,
            ladders: bag.ladders,
            snipeJobs: bag.snipeJobs,
          };
        }),
      armLive: (on) =>
        set((s) => ({
          settings: {
            ...s.settings,
            execLive: true,
            liveOn: true,
            snipeLive: on ? s.settings.snipeLive : s.settings.snipeLive,
          },
        })),
      setWallet: (pk) =>
        set({
          walletPk: pk,
          walletInjected: false,
          chainSol: null,
          chainHoldings: [],
          chainBagAt: 0,
          chainTokensOk: true,
          chainTape: [],
        }),
      setWatchPk: (pk) =>
        set({
          watchPk: pk,
          watchSol: null,
          watchHoldings: [],
          watchTape: [],
          watchBagAt: 0,
        }),
      setHotVault: (vault) =>
        set({
          hotVault: vault,
          hotUnlocked: false,
          walletInjected: false,
        }),
      markHotExported: () =>
        set((s) => {
          if (!s.hotVault) return {};
          return {
            hotVault: { ...s.hotVault, exported: true },
            hotUnlocked: !!peekSecret(),
            walletPk: s.hotVault.pub,
            walletInjected: false,
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
            walletInjected: false,
            chainSol: null,
            chainHoldings: [],
            chainBagAt: 0,
            chainTokensOk: true,
            chainTape: [],
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
        set({
          chainSol: sol,
          chainHoldings: holdings.slice(0, 40),
          chainBagAt: Date.now(),
          chainTokensOk: tokensOk,
        }),
      setChainTape: (prints) => set({ chainTape: prints.slice(0, 16) }),
      setWatchBag: (sol, holdings) =>
        set({
          watchSol: sol,
          watchHoldings: holdings.slice(0, 40),
          watchBagAt: Date.now(),
        }),
      setWatchTape: (prints) => set({ watchTape: prints.slice(0, 16) }),
      recordLiveFill: (fill) =>
        set((s) => {
          const next: LiveFill = {
            id: uid("lf"),
            ts: s.now,
            sig: fill.sig,
            mint: fill.mint,
            tokenId: fill.tokenId,
            side: fill.side,
            sol: fill.sol,
            status: fill.status,
          };
          const token = s.tokens.find((t) => t.id === fill.tokenId);
          const label = token?.symbol ?? fill.mint.slice(0, 6);
          const text =
            fill.status === "fail"
              ? `Chain ${fill.side} failed $${label}`
              : `Chain ${fill.side} $${label} · ${fill.sol.toFixed(2)} SOL`;
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
            liveFills: [next, ...s.liveFills.filter((x) => x.sig !== fill.sig)].slice(0, 24),
            chainExits,
            feed: [
              {
                id: uid("feed"),
                ts: s.now,
                kind: "flow" as const,
                tokenId: fill.tokenId,
                side: fill.side,
                text,
                textAr,
              },
              ...s.feed,
            ].slice(0, 80),
            bagNonce: fill.status === "ok" || fill.status === "sent" ? s.bagNonce + 1 : s.bagNonce,
          };
        }),
      patchLiveFill: (sig, status) =>
        set((s) => ({
          liveFills: s.liveFills.map((f) => (f.sig === sig ? { ...f, status } : f)),
        })),
      finishChainSlice: (kind, tokenId, ok, px) =>
        set((s) => {
          const now = Date.now();
          const tk = s.tokens.find((t) => t.id === tokenId);
          const label = tk ? `$${tk.symbol}` : "";
          const missed = ok
            ? s.feed
            : [
                {
                  id: uid("feed"),
                  ts: now,
                  kind: "risk" as const,
                  tokenId,
                  text: `Chain slice missed ${label}`.trim(),
                  textAr: `فاتت شريحة السلسلة ${label}`.trim(),
                },
                ...s.feed,
              ].slice(0, 80);
          if (kind === "ladder") {
            return {
              ladders: ok
                ? commitLadderSlice(s.ladders, tokenId, px ?? 0, now)
                : failLadderSlice(s.ladders, tokenId, now),
              feed: missed,
            };
          }
          return {
            dcaPlans: s.dcaPlans.map((p) => {
              if (p.tokenId !== tokenId || p.status !== "live" || p.pendingSol < 0.05) return p;
              if (!ok) {
                return { ...p, pendingSol: 0, pendingSince: 0, nextAt: now + Math.max(p.intervalMs, 12_000) };
              }
              const done = p.done + 1;
              if (done >= p.slices) {
                return { ...p, done, pendingSol: 0, pendingSince: 0, status: "done" as const };
              }
              return { ...p, done, pendingSol: 0, pendingSince: 0, nextAt: now + p.intervalMs };
            }),
            feed: missed,
          };
        }),
      finishChainExit: (tokenId, ok) =>
        set((s) => {
          const now = Date.now();
          const before = s.chainExits.find((e) => e.tokenId === tokenId);
          const chainExits = ok ? commitChainExit(s.chainExits, tokenId, now) : failChainExit(s.chainExits, tokenId, now);
          const gone = ok && before && !chainExits.some((e) => e.tokenId === tokenId);
          return {
            chainExits,
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
          positions: [],
          sol: 0,
          chainExits,
          dcaPlans: s.dcaPlans.map((p) => (p.status === "live" ? { ...p, status: "stopped" } : p)),
          ladders: s.ladders.map((l) => (l.status === "live" ? { ...l, status: "stopped" } : l)),
          copyPending: [],
          snipeJobs: [],
          feed: [
            { id: uid("feed"), ts: now, kind: "risk" as const, text, textAr },
            ...s.feed,
          ].slice(0, 80),
          alerts: pushAlert(
            s.alerts,
            { id: uid("al"), ts: now, kind: "risk", text, textAr },
            s.settings.radarRisk,
          ),
        });
      },
      clearHalt: () => set({ riskHalt: false, lossStreak: 0 }),
      resetDay: () =>
        set({
          dayStart: get().equity(),
          lossStreak: 0,
          riskHalt: false,
        }),
      tick: () => {
        const state = get();
        const now = Date.now();
        const rng = mulberry32((state.tickN + 1) * 9973 + (now & 0xffff));
        let tokens = state.tokens.map((tk) => (tk.live ? tk : tickToken(tk, now, rng)));
        let feed = state.feed;
        let wallets = state.wallets;
        let fills = state.fills;
        let positions = state.positions;
        let sol = state.sol;
        let realized = state.realized;
        let limits = state.limits;
        let armedSnipes = state.armedSnipes;
        let copyPending = state.copyPending;
        let dcaPlans = state.dcaPlans;
        let ladders = state.ladders;
        let chainExits = state.chainExits;
        let alerts = state.alerts;
        let snipeJobs = state.snipeJobs;
        let recentSniped = state.recentSniped.filter((r) => now - r.ts < 8_000);
        let riskHalt = state.riskHalt;
        let lossStreak = state.lossStreak;

        const migratedNow = tokens.filter(
          (tkn, i) => tkn.stage === "migrated" && state.tokens[i]?.stage !== "migrated",
        );

        if ((!state.settings.liveOn || !state.liveOk) && rng() > 0.82 && tokens.filter((tkn) => tkn.stage === "new" && !tkn.live).length < 16) {
          const spawned = spawnToken(now);
          tokens = [spawned, ...tokens].slice(0, 48);
          const noted = ping(feed, alerts, now, state.settings.radarLaunch, {
            kind: "launch",
            tokenId: spawned.id,
            feedEn: `Launched $${spawned.symbol} on SOL`,
            feedAr: `أُطلق $${spawned.symbol} على SOL`,
            alertEn: `Launch $${spawned.symbol}`,
            alertAr: `إطلاق $${spawned.symbol}`,
          });
          feed = noted.feed;
          alerts = noted.alerts;
          if (state.settings.snipeLaunch) {
            const bag: SnipeBag = {
              sol,
              positions,
              fills,
              feed,
              tokens,
              riskHalt,
              lossStreak,
              dayStart: state.dayStart,
              ladders,
              snipeJobs,
            };
            recentSniped = fireSnipe(bag, spawned, state.settings, now, "launch", recentSniped);
            sol = bag.sol;
            positions = bag.positions;
            fills = bag.fills;
            feed = bag.feed;
            ladders = bag.ladders;
            snipeJobs = bag.snipeJobs;
          }
        }

        const recentMigrated = [
          ...migratedNow.map((tk) => ({ id: tk.id, ts: now })),
          ...state.recentMigrated.filter((r) => now - r.ts < 8_000),
        ].slice(0, 12);

        for (const tk of migratedNow) {
          const bag: SnipeBag = {
            sol,
            positions,
            fills,
            feed,
            tokens,
            riskHalt,
            lossStreak,
            dayStart: state.dayStart,
            ladders,
            snipeJobs,
          };
          const next = fireMigrate(
            bag,
            tk,
            state.settings,
            now,
            state.settings.snipeMigrate || state.armedSnipes.includes(tk.id),
            recentSniped,
            alerts,
          );
          sol = bag.sol;
          positions = bag.positions;
          fills = bag.fills;
          feed = bag.feed;
          recentSniped = next.recentSniped;
          alerts = next.alerts;
          ladders = bag.ladders;
          snipeJobs = bag.snipeJobs;
        }

        armedSnipes = armedSnipes.filter((id) => !migratedNow.some((tk) => tk.id === id));

        const runCopy = (tk: Token, side: Side, rule: CopyRule, srcSol?: number) => {
          const follow = isFollowId(rule.walletId);
          const w = follow ? undefined : wallets.find((x) => x.id === rule.walletId);
          if (!follow && !w?.tracked) return;
          const why = copySkipReason(tk, rule, side, state.settings.hideRugs, positions, w);
          if (why === "weak" && w) {
            feed = pushFeed({ ...state, feed, now } as DeskState, {
              id: uid("feed"),
              ts: now,
              kind: "smart",
              tokenId: tk.id,
              walletId: w.id,
              side,
              text: `Skip paper ${w.name} on $${tk.symbol}`,
              textAr: `تخطّ أيادٍ ورقية ${w.name} على $${tk.symbol}`,
            });
            return;
          }
          if (why) return;
          const cap =
            srcSol != null
              ? Math.min(styleSize(styleOf(rule.style), rule.sizePct, rule.maxSol, srcSol), sol * 0.15)
              : copyCap(rule, state.settings.quickBuy, sol);
          if (side === "buy" && cap >= 0.05 && sol >= cap) {
            if (!tokenPasses(tk, state.settings) || snipeEdge(tk, now) < 0.4) return;
            const sized = clipAuto(
              state.settings,
              { riskHalt, lossStreak, dayStart: state.dayStart, sol, positions, tokens },
              tk.id,
              cap,
            );
            if (sized.spend >= 0.05) {
              if (state.settings.ladderOn) {
                const next = startLadder(ladders, {
                  tokenId: tk.id,
                  now,
                  price: tk.price,
                  budget: sized.spend,
                  source: "copy",
                });
                ladders = next.ladders;
                feed = pushFeed({ ...state, feed, now } as DeskState, {
                  id: uid("feed"),
                  ts: now,
                  kind: "smart",
                  tokenId: tk.id,
                  text: next.born
                    ? `Confirm copy $${tk.symbol} · ${sized.spend.toFixed(2)} SOL`
                    : `Confirm +1 $${tk.symbol}`,
                  textAr: next.born
                    ? `تأكيد نسخ $${tk.symbol} · ${sized.spend.toFixed(2)} SOL`
                    : `تأكيد +1 $${tk.symbol}`,
                });
              } else {
              const price = tk.price * (1 + fillSlip(state.settings) / 1000);
              const amount = sized.spend / price;
              sol -= sized.spend;
              positions = upsertBuy(positions, tk.id, amount, sized.spend, autoExits(state.settings));
              fills = [
                {
                  id: uid("f"),
                  ts: now,
                  tokenId: tk.id,
                  side: "buy" as const,
                  sol: sized.spend,
                  amount,
                  price,
                  source: "copy" as const,
                },
                ...fills,
              ].slice(0, 200);
              feed = pushFeed({ ...state, feed, now } as DeskState, {
                id: uid("feed"),
                ts: now,
                kind: "smart",
                tokenId: tk.id,
                side: "buy",
                text: `Copy fill $${tk.symbol} · ${sized.spend.toFixed(2)} SOL`,
                textAr: `تنفيذ نسخ $${tk.symbol} · ${sized.spend.toFixed(2)} SOL`,
              });
              }
            }
          }
          if (side === "sell") {
            const pos = positions.find((p) => p.tokenId === tk.id);
            if (!pos) return;
            const value = pos.amount * tk.price;
            const spend = Math.min(cap, value);
            if (spend < 0.05) return;
            const fraction = spend / Math.max(value, 1e-9);
            const soldAmt = pos.amount * fraction;
            const proceeds = soldAmt * tk.price;
            const costCut = pos.costSol * fraction;
            realized += proceeds - costCut;
            sol += proceeds;
            lossStreak = nextStreak(lossStreak, proceeds - costCut);
            const left = pos.amount - soldAmt;
            positions =
              left < 1e-9
                ? positions.filter((p) => p.tokenId !== tk.id)
                : positions.map((p) =>
                    p.tokenId === tk.id ? { ...p, amount: left, costSol: pos.costSol - costCut } : p,
                  );
            fills = [
              {
                id: uid("f"),
                ts: now,
                tokenId: tk.id,
                side: "sell" as const,
                sol: proceeds,
                amount: soldAmt,
                price: tk.price,
                source: "copy" as const,
                pnl: proceeds - costCut,
              },
              ...fills,
            ].slice(0, 200);
            feed = pushFeed({ ...state, feed, now } as DeskState, {
              id: uid("feed"),
              ts: now,
              kind: "smart",
              tokenId: tk.id,
              side: "sell",
              text: `Copy sell $${tk.symbol} · ${proceeds.toFixed(2)} SOL`,
              textAr: `نسخ بيع $${tk.symbol} · ${proceeds.toFixed(2)} SOL`,
            });
          }
        };

        const due = copyPending.filter((p) => !p.chain && p.fireAt <= now);
        copyPending = copyPending.filter((p) => p.chain || p.fireAt > now);
        void due;

        if (!state.settings.execLive && rng() > 0.55) {
          const w = wallets[Math.floor(rng() * wallets.length)];
          const pool = tokens.filter((tkn) => tkn.chain === "sol" || tkn.stage !== "new");
          const tk = pool[Math.floor(rng() * pool.length)];
          if (w && tk) {
            const side: Side = rng() > 0.38 ? "buy" : "sell";
            wallets = wallets.map((x) =>
              x.id === w.id ? { ...x, lastTokenId: tk.id, lastSide: side, lastTs: now } : x,
            );
            feed = pushFeed({ ...state, feed, now } as DeskState, {
              id: uid("feed"),
              ts: now,
              kind: "smart",
              tokenId: tk.id,
              walletId: w.id,
              side,
              text: `${w.name} ${side === "buy" ? "bought" : "sold"} $${tk.symbol}`,
              textAr: `${w.name} ${side === "buy" ? "اشترى" : "باع"} $${tk.symbol}`,
            });
            if (w.tracked) {
              alerts = pushAlert(
                alerts,
                {
                  id: uid("al"),
                  ts: now,
                  kind: "smart",
                  tokenId: tk.id,
                  walletId: w.id,
                  side,
                  text: `${w.name} ${side === "buy" ? "bought" : "sold"} $${tk.symbol}`,
                  textAr: `${w.name} ${side === "buy" ? "اشترى" : "باع"} $${tk.symbol}`,
                },
                state.settings.radarSmart,
              );
              if (side === "buy" && state.settings.ladderOn) {
                ladders = confirmLadder(ladders, tk.id, now);
              }
            }
            const rule = state.copyRules.find((r) => r.walletId === w.id && r.enabled);
            if (rule && w.tracked && (side === "buy" || rule.copySells)) {
              if (rule.delaySec > 0 && !(state.settings.ladderOn && side === "buy")) {
                const dup = copyPending.some(
                  (p) => p.walletId === w.id && p.tokenId === tk.id && p.side === side,
                );
                const why = copySkipReason(tk, rule, side, state.settings.hideRugs, positions, w);
                if (why === "weak") {
                  runCopy(tk, side, rule);
                } else if (!dup && !why) {
                  copyPending = [
                    {
                      id: uid("cq"),
                      walletId: w.id,
                      tokenId: tk.id,
                      side,
                      fireAt: now + rule.delaySec * 1000,
                    },
                    ...copyPending,
                  ].slice(0, 24);
                  feed = pushFeed({ ...state, feed, now } as DeskState, {
                    id: uid("feed"),
                    ts: now,
                    kind: "smart",
                    tokenId: tk.id,
                    walletId: w.id,
                    side,
                    text: `Copy queued $${tk.symbol} in ${rule.delaySec}s`,
                    textAr: `نسخ معلّق $${tk.symbol} خلال ${rule.delaySec}ث`,
                  });
                }
              } else {
                runCopy(tk, side, rule);
              }
            }
          }
        }

        if (!state.settings.execLive && rng() > (state.kols.some((k) => k.tradeOn) ? 0.52 : 0.7)) {
          const armed = state.kols.filter((k) => k.tradeOn);
          const tracked = state.kols.filter((k) => k.tracked);
          const pool = armed.length ? armed : tracked.length ? tracked : state.kols;
          const kol = pool[Math.floor(rng() * pool.length)];
          const tk = tokens[Math.floor(rng() * tokens.length)];
          if (kol && tk) {
            const tw = nextTweet(tk, rng());
            feed = pushFeed({ ...state, feed, now } as DeskState, {
              id: uid("feed"),
              ts: now,
              kind: "social",
              tokenId: tk.id,
              text: `${kol.handle} ${tw.en}`,
              textAr: `${kol.handle} ${tw.ar}`,
            });
            if (kol.tracked) {
              alerts = pushAlert(
                alerts,
                {
                  id: uid("al"),
                  ts: now,
                  kind: "social",
                  tokenId: tk.id,
                  text: `${kol.handle} $${tk.symbol}`,
                  textAr: `${kol.handle} $${tk.symbol}`,
                },
                state.settings.radarSocial,
              );
            }
            const spendWant = Math.min(state.settings.socialSol || state.settings.quickBuy, sol);
            const stacked = positions.some((p) => p.tokenId === tk.id);
            const sized = clipAuto(
              state.settings,
              { riskHalt, lossStreak, dayStart: state.dayStart, sol, positions, tokens },
              tk.id,
              spendWant,
            );
            if (
              !state.settings.execLive &&
              kol.tradeOn &&
              tw.chase &&
              sized.spend >= 0.05 &&
              tokenPasses(tk, state.settings) &&
              snipeEdge(tk, now) >= 0.5 &&
              !(state.settings.socialNoStack && stacked)
            ) {
              if (state.settings.ladderOn) {
                const next = startLadder(ladders, {
                  tokenId: tk.id,
                  now,
                  price: tk.price,
                  budget: sized.spend,
                  source: "social",
                });
                ladders = next.ladders;
                feed = pushFeed({ ...state, feed, now } as DeskState, {
                  id: uid("feed"),
                  ts: now,
                  kind: "social",
                  tokenId: tk.id,
                  text: next.born
                    ? `Confirm post $${tk.symbol} · ${sized.spend.toFixed(2)} SOL`
                    : `Confirm +1 $${tk.symbol}`,
                  textAr: next.born
                    ? `تأكيد منشور $${tk.symbol} · ${sized.spend.toFixed(2)} SOL`
                    : `تأكيد +1 $${tk.symbol}`,
                });
              } else {
              const price = tk.price * (1 + fillSlip(state.settings) / 1000);
              const amount = sized.spend / price;
              sol -= sized.spend;
              positions = upsertBuy(positions, tk.id, amount, sized.spend, autoExits(state.settings));
              fills = [
                {
                  id: uid("f"),
                  ts: now,
                  tokenId: tk.id,
                  side: "buy" as const,
                  sol: sized.spend,
                  amount,
                  price,
                  source: "social" as const,
                },
                ...fills,
              ].slice(0, 200);
              feed = pushFeed({ ...state, feed, now } as DeskState, {
                id: uid("feed"),
                ts: now,
                kind: "social",
                tokenId: tk.id,
                side: "buy",
                text: `Post fill $${tk.symbol} · ${sized.spend.toFixed(2)} SOL`,
                textAr: `تنفيذ منشور $${tk.symbol} · ${sized.spend.toFixed(2)} SOL`,
              });
              }
            }
          }
        }

        limits = limits.map((o) => {
          if (state.settings.execLive) return o;
          if (o.status !== "open") return o;
          const tk = tokens.find((tkn) => tkn.id === o.tokenId);
          if (!tk) return o;
          const hit = o.side === "buy" ? tk.mc <= o.triggerMc : tk.mc >= o.triggerMc;
          if (!hit) return o;
          if (o.side === "buy" && sol >= o.sol) {
            const sized = clipAuto(
              state.settings,
              { riskHalt, lossStreak, dayStart: state.dayStart, sol, positions, tokens },
              tk.id,
              o.sol,
              false,
            );
            if (sized.spend < 0.05) return o;
            const price = tk.price * (1 + fillSlip(state.settings) / 1000);
            const amount = sized.spend / price;
            sol -= sized.spend;
            positions = upsertBuy(positions, tk.id, amount, sized.spend, { devExit: state.settings.devExit });
            fills = [
              {
                id: uid("f"),
                ts: now,
                tokenId: tk.id,
                side: "buy" as const,
                sol: sized.spend,
                amount,
                price,
                source: "limit" as const,
              },
              ...fills,
            ].slice(0, 200);
            feed = pushFeed({ ...state, feed, now } as DeskState, {
              id: uid("feed"),
              ts: now,
              kind: "flow",
              tokenId: tk.id,
              text: `Limit filled $${tk.symbol}`,
              textAr: `نُفّذ أمر محدود $${tk.symbol}`,
            });
            return { ...o, status: "filled" as const };
          }
          if (o.side === "sell") {
            const pos = positions.find((p) => p.tokenId === tk.id);
            if (!pos) return { ...o, status: "cancelled" as const };
            const value = pos.amount * tk.price;
            const spend = Math.min(o.sol, value);
            if (spend < 0.05) return o;
            const fraction = spend / Math.max(value, 1e-9);
            const soldAmt = pos.amount * fraction;
            const proceeds = soldAmt * tk.price;
            const costCut = pos.costSol * fraction;
            const pnl = proceeds - costCut;
            realized += pnl;
            sol += proceeds;
            lossStreak = nextStreak(lossStreak, pnl);
            const left = pos.amount - soldAmt;
            positions =
              left < 1e-9
                ? positions.filter((p) => p.tokenId !== tk.id)
                : positions.map((p) =>
                    p.tokenId === tk.id ? { ...p, amount: left, costSol: pos.costSol - costCut } : p,
                  );
            fills = [
              {
                id: uid("f"),
                ts: now,
                tokenId: tk.id,
                side: "sell" as const,
                sol: proceeds,
                amount: soldAmt,
                price: tk.price,
                source: "limit" as const,
                pnl,
              },
              ...fills,
            ].slice(0, 200);
            feed = pushFeed({ ...state, feed, now } as DeskState, {
              id: uid("feed"),
              ts: now,
              kind: "flow",
              tokenId: tk.id,
              side: "sell",
              text: `Limit sold $${tk.symbol} · ${proceeds.toFixed(2)} SOL`,
              textAr: `بيع محدود $${tk.symbol} · ${proceeds.toFixed(2)} SOL`,
            });
            return { ...o, status: "filled" as const };
          }
          return o;
        });

        dcaPlans = dcaPlans.map((plan) => {
          if (plan.status !== "live" || now < plan.nextAt) return plan;
          if (ladders.some((l) => l.tokenId === plan.tokenId && l.status === "live")) return plan;
          const tk = tokens.find((tkn) => tkn.id === plan.tokenId);
          if (!tk || (state.settings.hideRugs && isRug(tk.security))) {
            return { ...plan, status: "stopped" as const, pendingSol: 0, pendingSince: 0 };
          }
          if (plan.chain) {
            if (plan.pendingSol >= 0.05) {
              if (now - plan.pendingSince > 28_000) return { ...plan, pendingSol: 0, pendingSince: 0 };
              return plan;
            }
            return { ...plan, pendingSol: plan.sol, pendingSince: now, nextAt: now + plan.intervalMs };
          }
          if (sol < plan.sol) return { ...plan, status: "stopped" as const };
          const sized = clipAuto(
            state.settings,
            { riskHalt, lossStreak, dayStart: state.dayStart, sol, positions, tokens },
            plan.tokenId,
            plan.sol,
          );
          if (sized.spend < 0.05) return { ...plan, nextAt: now + plan.intervalMs };
          const price = tk.price * (1 + fillSlip(state.settings) / 1000);
          const amount = sized.spend / price;
          sol -= sized.spend;
          positions = upsertBuy(positions, tk.id, amount, sized.spend, autoExits(state.settings));
          fills = [
            {
              id: uid("f"),
              ts: now,
              tokenId: tk.id,
              side: "buy" as const,
              sol: sized.spend,
              amount,
              price,
              source: "dca" as const,
            },
            ...fills,
          ].slice(0, 200);
          const sliceN = plan.done + 1;
          feed = pushFeed({ ...state, feed, now } as DeskState, {
            id: uid("feed"),
            ts: now,
            kind: "flow",
            tokenId: tk.id,
            side: "buy",
            text: `DCA ${sliceN}/${plan.slices} $${tk.symbol} · ${sized.spend.toFixed(2)} SOL`,
            textAr: `تجميع ${sliceN}/${plan.slices} $${tk.symbol} · ${sized.spend.toFixed(2)} SOL`,
          });
          const done = sliceN;
          if (done >= plan.slices) return { ...plan, done, status: "done" as const };
          return { ...plan, done, nextAt: now + plan.intervalMs };
        });

        {
          const stepped = tickLadders(ladders, {
            now,
            priceOf: (id) => tokens.find((t) => t.id === id)?.price ?? null,
            edgeOk: (id) => {
              const tk = tokens.find((t) => t.id === id);
              return !!tk && snipeEdge(tk, now) >= 0.35;
            },
            alive: (id) => {
              const tk = tokens.find((t) => t.id === id);
              return !!tk && tokenPasses(tk, state.settings);
            },
          });
          ladders = stepped.ladders;
          for (const note of stepped.notes) {
            const tk = tokens.find((t) => t.id === note.tokenId);
            const mark = tk ? `$${tk.symbol}` : "";
            feed = pushFeed({ ...state, feed, now } as DeskState, {
              id: uid("feed"),
              ts: now,
              kind: note.kind,
              tokenId: note.tokenId,
              text: `${mark} ${note.en}`.trim(),
              textAr: `${mark} ${note.ar}`.trim(),
            });
            if (note.kind === "risk") {
              alerts = pushAlert(
                alerts,
                {
                  id: uid("al"),
                  ts: now,
                  kind: "risk",
                  tokenId: note.tokenId,
                  text: `${mark} ${note.en}`.trim(),
                  textAr: `${mark} ${note.ar}`.trim(),
                },
                state.settings.radarRisk,
              );
            }
          }
          for (const slice of stepped.slices) {
            const tk = tokens.find((t) => t.id === slice.tokenId);
            if (!tk) continue;
            const lad = ladders.find((l) => l.tokenId === tk.id && (l.status === "live" || l.status === "done"));
            if (lad?.chain) continue;
            const sized = clipAuto(
              state.settings,
              { riskHalt, lossStreak, dayStart: state.dayStart, sol, positions, tokens },
              slice.tokenId,
              slice.sol,
            );
            if (sized.spend < 0.05) continue;
            const price = tk.price * (1 + fillSlip(state.settings) / 1000);
            const amount = sized.spend / price;
            sol -= sized.spend;
            positions = upsertBuy(positions, tk.id, amount, sized.spend, autoExits(state.settings));
            fills = [
              {
                id: uid("f"),
                ts: now,
                tokenId: tk.id,
                side: "buy" as const,
                sol: sized.spend,
                amount,
                price,
                source: slice.source,
              },
              ...fills,
            ].slice(0, 200);
            const live = ladders.find((l) => l.tokenId === tk.id && (l.status === "live" || l.status === "done"));
            const tag = slice.source === "twap" ? "TWAP" : "DCA down";
            const tagAr = slice.source === "twap" ? "TWAP" : "هبوط";
            const step =
              slice.source === "twap"
                ? `${live?.twapDone ?? 0}/${live?.twapNeed ?? 0}`
                : `${live?.dipDone ?? 0}/${live?.dipNeed ?? 0}`;
            feed = pushFeed({ ...state, feed, now } as DeskState, {
              id: uid("feed"),
              ts: now,
              kind: "flow",
              tokenId: tk.id,
              side: "buy",
              text: `${tag} ${step} $${tk.symbol} · ${sized.spend.toFixed(2)} SOL`,
              textAr: `${tagAr} ${step} $${tk.symbol} · ${sized.spend.toFixed(2)} SOL`,
            });
          }
        }

        const heldIds = new Set(positions.map((p) => p.tokenId));
        tokens = tokens.map((tk) => {
          const dumped = maybeDumpDev(tk, now, rng, heldIds.has(tk.id));
          if (!dumped) return tk;
          feed = pushFeed({ ...state, feed, now } as DeskState, {
            id: uid("feed"),
            ts: now,
            kind: "risk",
            tokenId: tk.id,
            side: "sell",
            text: `Dev sold $${tk.symbol}`,
            textAr: `باع المطوّر $${tk.symbol}`,
          });
          alerts = pushAlert(
            alerts,
            {
              id: uid("al"),
              ts: now,
              kind: "dev",
              tokenId: tk.id,
              side: "sell",
              text: `Dev sold $${tk.symbol}`,
              textAr: `باع المطوّر $${tk.symbol}`,
            },
            state.settings.radarDev,
          );
          const pos = positions.find((p) => p.tokenId === tk.id);
          if (pos?.devExit && pos.amount > 0) {
            const proceeds = pos.amount * dumped.price;
            const costCut = pos.costSol;
            sol += proceeds;
            realized += proceeds - costCut;
            lossStreak = nextStreak(lossStreak, proceeds - costCut);
            fills = [
              {
                id: uid("f"),
                ts: now,
                tokenId: tk.id,
                side: "sell" as const,
                sol: proceeds,
                amount: pos.amount,
                price: dumped.price,
                source: "dev" as const,
                pnl: proceeds - costCut,
              },
              ...fills,
            ].slice(0, 200);
            feed = pushFeed({ ...state, feed, now } as DeskState, {
              id: uid("feed"),
              ts: now,
              kind: "risk",
              tokenId: tk.id,
              side: "sell",
              text: `Dev exit $${tk.symbol} · ${proceeds.toFixed(2)} SOL`,
              textAr: `خروج المطوّر $${tk.symbol} · ${proceeds.toFixed(2)} SOL`,
            });
            alerts = pushAlert(
              alerts,
              {
                id: uid("al"),
                ts: now,
                kind: "dev",
                tokenId: tk.id,
                side: "sell",
                text: `Dev exit $${tk.symbol}`,
                textAr: `خروج المطوّر $${tk.symbol}`,
              },
              state.settings.radarDev,
            );
            positions = positions.filter((p) => p.tokenId !== tk.id);
          }
          return dumped;
        });

        const closed = applyExits({
          tokens,
          positions,
          fills,
          sol,
          realized,
          feed,
          alerts,
          now,
          radarStop: state.settings.radarStop,
          lossStreak,
        });
        if (state.settings.execLive) {
          chainExits = queueChainExits(chainExits, {
            now,
            priceOf: (id) => tokens.find((t) => t.id === id)?.price ?? null,
            holdAmt: (mint) => state.chainHoldings.find((h) => h.mint === mint)?.amount ?? 0,
            dumpOf: (id) => {
              const tk = tokens.find((t) => t.id === id);
              return !!tk && isLiveDump(tk, now);
            },
          });
        }

        const halted = applyHalt(
          state.settings,
          {
            riskHalt,
            lossStreak: closed.lossStreak,
            dayStart: state.dayStart,
            sol: closed.sol,
            positions: closed.positions,
            tokens,
          },
          closed.alerts,
          closed.feed,
          now,
        );

        set({
          now,
          tickN: state.tickN + 1,
          tokens,
          wallets,
          feed: halted.feed,
          fills: closed.fills,
          positions: closed.positions,
          sol: closed.sol,
          realized: closed.realized,
          limits,
          armedSnipes,
          recentMigrated,
          recentSniped,
          copyPending,
          dcaPlans,
          ladders,
          chainExits,
          snipeJobs,
          alerts: halted.alerts,
          lossStreak: closed.lossStreak,
          riskHalt: halted.riskHalt,
          liveOk: state.liveOk && now - state.liveAt < 45_000,
        });
      },
      tokenById: (id) => get().tokens.find((tkn) => tkn.id === id),
      equity: () => Math.max(0, get().chainSol ?? 0),
      msg: (key) => t("en", key),
    }),
    {
      name: "wick-desk-v1",
      skipHydration: true,
      storage: createJSONStorage(() => throttleStorage(2000)),
      partialize: (s) => ({
        locale: "en",
        liveFills: s.liveFills.slice(0, 24),
        chainExits: s.chainExits.slice(0, 24).map((e) => ({
          ...e,
          pendingFrac: 0,
          pendingKind: null,
          pendingSince: 0,
        })),
        limits: s.limits.filter((o) => o.status === "open").slice(0, 24),
        copyRules: s.copyRules.filter((r) => isFollowId(r.walletId)),
        follows: s.follows.slice(0, MAX_FOLLOWS),
        followCursor: s.followCursor,
        dcaPlans: s.dcaPlans.filter((p) => p.status === "live"),
        ladders: s.ladders.filter((l) => l.status === "live").slice(0, 12),
        watch: s.watch,
        armedSnipes: s.armedSnipes,
        settings: { ...s.settings, execLive: true, liveOn: true },
        kols: s.kols.map((k) => ({ id: k.id, tracked: k.tracked, tradeOn: false })),
        walletPk: s.hotVault?.pub ?? null,
        watchPk: s.watchPk && s.watchPk !== s.hotVault?.pub ? s.watchPk : null,
        hotVault: s.hotVault,
        riskHalt: s.riskHalt,
        lossStreak: s.lossStreak,
        dayStart: s.dayStart,
        tokens: slimHeld(s.tokens, [
          ...s.positions.map((p) => p.tokenId),
          ...s.watch,
          ...s.armedSnipes,
          ...s.ladders.filter((l) => l.status === "live").map((l) => l.tokenId),
          ...s.chainHoldings.map((h) => h.mint),
        ]),
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<DeskState>;
        return {
          ...current,
          locale: "en",
          intro: false,
          sol: 0,
          realized: 0,
          positions: [],
          fills: [],
          liveFills: slimLiveFills(p.liveFills),
          chainExits: Array.isArray(p.chainExits)
            ? p.chainExits.map(slimChainExit).filter((e): e is ChainExit => !!e).slice(0, 24)
            : current.chainExits,
          limits: Array.isArray(p.limits)
            ? p.limits
                .filter(
                  (o) =>
                    o &&
                    typeof o.tokenId === "string" &&
                    (o.side === "buy" || o.side === "sell") &&
                    Number.isFinite(o.triggerMc) &&
                    Number.isFinite(o.sol),
                )
                .slice(0, 40)
            : current.limits,
          copyRules: Array.isArray(p.copyRules)
            ? p.copyRules.map((r) => normalizeCopy(r))
            : current.copyRules,
          follows: Array.isArray(p.follows)
            ? p.follows.map(slimFollow).filter((f): f is Follow => !!f).slice(0, MAX_FOLLOWS)
            : current.follows,
          followCursor:
            p.followCursor && typeof p.followCursor === "object"
              ? Object.fromEntries(
                  Object.entries(p.followCursor as Record<string, unknown>)
                    .filter((e): e is [string, string] => isB58(e[0]) && typeof e[1] === "string" && isSig(e[1]))
                    .slice(0, MAX_FOLLOWS),
                )
              : current.followCursor,
          copyPending: Array.isArray(p.copyPending)
            ? p.copyPending
                .filter((x) => x && typeof x.tokenId === "string" && typeof x.walletId === "string")
                .slice(0, 24)
            : current.copyPending,
          dcaPlans: Array.isArray(p.dcaPlans)
            ? p.dcaPlans
                .filter((d) => d && typeof d.tokenId === "string" && d.status === "live")
                .slice(0, 12)
                .map((d) => ({
                  ...d,
                  chain: d.chain === true,
                  pendingSol: 0,
                  pendingSince: 0,
                }))
            : current.dcaPlans,
          ladders: Array.isArray(p.ladders)
            ? p.ladders
                .filter((l) => l && typeof l.tokenId === "string" && l.status === "live")
                .slice(0, 12)
                .map((l) => ({
                  ...l,
                  chain: l.chain === true,
                  pendingSol: 0,
                  pendingSrc: null,
                  pendingSince: 0,
                }))
            : current.ladders,
          watch: slimIds(p.watch, current.watch),
          armedSnipes: slimIds(p.armedSnipes, current.armedSnipes),
          settings: {
            ...current.settings,
            ...sanitizeDesk({
              ...current.settings,
              ...(p.settings ?? {}),
              chain: "sol",
              snipeMigrate: p.settings?.snipeMigrate ?? true,
              snipeLaunch: p.settings?.snipeLaunch ?? false,
              radarLaunch: p.settings?.radarLaunch ?? true,
              radarMigrate: p.settings?.radarMigrate ?? true,
              radarSmart: p.settings?.radarSmart ?? true,
              radarStop: p.settings?.radarStop ?? true,
              radarDev: p.settings?.radarDev ?? true,
              devExit: p.settings?.devExit ?? true,
              socialSol: typeof p.settings?.socialSol === "number" ? p.settings.socialSol : 0.5,
              socialNoStack: p.settings?.socialNoStack ?? true,
              radarSocial: p.settings?.radarSocial ?? true,
              liveOn: true,
              guardMint: p.settings?.guardMint ?? true,
              ladderOn: p.settings?.ladderOn ?? true,
              execLive: true,
              snipeLive: p.settings?.snipeLive === true,
              riskOn: p.settings?.riskOn ?? true,
              maxTradeSol: typeof p.settings?.maxTradeSol === "number" ? p.settings.maxTradeSol : 2,
              maxBookPct: typeof p.settings?.maxBookPct === "number" ? p.settings.maxBookPct : 40,
              maxPositions: typeof p.settings?.maxPositions === "number" ? p.settings.maxPositions : 6,
              maxDayLoss: typeof p.settings?.maxDayLoss === "number" ? p.settings.maxDayLoss : 15,
              streakHalt: typeof p.settings?.streakHalt === "number" ? p.settings.streakHalt : 3,
              maxCluster: typeof p.settings?.maxCluster === "number" ? p.settings.maxCluster : 2,
              radarRisk: p.settings?.radarRisk ?? true,
              maxMc: typeof p.settings?.maxMc === "number" ? p.settings.maxMc : 0,
              minHolders: typeof p.settings?.minHolders === "number" ? p.settings.minHolders : 0,
              maxAgeMin: typeof p.settings?.maxAgeMin === "number" ? p.settings.maxAgeMin : 0,
              skipFraud: p.settings?.skipFraud === true,
              minGrade: typeof p.settings?.minGrade === "string" ? p.settings.minGrade : "",
              sieve: typeof p.settings?.sieve === "string" ? p.settings.sieve : "",
            }),
            chain: "sol",
          },
          tokens: (() => {
            const byId = new Map(current.tokens.map((t) => [t.id, t]));
            if (Array.isArray(p.tokens)) {
              for (const t of p.tokens) {
                if (!t?.id || typeof t.id !== "string" || t.id.length > 48) continue;
                if (byId.has(t.id)) continue;
                byId.set(t.id, {
                  ...t,
                  symbol: sanitizeLabel(t.symbol, 12) || "???",
                  name: sanitizeLabel(t.name, 28) || "???",
                  candles: Array.isArray(t.candles) ? t.candles.slice(-8) : [],
                });
              }
            }
            return [...byId.values()];
          })(),
          feed: [],
          now: Date.now(),
          wallets: current.wallets.map((w) => {
            const saved = p.wallets?.find((x) => x.id === w.id);
            return saved ? { ...w, tracked: saved.tracked } : w;
          }),
          kols: current.kols.map((k) => {
            const saved = p.kols?.find((x) => x.id === k.id);
            return saved ? { ...k, tracked: saved.tracked, tradeOn: !!saved.tradeOn } : k;
          }),
          walletPk: slimVault(p.hotVault)?.pub ?? null,
          walletInjected: false,
          watchPk: (() => {
            const hot = slimVault(p.hotVault)?.pub;
            const saved = typeof p.walletPk === "string" && isB58(p.walletPk) ? p.walletPk : null;
            const watch = typeof p.watchPk === "string" && isB58(p.watchPk) ? p.watchPk : null;
            if (watch && watch !== hot) return watch;
            if (saved && saved !== hot) return saved;
            return null;
          })(),
          hotVault: slimVault(p.hotVault),
          hotUnlocked: false,
          chainSol: null,
          chainHoldings: [],
          chainBagAt: 0,
          chainTokensOk: true,
          chainTape: [],
          riskHalt: false,
          lossStreak: 0,
          dayStart: 0,
        };
      },
    },
  ),
);

export { tokenPasses, filteredTokens, activeFilterCount, FILTER_PRESETS } from "./sieve";
