import { createFileRoute } from "@tanstack/react-router";
import { clientKey, isB58, jsonErr, jsonOk, lruSet, rateLimit, sanitizeLabel } from "@/lib/guard";
import type { ChainHolding, ChainPrint } from "@/lib/solana-wallet";

const RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const TTL = 12_000;
const TOKEN_WAIT = 8_000;

const KNOWN: Record<string, { symbol: string; name: string }> = {
  So11111111111111111111111111111111111111112: { symbol: "SOL", name: "Wrapped SOL" },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", name: "USD Coin" },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: "USDT", name: "Tether" },
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": { symbol: "PYUSD", name: "PayPal USD" },
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: { symbol: "JUP", name: "Jupiter" },
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: { symbol: "BONK", name: "Bonk" },
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: { symbol: "WIF", name: "dogwifhat" },
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": { symbol: "RAY", name: "Raydium" },
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: { symbol: "JitoSOL", name: "Jito Staked SOL" },
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: { symbol: "mSOL", name: "Marinade SOL" },
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": { symbol: "ETH", name: "Ether (Wormhole)" },
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": { symbol: "WBTC", name: "Wrapped BTC" },
};

type RpcAccount = {
  account?: {
    data?: {
      parsed?: {
        info?: {
          mint?: string;
          tokenAmount?: { uiAmount?: number; decimals?: number };
        };
      };
    };
  };
};

type Bag = { sol: number | null; holdings: ChainHolding[]; tokensOk: boolean };

const cache = new Map<string, { at: number } & Bag>();

function parseAccounts(value: RpcAccount[] | undefined): ChainHolding[] {
  const byMint = new Map<string, ChainHolding>();
  for (const row of value ?? []) {
    const info = row.account?.data?.parsed?.info;
    const mint = info?.mint;
    const ui = info?.tokenAmount?.uiAmount;
    const decimals = Number(info?.tokenAmount?.decimals) || 0;
    if (typeof mint !== "string" || !isB58(mint) || typeof ui !== "number" || !(ui > 0)) continue;
    if (decimals === 0 && ui < 10) continue;
    const prev = byMint.get(mint);
    if (prev) prev.amount += ui;
    else byMint.set(mint, { mint, amount: ui, decimals });
  }
  return [...byMint.values()];
}

function isSpam(h: ChainHolding): boolean {
  if (KNOWN[h.mint]) return false;
  if (h.decimals === 0 && h.amount < 10) return true;
  if (h.decimals <= 2 && h.amount >= 1e9) return true;
  return false;
}

async function rpc<T>(url: string, method: string, params: unknown[], signal: AbortSignal): Promise<T | null> {
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", "user-agent": "WICK/1" },
    redirect: "error",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { result?: T };
  return data.result ?? null;
}

function sleep(ms: number, signal: AbortSignal): Promise<"timeout"> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve("timeout"), ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function jupPrices(mints: string[], signal: AbortSignal): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!mints.length) return out;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const t = setTimeout(() => ctrl.abort(), 3_000);
  try {
    const ids = mints.slice(0, 80).join(",");
    const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${ids}`, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
      redirect: "error",
    });
    if (!res.ok) return out;
    const data = (await res.json()) as Record<string, { usdPrice?: number }>;
    for (const [mint, row] of Object.entries(data ?? {})) {
      const px = row?.usdPrice;
      if (typeof px === "number" && px > 0) out.set(mint, px);
    }
  } catch {
    /* prices optional */
  } finally {
    clearTimeout(t);
    signal.removeEventListener("abort", onAbort);
  }
  return out;
}

async function jupMeta(mint: string, signal: AbortSignal): Promise<{ symbol: string; name: string } | null> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const t = setTimeout(() => ctrl.abort(), 2_200);
  try {
    const res = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}`, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
      redirect: "error",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ id?: string; symbol?: string; name?: string }>;
    const hit = Array.isArray(data) ? data.find((row) => row.id === mint) : null;
    const symbol = sanitizeLabel(hit?.symbol, 14);
    const name = sanitizeLabel(hit?.name, 28);
    if (!symbol && !name) return null;
    return { symbol: symbol || name, name: name || symbol };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
    signal.removeEventListener("abort", onAbort);
  }
}

