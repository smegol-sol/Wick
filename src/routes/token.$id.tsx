import { createFileRoute, Link } from "@tanstack/react-router";
import { Star } from "lucide-react";
import { useMemo, useState } from "react";
import { CandleChart } from "@/components/candle-chart";
import { TokenMark } from "@/components/mark";
import { Scorecard } from "@/components/scorecard";
import { FraudStrip } from "@/components/fraud-card";
import { SecurityAudit } from "@/components/security-audit";
import { TradeTicket } from "@/components/trade-ticket";
import { Button } from "@/components/ui/button";
import { formatAge, formatMc, formatPct, formatTime, formatUsd, shortMint } from "@/lib/format";
import { tokenHolders, tokenPrints, tokenSmartFlow } from "@/lib/market";
import { labRow } from "@/lib/lab";
import { fraudOf } from "@/lib/fraud";
import { tokenMood } from "@/lib/sentiment";
import { nameFlowOf } from "@/lib/smart-flow";
import { MoodStrip } from "@/components/mood-strip";
import { TokenFlowList } from "@/components/smart-flow";
import { useDesk } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { Msg } from "@/lib/i18n";

export const Route = createFileRoute("/token/$id")({ component: TokenPage });

function TokenPage() {
  const { id } = Route.useParams();
  const token = useDesk((s) => s.tokens.find((t) => t.id === id));
  const now = useDesk((s) => s.now);
  const msg = useDesk((s) => s.msg);
  const watch = useDesk((s) => s.watch);
  const toggle = useDesk((s) => s.toggleWatch);
  const pos = useDesk((s) => s.positions.find((p) => p.tokenId === id));
  const wallets = useDesk((s) => s.wallets);
  const [tab, setTab] = useState<"trades" | "holders" | "snipers" | "security" | "smart">("trades");
  const [smart, setSmart] = useState(true);
  const [focus, setFocus] = useState<string | null>(null);

  const flow = useMemo(
    () => (token ? tokenSmartFlow(token, wallets) : []),
    [token, wallets],
  );
  const trackedIds = useMemo(
    () => new Set(wallets.filter((w) => w.tracked).map((w) => w.id)),
    [wallets],
  );
  const trackedFlow = useMemo(
    () => flow.filter((p) => p.walletId && trackedIds.has(p.walletId)),
    [flow, trackedIds],
  );
  const legend = useMemo(() => {
    const map = new Map<string, { id: string; name: string; buys: number; sells: number }>();
    for (const p of trackedFlow) {
      if (!p.walletId) continue;
      const cur = map.get(p.walletId) ?? { id: p.walletId, name: p.wallet ?? p.walletId, buys: 0, sells: 0 };
      if (p.side === "buy") cur.buys += 1;
      else cur.sells += 1;
      map.set(p.walletId, cur);
    }
    return [...map.values()];
  }, [trackedFlow]);

  if (!token) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted">{msg("noToken")}</p>
        <Link to="/" className="mt-3 inline-block text-sm text-accent">
          {msg("back")}
        </Link>
      </div>
    );
  }

  const prints = tokenPrints(token, now);
  const holders = tokenHolders(token);
  const card = labRow(token, now);
  const mood = tokenMood(token, wallets);
  const watched = watch.includes(token.id);
  const tabs: Array<typeof tab> = ["trades", "holders", "snipers", "smart", "security"];
  const avg = pos ? pos.costSol / Math.max(pos.amount, 1e-12) : 0;
  const marks = pos
    ? [
        { price: avg, label: msg("avg"), tone: "muted" as const },
        ...(pos.tpPct != null
          ? [
              {
                price: avg * (1 + pos.tpPct / 100),
                label:
                  pos.tpScale > 1
                    ? `${msg("sourceTp")} ${pos.tpRung}/${pos.tpScale}`
                    : msg("sourceTp"),
                tone: "up" as const,
              },
            ]
          : []),
        ...(pos.slPct != null
          ? [
              {
                price: pos.trailOn
                  ? Math.max(
                      0,
                      Math.max(pos.peakPrice || avg, token.price, avg) * (1 - pos.slPct / 100),
                    )
                  : Math.max(0, avg * (1 - pos.slPct / 100)),
                label: pos.trailOn ? msg("sourceTrail") : msg("sourceSl"),
                tone: "down" as const,
              },
            ]
          : []),
      ]
    : undefined;
  const chartPrints = smart
    ? trackedFlow
        .filter((p) => !focus || p.walletId === focus)
        .map((p) => ({
          ts: p.ts,
          price: p.price,
          side: p.side,
          label: p.wallet ?? "",
          sol: p.sol,
        }))
    : [];

  return (
    <div className="mx-auto grid max-w-6xl gap-3 p-2 lg:grid-cols-[minmax(0,1.5fr)_20rem]">
      <div className="flex min-w-0 flex-col gap-3">
        <header className="flex items-start gap-3 rounded-lg bg-surface p-3 shadow-[var(--shadow-border)]">
          <TokenMark id={token.id} symbol={token.symbol} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-medium tracking-tight">{token.symbol}</h1>
              <span className="text-sm text-muted">{token.name}</span>
              <span className="font-mono text-2xs uppercase text-subtle">{token.chain}</span>
            </div>
            <button
              className="mt-1 font-mono text-2xs text-subtle num"
              onClick={() => navigator.clipboard?.writeText(token.mint)}
            >
              {shortMint(token.mint)}
            </button>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-2xs text-muted num">
              <span>
                {msg("mcap")} {formatMc(token.mc)}
              </span>
              <span>
                {msg("liquidity")} {formatUsd(token.liq, 0)}
              </span>
              <span>
                {msg("volume")} {formatUsd(token.vol, 0)}
              </span>
              <span>
                {msg("holders")} {token.holders}
              </span>
              <span>
                {msg("age")} {formatAge(token.createdAt, now)}
              </span>
              {token.twitter ? <span className="text-accent">{token.twitter}</span> : null}
            </div>
          </div>
          <div className="text-end">
            <div className="font-mono text-lg num">{formatUsd(token.price, 6)}</div>
            <div className={cn("font-mono text-xs num", token.change5m >= 0 ? "text-up" : "text-down")}>
              {formatPct(token.change5m)}
            </div>
            <Button
              size="icon"
              variant={watched ? "primary" : "quiet"}
              className="mt-2"
              onClick={() => toggle(token.id)}
              aria-label={msg("watch")}
            >
              <Star className={cn("size-4", watched && "fill-current")} />
            </Button>
          </div>
        </header>
        <MoodStrip
          mood={mood.mood}
          score={mood.score}
          tape={mood.tape}
          social={mood.social}
          smart={mood.smart}
          tone={mood.tone}
        />
        <Scorecard row={card} />
        <FraudStrip card={fraudOf(token)} />
        <div className="overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-border)]">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
            <label className="flex items-center gap-1.5 text-2xs text-muted">
              <input
                type="checkbox"
                checked={smart}
                onChange={(e) => setSmart(e.target.checked)}
                className="accent-accent"
              />
              {msg("smartOnChart")}
            </label>
            {smart && legend.length === 0 ? (
              <span className="text-2xs text-subtle">{msg("smartEmpty")}</span>
            ) : null}
            {smart
              ? legend.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => setFocus((cur) => (cur === w.id ? null : w.id))}
                    className={cn(
                      "h-7 rounded-sm px-2 font-mono text-2xs",
                      focus === w.id ? "bg-elevated text-fg" : "text-muted hover:text-fg",
                    )}
                  >
                    <span className="text-up">{w.buys}</span>
                    <span className="mx-1 text-subtle">/</span>
                    <span className="text-down">{w.sells}</span>
                    <span className="ms-1.5">{w.name}</span>
                    {wallets.find((x) => x.id === w.id)?.hands === "paper" ? (
                      <span className="ms-1 text-down">{msg("paperHands")}</span>
                    ) : null}
                  </button>
                ))
              : null}
          </div>
          <CandleChart candles={token.candles} marks={marks} prints={chartPrints} />
        </div>
        <div className="rounded-lg bg-surface shadow-[var(--shadow-border)]">
          <div className="flex gap-1 border-b border-border px-2 py-1">
            {tabs.map((k) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={cn(
                  "h-9 rounded-sm px-3 text-xs font-medium",
                  tab === k ? "bg-elevated text-fg" : "text-muted",
                )}
              >
                {msg(k as Msg)}
              </button>
            ))}
          </div>
          <div className="p-3">
            {tab === "security" ? <SecurityAudit security={token.security} live={!!token.live} /> : null}
            {tab === "smart" ? (
              <TokenFlowList flow={nameFlowOf(token, wallets)} prints={flow} wallets={wallets} />
            ) : null}
            {tab === "holders" ? (
              <ul>
                {holders.map((h) => (
                  <li key={h.label} className="flex items-center gap-3 py-1.5">
                    <span className="w-20 text-xs text-muted">{h.label}</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-elevated">
                      <div className="h-full bg-accent" style={{ width: `${Math.min(100, h.pct)}%` }} />
                    </div>
                    <span className="w-12 text-end font-mono text-2xs num">{h.pct.toFixed(1)}%</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {tab === "snipers" ? (
              <ul>
                {prints
                  .filter((p) => p.side === "buy")
                  .slice(0, 10)
                  .map((p, i) => (
                    <li key={p.id} className="flex justify-between border-b border-border py-2 text-sm">
                      <span className="text-muted">
                        {msg("firstBuyers")} #{i + 1}
                      </span>
                      <span className="font-mono text-2xs num">
                        {p.sol.toFixed(2)} SOL · {p.wallet ?? "—"}
                      </span>
                    </li>
                  ))}
              </ul>
            ) : null}
            {tab === "trades" ? (
              <ul>
                {trackedFlow.slice(0, 8).map((p) => (
                  <li key={p.id} className="flex items-center justify-between border-b border-border py-1.5">
                    <span className={cn("text-xs font-medium", p.side === "buy" ? "text-up" : "text-down")}>
                      {p.side === "buy" ? msg("buy") : msg("sell")}
                    </span>
                    <span className="truncate px-2 text-xs text-accent">{p.wallet}</span>
                    <span className="font-mono text-2xs text-muted num">{p.sol.toFixed(3)} SOL</span>
                  </li>
                ))}
                {prints.map((p) => (
                  <li key={p.id} className="flex items-center justify-between border-b border-border py-1.5">
                    <span className={cn("text-xs font-medium", p.side === "buy" ? "text-up" : "text-down")}>
                      {p.side === "buy" ? msg("buy") : msg("sell")}
                    </span>
                    <span className="truncate px-2 text-2xs text-subtle">{p.wallet ?? "—"}</span>
                    <span className="font-mono text-2xs text-muted num">{p.sol.toFixed(3)} SOL</span>
                    <span className="font-mono text-2xs text-subtle num">{formatTime(p.ts)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      </div>
      <div className="lg:sticky lg:top-16">
        <TradeTicket token={token} />
      </div>
    </div>
  );
}