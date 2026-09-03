import { isB58 } from "./guard";

export const WSOL = "So11111111111111111111111111111111111111112";

export function isPubkey(raw: string): boolean {
  return isB58(raw);
}

export type InjectedSolana = {
  isPhantom?: boolean;
  publicKey?: { toString: () => string };
  connect: () => Promise<{ publicKey: { toString: () => string } }>;
  disconnect?: () => Promise<void>;
  signAndSendTransaction?: (
    tx: unknown,
    opts?: { skipPreflight?: boolean },
  ) => Promise<{ signature: string }>;
};

export function getInjected(): InjectedSolana | null {
  if (typeof window === "undefined") return null;
  const p = (window as Window & { solana?: InjectedSolana }).solana;
  return p && typeof p.connect === "function" ? p : null;
}

export type ChainHolding = {
  mint: string;
  amount: number;
  decimals: number;
  symbol?: string;
  name?: string;
  usd?: number | null;
  priceUsd?: number | null;
};

export type ChainBag = {
  sol: number | null;
  holdings: ChainHolding[];
  tokensOk: boolean;
};

export type ChainPrint = {
  sig: string;
  ts: number;
  side: "buy" | "sell" | "in" | "out";
  sol: number;
  mint?: string;
  amount?: number;
  symbol?: string;
};

export async function fetchChainTape(pk: string): Promise<ChainPrint[] | null> {
  try {
    const res = await fetch(`/api/sol?pk=${encodeURIComponent(pk)}&tape=1`);
    if (res.status === 429) return null;
    if (!res.ok) return null;
    const data = (await res.json()) as { prints?: ChainPrint[] };
    return Array.isArray(data.prints) ? data.prints : [];
  } catch {
    return null;
  }
}

export async function fetchChainBag(pk: string): Promise<ChainBag | null> {
  try {
    const res = await fetch(`/api/sol?pk=${encodeURIComponent(pk)}`);
    if (!res.ok && res.status !== 502) return null;
    const data = (await res.json()) as {
      sol?: number | null;
      holdings?: ChainHolding[];
      tokensOk?: boolean;
    };
    return {
      sol: typeof data.sol === "number" ? data.sol : null,
      holdings: Array.isArray(data.holdings) ? data.holdings : [],
      tokensOk: data.tokensOk !== false,
    };
  } catch {
    return null;
  }
}
