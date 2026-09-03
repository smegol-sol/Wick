/**
 * Live pulse: pump.fun launches and migrations, enriched with DexScreener
 * pair stats and mint/freeze authority read from the chain.
 *
 * pump.fun's frontend API is unofficial and can be blocked from datacenter
 * IPs. When it fails the pulse comes back empty rather than made up.
 */
import { fetchDexStats } from "./dex-stats";
import { isB58, sanitizeLabel } from "./guard";
import type { Security, Token } from "./market";
import { auditMints, type MintFlags } from "./mint-audit";
import { solUsd } from "./sol-price";

type PumpCoin = {
  mint?: string;
  name?: string;
  symbol?: string;
  complete?: boolean;
  usd_market_cap?: number;
  market_cap?: number;
  virtual_sol_reserves?: number;
  real_sol_reserves?: number;
  created_timestamp?: number;
  twitter?: string | null;
  reply_count?: number;
  nsfw?: boolean;
  is_banned?: boolean;
  total_supply?: number;
};

export type Pulse = { tokens: Token[]; solUsd: number | null; at: number };

const PUMP = "https://frontend-api-v3.pump.fun/coins";
const SUPPLY = 1_000_000_000;
const PULSE_TTL = 3_200;

let pulseCache: Pulse | null = null;
let pulseInflight: Promise<Pulse> | null = null;

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function twitterHandle(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  if ((raw.match(/https?:/gi) ?? []).length > 1) return null;
  const m = raw.match(/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{2,15})/i);
  if (m) return `@${m[1]}`;
  const t = raw.trim();
  if (/^@[A-Za-z0-9_]{2,15}$/.test(t)) return t;
  return null;
}

function securityOf(complete: boolean, chain?: MintFlags): Security {
  if (chain) {
    return {
      mintable: chain.mintable,
      freeze: chain.freeze,
      lpBurned: complete,
      renounced: !chain.mintable && !chain.freeze,
      top10: null,
      onchain: true,
    };
  }
  return {
    mintable: false,
    freeze: false,
    lpBurned: complete,
    renounced: false,
    top10: null,
    onchain: false,
  };
}

function coinToToken(coin: PumpCoin, now: number, sol: number | null): Token | null {
  const mint = typeof coin.mint === "string" ? coin.mint.trim() : "";
  if (!isB58(mint)) return null;
  if (coin.nsfw || coin.is_banned) return null;
  const symbol = sanitizeLabel(coin.symbol, 12).toUpperCase() || "???";
  const name = sanitizeLabel(coin.name, 28) || symbol;
  if (!/[A-Z0-9]/.test(symbol)) return null;
  const usd = Number(coin.usd_market_cap) || (sol != null ? Number(coin.market_cap) * sol : 0) || 0;
  if (!Number.isFinite(usd) || usd <= 0) return null;
  const complete = !!coin.complete;
  const createdAt = Number(coin.created_timestamp) || now;
  if (createdAt > now + 60_000) return null;
  if (!complete && now - createdAt > 36 * 3600_000) return null;
  const virt = Number(coin.virtual_sol_reserves) / 1e9;
  const real = Number(coin.real_sol_reserves) / 1e9;
  const virtOk = Number.isFinite(virt) && virt > 0;
  // real_sol_reserves is the SOL actually deposited into the curve; the
  // virtual figure carries a 30 SOL offset that is not tradable liquidity.
  const realOk = coin.real_sol_reserves != null && Number.isFinite(real) && real >= 0;
  const bonding = complete ? 100 : clamp((((virtOk ? virt : 30) - 30) / 85) * 100, 1, 99);
  const stage: Token["stage"] = complete ? "migrated" : bonding >= 42 ? "bonding" : "new";
  const supply = Number(coin.total_supply) > 0 ? Number(coin.total_supply) / 1e6 : SUPPLY;
  const price = usd / supply;
  const liqSol = realOk ? real : virtOk ? Math.max(0, virt - 30) : 0;
  return {
    id: mint,
    mint,
    symbol,
    name,
    chain: "sol",
    stage,
    createdAt,
    price,
    mc: usd,
    liq: sol != null ? Math.max(0, liqSol) * sol : 0,
    vol: null,
    vol5m: null,
    tx: null,
    buys5m: null,
    sells5m: null,
    holders: null,
    change1m: 0,
    change5m: 0,
    change1h: null,
    bonding,
    mentions: Number(coin.reply_count) || 0,
    twitter: twitterHandle(coin.twitter),
    security: securityOf(complete),
    candles: [],
    supply,
    statsAt: null,
    pair: null,
  };
}

async function getPump(sort: string, extra = "", limit = 24): Promise<PumpCoin[]> {
  const url = `${PUMP}?offset=0&limit=${limit}&sort=${sort}&order=DESC&includeNsfw=false${extra}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": "WICK/1" },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) return [];
    return (data as PumpCoin[]).slice(0, limit);
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

async function fetchPulse(): Promise<Pulse> {
  const now = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6_500);
  try {
    const [sol, created, bonding, traded] = await Promise.all([
      solUsd(ctrl.signal),
      getPump("created_timestamp", "", 36),
      getPump("last_trade_timestamp", "&complete=false", 24),
      getPump("last_trade_timestamp", "&complete=true", 16),
    ]);
    const seen = new Set<string>();
    const tokens: Token[] = [];
    for (const coin of [...created, ...bonding, ...traded]) {
      const token = coinToToken(coin, now, sol);
      if (!token || seen.has(token.id)) continue;
      seen.add(token.id);
      tokens.push(token);
      if (tokens.length >= 56) break;
    }
    const mints = tokens.map((tk) => tk.mint);
    const [flags, stats] = await Promise.all([
      auditMints(mints),
      fetchDexStats(mints, ctrl.signal),
    ]);
    for (const tk of tokens) {
      const chain = flags.get(tk.mint);
      if (chain) {
        tk.security = securityOf(tk.stage === "migrated", chain);
        if (chain.supply > 0) {
          tk.supply = chain.supply;
          tk.price = tk.mc / chain.supply;
        }
      }
      const st = stats.get(tk.mint);
      if (!st) continue;
      tk.pair = st.pair;
      tk.statsAt = st.at;
      tk.vol = st.vol24;
      tk.vol5m = st.vol5m;
      tk.tx = st.tx24;
      tk.buys5m = st.buys5m;
      tk.sells5m = st.sells5m;
      tk.change5m = st.change5m ?? 0;
      tk.change1h = st.change1h;
      if (tk.stage === "migrated") {
        // Bonding-curve pairs report near-zero liquidity on DexScreener; the
        // curve's SOL reserves from pump.fun are the real number there.
        if (st.liqUsd != null) tk.liq = st.liqUsd;
        if (st.mc != null && st.mc > 0) tk.mc = st.mc;
        if (st.priceUsd != null && st.priceUsd > 0) {
          tk.price = st.priceUsd;
          if (tk.supply > 0 && st.mc == null) tk.mc = st.priceUsd * tk.supply;
        }
      }
    }
    return { tokens, solUsd: sol, at: now };
  } finally {
    clearTimeout(t);
  }
}

export async function loadSolanaPulse(): Promise<Pulse> {
  const now = Date.now();
  if (pulseCache && now - pulseCache.at < PULSE_TTL) return pulseCache;
  if (pulseInflight) return pulseInflight;
  pulseInflight = fetchPulse()
    .then((pulse) => {
      if (pulse.tokens.length) pulseCache = pulse;
      return pulse;
    })
    .finally(() => {
      pulseInflight = null;
    });
  return pulseInflight;
}
