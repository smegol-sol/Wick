import { fraudOf, fraudSkip } from "./fraud";
import type { FeedItem, FeedKind, Token } from "./market";
import { isRug } from "./market";
import { tokenQuality } from "./risk";

export type TapeGrade = "signal" | "desk" | "raw";
export type TapeRank = "signal" | "desk" | "noise";

const SKIP_RE = /\bskip\b|mint not on pulse/i;
const SOL_RE = /\d+(?:\.\d+)?\s*SOL\b/i;
const ACTION_RE = /\b(fill|filled|queued|halt|TWAP|DCA|snipe|exit|sold|triggered)\b/i;
const STYLE_SKIP_RE = /^Copy (dust|chase|confirm)\b/i;

export function tapeRank(item: FeedItem): TapeRank {
  const t = item.text;
  if (STYLE_SKIP_RE.test(t) || /mint not on pulse/i.test(t)) return "noise";
  if (/copy skip fraud/i.test(t)) return "desk";
  if (SKIP_RE.test(t) && !/fraud/i.test(t)) return "noise";
  if (SOL_RE.test(t) || ACTION_RE.test(t)) return "signal";
  if (item.kind === "risk" || item.kind === "snipe") return "signal";
  return "desk";
}

export function filterTape(
  feed: FeedItem[],
  opts: {
    grade: TapeGrade;
    kind: FeedKind | "all";
    tokens: Token[];
    hideRugs: boolean;
  },
): FeedItem[] {
  const byId = new Map(opts.tokens.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const out: FeedItem[] = [];
  for (const item of feed) {
    if (opts.kind !== "all" && item.kind !== opts.kind) continue;
    const rank = tapeRank(item);
    if (opts.grade === "signal" && rank !== "signal") continue;
    if (opts.grade === "desk" && rank === "noise") continue;
    const tk = item.tokenId ? byId.get(item.tokenId) : undefined;
    if (tk && opts.grade !== "raw") {
      if (opts.hideRugs && isRug(tk.security) && item.kind !== "risk") continue;
      if (opts.grade === "signal" && item.kind !== "risk") {
        if (fraudSkip(fraudOf(tk))) continue;
        if (tokenQuality(tk.security, tk.liq) < 0.28) continue;
      }
    }
    if (opts.grade !== "raw") {
      const bucket = Math.floor(item.ts / 12_000);
      const key = `${item.tokenId ?? ""}|${item.kind}|${item.side ?? ""}|${item.text.slice(0, 28)}|${bucket}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(item);
  }
  return out;
}
