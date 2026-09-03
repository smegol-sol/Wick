import { hashString, mulberry32 } from "./format";

export type Chain = "sol";
export type Stage = "new" | "bonding" | "migrated";
export type Side = "buy" | "sell";
export type FillSource = "manual" | "copy" | "limit" | "snipe" | "tp" | "sl" | "trail" | "dev" | "dca" | "social" | "twap";
export type FeedKind = "smart" | "social" | "snipe" | "risk" | "flow";
export type Hands = "steel" | "firm" | "paper";

export interface Security {
  mintable: boolean;
  freeze: boolean;
  lpBurned: boolean;
  honeypot: boolean;
  renounced: boolean;
  top10: number;
  bundled: number;
  insiders: number;
  snipers: number;
  devHold: number;
  onchain?: boolean;
}

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Token {
  id: string;
  mint: string;
  symbol: string;
  name: string;
  chain: Chain;
  stage: Stage;
  createdAt: number;
  price: number;
  mc: number;
  liq: number;
  vol: number;
  vol1m: number;
  vol5m: number;
  holders: number;
  tx: number;
  change1m: number;
  change5m: number;
  bonding: number;
  mentions: number;
  twitter: string | null;
  security: Security;
  candles: Candle[];
  supply: number;
  lastDevSell: number;
  live?: boolean;
}

export interface Wallet {
  id: string;
  name: string;
  handle: string;
  winRate: number;
  pnl30: number;
  trades: number;
  dumpRate: number;
  holdMin: number;
  grade: number;
  hands: Hands;
  lastTokenId: string | null;
  lastSide: Side | null;
  lastTs: number;
  tracked: boolean;
}

export interface Kol {
  id: string;
  handle: string;
  name: string;
  tracked: boolean;
  tradeOn: boolean;
}

export interface FeedItem {
  id: string;
  ts: number;
  kind: FeedKind;
  text: string;
  textAr: string;
  tokenId?: string;
  walletId?: string;
  side?: Side;
}

export interface Holder {
  label: string;
  pct: number;
  kind: "dev" | "sniper" | "insider" | "lp" | "desk" | "other";
}

export interface Print {
  id: string;
  ts: number;
  side: Side;
  sol: number;
  price: number;
  wallet?: string;
  walletId?: string;
}

const NAMES: Array<[string, string]> = [
  ["MOSS", "Moss"],
  ["HUSK", "Husk"],
  ["RILL", "Rill"],
  ["PLANK", "Plank"],
  ["CINDER", "Cinder"],
  ["QUILL", "Quill"],
  ["TARN", "Tarn"],
  ["BRINE", "Brine"],
  ["LOOM", "Loom"],
  ["WISP", "Wisp"],
  ["GRAIN", "Grain"],
  ["HITCH", "Hitch"],
  ["SABLE", "Sable"],
  ["KITE", "Kite"],
  ["FATHOM", "Fathom"],
  ["SPORE", "Spore"],
  ["VEIL", "Veil"],
  ["DUSK", "Dusk"],
  ["AXLE", "Axle"],
  ["RIDGE", "Ridge"],
  ["MARL", "Marl"],
  ["CORK", "Cork"],
  ["GNAT", "Gnat"],
  ["KELP", "Kelp"],
  ["LINT", "Lint"],
  ["PITH", "Pith"],
  ["SHALE", "Shale"],
  ["THORN", "Thorn"],
];

const WALLET_SEED: Array<[string, string, string]> = [
  ["glass", "Glass Whale", "glass.sol"],
  ["night", "Night Desk", "nightdesk"],
  ["copper", "Copper Bot", "copperbot"],
  ["kiln", "Kiln", "kiln_w"],
  ["brim", "Brim Stack", "brimstack"],
  ["quiet", "Quiet Hand", "quiethand"],
  ["marrow", "Marrow", "marrow_sol"],
  ["lumen", "Lumen Lot", "lumenlot"],
];

const KOL_SEED: Array<[string, string, string]> = [
  ["desknotes", "@desknotes", "Desk Notes"],
  ["tapeop", "@tapeop", "Tape Op"],
  ["hollowchart", "@hollowchart", "Hollow Chart"],
  ["dryink", "@dryink", "Dry Ink"],
];

