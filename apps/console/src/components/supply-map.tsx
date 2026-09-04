import type { SupplyMap } from "@wick/core/contracts";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type Row = {
  key: "dev" | "bundle" | "snipers" | "fresh" | "lp" | "cluster";
  value: number | null;
  warn: number;
  bad: number | null;
};

export function SupplyMapCard({ supply }: { supply: SupplyMap | null }) {
  if (!supply) return <p className="px-4 py-4 text-sm text-muted">{t("na")}</p>;
  const rows: Row[] = [
    { key: "dev", value: supply.devPct, warn: 5, bad: 10 },
    { key: "bundle", value: supply.bundlePct, warn: 10, bad: 20 },
    { key: "snipers", value: supply.sniperPct, warn: 15, bad: 25 },
    { key: "fresh", value: supply.freshWalletPct, warn: 40, bad: null },
    { key: "lp", value: supply.lpPct, warn: 0, bad: null },
    { key: "cluster", value: supply.clusterPct, warn: 0, bad: 0 },
  ];
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      {rows.map((r) => {
        const v = r.value;
        const tone =
          v == null
            ? "bg-elevated"
            : r.bad != null && v > r.bad
              ? "bg-down"
              : r.warn > 0 && v > r.warn
                ? "bg-warn"
                : "bg-accent";
        return (
          <div
            key={r.key}
            className="grid grid-cols-[6rem_minmax(0,1fr)_3.5rem] items-center gap-2 text-2xs"
          >
            <span className="text-muted">{t(r.key)}</span>
            <div className="h-1.5 overflow-hidden rounded-full bg-elevated">
              <div
                className={cn("h-full rounded-full", tone)}
                style={{ width: `${Math.min(100, v ?? 0)}%` }}
              />
            </div>
            <span className="text-end font-mono num">{v == null ? t("na") : `${v}%`}</span>
          </div>
        );
      })}
      <div className="flex items-center justify-between text-2xs">
        <span className="text-muted">{t("trend")}</span>
        <span
          className={cn(
            "font-mono",
            supply.earlyHoldersTrend === "accumulating" && "text-warn",
            supply.earlyHoldersTrend === "distributing" && "text-up",
          )}
        >
          {supply.earlyHoldersTrend ? t(supply.earlyHoldersTrend) : t("na")}
        </span>
      </div>
    </div>
  );
}
