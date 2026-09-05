/**
 * What a confirmed transaction did to the wallet, and what that does to the
 * position (ENGINE §12). Pure over balances read before and after; the
 * executor never trusts the quote for what landed.
 *
 * Prices are SOL per token. A realized price worse than the quoted one by
 * more than the slippage cap is flagged `mev-suspect` for the evaluator.
 */

export type Balances = { native: bigint; token: bigint };

export type FillInput = {
  side: "buy" | "sell";
  before: Balances;
  after: Balances;
  decimals: number;
  /** The quote's amounts in raw units: lamports on the SOL leg, base units on the token leg. */
  quote: { inAmount: string; outAmount: string };
  /** Network fee plus priority tip, lamports; excluded from the realized price when known. */
  feeLamports: number | null;
};

export type FillOut = {
  /** SOL leaving (negative) or entering (positive) the wallet, fees included. */
  solDelta: number;
  /** Tokens entering (positive) or leaving (negative). */
  tokenDelta: number;
  quotedPrice: number | null;
  realizedPrice: number | null;
  /** Positive means worse than quoted. */
  realizedSlippagePct: number | null;
};

const LAMPORTS = 1e9;

function ui(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

export function fillOf(i: FillInput): FillOut {
  const solDelta = Number(i.after.native - i.before.native) / LAMPORTS;
  const tokenDelta = ui(i.after.token - i.before.token, i.decimals);
  const qIn = Number(i.quote.inAmount);
  const qOut = Number(i.quote.outAmount);
  let quotedPrice: number | null = null;
  if (Number.isFinite(qIn) && Number.isFinite(qOut) && qIn > 0 && qOut > 0) {
    quotedPrice =
      i.side === "buy"
        ? qIn / LAMPORTS / ui(BigInt(Math.round(qOut)), i.decimals)
        : qOut / LAMPORTS / ui(BigInt(Math.round(qIn)), i.decimals);
  }
  let realizedPrice: number | null = null;
  const fee = i.feeLamports == null ? 0 : i.feeLamports / LAMPORTS;
  const solLeg = i.side === "buy" ? -solDelta - fee : solDelta + fee;
  const tokenLeg = Math.abs(tokenDelta);
  if (tokenLeg > 0 && solLeg > 0) realizedPrice = solLeg / tokenLeg;
  let realizedSlippagePct: number | null = null;
  if (quotedPrice != null && realizedPrice != null && quotedPrice > 0) {
    const worse =
      i.side === "buy" ? realizedPrice / quotedPrice - 1 : 1 - realizedPrice / quotedPrice;
    realizedSlippagePct = Math.round(worse * 1e6) / 1e4;
  }
  return { solDelta, tokenDelta, quotedPrice, realizedPrice, realizedSlippagePct };
}

export function mevSuspect(fill: FillOut, capPct: number): boolean {
  return fill.realizedSlippagePct != null && fill.realizedSlippagePct > capPct;
}

export type PositionRow = {
  mint: string;
  wallet: string;
  openedAt: number;
  costSol: number;
  qty: number;
  exits: { at: number; qty: number; sol: number }[];
  realizedPnlSol: number | null;
  status: "open" | "closing" | "closed";
};

/** Apply a fill to the open position for its mint (none when opening). Pure. */
export function applyFill(
  pos: PositionRow | null,
  fill: FillOut,
  x: { mint: string; wallet: string; at: number },
): PositionRow {
  if (fill.tokenDelta > 0) {
    const cost = Math.max(0, -fill.solDelta);
    if (!pos || pos.status === "closed")
      return {
        mint: x.mint,
        wallet: x.wallet,
        openedAt: x.at,
        costSol: cost,
        qty: fill.tokenDelta,
        exits: [],
        realizedPnlSol: null,
        status: "open",
      };
    return { ...pos, costSol: pos.costSol + cost, qty: pos.qty + fill.tokenDelta, status: "open" };
  }
  if (!pos) throw new Error("sell without a position");
  const sold = Math.min(pos.qty, -fill.tokenDelta);
  const proceeds = Math.max(0, fill.solDelta);
  const costOut = pos.qty > 0 ? (pos.costSol * sold) / pos.qty : 0;
  const left = Math.max(0, pos.qty - sold);
  const closed = left <= pos.qty * 1e-6;
  return {
    ...pos,
    costSol: closed ? 0 : pos.costSol - costOut,
    qty: closed ? 0 : left,
    exits: [...pos.exits, { at: x.at, qty: sold, sol: proceeds }],
    realizedPnlSol: (pos.realizedPnlSol ?? 0) + (proceeds - costOut),
    status: closed ? "closed" : "open",
  };
}
