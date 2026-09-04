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
  /** Pool address from the venue when it has indexed one. */
  pair: string | null;
  snapshot: Snapshot;
};

/** What an audit needs besides the mint: the stage tells curve from pool, the pair says which pool. */
export type AuditRef = { mint: string; stage: Stage; pair: string | null };

export type SourceBatch = {
  source: string;
  at: number;
  tokens: SourceToken[];
  /** SOL/USD the source or a sibling reported alongside, when any. */
  solUsd: number | null;
};

/** Whoever received the mint in the first ten slots after creation (ENGINE §7). */
export type LaunchBuyer = {
  wallet: string;
  slot: number;
  /** SOL the wallet paid in that transaction; null when it was not the payer. */
  sol: number | null;
  /** Share of total supply received, percent. */
  pct: number;
};

export type LaunchTx = {
  mint: string;
  slot: number;
  sig: string;
  /** Block time of the create transaction, ms; null when the node had none. */
  ts: number | null;
  creator: string;
  buyers: LaunchBuyer[];
  /** Bought in the create slot and the next three, by any wallet, percent of supply. */
  bundlePct: number;
  /** Bought in the create slot and the next ten, percent of supply. */
  sniperPct: number;
  /** Transactions in those slots were cut at the parser's cap; the shares are a floor. */
  truncated: boolean;
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
  audit(ref: AuditRef, signal: AbortSignal): Promise<Audit | null>;
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
