import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "./ui/button";
import { Sheet } from "./sheet";
import { formatTime } from "@/lib/format";
import { type Alert, type AlertKind, useDesk } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { Msg } from "@/lib/i18n";

const KINDS: AlertKind[] = ["launch", "migrate", "smart", "stop", "tp", "dev", "risk"];

const KIND_MSG: Record<AlertKind, Msg> = {
  launch: "alertLaunch",
  migrate: "alertMigrate",
  smart: "alertSmart",
  stop: "alertStop",
  tp: "alertTp",
  dev: "alertDev",
  risk: "alertRisk",
};

const TOGGLES: Array<[keyof Pick<ReturnType<typeof useDesk.getState>["settings"], "radarLaunch" | "radarMigrate" | "radarSmart" | "radarStop" | "radarDev" | "radarRisk">, Msg]> = [
  ["radarLaunch", "alertLaunch"],
  ["radarMigrate", "alertMigrate"],
  ["radarSmart", "alertSmart"],
  ["radarStop", "alertStop"],
  ["radarDev", "alertDev"],
  ["radarRisk", "alertRisk"],
];

export function RadarPanel({ onClose }: { onClose: () => void }) {
  const msg = useDesk((s) => s.msg);
  const alerts = useDesk((s) => s.alerts);
  const settings = useDesk((s) => s.settings);
  const patch = useDesk((s) => s.patchSettings);
  const mark = useDesk((s) => s.markRadarRead);
  const queueSnipe = useDesk((s) => s.queueSnipe);
  const holdings = useDesk((s) => s.chainHoldings);
  const tokens = useDesk((s) => s.tokens);
  const [kind, setKind] = useState<AlertKind | "all">("all");
  const shown = kind === "all" ? alerts : alerts.filter((a) => a.kind === kind);
  const unread = alerts.filter((a) => !a.read).length;

  return (
    <Sheet title={`${msg("alerts")}${unread ? ` ${unread}` : ""}`} onClose={onClose}>
      {unread ? (
        <div className="flex items-center justify-end border-b border-border px-3">
          <button type="button" className="h-11 text-xs text-muted hover:text-fg" onClick={mark}>
            {msg("markRead")}
          </button>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-1 border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={() => setKind("all")}
          className={cn("h-8 rounded-sm px-2 text-2xs font-medium", kind === "all" ? "bg-elevated text-fg" : "text-muted")}
        >
          {msg("all")}
        </button>
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={cn("h-8 rounded-sm px-2 text-2xs font-medium", kind === k ? "bg-elevated text-fg" : "text-muted")}
          >
            {msg(KIND_MSG[k])}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-3 border-b border-border px-3 py-2 text-2xs text-muted">
        {TOGGLES.map(([key, label]) => (
          <label key={key} className="flex items-center gap-1.5">
            <input type="checkbox" checked={settings[key]} onChange={(e) => patch({ [key]: e.target.checked })} className="accent-accent" />
            {msg(label)}
          </label>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <p className="p-4 text-sm text-muted">{msg("radarEmpty")}</p>
        ) : (
          shown.map((a) => {
            const mint = a.tokenId ? tokens.find((t) => t.id === a.tokenId)?.mint : undefined;
            const held = !!mint && holdings.some((h) => h.mint === mint && h.amount > 0);
            return (
              <AlertRow
                key={a.id}
                alert={a}
                msg={msg}
                onClose={onClose}
                onBuy={() => {
                  if (a.tokenId) queueSnipe(a.tokenId);
                }}
                canBuy={Boolean(a.tokenId) && (a.kind === "launch" || a.kind === "migrate") && !held}
              />
            );
          })
        )}
      </div>
    </Sheet>
  );
}

function AlertRow({
  alert: a,
  msg,
  onClose,
  onBuy,
  canBuy,
}: {
  alert: Alert;
  msg: (key: Msg) => string;
  onClose: () => void;
  onBuy: () => void;
  canBuy: boolean;
}) {
  const tone =
    a.kind === "stop" || a.kind === "dev" || a.kind === "risk"
      ? "text-down"
      : a.kind === "launch" || a.kind === "migrate" || a.kind === "tp"
        ? "text-up"
        : "text-accent";
  return (
    <div className={cn("border-b border-border px-3 py-2.5", !a.read && "bg-elevated/40")}>
      <div className="flex items-center justify-between gap-2">
        <span className={cn("font-mono text-2xs uppercase tracking-wide", tone)}>{msg(KIND_MSG[a.kind])}</span>
        <span className="font-mono text-2xs text-subtle num">{formatTime(a.ts)}</span>
      </div>
      {a.kind === "risk" || (a.tokenId && (a.kind === "stop" || a.kind === "tp" || a.kind === "dev")) ? (
        <Link to="/book" className="mt-1 block text-sm leading-snug hover:text-accent" onClick={onClose}>
          {a.text}
        </Link>
      ) : a.tokenId ? (
        <Link to="/token/$id" params={{ id: a.tokenId }} className="mt-1 block text-sm leading-snug hover:text-accent" onClick={onClose}>
          {a.text}
        </Link>
      ) : (
        <p className="mt-1 text-sm leading-snug">{a.text}</p>
      )}
      {canBuy ? (
        <Button size="sm" variant="buy" className="mt-2" onClick={onBuy}>
          {msg("buy")}
        </Button>
      ) : null}
    </div>
  );
}

export function RadarToast({ alert, onOpen }: { alert: Alert; onOpen: () => void }) {
  const msg = useDesk((s) => s.msg);
  return (
    <button type="button" onClick={onOpen} className="flex h-9 w-full items-center gap-2 border-b border-border bg-elevated px-3 text-start">
      <div className="shrink-0 font-mono text-2xs uppercase tracking-wide text-accent">{msg(KIND_MSG[alert.kind])}</div>
      <div className="min-w-0 truncate text-xs">{alert.text}</div>
    </button>
  );
}