const TWEETS: Array<[string, string]> = [
  ["charting $TOKEN — liquidity is holding the first shelf", "أراجع $TOKEN — السيولة تمسك الرف الأول"],
  ["$TOKEN bundle looks thin. watching the next print", "حزم $TOKEN خفيفة. أراقب الطباعة التالية"],
  ["rotation into $TOKEN from the night desk cluster", "دوران إلى $TOKEN من عنقود المكتب الليلي"],
  ["$TOKEN social is catching up to flow. still early", "اجتماعي $TOKEN يلحق التدفق. ما زال مبكراً"],
  ["would not chase $TOKEN here — wait for the dip print", "لن ألحق $TOKEN هنا — انتظر طبعة الهبوط"],
];

export function scoreWallet(id: string, winRate: number, pnl30: number, trades: number) {
  const h = hashString(id);
  const dumpRate = Math.max(6, Math.min(88, (100 - winRate) * 0.85 + (h % 22)));
  const holdMin = 3 + (h % 80);
  const grade = Math.round(
    Math.max(
      8,
      Math.min(
        96,
        winRate * 0.42 +
          Math.max(0, Math.min(100, (pnl30 + 120) / 6)) * 0.18 +
          (100 - dumpRate) * 0.28 +
          Math.min(trades, 200) * 0.04 +
          Math.min(holdMin, 50) * 0.12,
      ),
    ),
  );
  const hands: Hands = grade >= 70 && dumpRate < 32 ? "steel" : grade >= 50 ? "firm" : "paper";
  return { dumpRate, holdMin, grade, hands };
}

export function fakeMint(seed: string): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const rng = mulberry32(hashString(seed));
  let out = "";
  for (let i = 0; i < 44; i++) out += alphabet[Math.floor(rng() * alphabet.length)];
  return out;
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function pickCandleHistory(rng: () => number, price: number, now: number): Candle[] {
  const candles: Candle[] = [];
  let p = price * (0.55 + rng() * 0.5);
  for (let i = 80; i >= 0; i--) {
    const t = now - i * 60_000;
    const o = p;
    const drift = (rng() - 0.48) * p * 0.06;
    const c = Math.max(p * 0.2, o + drift);
    const h = Math.max(o, c) * (1 + rng() * 0.03);
    const l = Math.min(o, c) * (1 - rng() * 0.03);
    const v = 2 + rng() * 40;
    candles.push({ t, o, h, l, c, v });
    p = c;
  }
  return candles;
}

function makeSecurity(rng: () => number, stage: Stage): Security {
  const risky = rng() > 0.72;
  return {
    mintable: risky && rng() > 0.45,
    freeze: risky && rng() > 0.55,
    lpBurned: stage === "migrated" ? rng() > 0.25 : rng() > 0.55,
    honeypot: rng() > 0.92,
    renounced: rng() > 0.4,
    top10: clamp(18 + rng() * 55, 12, 88),
    bundled: rng() * (risky ? 42 : 18),
    insiders: rng() * (risky ? 28 : 12),
    snipers: rng() * 22,
    devHold: rng() * (risky ? 18 : 8),
  };
}

export function riskScore(sec: Security): number {
  let s = 0;
  if (sec.honeypot) s += 45;
  if (sec.mintable) s += 18;
  if (sec.freeze) s += 12;
  if (!sec.lpBurned) s += 10;
  if (!sec.renounced) s += 8;
  if (sec.top10 > 40) s += 8;
  if (sec.bundled > 20) s += 8;
  if (sec.devHold > 10) s += 6;
  return clamp(s, 0, 100);
}

export function isRug(sec: Security): boolean {
  return sec.honeypot || (sec.mintable && sec.freeze && !sec.lpBurned);
}

