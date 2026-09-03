import type { Token, Wallet } from "./market";
import { tokenSmartFlow } from "./market";

export type Mood = "euphoria" | "greed" | "neutral" | "fear" | "capitulation";
export type Tone = "stealth" | "aligned" | "fade" | "dead";

export interface TokenMood {
  tokenId: string;
  symbol: string;
  score: number;
  mood: Mood;
  tone: Tone;
  tape: number;
  social: number;
  smart: number;
  mentions: number;
  twitter: boolean;
}

export interface MarketMood {
  score: number;
  mood: Mood;
  tape: number;
  social: number;
  smart: number;
  breadth: number;
  leaders: TokenMood[];
  fades: TokenMood[];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function moodOf(score: number): Mood {
  if (score >= 55) return "euphoria";
  if (score >= 22) return "greed";
  if (score > -22) return "neutral";
  if (score > -55) return "fear";
  return "capitulation";
}

export function socialScore(mentions: number, twitter: boolean): number {
  const m = Math.min(1, Math.log1p(Math.max(0, mentions)) / Math.log1p(80));
  return Math.min(1, m * 0.82 + (twitter ? 0.18 : 0));
}

export function tapeScore(change1m: number, change5m: number): number {
  return clamp(0.55 * clamp(change1m / 40, -1, 1) + 0.45 * clamp(change5m / 50, -1, 1), -1, 1);
}

export function smartScore(prints: Array<{ side: "buy" | "sell"; sol: number }>): number {
  let buy = 0;
  let sell = 0;
  for (const p of prints) {
    if (p.side === "buy") buy += p.sol;
    else sell += p.sol;
  }
  const tot = buy + sell;
  if (tot < 0.05) return 0;
  return clamp((buy - sell) / tot, -1, 1);
}

export function blendScore(tape: number, social: number, smart: number): number {
  const socialSigned = clamp((social - 0.35) / 0.65, -1, 1);
  return clamp(100 * (0.4 * tape + 0.25 * socialSigned + 0.35 * smart), -100, 100);
}

export function toneOf(tape: number, social: number): Tone {
  const hotSocial = social >= 0.45;
  const hotTape = tape >= 0.12;
  const coldTape = tape <= -0.12;
  if (hotSocial && coldTape) return "fade";
  if (!hotSocial && hotTape) return "stealth";
  if (hotSocial && hotTape) return "aligned";
  return "dead";
}

export function tokenMood(tk: Token, wallets: Wallet[]): TokenMood {
  const tracked = wallets.filter((w) => w.tracked);
  const tape = tapeScore(tk.change1m, tk.change5m);
  const social = socialScore(tk.mentions, !!tk.twitter);
  const smart = smartScore(tokenSmartFlow(tk, tracked.length ? tracked : wallets));
  const score = blendScore(tape, social, smart);
  return {
    tokenId: tk.id,
    symbol: tk.symbol,
    score,
    mood: moodOf(score),
    tone: toneOf(tape, social),
    tape,
    social,
    smart,
    mentions: tk.mentions,
    twitter: !!tk.twitter,
  };
}

export function marketMood(tokens: Token[], wallets: Wallet[]): MarketMood {
  const rows = tokens.map((t) => tokenMood(t, wallets));
  const n = rows.length || 1;
  const tape = rows.reduce((a, r) => a + r.tape, 0) / n;
  const social = rows.reduce((a, r) => a + r.social, 0) / n;
  const smart = rows.reduce((a, r) => a + r.smart, 0) / n;
  const score = blendScore(tape, social, smart);
  const up = tokens.filter((t) => t.change5m > 0).length;
  return {
    score,
    mood: moodOf(score),
    tape,
    social,
    smart,
    breadth: tokens.length ? up / tokens.length : 0,
    leaders: [...rows].sort((a, b) => b.score - a.score).slice(0, 6),
    fades: rows.filter((r) => r.tone === "fade").sort((a, b) => b.social - a.social).slice(0, 6),
  };
}
