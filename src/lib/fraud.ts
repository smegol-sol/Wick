import type { Candle, Security } from "./market";

export type FraudTag = "clean" | "wash" | "bundle" | "trap" | "spoof";
export type FraudFlag = "washVol" | "washTape" | "bundle" | "insider" | "trap" | "spoof";

export type FraudCard = {
  score: number;
  tag: FraudTag;
  flags: FraudFlag[];
};

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
  if (avgR < 0.006) return 8;
  return 0;
}

const CLEAN_SEC: Security = {
  mintable: false,
  freeze: false,
  lpBurned: true,
  honeypot: false,
  renounced: true,
  top10: 20,
  bundled: 4,
  insiders: 3,
  snipers: 4,
  devHold: 2,
};

export function fraudOf(tk: {
  vol: number;
  vol1m: number;
  mc: number;
  holders: number;
  tx: number;
  change1m: number;
  mentions: number;
  twitter: string | null;
  candles: Candle[];
  security: Security;
}): FraudCard {
  const s = tk.security ?? CLEAN_SEC;
  const flags: FraudFlag[] = [];
  let score = 0;

  if (s.honeypot || (s.onchain && s.freeze) || (s.mintable && s.freeze)) {
    score += 42;
    flags.push("trap");
  }
  if (s.bundled >= 28 || s.snipers >= 25) {
    score += 18;
    flags.push("bundle");
  }
  if (s.insiders >= 18 || s.top10 >= 48 || s.devHold >= 14) {
    score += 14;
    flags.push("insider");
  }

  const volMc = tk.mc > 0 ? tk.vol / tk.mc : 0;
  const txPer = tk.holders > 0 ? tk.tx / tk.holders : 0;
  if ((volMc >= 2.2 && tk.holders < 90) || txPer >= 8) {
    score += 16;
    flags.push("washVol");
  }
  if (tk.mc > 0 && tk.vol1m / tk.mc >= 0.12 && Math.abs(tk.change1m) < 3) {
    score += 14;
    flags.push("washTape");
  }
  const cw = candleWash(tk.candles ?? []);
  if (cw >= 12) {
    score += cw;
    if (!flags.includes("washTape")) flags.push("washTape");
  }
  if (tk.mentions >= 12 && !tk.twitter) {
    score += 8;
    flags.push("spoof");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  let tag: FraudTag = "clean";
  if (flags.includes("trap") || score >= 70) tag = "trap";
  else if (flags.includes("washVol") || flags.includes("washTape")) tag = "wash";
  else if (flags.includes("bundle") || flags.includes("insider")) tag = "bundle";
  else if (flags.includes("spoof")) tag = "spoof";
  else if (score >= 35) tag = "wash";

  return { score, tag, flags };
}

export function fraudSkip(card: FraudCard): boolean {
  return card.tag === "trap" || (card.tag === "wash" && card.score >= 55);
}
