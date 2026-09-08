/**
 * The supply map and the wallet classes (ENGINE §7 and §8, ADR-0008), pure.
 * The engine's supply writer reads holders and profiles wallets on a budget
 * and feeds the numbers here; the gate reads the row this produces.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { fromB58, toB58 } from "./base58.ts";
import type { SupplyMap, WalletClass } from "./contracts.ts";

/** pump.fun's bonding-curve program; the curve account is its PDA of ["bonding-curve", mint]. */
export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

function onCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

/** A program-derived address: sha256(seeds, bump, program, "ProgramDerivedAddress"), first bump off the curve. */
export function pdaOf(seeds: Uint8Array[], programId: string): { address: string; bump: number } {
  const program = fromB58(programId);
  if (!program) throw new Error("bad program id");
  const marker = new TextEncoder().encode("ProgramDerivedAddress");
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), program, marker];
    const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      buf.set(p, o);
      o += p.length;
    }
    const hash = sha256(buf);
    if (!onCurve(hash)) return { address: toB58(hash), bump };
  }
  throw new Error("no bump found");
}

export function bondingCurveOf(mint: string): string {
  const m = fromB58(mint);
  if (!m) throw new Error("bad mint");
  return pdaOf([new TextEncoder().encode("bonding-curve"), m], PUMP_PROGRAM).address;
}

export type HolderRead = { account: string; owner: string; amount: number };

export type WalletStats = {
  /** Launches this wallet bought in the create slot or the next three, out of the ones we parsed. */
  createSlotBuys: number;
  /** Transactions seen, capped at the read limit (5); null when the wallet was not read. */
  txCount: number | null;
  /** Age from the oldest of those transactions, seconds; null when not read or over the cap. */
  ageSec: number | null;
};

export type Classified = { class: WalletClass; confidence: number; fresh: boolean | null };

export const FRESH_MAX_AGE_SEC = 24 * 3600;
export const FRESH_MAX_TX = 5;
export const SNIPER_MIN_LAUNCHES = 3;

/** The behavioural classes Phase 2 can tell from our own data; the rest arrive with the funding tree. */
export function classifyWallet(s: WalletStats): Classified {
  const fresh =
    s.txCount == null
      ? null
      : s.txCount < FRESH_MAX_TX && s.ageSec != null && s.ageSec < FRESH_MAX_AGE_SEC;
  if (s.createSlotBuys >= SNIPER_MIN_LAUNCHES)
    return { class: "sniper-bot", confidence: Math.min(1, s.createSlotBuys / 5), fresh };
  if (s.txCount == null) return { class: "unknown", confidence: 0, fresh };
  if (fresh) return { class: "unknown", confidence: 0.3, fresh };
  return { class: "organic", confidence: 0.5, fresh };
}

export type SupplyInputs = {
  at: number;
  /** Total supply in raw units and the mint's decimals; both from the audit. */
  supplyRaw: number;
  decimals: number;
  holders: HolderRead[];
  /** Owners whose holdings are the pool's: the bonding curve, the migrated pool. */
  poolOwners: string[];
  launch: {
    creator: string;
    slot: number;
    buyers: { wallet: string; slot: number }[];
    bundlePct: number;
  } | null;
  /** Fresh or not per holder owner; absent means not profiled. */
  fresh: Map<string, boolean | null>;
  /** The early share (dev + snipers) about 30 minutes ago, percent; null without a row. */
  earlyPctBefore: number | null;
};

export const SNIPER_SLOTS = 10;
export const TREND_STEP_PCT = 2;

export function trendOf(before: number | null, now: number): SupplyMap["earlyHoldersTrend"] {
  if (before == null) return null;
  if (now < before - TREND_STEP_PCT) return "distributing";
  if (now > before + TREND_STEP_PCT) return "accumulating";
  return "flat";
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export type SupplyResult = {
  map: SupplyMap;
  /** Every non-pool holder with its share, for the token view. */
  holders: { wallet: string; pct: number }[];
  earlyPct: number;
};

export function supplyMapOf(i: SupplyInputs): SupplyResult | null {
  if (!(i.supplyRaw > 0) || !i.holders.length) return null;
  const pool = new Set(i.poolOwners);
  const pct = (amount: number) => (amount / i.supplyRaw) * 100;
  let lp = 0;
  const byOwner = new Map<string, number>();
  for (const h of i.holders) {
    if (pool.has(h.owner)) lp += pct(h.amount);
    else byOwner.set(h.owner, (byOwner.get(h.owner) ?? 0) + pct(h.amount));
  }
  const snipers = new Set(
    i.launch
      ? i.launch.buyers.filter((b) => b.slot <= i.launch!.slot + SNIPER_SLOTS).map((b) => b.wallet)
      : [],
  );
  let dev = 0;
  let sniper = 0;
  let fresh = 0;
  let freshKnown = 0;
  for (const [owner, share] of byOwner) {
    if (i.launch && owner === i.launch.creator) dev += share;
    else if (snipers.has(owner)) sniper += share;
    const f = i.fresh.get(owner);
    if (f != null) {
      freshKnown += share;
      if (f) fresh += share;
    }
  }
  const earlyPct = r1(dev + sniper);
  return {
    map: {
      at: i.at,
      devPct: i.launch ? r1(dev) : null,
      bundlePct: i.launch ? r1(i.launch.bundlePct) : null,
      sniperPct: i.launch ? r1(sniper) : null,
      // The share held by fresh wallets among the holders we could profile; null when none was.
      freshWalletPct: freshKnown > 0 ? r1(fresh) : null,
      lpPct: r1(lp),
      clusterPct: null,
      earlyHoldersTrend: trendOf(i.earlyPctBefore, earlyPct),
    },
    holders: [...byOwner]
      .map(([wallet, p]) => ({ wallet, pct: r1(p) }))
      .sort((a, b) => b.pct - a.pct),
    earlyPct,
  };
}
