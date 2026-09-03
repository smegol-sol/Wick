import { createFileRoute, Link } from "@tanstack/react-router";
import { Copy, RefreshCw, Star } from "lucide-react";
import { useState } from "react";
import { TokenMark } from "@/components/mark";
import { PageTabs } from "@/components/page-tabs";
import { RiskStrip } from "@/components/risk-strip";
import { Button } from "@/components/ui/button";
import { WatchAddrForm } from "@/components/wallet-chip";
import { formatQty, formatSol, formatTime, formatUsd, shortMint } from "@/lib/format";
import { useDesk } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { Msg } from "@/lib/i18n";
import type { ChainHolding } from "@/lib/solana-wallet";
import type { LadderPhase } from "@/lib/entry";

export const Route = createFileRoute("/book")({ component: BookPage });

function BookPage() {
  const msg = useDesk((s) => s.msg);
  const tokens = useDesk((s) => s.tokens);
  const liveFills = useDesk((s) => s.liveFills);
  const limits = useDesk((s) => s.limits);
  const cancel = useDesk((s) => s.cancelLimit);
  const dcaPlans = useDesk((s) => s.dcaPlans);
  const cancelDca = useDesk((s) => s.cancelDca);
  const ladders = useDesk((s) => s.ladders);
  const cancelLadder = useDesk((s) => s.cancelLadder);
  const now = useDesk((s) => s.now);
  const equity = useDesk((s) => s.equity());
  const chainSol = useDesk((s) => s.chainSol);
  const holdings = useDesk((s) => s.chainHoldings);
  const [tab, setTab] = useState<"chain" | "watch" | "fills">("chain");
  const signed = liveFills.filter((f) => f.status === "ok");

  return (
    <div className="mx-auto max-w-5xl p-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label={msg("equity")} value={formatSol(equity)} hot />
        <Stat label={msg("chainSol")} value={chainSol == null ? "—" : formatSol(chainSol)} hot />
        <Stat label={msg("holdings")} value={String(holdings.length)} />
        <Stat label={msg("liveFills")} value={String(signed.length)} />
      </div>
      <p className="mt-2 font-mono text-2xs text-muted num">
        {msg("tradesN")} {liveFills.length}
      </p>
      <RiskStrip />
      <p className="mt-3 mb-1 text-2xs text-subtle">{msg("bookHint")}</p>
      <PageTabs
        value={tab}
        onChange={setTab}
        items={[
          { id: "chain", label: msg("deskChain"), count: holdings.length },
          { id: "watch", label: msg("deskWatch") },
          { id: "fills", label: msg("deskFills"), count: liveFills.length },
        ]}
      />

      {tab === "chain" ? (
        <>
          <h2 className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">
            {msg("holdings")}
          </h2>
          <p className="mb-2 font-mono text-2xs text-subtle">{msg("chainRead")}</p>
          <HoldingsPanel />
          <WalletTape />
          <LiveFillsPanel />

          <h2 className="mt-6 mb-2 text-xs font-medium tracking-wide text-muted uppercase">
            {msg("ladder")}
          </h2>
          <div className="overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-border)]">
            {ladders.filter((p) => p.status === "live").length === 0 ? (
              <p className="p-4 text-sm text-muted">{msg("ladderHint")}</p>
            ) : (
              ladders
                .filter((p) => p.status === "live")
                .map((p) => {
                  const tk = tokens.find((t) => t.id === p.tokenId);
                  const wait = Math.max(0, Math.ceil((p.nextAt - now) / 1000));
                  const phaseKey: Record<LadderPhase, Msg> = {
                    confirm: "phaseConfirm",
                    dip: "phaseDip",
                    twap: "phaseTwap",
                  };
                  const step =
                    p.phase === "confirm"
                      ? `${p.confirms}/${p.confirmNeed}`
                      : p.phase === "dip"
                        ? `${p.dipDone}/${p.dipNeed}`
                        : `${p.twapDone}/${p.twapNeed}`;
                  return (
                    <div
                      key={p.id}
                      className="flex items-center justify-between gap-2 border-b border-border px-3 py-2"
                    >
                      <Link to="/token/$id" params={{ id: p.tokenId }} className="min-w-0 text-sm">
                        {tk?.symbol ?? p.tokenId}
                        <span className="ms-2 font-mono text-2xs text-muted num">
                          {msg(phaseKey[p.phase])} {step} · {formatSol(p.budget - p.spent)} ·{" "}
                          {msg("dcaNext")} {wait}s
                          {p.pendingSol >= 0.05 ? ` · ${msg("signing")}` : ""}
                        </span>
                      </Link>
                      <Button size="sm" variant="quiet" onClick={() => cancelLadder(p.tokenId)}>
                        {msg("cancel")}
                      </Button>
                    </div>
                  );
                })
            )}
          </div>

          <h2 className="mt-6 mb-2 text-xs font-medium tracking-wide text-muted uppercase">
            {msg("dca")}
          </h2>
          <div className="overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-border)]">
            {dcaPlans.filter((p) => p.status === "live").length === 0 ? (
              <p className="p-4 text-sm text-muted">{msg("emptyTape")}</p>
            ) : (
              dcaPlans
                .filter((p) => p.status === "live")
                .map((p) => {
                  const tk = tokens.find((t) => t.id === p.tokenId);
                  const wait = Math.max(0, Math.ceil((p.nextAt - now) / 1000));
                  return (
                    <div
                      key={p.id}
                      className="flex items-center justify-between gap-2 border-b border-border px-3 py-2"
                    >
                      <Link to="/token/$id" params={{ id: p.tokenId }} className="min-w-0 text-sm">
                        {tk?.symbol ?? p.tokenId}
                        <span className="ms-2 font-mono text-2xs text-muted num">
                          {p.done}/{p.slices} · {formatSol(p.sol)} · {msg("dcaNext")} {wait}s
                          {p.pendingSol >= 0.05 ? ` · ${msg("signing")}` : ""}
                        </span>
                      </Link>
                      <Button size="sm" variant="quiet" onClick={() => cancelDca(p.tokenId)}>
                        {msg("cancel")}
                      </Button>
                    </div>
                  );
                })
            )}
          </div>

          <h2 className="mt-6 mb-2 text-xs font-medium tracking-wide text-muted uppercase">
            {msg("orderResting")}
          </h2>
          <div className="overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-border)]">
            {limits.filter((o) => o.status === "open" || o.status === "triggered").length === 0 ? (
              <p className="p-4 text-sm text-muted">{msg("emptyTape")}</p>
            ) : (
              limits
                .filter((o) => o.status === "open" || o.status === "triggered")
                .map((o) => {
                  const tk = tokens.find((t) => t.id === o.tokenId);
                  return (
                    <div
                      key={o.id}
                      className="flex items-center justify-between gap-2 border-b border-border px-3 py-2"
                    >
                      <span className="text-sm">
                        {o.side === "buy" ? msg("buy") : msg("sell")}{" "}
                        {tk?.symbol ?? o.tokenId.slice(0, 6)} @ {formatUsd(o.triggerMc, 0)} ·{" "}
                        {formatSol(o.sol)}
                        {o.status === "triggered" ? (
                          <span className="ms-2 text-warn">{msg("signing")}</span>
                        ) : null}
                      </span>
                      <Button size="sm" variant="quiet" onClick={() => cancel(o.id)}>
                        {msg("cancel")}
                      </Button>
                    </div>
                  );
                })
            )}
          </div>
        </>
      ) : null}

      {tab === "watch" ? <WatchHoldings /> : null}

      {tab === "fills" ? (
        <>
          <h2 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">
            {msg("history")}
          </h2>
          <div className="overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-border)]">
            {liveFills.length === 0 ? (
              <p className="p-4 text-sm text-muted">{msg("emptyLiveFills")}</p>
            ) : (
              liveFills.slice(0, 40).map((f) => {
                const tk = tokens.find((t) => t.id === f.tokenId || t.mint === f.mint);
                return (
                  <div
                    key={f.id}
                    className="flex items-center justify-between border-b border-border px-3 py-2 text-sm"
                  >
                    <span>
                      <span className={f.side === "buy" ? "text-up" : "text-down"}>
                        {f.side === "buy" ? msg("buy") : msg("sell")}
                      </span>{" "}
                      {tk?.symbol ?? f.mint.slice(0, 6)}
                    </span>
                    <span className="font-mono text-2xs text-muted num">
                      {f.sol.toFixed(3)} · {f.status}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

function holdingUsd(h: ChainHolding, price?: number): number | null {
  if (h.usd != null) return h.usd;
  if (price != null) return h.amount * price;
  return null;
}

function HoldingsPanel() {
  const msg = useDesk((s) => s.msg);
  const pk = useDesk((s) => s.walletPk);
  const chainSol = useDesk((s) => s.chainSol);
  const holdings = useDesk((s) => s.chainHoldings);
  const bagAt = useDesk((s) => s.chainBagAt);
  const tokensOk = useDesk((s) => s.chainTokensOk);
  const tokens = useDesk((s) => s.tokens);
  const chainExits = useDesk((s) => s.chainExits);
  const watch = useDesk((s) => s.watch);
  const toggleWatch = useDesk((s) => s.toggleWatch);
  const refreshBag = useDesk((s) => s.refreshBag);
  const [copied, setCopied] = useState<string | null>(null);

  if (!pk) {
    return (
      <div className="overflow-hidden rounded-lg bg-surface p-4 shadow-[var(--shadow-border)]">
        <p className="text-sm text-muted">{msg("needAddr")}</p>
      </div>
    );
  }

  const loading = bagAt === 0;
  const failed = bagAt > 0 && chainSol == null && holdings.length === 0;
  const ranked = [...holdings].sort((a, b) => {
    const ta = tokens.find((t) => t.mint === a.mint || t.id === a.mint);
    const tb = tokens.find((t) => t.mint === b.mint || t.id === b.mint);
    const ua = holdingUsd(a, ta?.price) ?? -1;
    const ub = holdingUsd(b, tb?.price) ?? -1;
    return ub - ua || b.amount - a.amount;
  });

  async function copyMint(mint: string) {
    try {
      await navigator.clipboard.writeText(mint);
      setCopied(mint);
      window.setTimeout(() => setCopied((cur) => (cur === mint ? null : cur)), 1400);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-border)]">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 truncate font-mono text-2xs text-accent num">{shortMint(pk)}</span>
        <span className="ms-auto shrink-0 font-mono text-xs num">
          {chainSol != null ? formatSol(chainSol) : "—"}
        </span>
        <button
          type="button"
          className="flex size-8 shrink-0 items-center justify-center rounded-sm text-muted hover:text-fg"
          aria-label={msg("refresh")}
          onClick={() => refreshBag()}
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>
      {loading ? (
        <p className="p-4 text-sm text-muted">{msg("loadingHoldings")}</p>
      ) : failed ? (
        <p className="p-4 text-sm text-warn">{msg("holdingsFail")}</p>
      ) : (
        <>
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <TokenMark id="sol" symbol="SOL" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">SOL</div>
              <div className="font-mono text-2xs text-muted">{msg("sol")}</div>
            </div>
            <div className="text-end font-mono text-sm num">
              {chainSol != null ? formatSol(chainSol) : "—"}
            </div>
          </div>
          {ranked.length === 0 ? (
            <p className="p-4 text-sm text-muted">
              {tokensOk ? msg("emptyHoldings") : msg("holdingsPartial")}
            </p>
          ) : (
            ranked.map((h) => {
              const tk = tokens.find((t) => t.mint === h.mint || t.id === h.mint);
              const watching = tk ? watch.includes(tk.id) : false;
              const val = holdingUsd(h, tk?.price);
              const label = tk?.symbol || h.symbol || shortMint(h.mint);
              const ex = tk ? chainExits.find((e) => e.tokenId === tk.id) : undefined;
              return (
                <div
                  key={h.mint}
                  className="flex items-center gap-2 border-b border-border px-3 py-2"
                >
                  <TokenMark id={tk?.id ?? h.mint} symbol={label} />
                  <div className="min-w-0 flex-1">
                    {tk ? (
                      <Link
                        to="/token/$id"
                        params={{ id: tk.id }}
                        className="block truncate text-sm font-medium"
                      >
                        {label}
                      </Link>
                    ) : (
                      <div className="truncate text-sm font-medium">{label}</div>
                    )}
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-mono text-2xs text-muted num">
                        {shortMint(h.mint)}
                      </span>
                      {tk ? <span className="text-2xs text-accent">{msg("onTape")}</span> : null}
                    </div>
                    {ex && (ex.tpPct != null || ex.slPct != null || ex.devExit) ? (
                      <div className="mt-0.5 flex flex-wrap gap-2 font-mono text-2xs num">
                        {ex.pendingKind ? (
                          <span className="text-warn">{msg("signing")}</span>
                        ) : null}
                        {ex.tpPct != null ? (
                          <span className="text-up">
                            {msg("sourceTp")} {ex.tpPct}%
                          </span>
                        ) : null}
                        {ex.slPct != null ? (
                          <span className="text-down">
                            {ex.trailOn ? msg("sourceTrail") : msg("sourceSl")} −{ex.slPct}%
                          </span>
                        ) : null}
                        {ex.devExit ? <span className="text-warn">{msg("devExit")}</span> : null}
                      </div>
                    ) : null}
                  </div>
                  <div className="text-end">
                    <div className="font-mono text-sm num">
                      {val != null ? formatUsd(val) : formatQty(h.amount)}
                    </div>
                    <div className="font-mono text-2xs text-muted num">{formatQty(h.amount)}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      className="flex size-8 items-center justify-center rounded-sm text-subtle hover:text-fg"
                      aria-label={copied === h.mint ? msg("copied") : msg("copyMint")}
                      onClick={() => void copyMint(h.mint)}
                    >
                      <Copy className={cn("size-3.5", copied === h.mint && "text-accent")} />
                    </button>
                    {tk ? (
                      <>
                        <button
                          type="button"
                          className={cn(
                            "flex size-8 items-center justify-center rounded-sm text-subtle hover:text-fg",
                            watching && "text-accent",
                          )}
                          aria-label={watching ? msg("watched") : msg("watch")}
                          onClick={() => toggleWatch(tk.id)}
                        >
                          <Star className={cn("size-3.5", watching && "fill-current")} />
                        </button>
                        <Link
                          to="/token/$id"
                          params={{ id: tk.id }}
                          className="flex h-8 items-center rounded-sm px-2 font-mono text-2xs text-up"
                        >
                          {msg("buy")}
                        </Link>
                      </>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </>
      )}
    </div>
  );
}

function WatchHoldings() {
  const msg = useDesk((s) => s.msg);
  const watchPk = useDesk((s) => s.watchPk);
  const deskPk = useDesk((s) => s.walletPk);
  const sol = useDesk((s) => s.watchSol);
  const holdings = useDesk((s) => s.watchHoldings);
  const bagAt = useDesk((s) => s.watchBagAt);
  const setWatchPk = useDesk((s) => s.setWatchPk);
  const tokens = useDesk((s) => s.tokens);
  const other = watchPk && watchPk !== deskPk ? watchPk : null;

  return (
    <div className="mt-4 overflow-hidden rounded-lg bg-surface p-3 shadow-[var(--shadow-border)]">
      <h3 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">
        {msg("watching")}
      </h3>
      <WatchAddrForm />
      {other ? (
        <div className="mt-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="font-mono text-2xs text-subtle num">{shortMint(other)}</span>
            <Button size="sm" variant="quiet" onClick={() => setWatchPk(null)}>
              {msg("close")}
            </Button>
          </div>
          <p className="font-mono text-xs num">
            SOL {sol != null ? formatSol(sol) : bagAt === 0 ? "…" : "—"}
          </p>
          {holdings.slice(0, 8).map((h) => {
            const tk = tokens.find((t) => t.mint === h.mint || t.id === h.mint);
            return (
              <div key={h.mint} className="flex items-center justify-between py-1 text-2xs">
                <span className="truncate">{tk?.symbol || h.symbol || shortMint(h.mint)}</span>
                <span className="font-mono num">
                  {h.usd != null ? formatUsd(h.usd) : formatQty(h.amount)}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function WalletTape() {
  const msg = useDesk((s) => s.msg);
  const pk = useDesk((s) => s.walletPk);
  const prints = useDesk((s) => s.chainTape);
  const tokens = useDesk((s) => s.tokens);
  if (!pk) return null;
  return (
    <>
      <h2 className="mt-6 mb-1 text-xs font-medium tracking-wide text-muted uppercase">
        {msg("chainTape")}
      </h2>
      <p className="mb-2 font-mono text-2xs text-subtle">{msg("chainRead")}</p>
      <div className="overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-border)]">
        {prints.length === 0 ? (
          <p className="p-4 text-sm text-muted">{msg("emptyChainTape")}</p>
        ) : (
          prints.map((p) => {
            const tk = p.mint
              ? tokens.find((t) => t.mint === p.mint || t.id === p.mint)
              : undefined;
            const label = tk?.symbol || p.symbol || (p.mint ? shortMint(p.mint) : "SOL");
            const buyish = p.side === "buy" || p.side === "in";
            return (
              <div
                key={p.sig}
                className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-sm"
              >
                <span className={buyish ? "text-up" : "text-down"}>
                  {p.side === "buy"
                    ? msg("buy")
                    : p.side === "sell"
                      ? msg("sell")
                      : p.side === "in"
                        ? msg("bought")
                        : msg("sold")}{" "}
                  {label}
                </span>
                <span className="font-mono text-2xs text-muted num">
                  {p.sol > 0 ? formatSol(p.sol) : p.amount != null ? formatQty(p.amount) : "—"}
                  {p.ts ? ` · ${formatTime(p.ts)}` : ""}
                </span>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

function LiveFillsPanel() {
  const msg = useDesk((s) => s.msg);
  const fills = useDesk((s) => s.liveFills);
  const tokens = useDesk((s) => s.tokens);
  return (
    <>
      <h2 className="mt-6 mb-1 text-xs font-medium tracking-wide text-muted uppercase">
        {msg("liveFills")}
      </h2>
      <p className="mb-2 font-mono text-2xs text-subtle">{msg("execHint")}</p>
      <div className="overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-border)]">
        {fills.length === 0 ? (
          <p className="p-4 text-sm text-muted">{msg("emptyLiveFills")}</p>
        ) : (
          fills.map((f) => {
            const tk = tokens.find((t) => t.id === f.tokenId || t.mint === f.mint);
            const label = tk?.symbol || shortMint(f.mint);
            return (
              <div
                key={f.sig}
                className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-sm"
              >
                <span className={f.side === "buy" ? "text-up" : "text-down"}>
                  {f.side === "buy" ? msg("signBuy") : msg("signSell")} {label}
                </span>
                <a
                  href={`https://solscan.io/tx/${f.sig}`}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 font-mono text-2xs text-muted num hover:text-fg"
                >
                  {f.status === "ok"
                    ? msg("signOk")
                    : f.status === "fail"
                      ? msg("signFail")
                      : msg("signSent")}{" "}
                  · {formatSol(f.sol)} · {shortMint(f.sig)}
                </a>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

function Stat({ label, value, hot }: { label: string; value: string; hot?: boolean }) {
  return (
    <div className="rounded-lg bg-surface p-3 shadow-[var(--shadow-border)]">
      <div className="text-2xs tracking-wide text-muted uppercase">{label}</div>
      <div
        className={cn(
          "mt-1 font-mono text-lg num",
          hot === undefined ? "text-fg" : hot ? "text-up" : "text-down",
        )}
      >
        {value}
      </div>
    </div>
  );
}
