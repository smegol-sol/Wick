import { Link } from "@tanstack/react-router";
import type { PositionView } from "@wick/core/api";
import { formatAge, formatPct, formatSol } from "@wick/core/format";
import { TokenMark } from "./mark";
import { useLang } from "@/lib/lang-context";
import { cn } from "@/lib/utils";

export function PositionRow({ p, now }: { p: PositionView; now: number }) {
  const { t } = useLang();
  const tone = p.pnlSol == null ? "text-muted" : p.pnlSol >= 0 ? "text-up" : "text-down";
  return (
    <Link
      to="/token/$mint"
      params={{ mint: p.mint }}
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0 hover:bg-elevated/50"
    >
      <TokenMark id={p.mint} symbol={p.symbol} />
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium">
          {p.symbol}
          <span className="font-mono text-2xs text-subtle num">{formatAge(p.openedAt, now)}</span>
        </div>
        <div className="font-mono text-2xs text-muted num">
          {t("cost")} {formatSol(p.costSol, 3)} · {t("trail")}{" "}
          {p.trailStopPct == null ? t("na") : `${p.trailStopPct}%`}
        </div>
      </div>
      <div className="text-end">
        <div className={cn("font-mono text-sm num", tone)}>
          {p.pnlSol == null ? t("na") : formatSol(p.pnlSol, 3)}
        </div>
        <div className={cn("font-mono text-2xs num", tone)}>
          {p.pnlPct == null ? "" : formatPct(p.pnlPct)}
        </div>
      </div>
    </Link>
  );
}
