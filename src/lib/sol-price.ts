import { WSOL } from "./solana-wallet";

const TTL = 20_000;
let cached: { at: number; usd: number } | null = null;

/** SOL/USD from Jupiter's price feed. Cached; null when unreachable. */
export async function solUsd(signal: AbortSignal): Promise<number | null> {
  if (cached && Date.now() - cached.at < TTL) return cached.usd;
  try {
    const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${WSOL}`, {
      signal,
      headers: { accept: "application/json" },
      redirect: "error",
    });
    if (!res.ok) return cached?.usd ?? null;
    const data = (await res.json()) as Record<string, { usdPrice?: number }>;
    const px = data?.[WSOL]?.usdPrice;
    if (typeof px === "number" && px > 0) {
      cached = { at: Date.now(), usd: px };
      return px;
    }
  } catch {
    /* fall through */
  }
  return cached?.usd ?? null;
}
