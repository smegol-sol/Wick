/**
 * Wallet-level caps in code (ADR-0003): per transaction, per day, and the
 * maximum operating balance. None can be raised from the control panel,
 * only by a redeploy, which is the point. They sit under the tier-1 numbers
 * in risk.yaml (a 15 SOL wallet, 1.5% per trade) and catch a runaway rule
 * or a mistaken approval, not normal sizing.
 */
export const WALLET_CAPS = {
  /** SOL spent in one transaction. Tier-1 sizing tops out near 0.45 SOL (3% of 15). */
  perTxSol: 0.5,
  /** SOL spent on entries in one UTC day. */
  perDaySol: 5,
  /** The engine refuses to enter while the wallet holds more than this. */
  maxOperatingSol: 15,
} as const;

export type CapCheck = {
  side: "buy" | "sell";
  sizeSol: number;
  sentTodaySol: number;
  walletSol: number | null;
};

/** The reason the trade is refused, or null. Exits are never capped. Pure. */
export function checkCaps(c: CapCheck, caps = WALLET_CAPS): string | null {
  if (c.side === "sell") return null;
  if (c.sizeSol > caps.perTxSol)
    return `size ${c.sizeSol} SOL over the ${caps.perTxSol} SOL per-transaction cap`;
  if (c.sentTodaySol + c.sizeSol > caps.perDaySol)
    return `${round(c.sentTodaySol + c.sizeSol)} SOL today over the ${caps.perDaySol} SOL daily cap`;
  if (c.walletSol != null && c.walletSol > caps.maxOperatingSol)
    return `wallet holds ${round(c.walletSol)} SOL, over the ${caps.maxOperatingSol} SOL operating cap`;
  return null;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** The UTC day a timestamp falls in, the key the daily cap counts against. */
export function dayKeyOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
