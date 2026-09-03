import { Link } from "@tanstack/react-router";
import { formatSol } from "@/lib/format";
import type { FlowBias, BookFlow, NameFlow } from "@/lib/smart-flow";
import { useDesk } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { Msg } from "@/lib/i18n";
import type { Hands, Print, Wallet } from "@/lib/market";

const BIAS_MSG: Record<FlowBias, Msg> = {
  accumulate: "accumulate",
  distribute: "distribute",
  mixed: "flowMixed",
  idle: "flowIdle",
};

function handsMsg(h: Hands): Msg {
  return h === "paper" ? "paperHands" : h;
}

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
  const names = flow.names.filter((n) => n.desks > 0).slice(0, 8);
  const desks = flow.desks.filter((d) => d.buySol + d.sellSol > 0.05).slice(0, 8);
  return (
    <div className="mb-4 grid gap-3 md:grid-cols-2">
      <div className="overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-border)]">
        <div className="flex items-baseline justify-between border-b border-border px-3 py-2">
          <h2 className="text-xs font-medium tracking-wide text-muted uppercase">{msg("nameFlow")}</h2>
          <span className={cn("text-2xs", flow.bias === "accumulate" ? "text-up" : flow.bias === "distribute" ? "text-down" : "text-subtle")}>
            {msg(BIAS_MSG[flow.bias])}
          </span>
        </div>
        <div className="flex gap-4 border-b border-border px-3 py-2 font-mono text-2xs num">
          <span className="text-accent">
            {msg("steel")} <Net n={flow.steelNet} />
          </span>
          <span className="text-down">
            {msg("paperHands")} <Net n={flow.paperNet} />
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
          <p className="p-4 text-sm text-muted">{msg("emptySmart")}</p>
        ) : (
          desks.map((d) => (
            <div key={d.walletId} className="flex items-center gap-2 border-b border-border px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{d.name}</div>
                <div className="font-mono text-2xs text-muted">
                  {msg(handsMsg(d.hands))}
                  <span className="ms-2">{d.names}</span>
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
    <Link
      to="/token/$id"
      params={{ id: row.tokenId }}
      className="flex items-center gap-2 border-b border-border px-3 py-2 hover:bg-elevated/60"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{row.symbol}</div>
        <div className="font-mono text-2xs text-muted">
          {msg(BIAS_MSG[row.bias])}
          <span className="ms-2 text-accent">
            {msg("steel")} {row.steelNet >= 0 ? "+" : ""}
            {row.steelNet.toFixed(1)}
          </span>
          <span className="ms-2 text-down">
            {msg("paperHands")} {row.paperNet >= 0 ? "+" : ""}
            {row.paperNet.toFixed(1)}
          </span>
        </div>
      </div>
      <Net n={row.net} />
    </Link>
  );
}

export function TokenFlowList({
  flow,
  prints,
  wallets,
}: {
  flow: NameFlow;
  prints: Print[];
  wallets: Wallet[];
}) {
  const msg = useDesk((s) => s.msg);
  const byId = new Map(wallets.map((w) => [w.id, w]));
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <span className={cn("text-sm", flow.bias === "accumulate" ? "text-up" : flow.bias === "distribute" ? "text-down" : "text-muted")}>
          {msg(BIAS_MSG[flow.bias])}
        </span>
        <Net n={flow.net} />
      </div>
      <div className="mb-3 grid grid-cols-2 gap-3 font-mono text-2xs num">
        <div>
          <div className="text-muted">{msg("steel")}</div>
          <Net n={flow.steelNet} />
        </div>
        <div>
          <div className="text-muted">{msg("paperHands")}</div>
          <Net n={flow.paperNet} />
        </div>
      </div>
      {prints.length === 0 ? (
        <p className="text-sm text-muted">{msg("emptySmart")}</p>
      ) : (
        <ul>
          {prints.slice(0, 12).map((p) => {
            const w = p.walletId ? byId.get(p.walletId) : undefined;
            return (
              <li key={p.id} className="flex items-center justify-between gap-2 border-b border-border py-1.5">
                <span className={cn("text-xs font-medium", p.side === "buy" ? "text-up" : "text-down")}>
                  {p.side === "buy" ? msg("buy") : msg("sell")}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs">
                  {p.wallet ?? "—"}
                  {w ? (
                    <span className={cn("ms-2 text-2xs", w.hands === "steel" ? "text-accent" : w.hands === "paper" ? "text-down" : "text-muted")}>
                      {msg(handsMsg(w.hands))}
                    </span>
                  ) : null}
                </span>
                <span className="font-mono text-2xs text-muted num">{p.sol.toFixed(2)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
