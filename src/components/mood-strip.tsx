import { Link } from "@tanstack/react-router";
import type { TokenMood, Mood, Tone } from "@/lib/sentiment";
import { formatPct } from "@/lib/format";
import { useDesk } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { Msg } from "@/lib/i18n";

const MOOD_MSG: Record<Mood, Msg> = {
  euphoria: "moodEuphoria",
  greed: "moodGreed",
  neutral: "moodNeutral",
  fear: "moodFear",
  capitulation: "moodCapitulation",
};

const TONE_MSG: Record<Tone, Msg> = {
  stealth: "toneStealth",
  aligned: "toneAligned",
  fade: "toneFade",
  dead: "toneDead",
};

function Bar({ label, value, signed }: { label: string; value: number; signed?: boolean }) {
  const pct = signed ? (value + 1) * 50 : value * 100;
  const fill = Math.max(2, Math.min(100, pct));
  const tone = signed ? (value > 0.08 ? "bg-up" : value < -0.08 ? "bg-down" : "bg-muted") : "bg-accent";
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-2xs text-muted">{label}</span>
        <span className={cn("font-mono text-2xs num", signed && value > 0.08 && "text-up", signed && value < -0.08 && "text-down")}>
          {signed ? formatPct(value * 100) : `${Math.round(value * 100)}`}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-elevated">
        <div className={cn("h-full", tone)} style={{ width: `${fill}%` }} />
      </div>
    </div>
  );
}

export function MoodStrip({
  mood,
  score,
  tape,
  social,
  smart,
  tone,
  breadth,
}: {
  mood: Mood;
  score: number;
  tape: number;
  social: number;
  smart: number;
  tone?: Tone;
  breadth?: number;
}) {
  const msg = useDesk((s) => s.msg);
  const hot = mood === "euphoria" || mood === "greed";
  const cold = mood === "fear" || mood === "capitulation";
  return (
    <div className="rounded-lg bg-surface p-3 shadow-[var(--shadow-border)]">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-2xs text-muted">{msg("sentiment")}</div>
          <div className={cn("text-sm font-medium tracking-wide uppercase", hot && "text-up", cold && "text-down")}>
            {msg(MOOD_MSG[mood])}
          </div>
        </div>
        <div className="text-end">
          <div className={cn("font-mono text-lg num", score >= 0 ? "text-up" : "text-down")}>
            {score >= 0 ? "+" : ""}
            {score.toFixed(0)}
          </div>
          {tone ? <div className="text-2xs text-subtle">{msg(TONE_MSG[tone])}</div> : null}
          {breadth != null ? (
            <div className="font-mono text-2xs text-muted num">
              {msg("breadth")} {formatPct(breadth * 100)}
            </div>
          ) : null}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Bar label={msg("pressure")} value={tape} signed />
        <Bar label={msg("social")} value={social} />
        <Bar label={msg("smart")} value={smart} signed />
      </div>
    </div>
  );
}

export function MoodList({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: TokenMood[];
  empty: string;
}) {
  const msg = useDesk((s) => s.msg);
  return (
    <div className="overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-border)]">
      <h2 className="border-b border-border px-3 py-2 text-xs font-medium tracking-wide text-muted uppercase">{title}</h2>
      {rows.length === 0 ? (
        <p className="p-4 text-sm text-muted">{empty}</p>
      ) : (
        rows.map((r) => (
          <Link
            key={r.tokenId}
            to="/token/$id"
            params={{ id: r.tokenId }}
            className="flex items-center gap-2 border-b border-border px-3 py-2 hover:bg-elevated/60"
          >
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{r.symbol}</span>
            <span className="text-2xs text-subtle">{msg(TONE_MSG[r.tone])}</span>
            <span className={cn("w-10 text-end font-mono text-xs num", r.score >= 0 ? "text-up" : "text-down")}>
              {r.score.toFixed(0)}
            </span>
          </Link>
        ))
      )}
    </div>
  );
}

export { MOOD_MSG, TONE_MSG };
