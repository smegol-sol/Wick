import type { FraudCard, FraudFlag, FraudTag } from "@/lib/fraud";
import type { Msg } from "@/lib/i18n";
import { useDesk } from "@/lib/store";
import { cn } from "@/lib/utils";

const TAG: Record<FraudTag, Msg> = {
  clean: "fraudClean",
  wash: "wash",
  insider: "insiders",
  trap: "trap",
  spoof: "spoofVol",
};

const FLAG: Record<FraudFlag, Msg> = {
  washVol: "washVol",
  washTape: "washTape",
  insider: "insiders",
  trap: "trap",
  spoof: "spoofVol",
};

export function FraudStrip({ card }: { card: FraudCard }) {
  const msg = useDesk((s) => s.msg);
  const tone = card.tag === "clean" ? "text-up" : card.tag === "trap" || card.tag === "wash" ? "text-down" : "text-warn";
  return (
    <div className="rounded-lg bg-surface p-3 shadow-[var(--shadow-border)]">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-medium tracking-wide text-muted uppercase">{msg("fraud")}</h3>
        <span className={cn("font-mono text-sm num", tone)}>
          {card.score} · {msg(TAG[card.tag])}
          <span className="ms-2 text-2xs text-subtle">
            {card.checked} {msg("checks")}
          </span>
        </span>
      </div>
      <p className="mb-2 text-2xs text-subtle">{msg("fraudHint")}</p>
      {card.flags.length === 0 ? (
        <p className="text-xs text-muted">{card.checked === 0 ? msg("fraudNoData") : msg("fraudClean")}</p>
      ) : (
        <div className="flex flex-wrap gap-1">
          {card.flags.map((f) => (
            <span key={f} className="rounded-sm bg-elevated px-2 py-1 font-mono text-2xs text-down">
              {msg(FLAG[f])}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
