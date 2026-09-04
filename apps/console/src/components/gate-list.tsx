import type { GateResult } from "@wick/core/contracts";
import { cn } from "@/lib/utils";

/** Seven gates in their fixed order; unrun gates render empty. */
const ORDER = [
  "safety",
  "supply",
  "liquidity",
  "manipulation",
  "quote",
  "risk",
  "execution",
] as const;

export function GateList({ gates, compact = false }: { gates: GateResult[]; compact?: boolean }) {
  const byGate = new Map(gates.map((g) => [g.gate, g]));
  return (
    <ol
      className={cn("flex flex-wrap gap-1", compact ? "" : "flex-col gap-1.5")}
      aria-label="gates"
    >
      {ORDER.map((name) => {
        const g = byGate.get(name);
        const tone = !g ? "empty" : !g.passed ? "reject" : g.adjustment ? "adjust" : "pass";
        return (
          <li
            key={name}
            className={cn(
              "flex items-center gap-2 rounded-xs px-2 font-mono text-2xs num",
              compact ? "h-6" : "h-7",
              tone === "empty" && "bg-elevated/40 text-subtle",
              tone === "pass" && "bg-up/10 text-up",
              tone === "adjust" && "bg-warn/15 text-warn",
              tone === "reject" && "bg-down/15 text-down",
            )}
            title={g?.adjustment?.reason ?? g?.reasonCode ?? undefined}
          >
            <span>{name}</span>
            {!compact && g?.reasonCode ? <span>{g.reasonCode}</span> : null}
            {!compact && g?.adjustment ? (
              <span>
                ×{g.adjustment.sizeMul} · {g.adjustment.reason}
              </span>
            ) : null}
            {compact && g?.adjustment ? <span>×{g.adjustment.sizeMul}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
