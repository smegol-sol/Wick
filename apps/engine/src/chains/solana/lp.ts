/**
 * LP state from the pool account (roadmap Phase 1; ENGINE §7 pool-share row).
 *
 * Reads the pool's LP mint and how much LP the pool program ever minted, then
 * the LP mint's current supply and its largest holders, and classifies:
 * `burned` when ≥ 95% of the minted LP no longer exists, `locked` when what
 * exists sits with a known locker, `deployer` when a wallet holds it (whoever
 * it is: a wallet can pull it), `null` when the pool or the holders could not
 * be read. Tokens still on the bonding curve are `curve` and never come here.
 *
 * Layout parsing is validated by checking that the pool's base or quote mint
 * equals the token's mint; a wrong offset returns null instead of a number.
 */
import { fromB58, toB58 } from "@wick/core/base58";
import type { LpRead, LpState } from "@wick/core/contracts";
import { rpcAny } from "@wick/core/rpc";

export const POOL_PROGRAMS: Record<string, "pumpswap" | "raydium-v4"> = {
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "pumpswap",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "raydium-v4",
};

/** Programs that hold LP on a schedule the holder cannot shorten. Extend only with a verified id. */
export const LOCKERS: Record<string, string> = {
  LockrWmn6K5twhz3y9w1PDDgVWPqHqk5ApM4Xv5T6Pa: "raydium-lock",
  strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m: "streamflow",
  LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn: "jupiter-lock",
};

export const BURNED_PCT = 95;

export type PoolRead = {
  dex: string;
  baseMint: string;
  quoteMint: string;
  lpMint: string;
  /** LP the program itself accounts for; burns through the token program do not lower it. */
  lpMinted: number;
};

function key(bytes: Uint8Array, at: number): string {
  return toB58(bytes.subarray(at, at + 32));
}

function u64(bytes: Uint8Array, at: number): number {
  let n = 0;
  for (let i = 7; i >= 0; i--) n = n * 256 + bytes[at + i];
  return n;
}

/** Raydium AMM v4 `LIQUIDITY_STATE_LAYOUT_V4` (752 bytes). */
export function parseRaydiumV4(bytes: Uint8Array): PoolRead | null {
  if (bytes.length < 752) return null;
  return {
    dex: "raydium-v4",
    baseMint: key(bytes, 400),
    quoteMint: key(bytes, 432),
    lpMint: key(bytes, 464),
    lpMinted: u64(bytes, 720),
  };
}

/** PumpSwap `Pool` (Anchor: 8-byte discriminator, bump u8, index u16, creator, base, quote, lp, vaults, lp_supply u64). */
export function parsePumpSwap(bytes: Uint8Array): PoolRead | null {
  if (bytes.length < 211) return null;
  return {
    dex: "pumpswap",
    baseMint: key(bytes, 43),
    quoteMint: key(bytes, 75),
    lpMint: key(bytes, 107),
    lpMinted: u64(bytes, 203),
  };
}

export function parsePool(owner: string, bytes: Uint8Array, mint: string): PoolRead | null {
  const kind = POOL_PROGRAMS[owner];
  const read =
    kind === "pumpswap"
      ? parsePumpSwap(bytes)
      : kind === "raydium-v4"
        ? parseRaydiumV4(bytes)
        : null;
  if (!read) return null;
  if (read.baseMint !== mint && read.quoteMint !== mint) return null;
  return read;
}

export type LpHolder = { owner: string; amount: number };

/** Pure classification over what the chain said. */
export function classifyLp(
  pool: PoolRead,
  lpSupply: number | null,
  holders: LpHolder[] | null,
): Omit<LpRead, "pool"> {
  const burnedPct =
    lpSupply != null && pool.lpMinted > 0
      ? Math.max(0, Math.min(100, ((pool.lpMinted - lpSupply) / pool.lpMinted) * 100))
      : null;
  const top = holders?.length ? holders.reduce((a, b) => (b.amount > a.amount ? b : a)) : null;
  const topPct = top && lpSupply ? Math.min(100, (top.amount / lpSupply) * 100) : null;
  let state: LpState | null = null;
  if (burnedPct != null && burnedPct >= BURNED_PCT) state = "burned";
  else if (top && topPct != null) {
    const remainingPct = 100 - (burnedPct ?? 0);
    const lockedOfMinted = LOCKERS[top.owner] ? (topPct * remainingPct) / 100 : 0;
    if ((burnedPct ?? 0) + lockedOfMinted >= BURNED_PCT) state = "locked";
    else state = "deployer";
  }
  return {
    state,
    dex: pool.dex,
    lpMint: pool.lpMint,
    burnedPct,
    topHolder: top?.owner ?? null,
    topHolderPct: topPct,
  };
}

type AccountInfo = { owner?: string; data?: [string, string] };
type Largest = { value?: { address?: string; amount?: string }[] };
type Supply = { value?: { amount?: string } };
type TokenAccount = { data?: { parsed?: { info?: { owner?: string } } } };

function amountOf(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Read one pool over the RPC. Every step that fails leaves its field null; nothing is guessed. */
export async function readLp(mint: string, pool: string, signal: AbortSignal): Promise<LpRead> {
  const none: LpRead = {
    state: null,
    pool,
    dex: "unknown",
    lpMint: null,
    burnedPct: null,
    topHolder: null,
    topHolderPct: null,
  };
  const acc = await rpcAny<{ value?: AccountInfo | null }>(
    "getAccountInfo",
    [pool, { encoding: "base64", commitment: "confirmed" }],
    signal,
  );
  const owner = acc?.value?.owner;
  const b64 = acc?.value?.data?.[0];
  if (!owner || !b64) return none;
  const parsed = parsePool(owner, Uint8Array.from(Buffer.from(b64, "base64")), mint);
  if (!parsed) return { ...none, dex: POOL_PROGRAMS[owner] ?? "unsupported" };

  const supplyRes = await rpcAny<Supply>("getTokenSupply", [parsed.lpMint], signal);
  const lpSupply = amountOf(supplyRes?.value?.amount);

  let holders: LpHolder[] | null = null;
  const largest = await rpcAny<Largest>(
    "getTokenLargestAccounts",
    [parsed.lpMint, { commitment: "confirmed" }],
    signal,
  );
  const accounts = (largest?.value ?? []).filter((v) => v.address && amountOf(v.amount) != null);
  if (accounts.length) {
    const infos = await rpcAny<{ value?: (TokenAccount | null)[] }>(
      "getMultipleAccounts",
      [accounts.map((a) => a.address), { encoding: "jsonParsed", commitment: "confirmed" }],
      signal,
    );
    holders = accounts.map((a, i) => ({
      owner: infos?.value?.[i]?.data?.parsed?.info?.owner ?? a.address!,
      amount: amountOf(a.amount)!,
    }));
  }
  return { pool, ...classifyLp(parsed, lpSupply, holders) };
}

/** Helper for tests and fixtures: a 32-byte key from a base58 string, zero-filled when invalid. */
export function keyBytes(b58: string): Uint8Array {
  const out = new Uint8Array(32);
  const got = fromB58(b58);
  if (got && got.length === 32) out.set(got);
  return out;
}
