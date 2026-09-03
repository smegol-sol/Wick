import { createFileRoute, Link } from "@tanstack/react-router";
import { Star } from "lucide-react";
import { useMemo, useState } from "react";
import { TokenMark } from "@/components/mark";
import { stat } from "@/components/token-row";
import { Button } from "@/components/ui/button";
import { formatMc, formatPct, formatUsd } from "@/lib/format";
import { snipeEdge } from "@/lib/risk";
import { filteredTokens, useDesk } from "@/lib/store";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/discover")({ component: DiscoverPage });

type Sort = "vol" | "mc" | "gain" | "tx" | "fit";

const nil = (n: number | null) => (n == null ? -1 : n);

function DiscoverPage() {
  const tokens = useDesk((s) => s.tokens);
  const settings = useDesk((s) => s.settings);
  const msg = useDesk((s) => s.msg);
  const queueSnipe = useDesk((s) => s.queueSnipe);
  const watch = useDesk((s) => s.watch);
  const toggleWatch = useDesk((s) => s.toggleWatch);
  const quick = settings.quickBuy;
  const now = useDesk((s) => s.now);
  const [sort, setSort] = useState<Sort>("fit");
  const list = useMemo(() => {
    const base = filteredTokens({ tokens, settings, now }).slice();
    base.sort((a, b) => {
      if (sort === "vol") return nil(b.vol) - nil(a.vol);
      if (sort === "mc") return b.mc - a.mc;
      if (sort === "gain") return b.change5m - a.change5m;
      if (sort === "fit") return snipeEdge(b, now) - snipeEdge(a, now);
      return nil(b.tx) - nil(a.tx);
    });
    return base;
  }, [tokens, settings, sort, now]);

  return (
    <div className="mx-auto max-w-6xl px-2 py-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="text-sm font-medium tracking-tight">{msg("scan")}</h1>
        <span className="font-mono text-2xs text-subtle">{msg("scanHint")}</span>
        {(
          [
            ["fit", msg("edge")],
            ["vol", msg("volume")],
            ["mc", msg("mcap")],
            ["gain", msg("gainers")],
            ["tx", msg("tx")],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setSort(id)}
            className={cn("h-8 rounded-sm px-2.5 text-2xs font-medium", sort === id ? "bg-elevated text-fg" : "text-muted")}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-border)]">
        <div className="hidden grid-cols-[minmax(0,1.6fr)_repeat(6,minmax(0,1fr))_auto] gap-2 border-b border-border px-3 py-2 font-mono text-2xs text-subtle md:grid">
          <span />
          <span className="text-end">{msg("mcap")}</span>
          <span className="text-end">{msg("volume")}</span>
          <span className="text-end">{msg("liquidity")}</span>
          <span className="text-end">{msg("tx")}</span>
          <span className="text-end">{msg("holders")}</span>
          <span className="text-end">{msg("vol5m")}</span>
          <span />
        </div>
        {list.length === 0 ? (
          <p className="p-4 text-sm text-muted">{msg("emptyFilter")}</p>
        ) : (
          list.map((t, i) => {
            const watching = watch.includes(t.id);
            return (
              <Link
                key={t.id}
                to="/token/$id"
                params={{ id: t.id }}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-border px-3 py-2 hover:bg-elevated/60 md:grid-cols-[minmax(0,1.6fr)_repeat(6,minmax(0,1fr))_auto]"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="hidden w-5 shrink-0 font-mono text-2xs text-subtle md:inline">{i + 1}</span>
                  <TokenMark id={t.id} symbol={t.symbol} />
                  <div className="min-w-0 overflow-hidden">
                    <div className="truncate text-sm font-medium">{t.symbol}</div>
                    <div className="truncate text-2xs text-muted">{t.name}</div>
                  </div>
                </div>
                <div className="hidden text-end font-mono text-xs num md:block">{formatMc(t.mc)}</div>
                <div className="hidden text-end font-mono text-xs num md:block">{stat(t.vol, (n) => formatUsd(n, 0))}</div>
                <div className="hidden text-end font-mono text-xs num md:block">{formatUsd(t.liq, 0)}</div>
                <div className="hidden text-end font-mono text-xs num md:block">{stat(t.tx, (n) => String(Math.round(n)))}</div>
                <div className="hidden text-end font-mono text-xs num md:block">{stat(t.holders, (n) => String(Math.round(n)))}</div>
                <div className={cn("hidden text-end font-mono text-xs num md:block", t.change5m >= 0 ? "text-up" : "text-down")}>
                  {formatPct(t.change5m)}
                </div>
                <div className="flex shrink-0 items-center justify-end gap-1">
                  <button
                    type="button"
                    className={cn("flex size-8 items-center justify-center rounded-sm text-subtle hover:text-fg", watching && "text-accent")}
                    aria-label={watching ? msg("watched") : msg("watch")}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      toggleWatch(t.id);
                    }}
                  >
                    <Star className={cn("size-3.5", watching && "fill-current")} />
                  </button>
                  <Button
                    size="sm"
                    variant="buy"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      queueSnipe(t.id);
                    }}
                  >
                    {quick}
                  </Button>
                </div>
              </Link>
            );
          })
        )}
      </div>
    </div>
  );
}
