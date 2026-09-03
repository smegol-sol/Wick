import { Link } from "@tanstack/react-router";
import { Crosshair, Star } from "lucide-react";
import { TokenMark } from "./mark";
import { Button } from "./ui/button";
import { CLUSTER_MSG, clusterOf } from "@/lib/cluster";
import type { Token } from "@/lib/market";
import { isRug, riskScore } from "@/lib/market";
import { riskGrade, tokenQuality } from "@/lib/risk";
import { formatAge, formatMc, formatPct, formatUsd, stat } from "@/lib/format";
import { useDesk } from "@/lib/store";
import { cn } from "@/lib/utils";

function Spark({ token }: { token: Token }) {
  const pts = token.candles.slice(-16);
  if (pts.length < 2) return null;
  const min = Math.min(...pts.map((c) => c.l));
  const max = Math.max(...pts.map((c) => c.h));
  const span = max - min || 1;
  const d = pts
    .map((c, i) => {
      const x = (i / (pts.length - 1)) * 56;
      const y = 16 - ((c.c - min) / span) * 16;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  const up = pts[pts.length - 1].c >= pts[0].o;
  return (
    <svg viewBox="0 0 56 16" className="h-4 w-14" aria-hidden>
      <path
        d={d}
        fill="none"
        stroke={up ? "var(--color-up)" : "var(--color-down)"}
        strokeWidth="1.4"
      />
    </svg>
  );
}

export function TokenRow({ token, dense }: { token: Token; dense?: boolean }) {
  const now = useDesk((s) => s.now);
  const quick = useDesk((s) => s.settings.quickBuy);
  const autoSnipe = useDesk((s) => s.settings.snipeMigrate);
  const autoLaunch = useDesk((s) => s.settings.snipeLaunch);
  const snipeLive = useDesk((s) => s.settings.snipeLive);
  const queueSnipe = useDesk((s) => s.queueSnipe);
  const armed = useDesk((s) => s.armedSnipes.includes(token.id));
  const recent = useDesk((s) => s.recentMigrated.some((r) => r.id === token.id));
  const sniped = useDesk((s) => s.recentSniped.some((r) => r.id === token.id));
  const toggleArm = useDesk((s) => s.toggleArmSnipe);
  const toggleWatch = useDesk((s) => s.toggleWatch);
  const watching = useDesk((s) => s.watch.includes(token.id));
  const msg = useDesk((s) => s.msg);
  const risk = riskScore(token.security);
  const grade = riskGrade(tokenQuality(token.security, token.liq));
  const topic = clusterOf(token.symbol, token.name);
  const rug = isRug(token.security);
  const imminent = token.stage === "bonding" && token.bonding >= 80;
  const sniping = snipeLive && (autoSnipe || armed || (autoLaunch && token.stage === "new"));

  return (
    <Link
      to="/token/$id"
      params={{ id: token.id }}
      className={cn(
        "grid items-center gap-2 border-b border-border/80 px-3 py-2.5 text-fg transition-[background-color] duration-150 hover:bg-elevated/80",
        dense
          ? "grid-cols-[auto_minmax(0,1fr)_auto_auto]"
          : "grid-cols-[auto_minmax(0,1.2fr)_auto_auto_auto] md:grid-cols-[auto_minmax(0,1.4fr)_repeat(5,minmax(0,1fr))_auto]",
        recent && "bg-elevated/80",
        sniped && "bg-elevated/80",
        imminent && sniping && "bg-elevated/40",
      )}
    >
      <TokenMark id={token.id} symbol={token.symbol} />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium tracking-tight">{token.symbol}</span>
          <span className="font-mono text-2xs text-subtle">{msg(CLUSTER_MSG[topic])}</span>
          {imminent ? (
            autoSnipe && snipeLive ? (
              <Crosshair className="size-3.5 text-accent" aria-hidden />
            ) : (
              <button
                type="button"
                className={cn("text-subtle", armed && "text-accent")}
                aria-label={armed ? msg("snipeArmed") : msg("armSnipe")}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  toggleArm(token.id);
                }}
              >
                <Crosshair className="size-3.5" />
              </button>
            )
          ) : null}
          {sniped ? <span className="text-2xs text-accent">{msg("snipeFilled")}</span> : null}
          {recent ? <span className="text-2xs text-up">{msg("migratedNow")}</span> : null}
          {rug ? <span className="text-2xs text-down">{msg("flagged")}</span> : null}
        </div>
        <div className="flex items-center gap-2 text-2xs text-muted">
          <span className="num">{formatAge(token.createdAt, now)}</span>
          <span className="num">{formatMc(token.mc)}</span>
          {token.stage !== "migrated" ? (
            <span className="num">{token.bonding.toFixed(0)}%</span>
          ) : null}
          {token.twitter ? <span className="text-accent">{token.twitter}</span> : null}
        </div>
        {token.stage !== "migrated" ? (
          <div className="mt-1 h-0.5 overflow-hidden rounded-full bg-elevated">
            <div className="h-full bg-accent" style={{ width: `${token.bonding}%` }} />
          </div>
        ) : null}
      </div>
      {dense ? null : (
        <>
          <div className="hidden text-end md:block">
            <div className="font-mono text-2xs text-muted">{msg("mcap")}</div>
            <div className="font-mono text-xs num">{formatMc(token.mc)}</div>
          </div>
          <div className="hidden text-end md:block">
            <div className="font-mono text-2xs text-muted">{msg("volume")}</div>
            <div className="font-mono text-xs num">{stat(token.vol, (n) => formatUsd(n, 0))}</div>
          </div>
          <div className="hidden text-end sm:block">
            <div className="font-mono text-2xs text-muted">{msg("liquidity")}</div>
            <div className="font-mono text-xs num">{formatUsd(token.liq, 0)}</div>
          </div>
          <div className="hidden text-end lg:block">
            <Spark token={token} />
          </div>
        </>
      )}
      <div className="text-end">
        <div
          className={cn(
            "font-mono text-sm font-medium num",
            token.change5m >= 0 ? "text-up" : "text-down",
          )}
        >
          {token.statsAt == null && token.change5m === 0 ? "n/a" : formatPct(token.change5m)}
        </div>
        <div className="font-mono text-2xs text-muted num">{formatUsd(token.price, 6)}</div>
      </div>
      <div className="flex items-center justify-end gap-1">
        <button
          type="button"
          className={cn(
            "flex size-11 items-center justify-center rounded-sm text-subtle hover:text-fg",
            watching && "text-accent",
          )}
          aria-label={watching ? msg("watched") : msg("watch")}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleWatch(token.id);
          }}
        >
          <Star className={cn("size-3.5", watching && "fill-current")} />
        </button>
        <span
          className={cn(
            "hidden font-mono text-2xs sm:inline",
            grade === "F" || grade === "D" ? "text-down" : grade === "A" ? "text-up" : "text-muted",
          )}
          title={`${msg("audit")} ${risk.toFixed(0)}`}
        >
          {grade}
        </span>
        <Button
          size="sm"
          variant="quiet"
          className="min-w-11 font-mono text-up"
          title={snipeLive ? msg("quickHint") : msg("snipeLiveOff")}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            queueSnipe(token.id);
          }}
        >
          {quick}
        </Button>
      </div>
    </Link>
  );
}

export function PulseColumn({
  title,
  tokens,
  empty,
  fill,
}: {
  title: string;
  tokens: Token[];
  empty?: string;
  fill?: boolean;
}) {
  const msg = useDesk((s) => s.msg);
  return (
    <section
      className={cn("panel flex min-w-0 flex-col", fill ? "min-h-0 flex-1 overflow-hidden" : "")}
    >
      <header className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <h2 className="kicker">{title}</h2>
        <span className="font-mono text-2xs text-subtle num">{tokens.length}</span>
      </header>
      <div className={fill ? "scroll-y min-h-0 flex-1" : ""}>
        {tokens.length === 0 ? (
          <p className="p-4 text-2xs text-muted">{empty ?? msg("emptyFilter")}</p>
        ) : (
          tokens.map((tk) => <TokenRow key={tk.id} token={tk} dense />)
        )}
      </div>
    </section>
  );
}
