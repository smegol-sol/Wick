import { Link } from "@tanstack/react-router";
import { type IntentView, ttlLeftMs } from "@wick/core/api";
import { formatSol, formatUsd } from "@wick/core/format";
import { useEffect, useState } from "react";
import { GateList } from "./gate-list";
import { TokenMark } from "./mark";
import { Button, Pill } from "./ui";
import { t } from "@/lib/i18n";

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

export function IntentCard({
  view,
  onApprove,
  onReject,
  busy,
}: {
  view: IntentView;
  onApprove?: (id: string) => void;
  onReject?: (id: string) => void;
  busy?: boolean;
}) {
  const now = useNow(1000);
  const { intent } = view;
  const left = ttlLeftMs(view, now);
  const waiting = view.status === "proposed" && left > 0;
  const finalSize = intent.sizeSol * view.adjustedMul;
  const statusTone =
    view.status === "approved" || view.status === "executed"
      ? "up"
      : view.status === "rejected" || view.status === "failed"
        ? "down"
        : view.status === "expired"
          ? "muted"
          : "accent";
  return (
    <article className="panel flex flex-col gap-3 p-4">
      <header className="flex items-start justify-between gap-3">
        <Link
          to="/token/$mint"
          params={{ mint: intent.mint }}
          className="flex min-w-0 items-center gap-3"
        >
          <TokenMark id={intent.mint} symbol={view.symbol} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-base font-medium">{view.symbol}</span>
              <Pill tone={intent.side === "buy" ? "up" : "down"}>{intent.side}</Pill>
            </div>
            <div className="truncate font-mono text-2xs text-muted">
              {intent.strategy} · {intent.mode}
            </div>
          </div>
        </Link>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="font-mono text-base num">{formatSol(finalSize, 3)}</span>
          {view.adjustedMul !== 1 ? (
            <span className="font-mono text-2xs text-warn num">
              {t("adjusted")} ×{view.adjustedMul} · {formatSol(intent.sizeSol, 3)}
            </span>
          ) : null}
        </div>
      </header>

      <p className="text-sm leading-snug text-fg/90">{intent.why}</p>

      <div className="grid grid-cols-3 gap-2 font-mono text-2xs text-muted num">
        <span>
          {t("liquidity")} {formatUsd(intent.features.liqUsd, 0)}
        </span>
        <span>
          {t("mcap")} {formatUsd(intent.features.mcUsd, 0)}
        </span>
        <span>
          {t("buysSells")} {intent.features.buys5m ?? "n/a"} / {intent.features.sells5m ?? "n/a"}
        </span>
      </div>

      <GateList gates={view.gates} compact />

      <footer className="flex items-center justify-between gap-2">
        {waiting ? (
          <span className="font-mono text-2xs text-subtle num">
            {t("expiresIn")} {Math.ceil(left / 1000)}s
          </span>
        ) : (
          <Pill tone={statusTone}>
            {t(view.status)}
            {view.decidedBy ? ` · ${view.decidedBy}` : ""}
          </Pill>
        )}
        {waiting && onApprove && onReject ? (
          <div className="flex gap-2">
            <Button variant="danger" disabled={busy} onClick={() => onReject(intent.id)}>
              {t("reject")}
            </Button>
            <Button variant="up" disabled={busy} onClick={() => onApprove(intent.id)}>
              {t("approve")}
            </Button>
          </div>
        ) : null}
      </footer>
    </article>
  );
}
