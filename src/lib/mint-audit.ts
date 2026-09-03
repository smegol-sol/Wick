import { isB58 } from "./guard";

const RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
const TTL = 120_000;

export type MintFlags = { mintable: boolean; freeze: boolean };

type Parsed = {
  data?: {
    parsed?: {
      type?: string;
      info?: { mintAuthority?: string | null; freezeAuthority?: string | null };
    };
  };
};

const cache = new Map<string, { at: number } & MintFlags>();

function parseMint(acc: Parsed | null): MintFlags | null {
  const parsed = acc?.data?.parsed;
  if (parsed?.type !== "mint") return null;
  const mintAuth = parsed.info?.mintAuthority;
  const freezeAuth = parsed.info?.freezeAuthority;
  return {
    mintable: typeof mintAuth === "string" && mintAuth.length > 0,
    freeze: typeof freezeAuth === "string" && freezeAuth.length > 0,
  };
}

async function getMultiple(url: string, mints: string[], signal: AbortSignal): Promise<(Parsed | null)[] | null> {
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getMultipleAccounts",
      params: [mints, { encoding: "jsonParsed", commitment: "confirmed" }],
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { result?: { value?: (Parsed | null)[] } };
  return data.result?.value ?? null;
}

export async function auditMints(mints: string[]): Promise<Map<string, MintFlags>> {
  const out = new Map<string, MintFlags>();
  const now = Date.now();
  const need: string[] = [];
  for (const mint of mints) {
    if (!isB58(mint)) continue;
    const hit = cache.get(mint);
    if (hit && now - hit.at < TTL) {
      out.set(mint, { mintable: hit.mintable, freeze: hit.freeze });
    } else if (need.length < 20) {
      need.push(mint);
    }
  }
  if (!need.length) return out;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3_500);
  try {
    let value: (Parsed | null)[] | null = null;
    for (const url of RPCS) {
      try {
        value = await getMultiple(url, need, ctrl.signal);
        if (value) break;
      } catch {
        /* next rpc */
      }
    }
    if (!value) return out;
    need.forEach((mint, i) => {
      const flags = parseMint(value![i] ?? null);
      if (!flags) return;
      cache.set(mint, { at: Date.now(), ...flags });
      out.set(mint, flags);
    });
    if (cache.size > 400) {
      for (const [k, v] of cache) {
        if (Date.now() - v.at > TTL * 2) cache.delete(k);
      }
    }
  } finally {
    clearTimeout(t);
  }
  return out;
}
