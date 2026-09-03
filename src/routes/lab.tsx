import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { TokenMark } from "@/components/mark";
import { CLUSTER_MSG } from "@/lib/cluster";
import { formatMc, formatPct } from "@/lib/format";
import { clusterHeat, labBoard, type SetupKind } from "@/lib/lab";
import { fraudOf } from "@/lib/fraud";
import { marketMood } from "@/lib/sentiment";
import { bookSmartFlow, followPrints } from "@/lib/smart-flow";
import { MoodList, MoodStrip } from "@/components/mood-strip";
import { PageTabs } from "@/components/page-tabs";
import { SmartBook } from "@/components/smart-flow";
import { filteredTokens, useDesk } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { Msg } from "@/lib/i18n";

export const Route = createFileRoute("/lab")({ component: LabPage });

const KINDS: SetupKind[] = ["setup", "heat", "toxic", "watch"];

function kindMsg(k: SetupKind): Msg {
  if (k === "setup") return "setups";
  if (k === "heat") return "chasing";
  if (k === "toxic") return "toxic";
  return "labWatch";
}

function LabPage() {
  const tokens = useDesk((s) => s.tokens);
  const settings = useDesk((s) => s.settings);
  const now = useDesk((s) => s.now);
  const msg = useDesk((s) => s.msg);
  const follows = useDesk((s) => s.follows);
  const followTape = useDesk((s) => s.followTape);
  const solUsd = useDesk((s) => s.solUsd);
  const [kind, setKind] = useState<SetupKind | "all">("setup");
  const [tab, setTab] = useState<"mood" | "board" | "fraud">("mood");
  const pool = useMemo(() => filteredTokens({ tokens, settings }), [tokens, settings]);
  const prints = useMemo(() => followPrints(follows, followTape, solUsd), [follows, followTape, solUsd]);
  const rows = useMemo(() => labBoard(pool, now), [pool, now]);
  const heat = useMemo(() => clusterHeat(rows), [rows]);
  const mood = useMemo(() => marketMood(pool, prints), [pool, prints]);
  const flow = useMemo(() => bookSmartFlow(pool, follows, prints), [pool, follows, prints]);
  const dirty = useMemo(
    () =>
      pool
        .map((t) => ({ t, f: fraudOf(t) }))
        .filter((x) => x.f.tag !== "clean")
        .sort((a, b) => b.f.score - a.f.score)
        .slice(0, 12),
    [pool],
  );
  const shown = kind === "all" ? rows : rows.filter((r) => r.kind === kind);
  const counts = useMemo(() => {
    const m: Record<SetupKind, number> = { setup: 0, heat: 0, toxic: 0, watch: 0 };
    for (const r of rows) m[r.kind] += 1;
    return m;
  }, [rows]);

  return (
    <div className="mx-auto max-w-6xl px-2 py-3">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-sm font-medium tracking-tight">{msg("lab")}</h1>
        <p className="font-mono text-2xs text-subtle">{msg("labHint")}</p>
      </div>
      <PageTabs
        value={tab}
        onChange={setTab}
        items={[
          { id: "mood", label: msg("labMood") },
          { id: "board", label: msg("labBoard"), count: rows.length },
          { id: "fraud", label: msg("labFraud"), count: dirty.length },
        ]}
      />

      {tab === "mood" ? (
        <>
          <div className="mb-4">
            <MoodStrip mood={mood.mood} score={mood.score} tape={mood.tape} social={mood.social} smart={mood.smart} breadth={mood.breadth} />
          </div>
          <p className="mb-3 font-mono text-2xs text-subtle">{msg("moodSources")}</p>
          <div className="mb-4 grid gap-3 md:grid-cols-2">
            <MoodList title={msg("leaders")} rows={mood.leaders} empty={msg("emptyFilter")} />
            <MoodList title={msg("faders")} rows={mood.fades} empty={msg("emptyFade")} />
          </div>
          <SmartBook flow={flow} />
        </>
      ) : null}

      {tab === "fraud" ? (
        <>
          <h2 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">{msg("fraud")}</h2>
          <p className="mb-2 text-2xs text-subtle">{msg("fraudHint")}</p>
          <div className="mb-4 overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-border)]">
            {dirty.length === 0 ? (
              <p className="p-4 text-sm text-muted">{msg("emptyFraud")}</p>
            ) : (
              dirty.map(({ t, f }) => (
                <Link
                  key={t.id}
                  to="/token/$id"
                  params={{ id: t.id }}
                  className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 hover:bg-elevated/60"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <TokenMark id={t.id} symbol={t.symbol} />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{t.symbol}</div>
                      <div className="truncate font-mono text-2xs text-muted">{f.flags.join(" · ")}</div>
                    </div>
                  </div>
                  <div className={cn("shrink-0 text-end font-mono text-xs num", f.tag === "trap" || f.tag === "wash" ? "text-down" : "text-warn")}>
                    {f.score} {msg(f.tag === "wash" ? "wash" : f.tag === "trap" ? "trap" : f.tag === "insider" ? "insiders" : "spoofVol")}
                  </div>
                </Link>
              ))
            )}
          </div>
        </>
      ) : null}

      {tab === "board" ? (
        <>
          <div className="mb-3 flex flex-wrap gap-1">
            <button
              type="button"
              onClick={() => setKind("all")}
              className={cn("h-9 rounded-sm px-3 text-2xs font-medium", kind === "all" ? "bg-elevated text-fg" : "text-muted")}
            >
              {msg("scan")} {rows.length}
            </button>
            {KINDS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={cn("h-9 rounded-sm px-3 text-2xs font-medium", kind === k ? "bg-elevated text-fg" : "text-muted")}
              >
                {msg(kindMsg(k))} {counts[k]}
              </button>
            ))}
          </div>

          <h2 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">{msg("clusterHeat")}</h2>
          <div className="mb-4 overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-border)]">
            {heat.length === 0 ? (
              <p className="p-4 text-sm text-muted">{msg("emptyFilter")}</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-4">
                {heat.map((c) => (
                  <div key={c.cluster} className="border-b border-e border-border px-3 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs">{msg(CLUSTER_MSG[c.cluster])}</span>
                      <span className="font-mono text-2xs text-muted num">{c.n}</span>
                    </div>
                    <div className={cn("font-mono text-xs num", c.avg5m >= 0 ? "text-up" : "text-down")}>{formatPct(c.avg5m)}</div>
                    {c.hot ? <div className="text-2xs text-warn">{msg("chasing")}</div> : null}
                  </div>
                ))}
              </div>
            )}
          </div>

          <h2 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">{kind === "all" ? msg("scan") : msg(kindMsg(kind))}</h2>
          <div className="overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-border)]">
            <div className="hidden grid-cols-[minmax(0,1.4fr)_repeat(6,minmax(0,1fr))] gap-2 border-b border-border px-3 py-2 font-mono text-2xs text-subtle md:grid">
              <span />
              <span className="text-end">{msg("grade")}</span>
              <span className="text-end">{msg("edge")}</span>
              <span className="text-end">{msg("drawdown")}</span>
              <span className="text-end">{msg("volMc")}</span>
              <span className="text-end">{msg("pressure")}</span>
              <span className="text-end">{msg("mcap")}</span>
            </div>
            {shown.length === 0 ? (
              <p className="p-4 text-sm text-muted">{msg("emptyFilter")}</p>
            ) : (
              shown.slice(0, 40).map((r) => {
                const tk = tokens.find((t) => t.id === r.tokenId);
                return (
                  <Link
                    key={r.tokenId}
                    to="/token/$id"
                    params={{ id: r.tokenId }}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-border px-3 py-2 hover:bg-elevated/60 md:grid-cols-[minmax(0,1.4fr)_repeat(6,minmax(0,1fr))]"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <TokenMark id={r.tokenId} symbol={r.symbol} />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{r.symbol}</div>
                        <div className="truncate font-mono text-2xs text-muted">
                          {msg(CLUSTER_MSG[r.cluster])}
                          <span className="ms-2">{msg(kindMsg(r.kind))}</span>
                        </div>
                      </div>
                    </div>
                    <div className={cn("text-end font-mono text-xs num", r.grade === "F" || r.grade === "D" ? "text-down" : "text-up")}>{r.grade}</div>
                    <div className="hidden text-end font-mono text-2xs num md:block">{r.edge.toFixed(1)}</div>
                    <div className="hidden text-end font-mono text-2xs num text-down md:block">{formatPct(-r.dd * 100)}</div>
                    <div className="hidden text-end font-mono text-2xs num md:block">{r.volMc == null ? "n/a" : r.volMc.toFixed(2)}</div>
                    <div className={cn("hidden text-end font-mono text-2xs num md:block", r.pressure >= 0 ? "text-up" : "text-down")}>
                      {formatPct(r.pressure * 100, 0)}
                    </div>
                    <div className="text-end font-mono text-2xs text-muted num">{tk ? formatMc(tk.mc) : "—"}</div>
                  </Link>
                );
              })
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
