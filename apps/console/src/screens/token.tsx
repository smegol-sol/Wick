import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { formatAge, formatPct, formatUsd, shortMint } from "@wick/core/format";
import { Candles } from "@/components/candles";
import { GateList } from "@/components/gate-list";
import { TokenMark } from "@/components/mark";
import { SupplyMapCard } from "@/components/supply-map";
import { Empty, Kicker, Pill, Stat } from "@/components/ui";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";

export function TokenScreen() {
  const { mint } = useParams({ from: "/token/$mint" });
  const q = useQuery({
    queryKey: ["token", mint],
    queryFn: () => api.token(mint),
    refetchInterval: 10_000,
    retry: 1,
  });
  const now = Date.now();
  const tk = q.data;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Link to="/" className="text-sm text-muted hover:text-fg">
          ← {t("back")}
        </Link>
      </div>
      {q.isError ? <Empty>{t("offline")}</Empty> : null}
      {tk ? (
        <>
          <header className="panel flex items-center gap-3 p-4">
            <TokenMark id={tk.mint} symbol={tk.symbol} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-base font-medium">{tk.symbol}</span>
                <Pill>{tk.stage}</Pill>
                {tk.example ? <Pill tone="accent">{t("example")}</Pill> : null}
              </div>
              <div className="truncate font-mono text-2xs text-muted">
                {tk.name} · {shortMint(tk.mint)}
              </div>
            </div>
          </header>

          <div className="panel grid grid-cols-4 gap-3 px-4 py-3">
            <Stat
              label={t("liquidity")}
              value={tk.latest?.liq == null ? t("na") : formatUsd(tk.latest.liq, 0)}
            />
            <Stat
              label={t("mcap")}
              value={tk.latest?.mc == null ? t("na") : formatUsd(tk.latest.mc, 0)}
            />
            <Stat
              label={t("age")}
              value={tk.createdAt == null ? t("na") : formatAge(tk.createdAt, now)}
            />
            <Stat
              label={t("buysSells")}
              value={`${tk.latest?.buys5m ?? t("na")} / ${tk.latest?.sells5m ?? t("na")}`}
            />
          </div>

          <section className="panel overflow-hidden">
            <Kicker className="px-4 pt-3">
              {t("candles")} · {tk.candleBucketSec}s
            </Kicker>
            <Candles candles={tk.candles} />
          </section>

          <div className="grid gap-4 md:grid-cols-2">
            <section className="panel">
              <Kicker className="px-4 pt-3">{t("supplyMap")}</Kicker>
              <SupplyMapCard supply={tk.supply} />
              <div className="grid grid-cols-2 gap-2 border-t border-border px-4 py-3 text-2xs">
                <span className="text-muted">{t("authorities")}</span>
                <span className="text-end font-mono">
                  {tk.audit?.authorities
                    ? `${t("mintAuth")} ${tk.audit.authorities.mint ? "✗" : "✓"} · ${t("freezeAuth")} ${tk.audit.authorities.freeze ? "✗" : "✓"}`
                    : t("na")}
                </span>
                <span className="text-muted">{t("extensions")}</span>
                <span className="text-end font-mono">
                  {tk.audit?.extensions
                    ? [
                        tk.audit.extensions.transferFeeBps
                          ? `fee ${tk.audit.extensions.transferFeeBps}bps`
                          : null,
                        tk.audit.extensions.hook ? "hook" : null,
                        tk.audit.extensions.permanentDelegate ? "delegate" : null,
                        tk.audit.extensions.defaultFrozen ? "frozen" : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "✓"
                    : t("na")}
                </span>
                <span className="text-muted">{t("netFlow5m")}</span>
                <span className="text-end font-mono num">
                  {tk.micro?.netFlowSol5m == null
                    ? t("na")
                    : `${tk.micro.netFlowSol5m > 0 ? "+" : ""}${tk.micro.netFlowSol5m} SOL`}
                </span>
                <span className="text-muted">{t("organic")}</span>
                <span className="text-end font-mono num">
                  {tk.micro?.organicVolPct5m == null
                    ? t("na")
                    : formatPct(tk.micro.organicVolPct5m, 0)}
                </span>
                <span className="text-muted">{t("depth")}</span>
                <span className="text-end font-mono num">
                  {tk.micro?.depthBuy2PctUsd == null || tk.micro.depthSell2PctUsd == null
                    ? t("na")
                    : `${formatUsd(tk.micro.depthBuy2PctUsd, 0)} / ${formatUsd(tk.micro.depthSell2PctUsd, 0)}`}
                </span>
              </div>
            </section>

            <section className="panel overflow-hidden">
              <Kicker className="px-4 pt-3">{t("holders")}</Kicker>
              {tk.holders.length === 0 ? (
                <Empty>{t("na")}</Empty>
              ) : (
                <ul className="px-4 py-2">
                  {tk.holders.map((h) => (
                    <li
                      key={h.wallet}
                      className="flex items-center justify-between gap-2 py-1 text-2xs"
                    >
                      <span className="font-mono text-muted">{shortMint(h.wallet)}</span>
                      <span className="flex items-center gap-2">
                        {h.class ? (
                          <Pill
                            tone={
                              h.class === "organic" || h.class === "early-consistent"
                                ? "up"
                                : h.class === "unknown"
                                  ? "muted"
                                  : "warn"
                            }
                          >
                            {h.class}
                          </Pill>
                        ) : null}
                        <span className="font-mono num">{h.pct}%</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section className="flex flex-col gap-2">
            <Kicker>{t("gateHistory")}</Kicker>
            {tk.intents.length === 0 ? (
              <div className="panel">
                <Empty>{t("noIntents")}</Empty>
              </div>
            ) : (
              tk.intents.map((v) => (
                <div key={v.intent.id} className="panel flex flex-col gap-2 p-4">
                  <div className="flex items-center justify-between font-mono text-2xs text-muted">
                    <span>
                      {v.intent.strategy} · {v.intent.mode}
                    </span>
                    <span className="num">{new Date(v.intent.ts).toLocaleTimeString()}</span>
                  </div>
                  <GateList gates={v.gates} />
                </div>
              ))
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