function makeToken(index: number, now: number, forced?: Partial<Token>): Token {
  const [symbol, name] = NAMES[index % NAMES.length];
  const rng = mulberry32(hashString(`${symbol}-${index}`));
  const chain: Chain = "sol";
  const stage: Stage = index % 3 === 0 ? "bonding" : index % 3 === 1 ? "migrated" : "new";
  const bonding = stage === "new" ? rng() * 35 : stage === "bonding" ? (index % 6 === 0 ? 88 + rng() * 9 : 52 + rng() * 20) : 100;
  const mc =
    stage === "new"
      ? 4_000 + rng() * 28_000
      : stage === "bonding"
        ? 22_000 + rng() * 90_000
        : 80_000 + rng() * 1_800_000;
  const supply = 1_000_000_000;
  const price = mc / supply;
  const candles = pickCandleHistory(rng, price, now);
  const last = candles[candles.length - 1]?.c ?? price;
  return {
    id: `${symbol.toLowerCase()}-${index}`,
    mint: fakeMint(`${symbol}-${index}`),
    symbol,
    name,
    chain,
    stage,
    createdAt: now - Math.floor(rng() * (stage === "migrated" ? 36e5 * 18 : stage === "bonding" ? 36e5 : 12 * 60_000)),
    price: last,
    mc: last * supply,
    liq: mc * (0.08 + rng() * 0.35),
    vol: mc * (0.15 + rng() * 1.4),
    vol1m: mc * (0.01 + rng() * 0.08),
    vol5m: mc * (0.04 + rng() * 0.2),
    holders: Math.floor(20 + rng() * (stage === "migrated" ? 2400 : 280)),
    tx: Math.floor(10 + rng() * (stage === "migrated" ? 8000 : 400)),
    change1m: (rng() - 0.45) * 28,
    change5m: (rng() - 0.4) * 62,
    bonding,
    mentions: Math.floor(rng() * (stage === "migrated" ? 90 : 18)),
    twitter: rng() > 0.35 ? `@${symbol.toLowerCase()}desk` : null,
    security: makeSecurity(rng, stage),
    candles,
    supply,
    lastDevSell: 0,
    live: false,
    ...forced,
  };
}

export function seedWorld(now = Date.now()): { tokens: Token[]; wallets: Wallet[]; kols: Kol[] } {
  const tokens = NAMES.slice(0, 24).map((_, i) => makeToken(i, now));
  const wallets: Wallet[] = WALLET_SEED.map(([id, name, handle], i) => {
    const rng = mulberry32(hashString(id));
    const winRate = 48 + rng() * 32;
    const pnl30 = (rng() - 0.25) * 420;
    const trades = 40 + Math.floor(rng() * 380);
    const scored = scoreWallet(id, winRate, pnl30, trades);
    const forced =
      i === 0
        ? { dumpRate: 14, holdMin: 52, grade: 84, hands: "steel" as const }
        : i >= 5
          ? { dumpRate: 62 + i, holdMin: 5 + i, grade: 28 + i, hands: "paper" as const }
          : scored;
    return {
      id,
      name,
      handle,
      winRate,
      pnl30,
      trades,
      ...forced,
      lastTokenId: tokens[i % tokens.length]?.id ?? null,
      lastSide: rng() > 0.4 ? ("buy" as const) : ("sell" as const),
      lastTs: now - Math.floor(rng() * 180_000),
      tracked: i < 3,
    };
  });
  const kols: Kol[] = KOL_SEED.map(([id, handle, name], i) => ({
    id,
    handle,
    name,
    tracked: i < 2,
    tradeOn: false,
  }));
  return { tokens, wallets, kols };
}

export function tokenHolders(token: Token): Holder[] {
  const rng = mulberry32(hashString(token.id + "h"));
  const lp = clamp(token.liq / Math.max(token.mc, 1), 0.05, 0.42);
  const dev = token.security.devHold / 100;
  const sniper = token.security.snipers / 100;
  const insider = token.security.insiders / 100;
  const rest = Math.max(0.05, 1 - lp - dev - sniper - insider);
  const desks = rest * (0.25 + rng() * 0.3);
  const other = rest - desks;
  return [
    { label: "LP", pct: lp * 100, kind: "lp" },
    { label: "Dev", pct: dev * 100, kind: "dev" },
    { label: "Snipers", pct: sniper * 100, kind: "sniper" },
    { label: "Insiders", pct: insider * 100, kind: "insider" },
    { label: "Desks", pct: desks * 100, kind: "desk" },
    { label: "Scattered", pct: other * 100, kind: "other" },
  ];
}

