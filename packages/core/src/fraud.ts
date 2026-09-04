import type { Candle, Security } from "./market.ts";

export type FraudTag = "clean" | "wash" | "insider" | "trap" | "spoof";
export type FraudFlag = "washVol" | "washTape" | "insider" | "trap" | "spoof";

export type FraudCard = {
  score: number;
  tag: FraudTag;
  flags: FraudFlag[];
  /** How many of the checks had data. 0 means the card says nothing. */
  checked: number;
};

/** Flat candles with volume: price pinned while prints flow. */
export function candleWash(candles: Candle[]): number {
  const last = candles.slice(-8);
  if (last.length < 4) return 0;
  let vol = 0;
  let range = 0;
  let n = 0;
  for (const c of last) {
    if (!(c.c > 0)) continue;
    vol += c.v;
    range += (c.h - c.l) / c.c;
    n += 1;
  }
  if (!n) return 0;
  const avgR = range / n;
  const avgV = vol / n;
  if (avgV > 0 && avgR < 0.01) return 18;
  return 0;
}

export type FraudInput = {
  vol: number | null;
  vol5m: number | null;
  mc: number;
  holders: number | null;
  tx: number | null;
  change5m: number;
  mentions: number;
  twitter: string | null;
  candles: Candle[];
  security: Security;
  stage: "new" | "bonding" | "migrated";
};

/**
 * Heuristics over reported numbers only. A check whose inputs are unknown is
 * skipped and does not count toward the score.
 */
export function fraudOf(tk: FraudInput): FraudCard {
  const s = tk.security;
  const flags: FraudFlag[] = [];
  let score = 0;
  let checked = 0;

  if (s.onchain) {
    checked += 1;
    if (s.freeze || (s.mintable && tk.stage === "migrated")) {
      score += 42;
      flags.push("trap");
    }
  }
  if (s.top10 != null) {
    checked += 1;
    if (s.top10 >= 48) {
      score += 14;
      flags.push("insider");
    }
  }
  if (tk.vol != null && tk.mc > 0) {
    checked += 1;
    const volMc = tk.vol / tk.mc;
    const txPer = tk.tx != null && tk.holders != null && tk.holders > 0 ? tk.tx / tk.holders : null;
    if ((volMc >= 2.2 && tk.holders != null && tk.holders < 90) || (txPer != null && txPer >= 8)) {
      score += 16;
      flags.push("washVol");
    }
  }
  if (tk.vol5m != null && tk.mc > 0) {
    checked += 1;
    if (tk.vol5m / tk.mc >= 0.12 && Math.abs(tk.change5m) < 3) {
      score += 14;
      flags.push("washTape");
    }
  }
  if (tk.candles.length >= 4) {
    checked += 1;
    const cw = candleWash(tk.candles);
    if (cw >= 12) {
      score += cw;
      if (!flags.includes("washTape")) flags.push("washTape");
    }
  }
  checked += 1;
  if (tk.mentions >= 12 && !tk.twitter) {
    score += 8;
    flags.push("spoof");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  let tag: FraudTag = "clean";
  if (flags.includes("trap") || score >= 70) tag = "trap";
  else if (flags.includes("washVol") || flags.includes("washTape")) tag = "wash";
  else if (flags.includes("insider")) tag = "insider";
  else if (flags.includes("spoof")) tag = "spoof";
  else if (score >= 35) tag = "wash";

  return { score, tag, flags, checked };
}

export function fraudSkip(card: FraudCard): boolean {
  return card.tag === "trap" || (card.tag === "wash" && card.score >= 55);
}
