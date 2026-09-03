import type { Hands, Token, Wallet } from "./market";
import { tokenSmartFlow } from "./market";

export type FlowBias = "accumulate" | "distribute" | "mixed" | "idle";

export interface DeskFlow {
  walletId: string;
  name: string;
  hands: Hands;
  tracked: boolean;
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
  steelNet: number;
  paperNet: number;
  bias: FlowBias;
  desks: number;
}

export interface BookFlow {
  desks: DeskFlow[];
  names: NameFlow[];
  steelNet: number;
  paperNet: number;
  bias: FlowBias;
}

export function flowBias(net: number, tot: number): FlowBias {
  if (!(tot >= 0.25)) return "idle";
  const r = net / tot;
  if (r >= 0.28) return "accumulate";
  if (r <= -0.28) return "distribute";
  return "mixed";
}

export function nameFlowOf(tk: Token, wallets: Wallet[]): NameFlow {
  const desk = wallets.filter((w) => w.tracked);
  const used = desk.length ? desk : wallets;
  const byId = new Map(used.map((w) => [w.id, w]));
  let buySol = 0;
  let sellSol = 0;
  let steelNet = 0;
  let paperNet = 0;
  const seen = new Set<string>();
  for (const p of tokenSmartFlow(tk, used)) {
    if (p.side === "buy") buySol += p.sol;
    else sellSol += p.sol;
    const w = p.walletId ? byId.get(p.walletId) : undefined;
    const signed = p.side === "buy" ? p.sol : -p.sol;
    if (w?.hands === "steel") steelNet += signed;
    else if (w?.hands === "paper") paperNet += signed;
    if (p.walletId) seen.add(p.walletId);
  }
  const net = buySol - sellSol;
  return {
    tokenId: tk.id,
    symbol: tk.symbol,
    buySol,
    sellSol,
    net,
    steelNet,
    paperNet,
    bias: flowBias(net, buySol + sellSol),
    desks: seen.size,
  };
}

export function bookSmartFlow(tokens: Token[], wallets: Wallet[]): BookFlow {
  const desk = wallets.filter((w) => w.tracked);
  const used = desk.length ? desk : wallets;
  const byId = new Map(used.map((w) => [w.id, w]));
  const deskMap = new Map<string, DeskFlow>();
  for (const w of used) {
    deskMap.set(w.id, {
      walletId: w.id,
      name: w.name,
      hands: w.hands,
      tracked: w.tracked,
      buySol: 0,
      sellSol: 0,
      net: 0,
      names: 0,
    });
  }
  const names: NameFlow[] = [];
  let steelNet = 0;
  let paperNet = 0;
  for (const tk of tokens) {
    const prints = tokenSmartFlow(tk, used);
    let buySol = 0;
    let sellSol = 0;
    let sNet = 0;
    let pNet = 0;
    const seen = new Set<string>();
    for (const p of prints) {
      if (p.side === "buy") buySol += p.sol;
      else sellSol += p.sol;
      const w = p.walletId ? byId.get(p.walletId) : undefined;
      const signed = p.side === "buy" ? p.sol : -p.sol;
      if (w?.hands === "steel") sNet += signed;
      else if (w?.hands === "paper") pNet += signed;
      if (!p.walletId) continue;
      const d = deskMap.get(p.walletId);
      if (!d) continue;
      if (p.side === "buy") d.buySol += p.sol;
      else d.sellSol += p.sol;
      if (!seen.has(p.walletId)) {
        seen.add(p.walletId);
        d.names += 1;
      }
    }
    steelNet += sNet;
    paperNet += pNet;
    names.push({
      tokenId: tk.id,
      symbol: tk.symbol,
      buySol,
      sellSol,
      net: buySol - sellSol,
      steelNet: sNet,
      paperNet: pNet,
      bias: flowBias(buySol - sellSol, buySol + sellSol),
      desks: seen.size,
    });
  }
  const desks = [...deskMap.values()].map((d) => ({ ...d, net: d.buySol - d.sellSol }));
  desks.sort((a, b) => b.net - a.net);
  names.sort((a, b) => Math.abs(b.steelNet) - Math.abs(a.steelNet) || b.net - a.net);
  const tot = names.reduce((a, n) => a + n.buySol + n.sellSol, 0);
  const net = names.reduce((a, n) => a + n.net, 0);
  return { desks, names, steelNet, paperNet, bias: flowBias(net, tot) };
}
