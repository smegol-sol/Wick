/**
 * Pair stats from DexScreener (no key, 300 req/min). Volume, transaction
 * counts, price change and liquidity are the venue's own numbers; anything
 * the venue has not indexed yet comes back absent and stays `null`.
 */
import { isB58, lruSet } from "./guard";

export type DexStats = {
  pair: string;
  priceUsd: number | null;
  mc: number | null;
  liqUsd: number | null;
  vol24: number | null;
  vol5m: number | null;
  tx24: number | null;
  buys5m: number | null;
  sells5m: number | null;
  change5m: number | null;
  change1h: number | null;
  at: number;
};

type DexPair = {
  chainId?: string;
  pairAddress?: string;
  baseToken?: { address?: string };
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  volume?: { m5?: number; h24?: number };
  txns?: { m5?: { buys?: number; sells?: number }; h24?: { buys?: number; sells?: number } };
  priceChange?: { m5?: number; h1?: number };
};

const API = "https://api.dexscreener.com/tokens/v1/solana/";
const TTL = 10_000;
const BATCH = 30;
const cache = new Map<string, DexStats>();
const missing = new Map<string, number>();

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function pickPair(rows: DexPair[]): Map<string, DexPair> {
  const best = new Map<string, DexPair>();
  for (const p of rows) {
    const mint = p.baseToken?.address;
    if (!mint || p.chainId !== "solana" || !isB58(mint)) continue;
    const cur = best.get(mint);
    if (!cur || (p.liquidity?.usd ?? 0) > (cur.liquidity?.usd ?? 0)) best.set(mint, p);
  }
  return best;
}

async function fetchBatch(mints: string[], signal: AbortSignal): Promise<DexPair[]> {
  const res = await fetch(API + mints.join(","), {
    signal,
    headers: { accept: "application/json", "user-agent": "WICK/1" },
    redirect: "error",
  });
  if (!res.ok) return [];
  const data = (await res.json()) as unknown;
  return Array.isArray(data) ? (data as DexPair[]) : [];
}

export async function fetchDexStats(
  mints: string[],
  signal: AbortSignal,
): Promise<Map<string, DexStats>> {
  const out = new Map<string, DexStats>();
  const now = Date.now();
  const need: string[] = [];
  for (const mint of mints) {
    if (!isB58(mint)) continue;
    const hit = cache.get(mint);
    if (hit && now - hit.at < TTL) {
      out.set(mint, hit);
      continue;
    }
    const miss = missing.get(mint);
    if (miss && now - miss < TTL * 3) continue;
    need.push(mint);
  }
  for (let i = 0; i < need.length; i += BATCH) {
    if (signal.aborted) break;
    const slice = need.slice(i, i + BATCH);
    let rows: DexPair[] = [];
    try {
      rows = await fetchBatch(slice, signal);
    } catch {
      continue;
    }
    const best = pickPair(rows);
    for (const mint of slice) {
      const p = best.get(mint);
      if (!p?.pairAddress) {
        missing.set(mint, Date.now());
        continue;
      }
      const stats: DexStats = {
        pair: p.pairAddress,
        priceUsd: num(p.priceUsd),
        mc: num(p.marketCap) ?? num(p.fdv),
        liqUsd: num(p.liquidity?.usd),
        vol24: num(p.volume?.h24),
        vol5m: num(p.volume?.m5),
        tx24: p.txns?.h24 ? (num(p.txns.h24.buys) ?? 0) + (num(p.txns.h24.sells) ?? 0) : null,
        buys5m: num(p.txns?.m5?.buys),
        sells5m: num(p.txns?.m5?.sells),
        change5m: num(p.priceChange?.m5),
        change1h: num(p.priceChange?.h1),
        at: Date.now(),
      };
      lruSet(cache, mint, stats, 800);
      missing.delete(mint);
      out.set(mint, stats);
    }
  }
  if (missing.size > 2000) {
    for (const [k, at] of missing) if (Date.now() - at > TTL * 6) missing.delete(k);
  }
  return out;
}
