/**
 * Smart flow = swaps by the wallets you follow, read from their on-chain
 * tape. Nothing here is modelled; an empty list means they did not trade.
 */
import type { Follow } from "./live-copy";
import type { Print, Token } from "./market";
import type { ChainPrint } from "./solana-wallet";

export type FlowBias = "accumulate" | "distribute" | "mixed" | "idle";

export interface DeskFlow {
  walletId: string;
  name: string;
  buySol: number;
  sellSol: number;
  net: number;
  names: number;
}

export interface NameFlow {
  tokenId: string;
  symbol: string;
  buySol: number;
  sellSol: number;
  net: number;
  bias: FlowBias;
  desks: number;
}

export interface BookFlow {
  desks: DeskFlow[];
  names: NameFlow[];
  bias: FlowBias;
}

export function flowBias(net: number, tot: number): FlowBias {
  if (!(tot >= 0.25)) return "idle";
  const r = net / tot;
  if (r >= 0.28) return "accumulate";
  if (r <= -0.28) return "distribute";
  return "mixed";
}

function shortPk(pk: string): string {
  return pk.length < 10 ? pk : `${pk.slice(0, 4)}…${pk.slice(-4)}`;
}

/** Turn followed wallets' chain tapes into prints keyed by mint. */
export function followPrints(
  follows: Follow[],
  tape: Record<string, ChainPrint[]>,
  solUsd: number | null,
): Print[] {
  const out: Print[] = [];
  for (const f of follows) {
    for (const p of tape[f.pk] ?? []) {
      if ((p.side !== "buy" && p.side !== "sell") || !p.mint) continue;
      const price = solUsd != null && p.amount && p.amount > 0 ? (p.sol * solUsd) / p.amount : 0;
      out.push({
        id: `${f.pk}:${p.sig}`,
        ts: p.ts,
        side: p.side,
        sol: p.sol,
        price,
        mint: p.mint,
        wallet: f.label || shortPk(f.pk),
        walletId: f.pk,
      });
    }
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

export function printsFor(mint: string, prints: Print[]): Print[] {
  return prints.filter((p) => p.mint === mint);
}

export function nameFlowOf(tk: Token, prints: Print[]): NameFlow {
  let buySol = 0;
  let sellSol = 0;
  const seen = new Set<string>();
  for (const p of printsFor(tk.mint, prints)) {
    if (p.side === "buy") buySol += p.sol;
    else sellSol += p.sol;
    if (p.walletId) seen.add(p.walletId);
  }
  const net = buySol - sellSol;
  return {
    tokenId: tk.id,
    symbol: tk.symbol,
    buySol,
    sellSol,
    net,
    bias: flowBias(net, buySol + sellSol),
    desks: seen.size,
  };
}

export function bookSmartFlow(tokens: Token[], follows: Follow[], prints: Print[]): BookFlow {
  const deskMap = new Map<string, DeskFlow>();
  for (const f of follows) {
    deskMap.set(f.pk, {
      walletId: f.pk,
      name: f.label || shortPk(f.pk),
      buySol: 0,
      sellSol: 0,
      net: 0,
      names: 0,
    });
  }
  const names: NameFlow[] = [];
  const byMint = new Map(tokens.map((t) => [t.mint, t]));
  const namesPerDesk = new Map<string, Set<string>>();
  for (const p of prints) {
    const d = p.walletId ? deskMap.get(p.walletId) : undefined;
    if (!d) continue;
    if (p.side === "buy") d.buySol += p.sol;
    else d.sellSol += p.sol;
    const set = namesPerDesk.get(d.walletId) ?? new Set<string>();
    set.add(p.mint);
    namesPerDesk.set(d.walletId, set);
  }
  for (const tk of byMint.values()) {
    const row = nameFlowOf(tk, prints);
    if (row.desks > 0) names.push(row);
  }
  const desks = [...deskMap.values()].map((d) => ({
    ...d,
    net: d.buySol - d.sellSol,
    names: namesPerDesk.get(d.walletId)?.size ?? 0,
  }));
  desks.sort((a, b) => b.net - a.net);
  names.sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
  const tot = names.reduce((a, n) => a + n.buySol + n.sellSol, 0);
  const net = names.reduce((a, n) => a + n.net, 0);
  return { desks, names, bias: flowBias(net, tot) };
}
