import { isB58 } from "./guard";
import type { ChainPrint } from "./solana-wallet";
import { WSOL } from "./solana-wallet";

export const MAX_FOLLOWS = 3;

const STABLE = new Set([
  WSOL,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
]);

export type Follow = { pk: string; label: string };
export type CopyStyle = "mirror" | "shadow" | "confirm" | "scale";
export type CopyHit = { pk: string; mint: string; ts: number };

export function isFollowId(id: string): boolean {
  return isB58(id);
}

export function styleOf(raw: unknown): CopyStyle {
  return raw === "shadow" || raw === "confirm" || raw === "scale" ? raw : "mirror";
}

export function copySize(sizePct: number, maxSol: number, srcSol: number): number {
  const pct = Math.max(1, Math.min(100, sizePct)) / 100;
  const cap = Math.max(0.05, maxSol);
  return Math.min(cap, Math.max(0, srcSol) * pct);
}

/** Shadow halves. Scale skips dust and weights whales toward the cap. */
export function styleSize(style: CopyStyle, sizePct: number, maxSol: number, srcSol: number): number {
  const base = copySize(sizePct, maxSol, srcSol);
  if (style === "shadow") return base * 0.45;
  if (style === "scale") {
    if (srcSol < 0.4) return 0;
    const w = Math.min(1, Math.log1p(srcSol) / Math.log1p(20));
    return Math.min(Math.max(0.05, maxSol), base * (0.35 + 0.65 * w));
  }
  return base;
}

export function styleDelay(style: CopyStyle, delaySec: number): number {
  const d = Math.max(0, Math.min(30, delaySec));
  if (style === "shadow") return Math.max(2, d);
  if (style === "confirm") return Math.max(1, d);
  return d;
}

export type StyleSkip = "chase" | "confirm" | "dust" | null;

export function styleSkip(
  style: CopyStyle,
  args: { side: "buy" | "sell"; change5m: number; srcSol: number; confirms: number },
): StyleSkip {
  if (style === "scale" && args.side === "buy" && args.srcSol < 0.4) return "dust";
  if (style === "shadow" && args.side === "buy" && args.change5m >= 18) return "chase";
  if (style === "confirm" && args.side === "buy" && args.confirms < 1) return "confirm";
  return null;
}

const CONFIRM_MS = 90_000;

export function priorConfirms(hits: CopyHit[], pk: string, mint: string, now: number): number {
  return hits.filter((h) => h.pk === pk && h.mint === mint && now - h.ts < CONFIRM_MS).length;
}

export function bumpConfirm(hits: CopyHit[], pk: string, mint: string, now: number): CopyHit[] {
  return [...hits.filter((h) => now - h.ts < CONFIRM_MS), { pk, mint, ts: now }].slice(-40);
}

export function swapPrint(p: ChainPrint): (ChainPrint & { mint: string; side: "buy" | "sell" }) | null {
  if (p.side !== "buy" && p.side !== "sell") return null;
  if (!p.mint || !isB58(p.mint) || STABLE.has(p.mint)) return null;
  if (!(p.sol >= 0.05)) return null;
  return p as ChainPrint & { mint: string; side: "buy" | "sell" };
}

/** Newest-first tape. First cursor records the tip and copies nothing. */
export function pickNews(
  prints: ChainPrint[],
  cursor: string | null,
): { cursor: string | null; news: ChainPrint[] } {
  if (!prints.length) return { cursor, news: [] };
  const newest = prints[0]?.sig;
  if (!newest) return { cursor, news: [] };
  if (!cursor) return { cursor: newest, news: [] };
  if (newest === cursor) return { cursor, news: [] };
  const news: ChainPrint[] = [];
  let hit = false;
  for (const p of prints) {
    if (p.sig === cursor) {
      hit = true;
      break;
    }
    news.push(p);
  }
  if (!hit) return { cursor: newest, news: [prints[0]] };
  news.reverse();
  return { cursor: newest, news };
}

export function slimFollow(raw: unknown): Follow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.pk !== "string" || !isB58(r.pk)) return null;
  const label = typeof r.label === "string" ? r.label.replace(/[^\w\s.\-_$]/g, "").trim().slice(0, 24) : "";
  return { pk: r.pk, label };
}
