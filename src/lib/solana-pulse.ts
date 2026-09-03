import { hashString, mulberry32 } from "./format";
import { isB58, sanitizeLabel } from "./guard";
import type { Candle, Security, Token } from "./market";
import { auditMints } from "./mint-audit";

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
  last_trade_timestamp?: number;
  total_supply?: number;
};

const PUMP = "https://frontend-api-v3.pump.fun/coins";
const SUPPLY = 1_000_000_000;
const PULSE_TTL = 3_200;

let pulseCache: { at: number; tokens: Token[] } | null = null;
let pulseInflight: Promise<Token[]> | null = null;

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

function liveSecurity(
  complete: boolean,
  chain?: { mintable: boolean; freeze: boolean },
): Security {
  if (chain) {
    return {
      mintable: chain.mintable,
      freeze: chain.freeze,
      lpBurned: complete,
      honeypot: false,
      renounced: !chain.mintable && !chain.freeze,
      top10: 0,
      bundled: 0,
      insiders: 0,
      snipers: 0,
      devHold: 0,
      onchain: true,
    };
  }
  return {
    mintable: true,
    freeze: false,
    lpBurned: complete,
    honeypot: false,
    renounced: false,
    top10: 0,
    bundled: 0,
    insiders: 0,
    snipers: 0,
    devHold: 0,
    onchain: false,
  };
}

function seedCandles(price: number, now: number, mint: string): Candle[] {
  const rng = mulberry32(hashString(`${mint}:c`));
  const out: Candle[] = [];
  let p = price * (0.94 + rng() * 0.08);
  for (let i = 2; i >= 0; i--) {
    const t = now - i * 60_000;
    const o = p;
    const c = i === 0 ? price : Math.max(price * 0.2, o * (1 + (rng() - 0.48) * 0.04));
    out.push({
      t,
      o,
      h: Math.max(o, c) * (1 + rng() * 0.012),
      l: Math.min(o, c) * (1 - rng() * 0.012),
      c,
      v: 1 + rng() * 12,
    });
    p = c;
  }
  return out;
}

function coinToToken(coin: PumpCoin, now: number): Token | null {
  const mint = typeof coin.mint === "string" ? coin.mint.trim() : "";
  if (!isB58(mint)) return null;
  if (coin.nsfw || coin.is_banned) return null;
  const symbol = sanitizeLabel(coin.symbol, 12).toUpperCase() || "???";
  const name = sanitizeLabel(coin.name, 28) || symbol;
  if (!/[A-Z0-9]/.test(symbol)) return null;
  if (/(nigg|faggot|kike|retard)/i.test(`${symbol} ${name}`)) return null;
  const usd = Number(coin.usd_market_cap) || Number(coin.market_cap) * 100 || 0;
  if (!Number.isFinite(usd) || usd <= 0) return null;
  const complete = !!coin.complete;
  if (!complete && usd > 420_000) return null;
  const createdAt = Number(coin.created_timestamp) || now;
  if (createdAt > now + 60_000) return null;
  if (!complete && now - createdAt > 36 * 3600_000) return null;
  const virt = Number(coin.virtual_sol_reserves) / 1e9;
  const real = Number(coin.real_sol_reserves) / 1e9;
  const virtOk = Number.isFinite(virt) && virt > 0;
  const realOk = Number.isFinite(real) && real > 0;
  const bonding = complete ? 100 : clamp((((virtOk ? virt : 30) - 30) / 85) * 100, 1, 99);
  const stage: Token["stage"] = complete ? "migrated" : bonding >= 42 ? "bonding" : "new";
  const price = usd / SUPPLY;
  const liqSol = complete ? (realOk ? real : virtOk ? virt : 0) : virtOk ? virt : realOk ? real : 0;
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
    liq: Math.max(0, liqSol) * 100,
    vol: usd * 0.2,
    vol1m: usd * 0.02,
    vol5m: usd * 0.08,
    holders: 12 + (hashString(mint) % 800),
    tx: 8 + (hashString(mint + "tx") % 4000),
    change1m: 0,
    change5m: 0,
    bonding,
    mentions: Number(coin.reply_count) || 0,
    twitter: twitterHandle(coin.twitter),
    security: liveSecurity(complete),
    candles: seedCandles(price, now, mint),
    supply: SUPPLY,
    lastDevSell: 0,
    live: true,
  };
}

async function getPump(sort: string, extra = "", limit = 24): Promise<PumpCoin[]> {
  const url = `${PUMP}?offset=0&limit=${limit}&sort=${sort}&order=DESC&includeNsfw=false${extra}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json", "User-Agent": "WICK-desk/1.0" },
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

async function fetchPulse(): Promise<Token[]> {
  const now = Date.now();
  const [created, bonding, traded] = await Promise.all([
    getPump("created_timestamp", "", 36),
    getPump("last_trade_timestamp", "&complete=false", 24),
    getPump("last_trade_timestamp", "&complete=true", 16),
  ]);
  const seen = new Set<string>();
  const tokens: Token[] = [];
  for (const coin of [...created, ...bonding, ...traded]) {
    const token = coinToToken(coin, now);
    if (!token || seen.has(token.id)) continue;
    seen.add(token.id);
    tokens.push(token);
    if (tokens.length >= 56) break;
  }
  const flags = await auditMints(tokens.map((t) => t.mint));
  for (const tk of tokens) {
    const chain = flags.get(tk.mint);
    if (chain) tk.security = liveSecurity(tk.stage === "migrated", chain);
  }
  return tokens;
}

export async function loadSolanaPulse(): Promise<Token[]> {
  const now = Date.now();
  if (pulseCache && now - pulseCache.at < PULSE_TTL) return pulseCache.tokens;
  if (pulseInflight) return pulseInflight;
  pulseInflight = fetchPulse()
    .then((tokens) => {
      pulseCache = { at: Date.now(), tokens };
      return tokens;
    })
    .finally(() => {
      pulseInflight = null;
    });
  return pulseInflight;
}
