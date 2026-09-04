/**
 * Trades from a parsed transaction, program-agnostic: a signer whose balance
 * of a mint moved bought or sold that mint. Pools, curves and vaults never
 * sign, so they never appear. Wrapped SOL is not a trade leg.
 */
import type { Trade, TxSummary } from "@wick/core/chain";
import { rpcAny } from "@wick/core/rpc";
import type { ParsedTx, TokenBalance } from "./launch.ts";

export const WSOL = "So11111111111111111111111111111111111111112";

function ui(b: TokenBalance | undefined): number {
  if (!b) return 0;
  const raw = Number(b.uiTokenAmount.amount);
  return Number.isFinite(raw) ? raw / 10 ** b.uiTokenAmount.decimals : 0;
}

export function tradesOf(sig: string, tx: ParsedTx | null | undefined): Trade[] {
  if (!tx?.meta || tx.meta.err != null) return [];
  const keys = tx.transaction.message.accountKeys;
  const signers = new Map<string, number>();
  keys.forEach((k, i) => {
    if (k.signer) signers.set(k.pubkey, i);
  });
  if (!signers.size) return [];

  const pre = new Map<string, number>();
  const post = new Map<string, number>();
  const keyOf = (b: TokenBalance) => `${b.owner ?? keys[b.accountIndex]?.pubkey ?? ""}|${b.mint}`;
  for (const b of tx.meta.preTokenBalances ?? [])
    pre.set(keyOf(b), (pre.get(keyOf(b)) ?? 0) + ui(b));
  for (const b of tx.meta.postTokenBalances ?? [])
    post.set(keyOf(b), (post.get(keyOf(b)) ?? 0) + ui(b));

  const out: Trade[] = [];
  for (const key of new Set([...pre.keys(), ...post.keys()])) {
    const [wallet, mint] = key.split("|");
    if (!wallet || !mint || mint === WSOL) continue;
    const idx = signers.get(wallet);
    if (idx == null) continue;
    const delta = (post.get(key) ?? 0) - (pre.get(key) ?? 0);
    if (Math.abs(delta) < 1e-12) continue;
    const lamports = (tx.meta.preBalances[idx] ?? 0) - (tx.meta.postBalances[idx] ?? 0);
    out.push({
      sig,
      slot: tx.slot,
      ts: tx.blockTime != null ? tx.blockTime * 1000 : null,
      wallet,
      mint,
      side: delta > 0 ? "buy" : "sell",
      sol: Math.abs(lamports) / 1e9,
      amount: Math.abs(delta),
    });
  }
  return out;
}

export function summaryOf(sig: string, tx: ParsedTx | null | undefined): TxSummary | null {
  if (!tx) return null;
  const keys = tx.transaction.message.accountKeys;
  const signers = keys.filter((k) => k.signer).map((k) => k.pubkey);
  const signerSet = new Set(signers);
  const mints = new Set<string>();
  const best = new Map<string, { owner: string; amount: number }>();
  for (const b of tx.meta?.postTokenBalances ?? []) {
    if (b.mint === WSOL) continue;
    mints.add(b.mint);
    const owner = b.owner ?? keys[b.accountIndex]?.pubkey ?? "";
    if (!owner || signerSet.has(owner)) continue;
    const amount = ui(b);
    const cur = best.get(b.mint);
    if (!cur || amount > cur.amount) best.set(b.mint, { owner, amount });
  }
  const holders: Record<string, string> = {};
  for (const [mint, h] of best) holders[mint] = h.owner;
  return {
    sig,
    slot: tx.slot,
    ts: tx.blockTime != null ? tx.blockTime * 1000 : null,
    ok: tx.meta?.err == null,
    signers,
    mints: [...mints],
    holders,
  };
}

export async function fetchTx(sig: string, signal: AbortSignal): Promise<ParsedTx | null> {
  return rpcAny<ParsedTx>(
    "getTransaction",
    [sig, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }],
    signal,
  );
}
