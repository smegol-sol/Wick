import { WSOL } from "./solana-wallet";

const JUP = "https://lite-api.jup.ag/swap/v1";

export type JupQuote = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct?: string;
  [k: string]: unknown;
};

export async function fetchJupQuote(
  inputMint: string,
  outputMint: string,
  amount: string,
  bps: number,
  signal: AbortSignal,
): Promise<JupQuote | null> {
  const url =
    `${JUP}/quote?inputMint=${encodeURIComponent(inputMint)}` +
    `&outputMint=${encodeURIComponent(outputMint)}` +
    `&amount=${encodeURIComponent(amount)}&slippageBps=${bps}&restrictIntermediateTokens=true`;
  const res = await fetch(url, {
    signal,
    headers: { Accept: "application/json" },
    redirect: "error",
  });
  if (!res.ok) return null;
  const data = (await res.json()) as Partial<JupQuote>;
  if (typeof data.outAmount !== "string" || !data.outAmount) return null;
  if (typeof data.inAmount !== "string" || !data.inAmount) return null;
  if (typeof data.inputMint !== "string" || typeof data.outputMint !== "string") return null;
  return data as JupQuote;
}

export async function fetchJupSwap(
  quote: JupQuote,
  user: string,
  priorityLamports: number,
  signal: AbortSignal,
): Promise<{ swapTransaction: string; lastValidBlockHeight?: number } | null> {
  const res = await fetch(`${JUP}/swap`, {
    method: "POST",
    signal,
    headers: { accept: "application/json", "content-type": "application/json" },
    redirect: "error",
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: user,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: Math.round(priorityLamports),
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { swapTransaction?: string; lastValidBlockHeight?: number };
  if (typeof data.swapTransaction !== "string" || data.swapTransaction.length < 32) return null;
  if (data.swapTransaction.length > 12_000) return null;
  return {
    swapTransaction: data.swapTransaction,
    lastValidBlockHeight:
      typeof data.lastValidBlockHeight === "number" ? data.lastValidBlockHeight : undefined,
  };
}

export function jupPair(side: "buy" | "sell", mint: string): { input: string; output: string } {
  return side === "sell" ? { input: mint, output: WSOL } : { input: WSOL, output: mint };
}
