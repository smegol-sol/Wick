import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { CurveRail } from "@/components/curve-rail";
import { PulseColumn } from "@/components/token-row";
import type { Token } from "@/lib/market";
import { filteredTokens, useDesk } from "@/lib/store";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({ component: PulsePage });

type PulseCol = "new" | "bonding" | "migrated" | "watch";

function pickWatched(tokens: Token[], ids: string[]): Token[] {
  const map = new Map(tokens.map((t) => [t.id, t]));
  const out: Token[] = [];
  for (let i = ids.length - 1; i >= 0; i--) {
    const tk = map.get(ids[i]);
    if (tk) out.push(tk);
  }
  return out;
}

function PulsePage() {
  const tokens = useDesk((s) => s.tokens);
  const watch = useDesk((s) => s.watch);
  const settings = useDesk((s) => s.settings);
  const msg = useDesk((s) => s.msg);
  const [col, setCol] = useState<PulseCol>("new");
  const list = filteredTokens({ tokens, settings });
  const neu = list.filter((t) => t.stage === "new");
  const bond = list.filter((t) => t.stage === "bonding");
  const mig = list.filter((t) => t.stage === "migrated");
  const watched = useMemo(() => pickWatched(tokens, watch), [tokens, watch]);

  const tabs = [
    ["new", msg("newPairs"), neu.length],
    ["bonding", msg("bonding"), bond.length],
    ["migrated", msg("migrated"), mig.length],
    ["watch", msg("watch"), watched.length],
  ] as const;

  return (
    <div className="flex flex-col gap-2 p-2 xl:min-h-0 xl:flex-1 xl:overflow-hidden">
      <p className="px-1 text-2xs text-subtle">{msg("pulseHint")}</p>
      <CurveRail />
      <div className="flex shrink-0 flex-nowrap gap-1 overflow-x-auto overscroll-x-contain touch-pan-x xl:hidden">
        {tabs.map(([id, label, n]) => (
          <button
            key={id}
            onClick={() => setCol(id)}
            className={cn(
              "h-11 shrink-0 whitespace-nowrap rounded-sm px-3 text-2xs font-medium tracking-wide",
              col === id ? "bg-fg text-bg" : "text-muted",
            )}
          >
            {label} {n}
          </button>
        ))}
      </div>
      <div className="hidden min-h-0 flex-1 gap-2 xl:flex">
        <PulseColumn fill title={msg("newPairs")} tokens={neu} />
        <PulseColumn fill title={msg("bonding")} tokens={bond} />
        <PulseColumn fill title={msg("migrated")} tokens={mig} />
        <PulseColumn fill title={msg("watch")} tokens={watched} empty={msg("emptyWatch")} />
      </div>
      <div className="xl:hidden">
        {col === "watch" ? (
          <PulseColumn title={msg("watch")} tokens={watched} empty={msg("emptyWatch")} />
        ) : (
          <PulseColumn
            title={col === "new" ? msg("newPairs") : col === "bonding" ? msg("bonding") : msg("migrated")}
            tokens={col === "new" ? neu : col === "bonding" ? bond : mig}
          />
        )}
      </div>
    </div>
  );
}