async function enrich(holdings: ChainHolding[], signal: AbortSignal): Promise<ChainHolding[]> {
  const filtered = holdings.filter((h) => !isSpam(h)).sort((a, b) => b.amount - a.amount).slice(0, 80);
  if (!filtered.length) return [];
  const prices = await jupPrices(
    filtered.map((h) => h.mint),
    signal,
  );
  const tagged: ChainHolding[] = [];
  for (const h of filtered) {
    const known = KNOWN[h.mint];
    const priceUsd = prices.get(h.mint) ?? null;
    const usd = priceUsd != null ? priceUsd * h.amount : null;
    if (usd != null && usd < 0.05 && !known) continue;
    tagged.push({
      mint: h.mint,
      amount: h.amount,
      decimals: h.decimals,
      symbol: known?.symbol,
      name: known?.name,
      priceUsd,
      usd,
    });
  }
  tagged.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.amount - a.amount);
  const top = tagged.slice(0, 40);

  const needMeta = top.filter((h) => !h.symbol).slice(0, 12);
  if (needMeta.length) {
    const metas = await Promise.all(needMeta.map((h) => jupMeta(h.mint, signal)));
    needMeta.forEach((row, i) => {
      const meta = metas[i];
      if (!meta) return;
      row.symbol = meta.symbol;
      row.name = meta.name;
    });
  }
  return top;
}

