import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { RISK_PRESETS } from "@/lib/risk";
import { activeFilterCount, FILTER_PRESETS, filteredTokens, useDesk, type DeskSettings } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { Msg } from "@/lib/i18n";

type Preset = keyof typeof FILTER_PRESETS;

function presetMatches(id: Preset, s: DeskSettings): boolean {
  const p = FILTER_PRESETS[id];
  return (
    s.minLiq === p.minLiq &&
    s.minMc === p.minMc &&
    s.maxMc === p.maxMc &&
    s.minHolders === p.minHolders &&
    s.maxAgeMin === p.maxAgeMin &&
    s.keywords === p.keywords &&
    s.exclude === p.exclude &&
    s.hasX === p.hasX &&
    s.skipFraud === p.skipFraud &&
    s.minGrade === p.minGrade &&
    s.sieve === p.sieve
  );
}

export function DeskFilters() {
  const settings = useDesk((s) => s.settings);
  const patch = useDesk((s) => s.patchSettings);
  const tokens = useDesk((s) => s.tokens);
  const msg = useDesk((s) => s.msg);
  const shown = filteredTokens({ tokens, settings }).length;
  const active = activeFilterCount(settings);

  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {(
          [
            ["off", "presetOff"],
            ["clean", "presetClean"],
            ["tight", "presetTight"],
            ["snipe", "presetSnipe"],
          ] as const
        ).map(([id, key]) => (
          <Button key={id} size="sm" variant={presetMatches(id, settings) ? "primary" : "quiet"} onClick={() => patch(FILTER_PRESETS[id])}>
            {msg(key satisfies Msg)}
          </Button>
        ))}
        <label className="ms-2 flex min-h-9 items-center gap-2 px-1 text-2xs text-muted">
          <input type="checkbox" checked={settings.devExit} onChange={(e) => patch({ devExit: e.target.checked })} className="size-4 accent-accent" />
          {msg("devExit")}
        </label>
        <span className="ms-auto font-mono text-2xs text-muted num">
          {msg("shown")} {shown}/{tokens.length}
          {active ? ` · ${active}` : ""}
        </span>
      </div>
      <label className="flex flex-col gap-1 text-2xs text-muted">
        {msg("sieve")}
        <Input
          value={settings.sieve}
          onChange={(e) => patch({ sieve: e.target.value })}
          placeholder="liq>=2k mc<=80k age<20 freeze=0 top10<=30 topic!=ai"
          className="h-9 font-mono"
          spellCheck={false}
        />
        <span className="font-mono text-2xs text-subtle">{msg("sieveHint")}</span>
      </label>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <NumField label={msg("minLiq")} value={settings.minLiq} onChange={(n) => patch({ minLiq: n })} />
        <NumField label={msg("minMc")} value={settings.minMc} onChange={(n) => patch({ minMc: n })} />
        <NumField label={msg("maxMc")} value={settings.maxMc} onChange={(n) => patch({ maxMc: n })} />
        <NumField label={msg("maxAge")} value={settings.maxAgeMin} onChange={(n) => patch({ maxAgeMin: n })} />
        <NumField label={`${msg("minHolders")} ·${msg("chainOnly")}`} value={settings.minHolders} onChange={(n) => patch({ minHolders: n })} />
        <label className="flex flex-col gap-1 text-2xs text-muted">
          {msg("minGrade")}
          <select
            value={settings.minGrade}
            onChange={(e) => patch({ minGrade: e.target.value })}
            className="h-9 rounded-sm bg-bg px-2 font-mono text-sm text-fg outline-none"
          >
            <option value="">{msg("all")}</option>
            <option value="A">A</option>
            <option value="B">B</option>
            <option value="C">C</option>
            <option value="D">D</option>
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-2xs text-muted">
        <label className="flex min-h-9 items-center gap-2 px-1">
          <input type="checkbox" checked={settings.skipFraud} onChange={(e) => patch({ skipFraud: e.target.checked })} className="size-4 accent-accent" />
          {msg("skipFraud")}
        </label>
        <label className="flex min-h-9 items-center gap-2 px-1">
          <input type="checkbox" checked={settings.hasX} onChange={(e) => patch({ hasX: e.target.checked })} className="size-4 accent-accent" />
          {msg("hasX")}
        </label>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-2xs text-muted">
          {msg("keywords")}
          <Input value={settings.keywords} onChange={(e) => patch({ keywords: e.target.value })} placeholder="cat, pepe" className="h-9 font-mono" />
        </label>
        <label className="flex flex-col gap-1 text-2xs text-muted">
          {msg("exclude")}
          <Input value={settings.exclude} onChange={(e) => patch({ exclude: e.target.value })} placeholder="ai, agent" className="h-9 font-mono" />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-2xs text-muted">{msg("risk")}</span>
        {(
          [
            ["off", "clearExit"],
            ["desk", "presetRiskDesk"],
            ["tight", "presetRiskTight"],
          ] as const
        ).map(([id, key]) => (
          <Button
            key={id}
            size="sm"
            variant={
              id === "off"
                ? !settings.riskOn
                  ? "primary"
                  : "quiet"
                : settings.riskOn &&
                    settings.maxTradeSol === RISK_PRESETS[id].maxTradeSol &&
                    settings.maxBookPct === RISK_PRESETS[id].maxBookPct &&
                    settings.maxPositions === RISK_PRESETS[id].maxPositions &&
                    settings.maxCluster === RISK_PRESETS[id].maxCluster
                  ? "primary"
                  : "quiet"
            }
            onClick={() => patch({ ...RISK_PRESETS[id] })}
          >
            {msg(key)}
          </Button>
        ))}
        <label className="ms-2 flex min-h-9 items-center gap-2 px-1 text-2xs text-muted">
          <input type="checkbox" checked={settings.riskOn} onChange={(e) => patch({ riskOn: e.target.checked })} className="size-4 accent-accent" />
          {msg("riskOn")}
        </label>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <NumField label={msg("maxTrade")} value={settings.maxTradeSol} onChange={(n) => patch({ maxTradeSol: n })} />
        <NumField label={msg("maxBook")} value={settings.maxBookPct} onChange={(n) => patch({ maxBookPct: n })} />
        <NumField label={msg("maxNames")} value={settings.maxPositions} onChange={(n) => patch({ maxPositions: n })} />
        <NumField label={msg("maxCluster")} value={settings.maxCluster} onChange={(n) => patch({ maxCluster: n })} />
        <NumField label={msg("maxDayLoss")} value={settings.maxDayLoss} onChange={(n) => patch({ maxDayLoss: n })} />
        <NumField label={msg("streak")} value={settings.streakHalt} onChange={(n) => patch({ streakHalt: n })} />
        <NumField label={msg("slippage")} value={settings.slippage} onChange={(n) => patch({ slippage: n })} />
        <NumField label={msg("priority")} value={settings.priority} onChange={(n) => patch({ priority: n })} />
      </div>
      <p className="font-mono text-2xs text-subtle">{msg("riskHint")}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-2 font-mono text-2xs text-muted">
        <span className="text-subtle">{msg("guard")}</span>
        <label className="flex min-h-9 items-center gap-2 px-1">
          <input type="checkbox" checked={settings.ladderOn} onChange={(e) => patch({ ladderOn: e.target.checked })} className="size-4 accent-accent" />
          {msg("ladderOn")}
        </label>
        <label className="flex min-h-9 items-center gap-2 px-1">
          <input type="checkbox" checked={settings.guardMint} onChange={(e) => patch({ guardMint: e.target.checked })} className="size-4 accent-accent" />
          {msg("guardMint")}
        </label>
        <label className="flex min-h-9 items-center gap-2 px-1">
          <input type="checkbox" checked={settings.mev} onChange={(e) => patch({ mev: e.target.checked })} className="size-4 accent-accent" />
          {msg("mev")}
        </label>
        <span>{msg("guardImpact")}</span>
      </div>
    </div>
  );
}

function showNum(n: number): number | string {
  if (!Number.isFinite(n)) return 0;
  if (Math.abs(n - Math.round(n)) < 1e-9) return Math.round(n);
  return Number(n.toFixed(6));
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <label className="flex flex-col gap-1 text-2xs text-muted">
      {label}
      <Input
        type="number"
        inputMode="decimal"
        value={showNum(value)}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) ? n : 0);
        }}
        className="h-9 font-mono text-base md:text-sm"
      />
    </label>
  );
}

export function FilterToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const settings = useDesk((s) => s.settings);
  const msg = useDesk((s) => s.msg);
  const n = activeFilterCount(settings);
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn("flex h-9 items-center gap-1.5 rounded-sm px-2.5 font-mono text-2xs uppercase", open || n > 0 ? "bg-elevated text-fg" : "text-muted hover:text-fg")}
    >
      {msg("filter")}
      {n > 0 ? <span className="font-mono text-accent num">{n}</span> : null}
    </button>
  );
}
