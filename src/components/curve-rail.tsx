import { Link } from "@tanstack/react-router";
import { Crosshair } from "lucide-react";
import { TokenMark } from "./mark";
import { Button } from "./ui/button";
import { useDesk, filteredTokens } from "@/lib/store";
import { cn } from "@/lib/utils";

export function CurveRail() {
  const allTokens = useDesk((s) => s.tokens);
  const settings = useDesk((s) => s.settings);
  const tokens = filteredTokens({ tokens: allTokens, settings });
  const patch = useDesk((s) => s.patchSettings);
  const armed = useDesk((s) => s.armedSnipes);
  const toggle = useDesk((s) => s.toggleArmSnipe);
  const recent = useDesk((s) => s.recentMigrated);
  const liveFills = useDesk((s) => s.liveFills);
  const queueSnipe = useDesk((s) => s.queueSnipe);
  const msg = useDesk((s) => s.msg);
  const now = useDesk((s) => s.now);
  const auto = settings.snipeMigrate;
  const quick = settings.quickBuy;

  const imminent = tokens
    .filter((t) => t.stage === "bonding" && t.bonding >= 80)
    .sort((a, b) => b.bonding - a.bonding)
    .slice(0, 6);

  const just = recent
    .map((r) => tokens.find((t) => t.id === r.id))
    .filter((t): t is NonNullable<typeof t> => Boolean(t))
    .slice(0, 2);

  return (
    <div className="panel flex flex-col gap-2 p-2 sm:flex-row sm:items-center">
      <label className="flex h-10 shrink-0 items-center gap-2 rounded-sm px-2 text-xs font-medium md:hidden">
        <input type="checkbox" checked={auto} onChange={(e) => patch({ snipeMigrate: e.target.checked })} className="size-4 accent-accent" />
        <Crosshair className="size-3.5 text-accent" />
        {msg("snipeMigrate")}
        <span className="font-mono text-2xs text-muted num">{quick} SOL</span>
        {settings.snipeLive ? <span className="font-mono text-2xs text-warn">{msg("snipeLive")}</span> : null}
      </label>
      <div className="min-w-0 overflow-x-auto overscroll-x-contain touch-pan-x sm:flex-1">
        <div className="flex w-max flex-nowrap gap-2">
          {imminent.length === 0 && just.length === 0 ? (
            <p className="flex h-10 items-center px-2 text-2xs text-muted">{msg("curveQuiet")}</p>
          ) : null}
          {imminent.map((t) => {
            const isArmed = auto || armed.includes(t.id);
            return (
              <div
                key={t.id}
                className={cn("flex h-10 shrink-0 items-center gap-2 rounded-sm bg-elevated px-2", isArmed && "outline outline-1 outline-accent/50")}
              >
                <Link to="/token/$id" params={{ id: t.id }} className="flex items-center gap-2">
                  <TokenMark id={t.id} symbol={t.symbol} className="size-6" />
                  <span className="text-xs font-medium">{t.symbol}</span>
                  <span className="font-mono text-2xs text-muted num">{t.bonding.toFixed(0)}%</span>
                </Link>
                <div className="h-1 w-8 overflow-hidden rounded-full bg-bg">
                  <div className="h-full bg-accent" style={{ width: `${t.bonding}%` }} />
                </div>
                {auto ? (
                  <span className="text-2xs text-accent">{msg("snipeArmed")}</span>
                ) : (
                  <Button size="sm" variant={isArmed ? "primary" : "quiet"} onClick={() => toggle(t.id)}>
                    {isArmed ? msg("snipeArmed") : msg("armSnipe")}
                  </Button>
                )}
              </div>
            );
          })}
          {just.map((t) => {
            const filled = liveFills.some((f) => f.mint === t.mint && f.side === "buy" && now - f.ts < 15_000);
            return (
              <div key={`m-${t.id}`} className="flex h-10 shrink-0 items-center gap-2 rounded-sm bg-elevated px-2">
                <Link to="/token/$id" params={{ id: t.id }} className="flex items-center gap-2">
                  <TokenMark id={t.id} symbol={t.symbol} className="size-6" />
                  <span className="text-xs font-medium">{t.symbol}</span>
                  <span className="text-2xs text-up">{msg("migratedNow")}</span>
                </Link>
                {filled ? (
                  <span className="text-2xs text-up">{msg("snipeFilled")}</span>
                ) : (
                  <Button size="sm" variant="buy" onClick={() => queueSnipe(t.id)}>
                    {quick}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
