/**
 * Launch transaction parsing (roadmap Phase 1; ENGINE §7 bundle and sniper rows).
 *
 * Walks the mint's signature history back to its first transaction, takes
 * every successful transaction in the create slot and the next ten, and
 * reads token-balance deltas: any account whose balance of the mint went up
 * received tokens. Pool accounts are the ones that held over half of the
 * supply in the create transaction; their inflows (sells) are not buys.
 * Program-agnostic on purpose: it reads balances, not instructions.
 */
import type { LaunchBuyer, LaunchTx } from "@wick/core/chain";
import { rpcAny } from "@wick/core/rpc";

export const BUNDLE_SLOTS = 3;
export const SNIPER_SLOTS = 10;
/** At most this many transactions are fetched per launch; beyond it the shares are a floor. */
export const MAX_TXS = 60;
const SIG_PAGE = 1000;
/** Ten pages is 10,000 signatures; a token busier than that in its first hours is logged and left unparsed. */
const MAX_SIG_PAGES = 10;

export type SigInfo = { signature: string; slot: number; err: unknown; blockTime?: number | null };

export type TokenBalance = {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
};

export type ParsedTx = {
  slot: number;
  blockTime?: number | null;
  transaction: { message: { accountKeys: { pubkey: string; signer?: boolean }[] } };
  meta: {
    err: unknown;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
};

function amt(b: TokenBalance | undefined): number {
  const n = b ? Number(b.uiTokenAmount.amount) : 0;
  return Number.isFinite(n) ? n : 0;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Pure: the launch record from the first transactions, oldest first. `create` is the earliest one. */
export function parseLaunch(
  mint: string,
  sigs: SigInfo[],
  txs: Map<string, ParsedTx>,
  truncated: boolean,
): LaunchTx | null {
  const create = sigs[0];
  const tx0 = create ? txs.get(create.signature) : undefined;
  if (!create || !tx0?.meta || tx0.meta.err != null) return null;
  const keys = tx0.transaction.message.accountKeys;
  const creator = keys.find((k) => k.signer)?.pubkey ?? keys[0]?.pubkey;
  if (!creator) return null;

  // Total supply: the mint did not exist before this transaction.
  const post0 = (tx0.meta.postTokenBalances ?? []).filter((b) => b.mint === mint);
  const supply = post0.reduce((s, b) => s + amt(b), 0);
  if (supply <= 0) return null;
  const pools = new Set<string>();
  for (const b of post0) {
    if (amt(b) > supply / 2) pools.add(keys[b.accountIndex]?.pubkey ?? "");
  }

  const bought = new Map<string, LaunchBuyer>();
  const last = create.slot + SNIPER_SLOTS;
  for (const s of sigs) {
    if (s.slot > last) break;
    const tx = txs.get(s.signature);
    if (!tx?.meta || tx.meta.err != null) continue;
    const ks = tx.transaction.message.accountKeys;
    const pre = new Map<number, TokenBalance>();
    for (const b of tx.meta.preTokenBalances ?? []) if (b.mint === mint) pre.set(b.accountIndex, b);
    for (const b of tx.meta.postTokenBalances ?? []) {
      if (b.mint !== mint) continue;
      const delta = amt(b) - amt(pre.get(b.accountIndex));
      if (delta <= 0) continue;
      const account = ks[b.accountIndex]?.pubkey ?? "";
      if (pools.has(account)) continue;
      const wallet = b.owner ?? account;
      if (!wallet || pools.has(wallet)) continue;
      const payer = ks.findIndex((k) => k.pubkey === wallet);
      const lamports =
        payer >= 0 ? (tx.meta.preBalances[payer] ?? 0) - (tx.meta.postBalances[payer] ?? 0) : null;
      const prev = bought.get(wallet);
      const sol = lamports != null && lamports > 0 ? lamports / 1e9 : null;
      bought.set(wallet, {
        wallet,
        slot: prev ? Math.min(prev.slot, tx.slot) : tx.slot,
        sol: prev?.sol != null || sol != null ? (prev?.sol ?? 0) + (sol ?? 0) : null,
        pct: (prev?.pct ?? 0) + (delta / supply) * 100,
      });
    }
  }

  const buyers = [...bought.values()]
    .map((b) => ({ ...b, pct: round(b.pct), sol: b.sol == null ? null : round(b.sol) }))
    .sort((a, b) => a.slot - b.slot || b.pct - a.pct);
  const share = (within: number) =>
    round(buyers.filter((b) => b.slot <= create.slot + within).reduce((s, b) => s + b.pct, 0));
  return {
    mint,
    slot: create.slot,
    sig: create.signature,
    ts: tx0.blockTime != null ? tx0.blockTime * 1000 : null,
    creator,
    buyers,
    bundlePct: share(BUNDLE_SLOTS),
    sniperPct: share(SNIPER_SLOTS),
    truncated,
  };
}

/** Oldest first, complete back to the first transaction, or null when the history is longer than the page budget. */
export async function fetchLaunchSigs(
  mint: string,
  signal: AbortSignal,
): Promise<SigInfo[] | null> {
  const all: SigInfo[] = [];
  let before: string | undefined;
  for (let page = 0; page < MAX_SIG_PAGES; page++) {
    const got = await rpcAny<SigInfo[]>(
      "getSignaturesForAddress",
      [mint, { limit: SIG_PAGE, commitment: "confirmed", ...(before ? { before } : {}) }],
      signal,
    );
    if (!got) return null;
    all.push(...got);
    if (got.length < SIG_PAGE) return all.reverse();
    before = got[got.length - 1]!.signature;
  }
  return null;
}

export async function fetchLaunch(mint: string, signal: AbortSignal): Promise<LaunchTx | null> {
  const sigs = await fetchLaunchSigs(mint, signal);
  if (!sigs?.length) return null;
  const create = sigs[0]!;
  const wanted = sigs.filter((s) => s.err == null && s.slot <= create.slot + SNIPER_SLOTS);
  const truncated = wanted.length > MAX_TXS;
  const take = wanted.slice(0, MAX_TXS);
  const txs = new Map<string, ParsedTx>();
  for (let i = 0; i < take.length; i += 5) {
    if (signal.aborted) return null;
    const batch = take.slice(i, i + 5);
    const got = await Promise.all(
      batch.map((s) =>
        rpcAny<ParsedTx>(
          "getTransaction",
          [
            s.signature,
            { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
          ],
          signal,
        ),
      ),
    );
    got.forEach((tx, k) => {
      if (tx) txs.set(batch[k]!.signature, tx);
    });
  }
  return parseLaunch(mint, take, txs, truncated);
}
