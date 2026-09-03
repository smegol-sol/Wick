import type { Msg } from "@/lib/i18n";
import type { Security } from "@/lib/market";
import { riskScore } from "@/lib/market";
import { useDesk } from "@/lib/store";
import { cn } from "@/lib/utils";

function Row({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-0">
      <span className="text-xs text-muted">{label}</span>
      <span className={cn("font-mono text-xs num", ok ? "text-up" : "text-down")}>{value}</span>
    </div>
  );
}

export function SecurityAudit({ security, live }: { security: Security; live?: boolean }) {
  const msg = useDesk((s) => s.msg);
  const score = riskScore(security);
  const source: Msg = security.onchain ? "guardOnchain" : live ? "guardEst" : "guardEst";
  const unknown = live && !security.onchain;
  const rows: Array<{ ok: boolean; label: Msg; value: string }> = [
    { ok: !security.mintable, label: "mintable", value: security.mintable ? msg("open") : msg("passed") },
    { ok: !security.freeze, label: "freeze", value: security.freeze ? msg("open") : msg("passed") },
    { ok: security.lpBurned, label: "lp", value: security.lpBurned ? msg("burned") : msg("open") },
    { ok: security.renounced, label: "renounced", value: security.renounced ? msg("passed") : msg("open") },
  ];
  if (!live) {
    rows.push(
      { ok: !security.honeypot, label: "honeypot", value: security.honeypot ? msg("flagged") : msg("passed") },
      { ok: security.top10 < 40, label: "top10", value: `${security.top10.toFixed(0)}%` },
      { ok: security.bundled < 20, label: "bundled", value: `${security.bundled.toFixed(0)}%` },
      { ok: security.devHold < 10, label: "dev", value: `${security.devHold.toFixed(1)}%` },
      { ok: security.snipers < 15, label: "snipers", value: `${security.snipers.toFixed(0)}%` },
      { ok: security.insiders < 12, label: "insiders", value: `${security.insiders.toFixed(0)}%` },
    );
  }

  return (
    <div className="rounded-md bg-elevated p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-xs font-medium tracking-wide text-muted uppercase">{msg("audit")}</h3>
        <span className="flex items-center gap-2">
          <span className="font-mono text-2xs text-subtle">{msg(source)}</span>
          <span className={cn("font-mono text-sm num", score > 40 ? "text-down" : "text-up")}>
            {unknown ? "—" : score.toFixed(0)}
          </span>
        </span>
      </div>
      {rows.map((r) => (
        <Row key={r.label} ok={r.ok} label={msg(r.label)} value={r.value} />
      ))}
    </div>
  );
}
