import { isB58 } from "./guard";
import { rpcAny, withTimeout } from "./rpc";

const TTL = 120_000;

export type MintFlags = { mintable: boolean; freeze: boolean; decimals: number; supply: number };

type Parsed = {
  data?: {
    parsed?: {
      type?: string;
      info?: {
        mintAuthority?: string | null;
        freezeAuthority?: string | null;
        decimals?: number;
        supply?: string;
      };
    };
  };
};

const cache = new Map<string, { at: number } & MintFlags>();

function parseMint(acc: Parsed | null): MintFlags | null {
  const parsed = acc?.data?.parsed;
  if (parsed?.type !== "mint") return null;
  const info = parsed.info ?? {};
  const decimals = Number(info.decimals) || 0;
  const raw = Number(info.supply) || 0;
  return {
    mintable: typeof info.mintAuthority === "string" && info.mintAuthority.length > 0,
    freeze: typeof info.freezeAuthority === "string" && info.freezeAuthority.length > 0,
    decimals,
    supply: raw / 10 ** decimals,
  };
}

/** Mint and freeze authority read straight from the mint account. Batched, cached. */
export async function auditMints(mints: string[]): Promise<Map<string, MintFlags>> {
  const out = new Map<string, MintFlags>();
  const now = Date.now();
  const need: string[] = [];
  for (const mint of mints) {
    if (!isB58(mint)) continue;
    const hit = cache.get(mint);
    if (hit && now - hit.at < TTL) {
      out.set(mint, { mintable: hit.mintable, freeze: hit.freeze, decimals: hit.decimals, supply: hit.supply });
    } else if (need.length < 100) {
      need.push(mint);
    }
  }
  if (!need.length) return out;

  const { signal, done } = withTimeout(4_000);
  try {
    const value = await rpcAny<{ value?: (Parsed | null)[] }>(
      "getMultipleAccounts",
      [need, { encoding: "jsonParsed", commitment: "confirmed" }],
      signal,
    );
    const rows = value?.value;
    if (!rows) return out;
    need.forEach((mint, i) => {
      const flags = parseMint(rows[i] ?? null);
      if (!flags) return;
      cache.set(mint, { at: Date.now(), ...flags });
      out.set(mint, flags);
    });
    if (cache.size > 600) {
      for (const [k, v] of cache) {
        if (Date.now() - v.at > TTL * 2) cache.delete(k);
      }
    }
  } catch {
    /* audit optional */
  } finally {
    done();
  }
  return out;
}
