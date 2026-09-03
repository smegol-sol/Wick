import { Link } from "@tanstack/react-router";
import { Button } from "./ui/button";
import { formatPct, formatSol } from "@/lib/format";
import { sizingScale } from "@/lib/risk";
import { useDesk } from "@/lib/store";
import { cn } from "@/lib/utils";

export function RiskStrip() {
  const msg = useDesk((s) => s.msg);
  const settings = useDesk((s) => s.settings);
  const holdings = useDesk((s) => s.chainHoldings);
  const sol = useDesk((s) => s.chainSol ?? 0);
  const equity = useDesk((s) => s.equity());
  const halt = useDesk((s) => s.riskHalt);
  const streak = useDesk((s) => s.lossStreak);
  const dayStart = useDesk((s) => s.dayStart);
  const flatten = useDesk((s) => s.flattenAll);
  const resume = useDesk((s) => s.clearHalt);
  const reset = useDesk((s) => s.resetDay);
  const heat = holdings.reduce((acc, h) => acc + (h.usd ?? 0), 0);
  const names = holdings.length;
  const cap = settings.maxBookPct > 0 ? dayStart * (settings.maxBookPct / 100) : 0;
  const dd = dayStart - equity;
  const hot = halt || (settings.riskOn && dd > 0);
  const scale = sizingScale(
    settings,
    {
      riskHalt: halt,
      lossStreak: streak,
      dayStart,
      sol,
      positions: holdings.map((h) => ({ tokenId: h.mint, costSol: h.usd ?? 0, amount: h.amount })),
      marks: Math.max(0, equity - sol),
    },
    1,
  );

  return (
    <div className="mt-3 rounded-lg bg-surface p-3 shadow-[var(--shadow-border)]">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("font-mono text-2xs uppercase tracking-wide", halt ? "text-down" : "text-muted")}>
          {msg("risk")} {halt ? msg("riskHalt") : settings.riskOn ? msg("riskOk") : msg("clearExit")}
        </span>
        <span className="font-mono text-2xs text-muted num">
          {msg("heat")} {heat ? `$${heat.toFixed(0)}` : formatSol(0)}
          {cap ? ` / ${formatSol(cap)}` : ""}
        </span>
        <span className="font-mono text-2xs text-muted num">
          {msg("maxNames")} {names}
          {settings.maxPositions ? ` / ${settings.maxPositions}` : ""}
        </span>
        <span className="font-mono text-2xs text-muted num">
          {msg("streak")} {streak}
          {settings.streakHalt ? ` / ${settings.streakHalt}` : ""}
        </span>
        <span className={cn("font-mono text-2xs num", hot ? "text-down" : "text-muted")}>
          {msg("pnl")} {formatPct((dd / Math.max(dayStart, 1e-9)) * -100)}
        </span>
        {settings.riskOn ? (
          <span className="font-mono text-2xs text-muted num">
            {msg("riskScale")} ×{scale.toFixed(2)}
          </span>
        ) : null}
        <div className="ms-auto flex flex-wrap gap-1">
          {halt ? (
            <Button size="sm" variant="quiet" className="h-10" onClick={resume}>
              {msg("resumeRisk")}
            </Button>
          ) : (
            <Button size="sm" variant="sell" className="h-10" onClick={flatten}>
              {msg("flatten")}
            </Button>
          )}
          <Button size="sm" variant="quiet" className="h-10" onClick={reset}>
            {msg("resetDay")}
          </Button>
        </div>
      </div>
      {cap > 0 ? (
        <div className="mt-2 h-0.5 overflow-hidden rounded-full bg-elevated">
          <div
            className={cn("h-full", halt ? "bg-down" : "bg-accent")}
            style={{ width: `${Math.min(100, (heat / cap) * 100)}%` }}
          />
        </div>
      ) : null}
      <p className="mt-2 font-mono text-2xs text-subtle num">
        {msg("cash")} {formatSol(sol)} · {msg("maxTrade")} {settings.maxTradeSol || "—"} · {msg("maxDayLoss")}{" "}
        {settings.maxDayLoss || "—"}
      </p>
    </div>
  );
}

export function RiskChip() {
  const msg = useDesk((s) => s.msg);
  const halt = useDesk((s) => s.riskHalt);
  const on = useDesk((s) => s.settings.riskOn);
  if (!on && !halt) return null;
  return (
    <Link
      to="/book"
      className={cn(
        "hidden h-9 items-center rounded-sm px-2 font-mono text-2xs uppercase sm:flex",
        halt ? "text-down" : "text-muted",
      )}
    >
      {halt ? msg("riskHalt") : msg("risk")}
    </Link>
  );
}