export function tokenPrints(token: Token, now: number): Print[] {
  const rng = mulberry32(hashString(token.id + "p") ^ Math.floor(now / 4000));
  const prints: Print[] = [];
  for (let i = 0; i < 18; i++) {
    const side: Side = rng() > 0.46 ? "buy" : "sell";
    const seed = WALLET_SEED[Math.floor(rng() * WALLET_SEED.length)];
    const tagged = rng() > 0.55;
    prints.push({
      id: `${token.id}-p-${i}`,
      ts: now - i * (4000 + rng() * 8000),
      side,
      sol: 0.05 + rng() * (side === "buy" ? 4 : 2.2),
      price: token.price * (1 + (rng() - 0.5) * 0.04),
      wallet: tagged ? seed[1] : undefined,
      walletId: tagged ? seed[0] : undefined,
    });
  }
  return prints;
}

function nearestCandle(token: Token, ts: number): Candle | undefined {
  const list = token.candles;
  if (!list.length) return undefined;
  let best = list[0];
  let bestD = Math.abs(list[0].t - ts);
  for (const c of list) {
    const d = Math.abs(c.t - ts);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

export function tokenSmartFlow(token: Token, wallets: Wallet[]): Print[] {
  if (!token.candles.length || !wallets.length) return [];
  const t0 = token.candles[0].t;
  const tN = token.candles[token.candles.length - 1].t;
  const span = Math.max(1, tN - t0);
  const out: Print[] = [];
  for (const w of wallets) {
    const aff = hashString(`${token.id}:${w.id}`) % 100;
    if (!w.tracked && aff > 42) continue;
    if (w.tracked && aff > 92) continue;
    const n = w.tracked ? 2 + (hashString(w.id + token.id) % 3) : 1;
    for (let k = 0; k < n; k++) {
      const frac = ((hashString(`${token.id}|${w.id}|${k}`) % 900) + 40) / 1000;
      const c = nearestCandle(token, t0 + frac * span);
      if (!c) continue;
      const buyBias = w.tracked ? 6 : 5;
      const side: Side = hashString(w.id + token.id + String(k)) % 10 < buyBias ? "buy" : "sell";
      const price = side === "buy" ? c.l + Math.max(0, c.c - c.l) * 0.28 : c.h - Math.max(0, c.h - c.c) * 0.28;
      out.push({
        id: `sm-${token.id}-${w.id}-${k}`,
        ts: c.t,
        side,
        sol: 0.4 + (hashString(w.id + token.symbol + String(k)) % 70) / 10,
        price,
        wallet: w.name,
        walletId: w.id,
      });
    }
    if (w.tracked && w.lastTokenId === token.id && w.lastSide && w.lastTs) {
      const c = nearestCandle(token, w.lastTs) ?? token.candles[token.candles.length - 1];
      out.push({
        id: `sm-live-${token.id}-${w.id}`,
        ts: c.t,
        side: w.lastSide,
        sol: 0.8 + (hashString(w.id) % 40) / 10,
        price: w.lastSide === "buy" ? c.l * 1.002 : c.h * 0.998,
        wallet: w.name,
        walletId: w.id,
      });
    }
  }
  const seen = new Set<string>();
  return out.filter((p) => {
    const key = `${p.walletId}:${p.ts}:${p.side}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

let nextName = 24;

export function spawnToken(now: number): Token {
  return makeToken(nextName++, now, {
    stage: "new",
    createdAt: now,
    bonding: 1 + Math.random() * 8,
    chain: "sol",
  });
}

export function nextTweet(token: Token, pick = Math.random()): { en: string; ar: string; chase: boolean } {
  const i = Math.min(TWEETS.length - 1, Math.floor(pick * TWEETS.length));
  const [en, ar] = TWEETS[i];
  return {
    en: en.replaceAll("$TOKEN", `$${token.symbol}`),
    ar: ar.replaceAll("$TOKEN", `$${token.symbol}`),
    chase: i !== 4,
  };
}

export function tickToken(token: Token, now: number, rng: () => number): Token {
  if (token.live) return token;
  const shock = rng() > 0.97 ? (rng() - 0.4) * 0.22 : (rng() - 0.48) * 0.035;
  const nextPrice = Math.max(token.price * 0.15, token.price * (1 + shock));
  const mc = nextPrice * token.supply;
  const last = token.candles[token.candles.length - 1];
  let candles = token.candles;
  if (!last || now - last.t > 60_000) {
    candles = [
      ...token.candles.slice(-79),
      {
        t: now,
        o: last?.c ?? nextPrice,
        h: Math.max(last?.c ?? nextPrice, nextPrice),
        l: Math.min(last?.c ?? nextPrice, nextPrice),
        c: nextPrice,
        v: 1 + rng() * 20,
      },
    ];
  } else {
    candles = token.candles.map((c, i) =>
      i === token.candles.length - 1
        ? { ...c, h: Math.max(c.h, nextPrice), l: Math.min(c.l, nextPrice), c: nextPrice, v: c.v + rng() * 4 }
        : c,
    );
  }
  let stage = token.stage;
  let bonding = token.bonding;
  if (stage === "new") {
    bonding = clamp(bonding + rng() * 4.5, 0, 100);
    if (bonding >= 42) stage = "bonding";
  } else if (stage === "bonding") {
    const accel = bonding >= 90 ? 4.2 : 1.6;
    bonding = clamp(bonding + rng() * accel, 0, 100);
    if (bonding >= 100) {
      stage = "migrated";
      bonding = 100;
    }
  }
  const change1m = clamp(token.change1m * 0.7 + shock * 100, -80, 180);
  const change5m = clamp(token.change5m * 0.85 + shock * 40, -90, 260);
  return {
    ...token,
    price: nextPrice,
    mc,
    vol: token.vol + Math.abs(shock) * mc * 0.08,
    vol1m: Math.abs(shock) * mc * 0.4 + token.vol1m * 0.7,
    vol5m: Math.abs(shock) * mc * 0.7 + token.vol5m * 0.85,
    liq: clamp(token.liq * (1 + (rng() - 0.5) * 0.01), mc * 0.04, mc * 0.6),
    holders: token.holders + (rng() > 0.7 ? 1 : 0),
    tx: token.tx + Math.floor(rng() * 4),
    change1m,
    change5m,
    bonding,
    stage,
    candles,
    mentions: token.mentions + (rng() > 0.92 ? 1 : 0),
  };
}

export function maybeDumpDev(token: Token, now: number, rng: () => number, held: boolean): Token | null {
  if (token.live) return null;
  if (token.security.devHold < 2.5) return null;
  if (token.lastDevSell && now - token.lastDevSell < 16_000) return null;
  const chance = (held ? 0.08 : 0.01) + token.security.devHold * 0.002;
  if (rng() > chance) return null;
  const cut = 0.09 + rng() * 0.16;
  const nextPrice = Math.max(token.price * 0.12, token.price * (1 - cut));
  const last = token.candles[token.candles.length - 1];
  const candles = last
    ? token.candles.map((c, i) =>
        i === token.candles.length - 1
          ? { ...c, l: Math.min(c.l, nextPrice), c: nextPrice, v: c.v + 10 + rng() * 14 }
          : c,
      )
    : token.candles;
  return {
    ...token,
    price: nextPrice,
    mc: nextPrice * token.supply,
    change1m: clamp(token.change1m - cut * 110, -80, 180),
    change5m: clamp(token.change5m - cut * 80, -90, 260),
    lastDevSell: now,
    candles,
    security: {
      ...token.security,
      devHold: Math.max(0.3, token.security.devHold * (0.22 + rng() * 0.28)),
    },
  };
}

export function mergeLiveToken(prev: Token | undefined, next: Token, now: number): Token {
  if (!prev) return next;
  const last = prev.candles[prev.candles.length - 1];
  const px = next.price;
  let candles = prev.candles;
  if (!last || now - last.t > 60_000) {
    candles = [
      ...prev.candles.slice(-79),
      {
        t: now,
        o: last?.c ?? px,
        h: Math.max(last?.c ?? px, px),
        l: Math.min(last?.c ?? px, px),
        c: px,
        v: 1 + (hashString(`${next.id}:${now}`) % 16),
      },
    ];
  } else {
    candles = prev.candles.map((c, i) =>
      i === prev.candles.length - 1 ? { ...c, h: Math.max(c.h, px), l: Math.min(c.l, px), c: px, v: c.v + 1 } : c,
    );
  }
  const prevPx = prev.price || px;
  const chg = prevPx > 0 ? ((px - prevPx) / prevPx) * 100 : 0;
  return {
    ...next,
    candles,
    lastDevSell: prev.lastDevSell,
    security: next.security.onchain || !prev.security.onchain ? next.security : prev.security,
    change1m: chg,
    change5m: clamp(prev.change5m * 0.7 + chg * 0.3, -90, 260),
  };
}
