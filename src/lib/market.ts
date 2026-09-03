/**
 * Market model. Every token here is a real Solana mint read from pump.fun,
 * DexScreener and the chain. A field is `null` when no source reported it;
 * the UI renders that as "n/a" and filters treat it as "unknown", never as 0.
 */

export type Chain = "sol";
export type Stage = "new" | "bonding" | "migrated";
export type Side = "buy" | "sell";
export type FillSource = "manual" | "copy" | "limit" | "snipe" | "tp" | "sl" | "trail" | "dev" | "dca" | "twap";
export type FeedKind = "smart" | "snipe" | "risk" | "flow";

export interface Security {
  /** Mint authority still set (supply can be inflated). */
  mintable: boolean;
  /** Freeze authority still set (holders can be frozen). */
  freeze: boolean;
  /** Bonding curve completed and LP created by pump.fun (locked). */
  lpBurned: boolean;
  /** Both authorities revoked. */
  renounced: boolean;
  /** Share of supply held by the top 10 accounts, from getTokenLargestAccounts. */
  top10: number | null;
  /** True once mint/freeze were read from the mint account itself. */
  onchain: boolean;
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
  /** Pool liquidity in USD. */
  liq: number;
  /** 24h volume, USD. */
  vol: number | null;
  /** 5 minute volume, USD. */
  vol5m: number | null;
  /** 24h transaction count. */
  tx: number | null;
  buys5m: number | null;
  sells5m: number | null;
  holders: number | null;
  /** Price change since the previous pulse poll (seconds), percent. */
  change1m: number;
  /** 5 minute change, percent. DexScreener when available, else an EMA of poll deltas. */
  change5m: number;
  /** 1 hour change, percent. */
  change1h: number | null;
  bonding: number;
  /** pump.fun reply count. The only social signal we have. */
  mentions: number;
  twitter: string | null;
  security: Security;
  candles: Candle[];
  supply: number;
  /** Where the volume/tx stats came from, null when none reported. */
  statsAt: number | null;
  pair: string | null;
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

/** A swap by a followed wallet on a mint, derived from its on-chain tape. */
export interface Print {
  id: string;
  ts: number;
  side: Side;
  sol: number;
  /** USD per token implied by the swap, 0 when unknown. */
  price: number;
  mint: string;
  wallet?: string;
  walletId?: string;
}

export interface TopHolder {
  address: string;
  amount: number;
  pct: number;
}

export interface HolderInfo {
  mint: string;
  at: number;
  holders: number | null;
  top10: number | null;
  top: TopHolder[];
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

/** 0 = clean, 100 = avoid. Only on-chain facts count. */
export function riskScore(sec: Security): number {
  let s = 0;
  if (sec.onchain) {
    if (sec.freeze) s += 45;
    if (sec.mintable) s += 22;
  }
  if (!sec.lpBurned) s += 8;
  if (!sec.renounced) s += 6;
  if (sec.top10 != null && sec.top10 > 40) s += 12;
  return clamp(s, 0, 100);
}

/** A token that can freeze holders is treated as a rug for filtering. */
export function isRug(sec: Security): boolean {
  return sec.onchain && sec.freeze;
}

export function mergeLiveToken(prev: Token | undefined, next: Token, now: number): Token {
  if (!prev) return next;
  const last = prev.candles[prev.candles.length - 1];
  const px = next.price;
  let candles = prev.candles;
  if (!last || now - last.t > 60_000) {
    candles = [
      ...prev.candles.slice(-119),
      { t: now, o: last?.c ?? px, h: Math.max(last?.c ?? px, px), l: Math.min(last?.c ?? px, px), c: px, v: 0 },
    ];
  } else {
    candles = prev.candles.map((c, i) =>
      i === prev.candles.length - 1 ? { ...c, h: Math.max(c.h, px), l: Math.min(c.l, px), c: px } : c,
    );
  }
  const prevPx = prev.price || px;
  const chg = prevPx > 0 ? ((px - prevPx) / prevPx) * 100 : 0;
  const change5m = next.statsAt != null ? next.change5m : clamp(prev.change5m * 0.7 + chg * 0.3, -95, 500);
  return {
    ...next,
    candles,
    security: next.security.onchain || !prev.security.onchain ? { ...next.security, top10: next.security.top10 ?? prev.security.top10 } : prev.security,
    holders: next.holders ?? prev.holders,
    change1m: chg,
    change5m,
  };
}
