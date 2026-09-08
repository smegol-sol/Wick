/**
 * Mirror-follow bookkeeping (ENGINE §9), pure: the copy gap of a print and
 * the demotion rule for a followed wallet.
 *
 * ENGINE says a wallet is demoted when gap plus slippage exceed its profit
 * over the last 10 copies. The copies' 30-minute outcomes are measured from
 * our modelled or real fill, so the gap and the slippage are already inside
 * them: a wallet is demoted when the mean signed outcome of its last ten
 * measured copies is negative. Only the owner follows it again.
 */
export const MIRROR_DEMOTION_COPIES = 10;

/** Milliseconds between the print's block time and the moment we saw it. */
export function copyGapMs(printTs: number | null, seenAt: number): number | null {
  if (printTs == null) return null;
  return Math.max(0, seenAt - printTs);
}

export type CopyOutcome = { retPct: number | null };

export type Demotion = {
  demote: boolean;
  copies: number;
  meanRetPct: number | null;
  reason: string;
};

export function mirrorDemotion(
  lastCopies: CopyOutcome[],
  minCopies = MIRROR_DEMOTION_COPIES,
): Demotion {
  const measured = lastCopies.map((c) => c.retPct).filter((r): r is number => r != null);
  if (measured.length < minCopies)
    return {
      demote: false,
      copies: measured.length,
      meanRetPct: measured.length ? round(mean(measured)) : null,
      reason: `${measured.length} measured copies, ${minCopies} needed`,
    };
  const recent = measured.slice(-minCopies);
  const m = round(mean(recent));
  return m < 0
    ? {
        demote: true,
        copies: recent.length,
        meanRetPct: m,
        reason: `mean ${m}% over the last ${recent.length} copies`,
      }
    : {
        demote: false,
        copies: recent.length,
        meanRetPct: m,
        reason: `mean +${m}% over the last ${recent.length} copies`,
      };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const round = (v: number) => Math.round(v * 1000) / 1000;
