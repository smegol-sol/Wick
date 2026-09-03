import { Link } from "@tanstack/react-router";
import { formatSol, formatTime, formatUsd } from "@/lib/format";
import type { FlowBias, BookFlow, NameFlow } from "@/lib/smart-flow";
import { useDesk } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { Msg } from "@/lib/i18n";
import type { Print } from "@/lib/market";

const BIAS_MSG: Record<FlowBias, Msg> = {
  accumulate: "accumulate",
  distribute: "distribute",
  mixed: "flowMixed",
  idle: "flowIdle",
};

function Net({ n }: { n: number }) {
  return (
    <span className={cn("font-mono text-xs num", n > 0.05 ? "text-up" : n < -0.05 ? "text-down" : "text-muted")}>
      {n >= 0 ? "+" : ""}
      {formatSol(n)}
    </span>
  );
}

export function SmartBook({ flow }: { flow: BookFlow }) {
  const msg = useDesk((s) => s.msg);
  const names = flow.names.slice(0, 8);
  const desks = flow.desks.slice(0, 8);
  return (
    <div className="mb-4 grid gap-3 md:grid-cols-2">
      <div className="overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-border)]">
        <div className="flex items-baseline justify-between border-b border-border px-3 py-2">
          <h2 className="text-xs font-medium tracking-wide text-muted uppercase">{msg("nameFlow")}</h2>
          <span
            className={cn(
              "text-2xs",
              flow.bias === "accumulate" ? "text-up" : flow.bias === "distribute" ? "text-down" : "text-subtle",
            )}
          >
            {msg(BIAS_MSG[flow.bias])}
          </span>
        </div>
        {names.length === 0 ? (
          <p className="p-4 text-sm text-muted">{msg("emptySmart")}</p>
        ) : (
          names.map((n) => <NameRow key={n.tokenId} row={n} />)
        )}
      </div>
      <div className="overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-border)]">
        <h2 className="border-b border-border px-3 py-2 text-xs font-medium tracking-wide text-muted uppercase">{msg("deskFlow")}</h2>
        {desks.length === 0 ? (
          <p className="p-4 text-sm text-muted">{msg("emptyFollow")}</p>
        ) : (
          desks.map((d) => (
            <div key={d.walletId} className="flex items-center gap-2 border-b border-border px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{d.name}</div>
                <div className="font-mono text-2xs text-muted">
                  {d.names} {msg("names")}
                </div>
              </div>
              <Net n={d.net} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function NameRow({ row }: { row: NameFlow }) {
  const msg = useDesk((s) => s.msg);
  return (
    <Link to="/token/$id" params={{ id: row.tokenId }} className="flex items-center gap-2 border-b border-border px-3 py-2 hover:bg-elevated/60">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{row.symbol}</div>
        <div className="font-mono text-2xs text-muted">
          {msg(BIAS_MSG[row.bias])}
          <span className="ms-2">
            {row.desks} {msg("kols")}
          </span>
        </div>
      </div>
      <Net n={row.net} />
    </Link>
  );
}

export function TokenFlowList({ flow, prints }: { flow: NameFlow; prints: Print[] }) {
  const msg = useDesk((s) => s.msg);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <span
          className={cn("text-sm", flow.bias === "accumulate" ? "text-up" : flow.bias === "distribute" ? "text-down" : "text-muted")}
        >
          {msg(BIAS_MSG[flow.bias])}
        </span>
        <Net n={flow.net} />
      </div>
      {prints.length === 0 ? (
        <p className="text-sm text-muted">{msg("emptySmart")}</p>
      ) : (
        <ul>
          {prints.slice(0, 12).map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 border-b border-border py-1.5">
              <span className={cn("text-xs font-medium", p.side === "buy" ? "text-up" : "text-down")}>
                {p.side === "buy" ? msg("buy") : msg("sell")}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-accent">{p.wallet ?? "—"}</span>
              <span className="font-mono text-2xs text-muted num">{p.price > 0 ? formatUsd(p.price, 6) : ""}</span>
              <span className="font-mono text-2xs text-muted num">{p.sol.toFixed(2)} SOL</span>
              <span className="font-mono text-2xs text-subtle num">{formatTime(p.ts)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
