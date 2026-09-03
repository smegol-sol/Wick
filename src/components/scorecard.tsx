import { CLUSTER_MSG } from "@/lib/cluster";
import { fraudOf } from "@/lib/fraud";
import { formatPct, formatUsd } from "@/lib/format";
import type { LabRow } from "@/lib/lab";
import { useDesk } from "@/lib/store";
import { cn } from "@/lib/utils";

const FRAUD_MSG = {
  clean: "fraudClean",
  wash: "wash",
  insider: "insiders",
  trap: "trap",
  spoof: "spoofVol",
} as const;

export function Scorecard({ row }: { row: LabRow }) {
  const msg = useDesk((s) => s.msg);
  const token = useDesk((s) => s.tokens.find((t) => t.id === row.tokenId));
  const fraud = token ? fraudOf(token) : null;
  const cells: Array<{ k: string; v: string; tone?: "up" | "down" | "warn" | "muted" }> = [
    { k: msg("grade"), v: row.grade, tone: row.grade === "F" || row.grade === "D" ? "down" : "up" },
    { k: msg("edge"), v: row.edge.toFixed(1), tone: row.edge >= 0.7 ? "up" : row.edge < 0 ? "down" : "muted" },
    { k: msg("ath"), v: formatUsd(row.ath, 6) },
    { k: msg("drawdown"), v: formatPct(-row.dd * 100), tone: row.dd >= 0.2 ? "down" : "muted" },
    { k: msg("volMc"), v: row.volMc == null ? "n/a" : row.volMc.toFixed(2) },
    {
      k: msg("pressure"),
      v: formatPct(row.pressure * 100, 0),
      tone: row.pressure > 0.15 ? "up" : row.pressure < -0.15 ? "down" : "muted",
    },
    { k: msg("clusterHeat"), v: msg(CLUSTER_MSG[row.cluster]) },
    {
      k: msg("lab"),
      v: msg(row.kind === "setup" ? "setups" : row.kind === "heat" ? "chasing" : row.kind === "toxic" ? "toxic" : "labWatch"),
      tone: row.kind === "setup" ? "up" : row.kind === "toxic" ? "down" : row.kind === "heat" ? "warn" : "muted",
    },
  ];
  if (fraud) {
    cells.push({
      k: msg("fraud"),
      v: fraud.checked === 0 ? "n/a" : `${fraud.score} ${msg(FRAUD_MSG[fraud.tag])}`,
      tone: fraud.tag === "clean" ? "up" : fraud.tag === "trap" || fraud.tag === "wash" ? "down" : "warn",
    });
  }
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg bg-surface p-3 shadow-[var(--shadow-border)] sm:grid-cols-4">
      {cells.map((c) => (
        <div key={c.k} className="min-w-0">
          <div className="text-2xs text-muted">{c.k}</div>
          <div
            className={cn(
              "truncate font-mono text-xs num",
              c.tone === "up" && "text-up",
              c.tone === "down" && "text-down",
              c.tone === "warn" && "text-warn",
              (!c.tone || c.tone === "muted") && "text-fg",
            )}
          >
            {c.v}
          </div>
        </div>
      ))}
    </div>
  );
}