async function loadBag(pk: string, signal: AbortSignal): Promise<Bag> {
  let last: Error | null = null;
  for (const url of RPCS) {
    const tokenCtrl = new AbortController();
    const onAbort = () => tokenCtrl.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const balP = rpc<{ value?: number }>(url, "getBalance", [pk], signal);
      const splP = rpc<{ value?: RpcAccount[] }>(
        url,
        "getTokenAccountsByOwner",
        [pk, { programId: TOKEN }, { encoding: "jsonParsed" }],
        tokenCtrl.signal,
      );
      const t22P = rpc<{ value?: RpcAccount[] }>(
        url,
        "getTokenAccountsByOwner",
        [pk, { programId: TOKEN22 }, { encoding: "jsonParsed" }],
        tokenCtrl.signal,
      );

      const bal = await balP;
      const lamports = bal?.value;
      const sol = typeof lamports === "number" ? lamports / 1e9 : null;

      const tokenRace = Promise.all([splP, t22P])
        .then((v) => ({ ok: true as const, v }))
        .catch(() => ({ ok: false as const }));
      const raced = await Promise.race([tokenRace, sleep(TOKEN_WAIT, signal)]);

      let holdings: ChainHolding[] = [];
      let tokensOk = false;
      if (raced !== "timeout" && raced.ok) {
        const [spl, t22] = raced.v;
        const byMint = new Map<string, ChainHolding>();
        for (const h of [...parseAccounts(spl?.value), ...parseAccounts(t22?.value)]) {
          const prev = byMint.get(h.mint);
          if (prev) prev.amount += h.amount;
          else byMint.set(h.mint, { ...h });
        }
        holdings = await enrich([...byMint.values()], signal);
        tokensOk = true;
      } else {
        tokenCtrl.abort();
      }

      if (sol == null && holdings.length === 0 && !tokensOk) continue;
      return { sol, holdings, tokensOk };
    } catch (err) {
      last = err instanceof Error ? err : new Error("rpc");
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
  if (last) throw last;
  return { sol: null, holdings: [], tokensOk: false };
}

const tapeCache = new Map<string, { at: number; prints: ChainPrint[] }>();

type TokenBal = { owner?: string; mint?: string; uiTokenAmount?: { uiAmount?: number | null } };
type ParsedTx = {
  blockTime?: number | null;
  meta?: {
    err?: unknown;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: TokenBal[];
    postTokenBalances?: TokenBal[];
  } | null;
  transaction?: { message?: { accountKeys?: Array<string | { pubkey?: string }> } };
};

function keyPk(k: string | { pubkey?: string } | undefined): string {
  if (typeof k === "string") return k;
  return k?.pubkey ?? "";
}

function tokenDelta(pk: string, pre: TokenBal[] | undefined, post: TokenBal[] | undefined) {
  const map = new Map<string, number>();
  for (const row of pre ?? []) {
    if (row.owner !== pk || !row.mint) continue;
    map.set(row.mint, (map.get(row.mint) ?? 0) - (row.uiTokenAmount?.uiAmount ?? 0));
  }
  for (const row of post ?? []) {
    if (row.owner !== pk || !row.mint) continue;
    map.set(row.mint, (map.get(row.mint) ?? 0) + (row.uiTokenAmount?.uiAmount ?? 0));
  }
  let mint = "";
  let amount = 0;
  for (const [m, d] of map) {
    if (Math.abs(d) > Math.abs(amount)) {
      mint = m;
      amount = d;
    }
  }
  return mint ? { mint, amount } : null;
}

function parsePrint(pk: string, sig: string, tx: ParsedTx | null): ChainPrint | null {
  if (!tx?.meta || tx.meta.err) return null;
  const keys = tx.transaction?.message?.accountKeys ?? [];
  const idx = keys.findIndex((k) => keyPk(k) === pk);
  const pre = tx.meta.preBalances?.[idx] ?? 0;
  const post = tx.meta.postBalances?.[idx] ?? 0;
  const solDelta = idx >= 0 ? (post - pre) / 1e9 : 0;
  const tok = tokenDelta(pk, tx.meta.preTokenBalances, tx.meta.postTokenBalances);
  const ts = (tx.blockTime ?? 0) * 1000;
  const known = tok?.mint ? KNOWN[tok.mint] : undefined;
  if (tok && solDelta < -0.002 && tok.amount > 0) {
    return { sig, ts, side: "buy", sol: Math.abs(solDelta), mint: tok.mint, amount: tok.amount, symbol: known?.symbol };
  }
  if (tok && solDelta > 0.002 && tok.amount < 0) {
    return { sig, ts, side: "sell", sol: solDelta, mint: tok.mint, amount: Math.abs(tok.amount), symbol: known?.symbol };
  }
  if (Math.abs(solDelta) >= 0.002) {
    return { sig, ts, side: solDelta > 0 ? "in" : "out", sol: Math.abs(solDelta) };
  }
  if (tok && Math.abs(tok.amount) > 0) {
    return {
      sig,
      ts,
      side: tok.amount > 0 ? "in" : "out",
      sol: 0,
      mint: tok.mint,
      amount: Math.abs(tok.amount),
      symbol: known?.symbol,
    };
  }
  return null;
}

async function loadTape(pk: string, signal: AbortSignal): Promise<ChainPrint[]> {
  const hit = tapeCache.get(pk);
  if (hit && Date.now() - hit.at < TTL) return hit.prints;
  for (const url of RPCS) {
    if (signal.aborted) break;
    const sigs = await rpc<Array<{ signature?: string }>>(url, "getSignaturesForAddress", [pk, { limit: 8 }], signal);
    if (!sigs?.length) continue;
    const rows = await Promise.all(
      sigs.slice(0, 6).map(async (s) => {
        const sig = s.signature;
        if (!sig) return null;
        const tx = await rpc<ParsedTx>(
          url,
          "getTransaction",
          [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
          signal,
        );
        return parsePrint(pk, sig, tx);
      }),
    );
    const prints = rows.filter((p): p is ChainPrint => !!p);
    lruSet(tapeCache, pk, { at: Date.now(), prints }, 32);
    return prints;
  }
  return hit?.prints ?? [];
}

export const Route = createFileRoute("/api/sol")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!rateLimit(`sol:${clientKey(request)}`, 24)) {
          return jsonErr("rate", 429);
        }
        const url = new URL(request.url);
        const pk = (url.searchParams.get("pk") ?? "").trim();
        if (!isB58(pk)) {
          return jsonErr("bad pk", 400);
        }
        const wantTape = url.searchParams.get("tape") === "1";
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), wantTape ? 10_000 : 12_000);
        try {
          if (wantTape) {
            const prints = await loadTape(pk, ctrl.signal);
            return jsonOk({ prints });
          }
          const hit = cache.get(pk);
          if (hit && Date.now() - hit.at < TTL && (hit.sol != null || hit.holdings.length > 0)) {
            return jsonOk({ sol: hit.sol, holdings: hit.holdings, tokensOk: hit.tokensOk });
          }
          const payload = await loadBag(pk, ctrl.signal);
          if (payload.sol != null || payload.holdings.length > 0) {
            lruSet(cache, pk, { at: Date.now(), ...payload }, 64);
          }
          return jsonOk(payload);
        } catch {
          if (wantTape) return jsonOk({ prints: tapeCache.get(pk)?.prints ?? [] });
          const hit = cache.get(pk);
          if (hit && (hit.sol != null || hit.holdings.length > 0)) {
            return jsonOk({ sol: hit.sol, holdings: hit.holdings, tokensOk: hit.tokensOk });
          }
          return jsonOk({ sol: null, holdings: [], tokensOk: false }, 502);
        } finally {
          clearTimeout(t);
        }
      },
    },
  },
});
