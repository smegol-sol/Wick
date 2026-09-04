import { createFileRoute, Link } from "@tanstack/react-router";
import { Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CandleChart } from "@/components/candle-chart";
import { TokenMark } from "@/components/mark";
import { Scorecard } from "@/components/scorecard";
import { FraudStrip } from "@/components/fraud-card";
import { SecurityAudit } from "@/components/security-audit";
import { TradeTicket } from "@/components/trade-ticket";
import { Button } from "@/components/ui/button";
import { formatAge, formatMc, formatPct, formatUsd, shortMint, stat } from "@wick/core/format";
import { labRow } from "@/lib/lab";
import { fraudOf } from "@wick/core/fraud";
import type { HolderInfo } from "@wick/core/market";
import { tokenMood } from "@wick/core/sentiment";
import { followPrints, nameFlowOf, printsFor } from "@wick/core/smart-flow";
import { MoodStrip } from "@/components/mood-strip";
import { TokenFlowList } from "@/components/smart-flow";
import { useDesk } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { Msg } from "@/lib/i18n";

export const Route = createFileRoute("/token/$id")({ component: TokenPage });

const HOLDERS_TTL = 30_000;

function useHolders(mint: string | undefined): HolderInfo | null {
  const cached = useDesk((s) => (mint ? (s.holderInfo[mint] ?? null) : null));
  const setHolderInfo = useDesk((s) => s.setHolderInfo);
  useEffect(() => {
    if (!mint) return;
    let stop = false;
    const pull = () => {
      const cur = useDesk.getState().holderInfo[mint];
      if (cur && Date.now() - cur.at < HOLDERS_TTL) return;
      void fetch(`/api/holders?mint=${encodeURIComponent(mint)}`)
        .then((r) => (r.ok ? (r.json() as Promise<HolderInfo>) : null))
        .then((info) => {
          if (!stop && info && info.mint === mint) setHolderInfo({ ...info, at: Date.now() });
        })
        .catch(() => undefined);
    };
    pull();
    const id = window.setInterval(pull, HOLDERS_TTL);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [mint, setHolderInfo]);
  return cached;
}

function TokenPage() {
  const { id } = Route.useParams();
  const token = useDesk((s) => s.tokens.find((t) => t.id === id));
  const now = useDesk((s) => s.now);
  const msg = useDesk((s) => s.msg);
  const watch = useDesk((s) => s.watch);
  const toggle = useDesk((s) => s.toggleWatch);
  const cx = useDesk((s) => s.chainExits.find((e) => e.tokenId === id));
  const hold = useDesk((s) => s.chainHoldings.find((h) => h.mint === token?.mint));
  const solUsd = useDesk((s) => s.solUsd);
  const follows = useDesk((s) => s.follows);
  const followTape = useDesk((s) => s.followTape);
  const holders = useHolders(token?.mint);
  const [tab, setTab] = useState<"smart" | "holders" | "security">("security");
  const [smart, setSmart] = useState(true);
  const [focus, setFocus] = useState<string | null>(null);

  const allPrints = useMemo(
    () => followPrints(follows, followTape, solUsd),
    [follows, followTape, solUsd],
  );
  const flow = useMemo(() => (token ? printsFor(token.mint, allPrints) : []), [token, allPrints]);
  const legend = useMemo(() => {
    const map = new Map<string, { id: string; name: string; buys: number; sells: number }>();
    for (const p of flow) {
      if (!p.walletId) continue;
      const cur = map.get(p.walletId) ?? {
        id: p.walletId,
        name: p.wallet ?? p.walletId,
        buys: 0,
        sells: 0,
      };
      if (p.side === "buy") cur.buys += 1;
      else cur.sells += 1;
      map.set(p.walletId, cur);
    }
    return [...map.values()];
  }, [flow]);

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

  const card = labRow(token, now);
  const mood = tokenMood(token, allPrints);
  const watched = watch.includes(token.id);
  const tabs: Array<typeof tab> = ["security", "holders", "smart"];
  const avg = cx && hold && cx.basisSol > 0 && solUsd ? (cx.basisSol * solUsd) / hold.amount : 0;
  const marks =
    cx && hold
      ? [
          ...(avg > 0 ? [{ price: avg, label: msg("avg"), tone: "muted" as const }] : []),
          ...(cx.tpPct != null && avg > 0
            ? [
                {
                  price: avg * (1 + cx.tpPct / 100),
                  label:
                    cx.tpScale > 1
                      ? `${msg("sourceTp")} ${cx.tpRung}/${cx.tpScale}`
                      : msg("sourceTp"),
                  tone: "up" as const,
                },
              ]
            : []),
          ...(cx.slPct != null
            ? [
                {
                  price: cx.trailOn
                    ? Math.max(
                        0,
                        Math.max(cx.peakPrice || avg, token.price, avg) * (1 - cx.slPct / 100),
                      )
                    : Math.max(0, (avg || token.price) * (1 - cx.slPct / 100)),
                  label: cx.trailOn ? msg("sourceTrail") : msg("sourceSl"),
                  tone: "down" as const,
                },
              ]
            : []),
        ]
      : undefined;
  const chartPrints = smart
    ? flow
        .filter((p) => (!focus || p.walletId === focus) && p.price > 0)
        .map((p) => ({ ts: p.ts, price: p.price, side: p.side, label: p.wallet ?? "", sol: p.sol }))
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
              <span className="font-mono text-2xs uppercase text-subtle">{token.stage}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-3 font-mono text-2xs text-subtle num">
              <button onClick={() => navigator.clipboard?.writeText(token.mint)}>
                {shortMint(token.mint)}
              </button>
              <a
                href={`https://solscan.io/token/${token.mint}`}
                target="_blank"
                rel="noreferrer"
                className="hover:text-fg"
              >
                solscan
              </a>
              <a
                href={`https://pump.fun/coin/${token.mint}`}
                target="_blank"
                rel="noreferrer"
                className="hover:text-fg"
              >
                pump.fun
              </a>
              {token.pair ? (
                <a
                  href={`https://dexscreener.com/solana/${token.pair}`}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-fg"
                >
                  dexscreener
                </a>
              ) : null}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-2xs text-muted num">
              <span>
                {msg("mcap")} {formatMc(token.mc)}
              </span>
              <span>
                {msg("liquidity")} {formatUsd(token.liq, 0)}
              </span>
              <span>
                {msg("volume")} {stat(token.vol, (n) => formatUsd(n, 0))}
              </span>
              <span>
                {msg("vol5m")} {stat(token.vol5m, (n) => formatUsd(n, 0))}
              </span>
              <span>
                {msg("tx")} {stat(token.tx, (n) => String(Math.round(n)))}
              </span>
              <span>
                {msg("holders")}{" "}
                {stat(holders?.holders ?? token.holders, (n) => String(Math.round(n)))}
              </span>
              <span>
                {msg("age")} {formatAge(token.createdAt, now)}
              </span>
              {token.twitter ? (
                <a
                  href={`https://x.com/${token.twitter.replace(/^@/, "")}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent"
                >
                  {token.twitter}
                </a>
              ) : null}
            </div>
            <p className="mt-1 font-mono text-2xs text-subtle">
              {token.statsAt ? msg("statsDex") : msg("statsNone")}
            </p>
          </div>
          <div className="text-end">
            <div className="font-mono text-lg num">{formatUsd(token.price, 6)}</div>
            <div
              className={cn("font-mono text-xs num", token.change5m >= 0 ? "text-up" : "text-down")}
            >
              {formatPct(token.change5m)} <span className="text-subtle">5m</span>
            </div>
            {token.change1h != null ? (
              <div
                className={cn(
                  "font-mono text-2xs num",
                  token.change1h >= 0 ? "text-up" : "text-down",
                )}
              >
                {formatPct(token.change1h)} <span className="text-subtle">1h</span>
              </div>
            ) : null}
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
                  </button>
                ))
              : null}
            <span className="ms-auto font-mono text-2xs text-subtle">{msg("chartHint")}</span>
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
            {tab === "security" ? (
              <SecurityAudit security={token.security} holders={holders} />
            ) : null}
            {tab === "smart" ? (
              <TokenFlowList flow={nameFlowOf(token, allPrints)} prints={flow} />
            ) : null}
            {tab === "holders" ? (
              holders && holders.top.length ? (
                <ul>
                  {holders.top.map((h, i) => (
                    <li key={h.address} className="flex items-center gap-3 py-1.5">
                      <span className="w-5 font-mono text-2xs text-subtle">{i + 1}</span>
                      <a
                        href={`https://solscan.io/account/${h.address}`}
                        target="_blank"
                        rel="noreferrer"
                        className="w-28 truncate font-mono text-2xs text-muted hover:text-fg"
                      >
                        {shortMint(h.address)}
                      </a>
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-elevated">
                        <div
                          className="h-full bg-accent"
                          style={{ width: `${Math.min(100, h.pct)}%` }}
                        />
                      </div>
                      <span className="w-14 text-end font-mono text-2xs num">
                        {h.pct.toFixed(2)}%
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">
                  {holders ? msg("holdersNoRpc") : msg("loadingHoldings")}
                </p>
              )
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
