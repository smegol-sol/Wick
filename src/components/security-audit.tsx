import type { Msg } from "@/lib/i18n";
import type { HolderInfo, Security } from "@/lib/market";
import { riskScore } from "@/lib/market";
import { shortMint } from "@/lib/format";
import { useDesk } from "@/lib/store";
import { cn } from "@/lib/utils";

function Row({ ok, label, value }: { ok: boolean | null; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-0">
      <span className="text-xs text-muted">{label}</span>
      <span className={cn("font-mono text-xs num", ok == null ? "text-subtle" : ok ? "text-up" : "text-down")}>{value}</span>
    </div>
  );
}

export function SecurityAudit({ security, holders }: { security: Security; holders: HolderInfo | null }) {
  const msg = useDesk((s) => s.msg);
  const score = riskScore(security);
  const unknown = !security.onchain;
  const rows: Array<{ ok: boolean | null; label: Msg; value: string }> = unknown
    ? [
        { ok: null, label: "mintable", value: "n/a" },
        { ok: null, label: "freeze", value: "n/a" },
      ]
    : [
        { ok: !security.mintable, label: "mintable", value: security.mintable ? msg("open") : msg("passed") },
        { ok: !security.freeze, label: "freeze", value: security.freeze ? msg("open") : msg("passed") },
        { ok: security.renounced, label: "renounced", value: security.renounced ? msg("passed") : msg("open") },
      ];
  rows.push({ ok: security.lpBurned, label: "lp", value: security.lpBurned ? msg("burned") : msg("curveLp") });
  const top10 = holders?.top10 ?? security.top10;
  rows.push({
    ok: top10 == null ? null : top10 < 40,
    label: "top10",
    value: top10 == null ? "n/a" : `${top10.toFixed(1)}%`,
  });
  rows.push({
    ok: holders?.holders == null ? null : holders.holders >= 50,
    label: "holders",
    value: holders?.holders == null ? msg("holdersNeedRpc") : String(holders.holders),
  });

  return (
    <div className="rounded-md bg-elevated p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-xs font-medium tracking-wide text-muted uppercase">{msg("audit")}</h3>
        <span className="flex items-center gap-2">
          <span className="font-mono text-2xs text-subtle">{msg(unknown ? "guardPending" : "guardOnchain")}</span>
          <span className={cn("font-mono text-sm num", score > 40 ? "text-down" : "text-up")}>{unknown ? "—" : score.toFixed(0)}</span>
        </span>
      </div>
      {rows.map((r) => (
        <Row key={r.label} ok={r.ok} label={msg(r.label)} value={r.value} />
      ))}
      {holders && holders.top.length ? (
        <div className="mt-3">
          <p className="mb-1 text-2xs text-muted">{msg("topHolders")}</p>
          <ul>
            {holders.top.slice(0, 10).map((h, i) => (
              <li key={h.address} className="flex items-center gap-3 py-1">
                <span className="w-5 font-mono text-2xs text-subtle">{i + 1}</span>
                <a
                  href={`https://solscan.io/account/${h.address}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex-1 truncate font-mono text-2xs text-muted hover:text-fg"
                >
                  {shortMint(h.address)}
                </a>
                <div className="h-1 w-24 overflow-hidden rounded-full bg-bg">
                  <div className="h-full bg-accent" style={{ width: `${Math.min(100, h.pct)}%` }} />
                </div>
                <span className="w-14 text-end font-mono text-2xs num">{h.pct.toFixed(2)}%</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
