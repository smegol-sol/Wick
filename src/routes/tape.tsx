import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { FeedKind } from "@/lib/market";
import { formatTime } from "@/lib/format";
import { filterTape, tapeRank, type TapeGrade } from "@/lib/tape";
import { useDesk } from "@/lib/store";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/tape")({ component: TapePage });

const KINDS = ["all", "smart", "snipe", "risk", "flow"] as const;
const GRADES: TapeGrade[] = ["signal", "desk", "raw"];

function TapePage() {
  const msg = useDesk((s) => s.msg);
  const feed = useDesk((s) => s.feed);
  const tokens = useDesk((s) => s.tokens);
  const hideRugs = useDesk((s) => s.settings.hideRugs);
  const [kind, setKind] = useState<FeedKind | "all">("all");
  const [grade, setGrade] = useState<TapeGrade>("desk");
  const shown = useMemo(
    () => filterTape(feed, { grade, kind, tokens, hideRugs }),
    [feed, grade, kind, tokens, hideRugs],
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col p-2">
      <h1 className="mb-1 text-sm font-medium tracking-tight">{msg("tape")}</h1>
      <p className="mb-3 text-2xs text-subtle">{msg("tapeHint")}</p>
      <section className="overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-border)]">
        <header className="flex flex-col gap-2 border-b border-border px-3 py-2">
          <div className="flex flex-wrap items-center gap-1">
            <span className="me-2 text-sm font-medium">{msg("feed")}</span>
            {GRADES.map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGrade(g)}
                className={cn(
                  "h-8 rounded-sm px-2 text-2xs font-medium tracking-wide",
                  grade === g ? "bg-fg text-bg" : "text-muted",
                )}
              >
                {g === "signal"
                  ? msg("tapeSignal")
                  : g === "desk"
                    ? msg("tapeDesk")
                    : msg("tapeRaw")}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {KINDS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={cn(
                  "h-8 rounded-sm px-2 text-2xs font-medium",
                  kind === k ? "bg-elevated text-fg" : "text-muted",
                )}
              >
                {k === "all"
                  ? msg("all")
                  : k === "smart"
                    ? msg("smart")
                    : k === "snipe"
                      ? msg("sourceSnipe")
                      : k === "risk"
                        ? msg("risk")
                        : msg("flow")}
              </button>
            ))}
          </div>
        </header>
        <div>
          {shown.length === 0 ? (
            <p className="p-4 text-sm text-muted">{msg("emptyTape")}</p>
          ) : (
            shown.map((f) => {
              const rank = tapeRank(f);
              return (
                <article key={f.id} className="border-b border-border px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2 text-2xs text-subtle">
                    <span className="flex items-center gap-2 uppercase tracking-wide">
                      <span>{f.kind}</span>
                      {rank === "signal" ? (
                        <span className="text-accent">{msg("tapeSignal")}</span>
                      ) : null}
                    </span>
                    <span className="font-mono num">{formatTime(f.ts)}</span>
                  </div>
                  {f.tokenId ? (
                    <Link
                      to="/token/$id"
                      params={{ id: f.tokenId }}
                      className="mt-1 block text-sm leading-snug hover:text-accent"
                    >
                      {f.text}
                    </Link>
                  ) : (
                    <p className="mt-1 text-sm leading-snug">{f.text}</p>
                  )}
                </article>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
