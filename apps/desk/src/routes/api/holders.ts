import { createFileRoute } from "@tanstack/react-router";
import { clientKey, isB58, jsonErr, jsonOk, lruSet, rateLimit } from "@wick/core/guard";
import type { HolderInfo, TopHolder } from "@wick/core/market";
import { hasPrivateRpc, rpcAny, withTimeout } from "@wick/core/rpc";

const TTL = 45_000;
const TOKEN_ACCOUNT_SIZE = 165;
const cache = new Map<string, HolderInfo>();

type Largest = { value?: Array<{ address?: string; uiAmount?: number | null }> };
type Supply = { value?: { uiAmount?: number | null } };
type ProgramAccount = { account?: { data?: [string, string] | string } };

/**
 * Holder count needs getProgramAccounts over the token program, which the
 * public RPCs refuse. Only attempted when SOLANA_RPC_URL is configured.
 * Counts accounts whose amount (u64 at offset 64) is non-zero.
 */
async function countHolders(mint: string, signal: AbortSignal): Promise<number | null> {
  if (!hasPrivateRpc()) return null;
  const rows = await rpcAny<ProgramAccount[]>(
    "getProgramAccounts",
    [
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      {
        encoding: "base64",
        dataSlice: { offset: 64, length: 8 },
        filters: [{ dataSize: TOKEN_ACCOUNT_SIZE }, { memcmp: { offset: 0, bytes: mint } }],
      },
    ],
    signal,
  );
  if (!Array.isArray(rows)) return null;
  let n = 0;
  for (const row of rows) {
    const data = row.account?.data;
    const b64 = Array.isArray(data) ? data[0] : typeof data === "string" ? data : "";
    if (!b64) continue;
    const bytes = Buffer.from(b64, "base64");
    let nonzero = false;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== 0) {
        nonzero = true;
        break;
      }
    }
    if (nonzero) n += 1;
  }
  return n;
}

async function loadHolders(mint: string): Promise<HolderInfo | null> {
  const { signal, done } = withTimeout(9_000);
  try {
    const [largest, supply, holders] = await Promise.all([
      rpcAny<Largest>("getTokenLargestAccounts", [mint, { commitment: "confirmed" }], signal),
      rpcAny<Supply>("getTokenSupply", [mint, { commitment: "confirmed" }], signal),
      countHolders(mint, signal).catch(() => null),
    ]);
    const total = supply?.value?.uiAmount ?? null;
    const rows = largest?.value ?? [];
    if (!rows.length && total == null) return null;
    const top: TopHolder[] = [];
    for (const r of rows) {
      const amount = r.uiAmount ?? 0;
      if (!r.address || !(amount > 0)) continue;
      top.push({
        address: r.address,
        amount,
        pct: total && total > 0 ? (amount / total) * 100 : 0,
      });
    }
    top.sort((a, b) => b.amount - a.amount);
    const top10 =
      total && total > 0 && top.length ? top.slice(0, 10).reduce((a, h) => a + h.pct, 0) : null;
    return { mint, at: Date.now(), holders, top10, top: top.slice(0, 20) };
  } finally {
    done();
  }
}

export const Route = createFileRoute("/api/holders")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!rateLimit(`holders:${clientKey(request)}`, 30)) return jsonErr("rate", 429);
        const url = new URL(request.url);
        const mint = (url.searchParams.get("mint") ?? "").trim();
        if (!isB58(mint)) return jsonErr("bad mint", 400);
        const hit = cache.get(mint);
        if (hit && Date.now() - hit.at < TTL) return jsonOk(hit);
        const empty: HolderInfo = { mint, at: Date.now(), holders: null, top10: null, top: [] };
        try {
          const info = await loadHolders(mint);
          if (!info) return jsonOk(hit ?? empty);
          lruSet(cache, mint, info, 200);
          return jsonOk(info);
        } catch {
          return jsonOk(hit ?? empty);
        }
      },
    },
  },
});
