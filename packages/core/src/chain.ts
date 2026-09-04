/**
 * Everything chain-specific sits behind this interface (ADR-0006). The core
 * never imports a chain SDK; one implementation per chain lives in
 * `apps/engine/src/chains/<chain>/`.
 */
import type { Audit, EngineChain, Snapshot, Stage } from "./contracts.ts";

/** A token as a source reports it, before any feature is derived. */
export type SourceToken = {
  mint: string;
  symbol: string;
  name: string;
  creator: string | null;
  createdAt: number;
  stage: Stage;
  snapshot: Snapshot;
};

export type SourceBatch = {
  source: string;
  at: number;
  tokens: SourceToken[];
  /** SOL/USD the source or a sibling reported alongside, when any. */
  solUsd: number | null;
};

export type LaunchTx = {
  mint: string;
  slot: number;
  creator: string;
  /** Buyers in the create slot and the next three, with the amount bought. */
  buyers: { wallet: string; slot: number; sol: number; tokens: number }[];
};

export type QuoteRequest = {
  side: "buy" | "sell";
  mint: string;
  amountRaw: string;
  slippageBps: number;
};

export type Quote = {
  id: string;
  at: number;
  inAmount: string;
  outAmount: string;
  impactPct: number | null;
  route: unknown;
};

export type UnsignedTx = { bytes: Uint8Array; blockhash: string; lastValidBlockHeight: number };
export type SignedTx = { bytes: Uint8Array; sig: string };
export type SimResult = { ok: boolean; err: string | null; unitsConsumed: number | null };
export type Confirmation = {
  status: "confirmed" | "failed" | "expired";
  slot: number | null;
  err: string | null;
};

/** An opaque handle to a key held in memory by the executor; never the bytes. */
export type SealedKeyHandle = {
  readonly wallet: string;
  readonly sign: (msg: Uint8Array) => Uint8Array;
};

export type SlotReading = { url: string; slot: number | null; ms: number };

export interface ChainAdapter {
  readonly chain: EngineChain;
  /** One poll of every launch and market source this chain has. */
  poll(signal: AbortSignal): Promise<SourceBatch[]>;
  /** Refresh venue stats for mints that are cooling (ADR-0007), 60 s cadence. */
  stats(mints: string[], signal: AbortSignal): Promise<Snapshot[]>;
  audit(mint: string, signal: AbortSignal): Promise<Audit | null>;
  launchTx(mint: string, signal: AbortSignal): Promise<LaunchTx | null>;
  quote(req: QuoteRequest, signal: AbortSignal): Promise<Quote | null>;
  buildTx(quote: Quote, wallet: string, signal: AbortSignal): Promise<UnsignedTx>;
  simulate(tx: UnsignedTx, signal: AbortSignal): Promise<SimResult>;
  sign(tx: UnsignedTx, key: SealedKeyHandle): Promise<SignedTx>;
  send(tx: SignedTx, signal: AbortSignal): Promise<string>;
  confirm(sig: string, timeoutMs: number, signal: AbortSignal): Promise<Confirmation>;
  balances(
    wallet: string,
    mint: string,
    signal: AbortSignal,
  ): Promise<{ native: bigint; token: bigint }>;
  /** Current slot from every configured endpoint; the engine derives slot lag. */
  slots(signal: AbortSignal): Promise<SlotReading[]>;
}
