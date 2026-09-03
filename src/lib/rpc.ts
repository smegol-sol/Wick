/**
 * Server-only Solana RPC selection.
 *
 * Set `SOLANA_RPC_URL` (Helius, Triton, QuickNode, …) for a real desk. The
 * public endpoints are rate-limited and slow; they are a fallback so the app
 * still renders, not something to trade through.
 */

const PUBLIC_RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];

function env(name: string): string | undefined {
  const v = typeof process !== "undefined" ? process.env?.[name] : undefined;
  return v && v.trim() ? v.trim() : undefined;
}

/** Ordered list: configured endpoint first, public fallbacks after. */
export function rpcUrls(): string[] {
  const own = env("SOLANA_RPC_URL");
  if (own && /^https:\/\//.test(own)) return [own, ...PUBLIC_RPCS.filter((u) => u !== own)];
  return PUBLIC_RPCS;
}

/** True when a dedicated (paid) RPC is configured. Gates heavy calls. */
export function hasPrivateRpc(): boolean {
  return !!env("SOLANA_RPC_URL");
}

export type RpcError = { code?: number; message?: string };

export async function rpcCall<T>(
  url: string,
  method: string,
  params: unknown[],
  signal: AbortSignal,
): Promise<T | null> {
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "WICK/1",
    },
    redirect: "error",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { result?: T; error?: RpcError };
  if (data.error) return null;
  return data.result ?? null;
}

/** Try each RPC in order until one answers. */
export async function rpcAny<T>(
  method: string,
  params: unknown[],
  signal: AbortSignal,
): Promise<T | null> {
  for (const url of rpcUrls()) {
    if (signal.aborted) break;
    try {
      const out = await rpcCall<T>(url, method, params, signal);
      if (out != null) return out;
    } catch {
      /* next */
    }
  }
  return null;
}

export function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}
