import type { ApiState } from "@wick/core/api";
import { formatPct, formatSol } from "@wick/core/format";
import { Pill, Stat } from "./ui";
import { t } from "@/lib/i18n";

export function StatusStrip({ state, online }: { state: ApiState | undefined; online: boolean }) {
  if (!state) {
    return (
      <div className="panel flex items-center gap-3 px-4 py-3 text-sm text-muted">
        <span className="size-2 rounded-full bg-down" />
        {t("offline")}
      </div>
    );
  }
  const halted = state.halts.some((h) => h.clearedAt == null);
  const health = state.health;
  const pnlTone = state.dayPnlSol == null ? undefined : state.dayPnlSol >= 0 ? "up" : "down";
  return (
    <div className="panel flex flex-col gap-2 px-4 py-3">
      <div className="grid grid-cols-4 gap-3">
        <Stat
          label={t("equity")}
          value={state.equitySol == null ? t("na") : formatSol(state.equitySol)}
        />
        <Stat
          label={t("dayPnl")}
          tone={pnlTone}
          value={
            state.dayPnlSol == null
              ? t("na")
              : `${formatSol(state.dayPnlSol, 3)} ${state.dayPnlPct == null ? "" : `(${formatPct(state.dayPnlPct)})`}`
          }
        />
        <Stat
          label={t("regime")}
          tone={
            state.regime?.sizeMul === 0
              ? "down"
              : state.regime?.sizeMul === 0.5
                ? "warn"
                : undefined
          }
          value={state.regime ? `×${state.regime.sizeMul}` : t("na")}
        />
        <Stat
          label={t("health")}
          tone={halted ? "down" : health.selfHalt ? "warn" : undefined}
          value={halted ? t("halted") : health.selfHalt ? t("selfHalt") : t("healthy")}
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={online ? "size-2 rounded-full bg-up" : "size-2 rounded-full bg-down"}
          aria-hidden
        />
        <Pill>
          {t("tier")} {state.tier}
        </Pill>
        <Pill
          tone={state.vault === "unsealed" ? "up" : state.vault === "sealed" ? "warn" : "muted"}
        >
          {t("vault")}:{" "}
          {state.vault === "sealed"
            ? t("vaultSealed")
            : state.vault === "unsealed"
              ? t("vaultUnsealed")
              : t("vaultNone")}
        </Pill>
        {state.regime ? (
          <span className="truncate text-2xs text-subtle">{state.regime.reason}</span>
        ) : null}
        {health.reasons.map((r) => (
          <Pill key={r} tone="warn">
            {r}
          </Pill>
        ))}
        {state.example ? <Pill tone="accent">{t("example")}</Pill> : null}
      </div>
    </div>
  );
}
