import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageTabs } from "@/components/page-tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatSol, formatTime, shortMint } from "@/lib/format";
import type { Hands } from "@/lib/market";
import { MAX_FOLLOWS, type CopyStyle } from "@/lib/live-copy";
import { useDesk } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { Msg } from "@/lib/i18n";

export const Route = createFileRoute("/copy")({ component: CopyPage });

function CopyPage() {
  const msg = useDesk((s) => s.msg);
  const wallets = useDesk((s) => s.wallets);
  const rules = useDesk((s) => s.copyRules);
  const setCopy = useDesk((s) => s.setCopy);
  const pending = useDesk((s) => s.copyPending);
  const cancel = useDesk((s) => s.cancelCopy);
  const now = useDesk((s) => s.now);
  const fillsAll = useDesk((s) => s.fills);
  const liveFills = useDesk((s) => s.liveFills);
  const tokens = useDesk((s) => s.tokens);
  const follows = useDesk((s) => s.follows);
  const followTape = useDesk((s) => s.followTape);
  const addFollow = useDesk((s) => s.addFollow);
  const removeFollow = useDesk((s) => s.removeFollow);
  const execLive = useDesk((s) => s.settings.execLive);
  const kols = useDesk((s) => s.kols);
  const toggleK = useDesk((s) => s.toggleTrackKol);
  const toggleTrade = useDesk((s) => s.toggleKolTrade);
  const patch = useDesk((s) => s.patchSettings);
  const settings = useDesk((s) => s.settings);
  const [tab, setTab] = useState<"live" | "desks" | "social" | "fills">("live");
  const fills = fillsAll.filter((f) => f.source === "copy");
  const [pk, setPk] = useState("");
  const [err, setErr] = useState<string | null>(null);

  function follow() {
    const why = addFollow(pk);
    if (why) {
      setErr(msg(why as Msg));
      return;
    }
    setPk("");
    setErr(null);
  }

  return (
    <div className="mx-auto max-w-5xl p-2">
      <h1 className="mb-1 text-sm font-medium tracking-tight">{msg("copyDesk")}</h1>
      <p className="mb-3 max-w-2xl text-sm text-muted">{msg("followHint")}</p>
      <PageTabs
        value={tab}
        onChange={setTab}
        items={[
          { id: "live", label: msg("liveFollows"), count: follows.length },
          { id: "social", label: msg("kols"), count: kols.length },
          { id: "fills", label: msg("deskFills"), count: liveFills.length + pending.length },
        ]}
      />

      {tab === "live" ? (
        <>
      <h2 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">{msg("liveFollows")}</h2>
      <div className="mb-4 overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-border)]">
        <div className="flex flex-col gap-2 border-b border-border p-3 sm:flex-row">
          <Input
            value={pk}
            onChange={(e) => setPk(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") follow();
            }}
            placeholder={msg("followAdd")}
            className="h-9 flex-1 font-mono text-2xs"
            autoComplete="off"
            spellCheck={false}
          />
          <Button size="sm" disabled={follows.length >= MAX_FOLLOWS} onClick={follow}>
            {msg("followAdd")}
          </Button>
        </div>
        {err ? <p className="px-3 py-2 text-2xs text-warn">{err}</p> : null}
        {follows.length === 0 ? (
          <p className="p-4 text-sm text-muted">{msg("emptyFollow")}</p>
        ) : (
          follows.map((f) => {
            const rule = rules.find((r) => r.walletId === f.pk);
            const tape = followTape[f.pk] ?? [];
            const last = tape.find((p) => p.side === "buy" || p.side === "sell");
            return (
              <div key={f.pk} className="border-b border-border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-mono text-sm num">{shortMint(f.pk)}</div>
                    <div className="font-mono text-2xs text-muted">
                      {msg("chainExec")}
                      {last ? (
                        <>
                          {" · "}
                          <span className={last.side === "buy" ? "text-up" : "text-down"}>
                            {last.side === "buy" ? msg("buy") : msg("sell")} {last.symbol ?? shortMint(last.mint ?? "")}{" "}
                            {last.sol ? formatSol(last.sol) : ""}
                          </span>
                        </>
                      ) : (
                        <> · {msg("emptyTape")}</>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <Button variant={rule?.enabled ? "buy" : "quiet"} onClick={() => setCopy(f.pk, { enabled: !rule?.enabled })}>
                      {rule?.enabled ? msg("copyOn") : msg("copyOff")}
                    </Button>
                    <Button size="sm" variant="quiet" onClick={() => removeFollow(f.pk)}>
                      {msg("close")}
                    </Button>
                  </div>
                </div>
                <RuleFields walletId={f.pk} />
              </div>
            );
          })
        )}
      </div>
        </>
      ) : null}

      {false && tab === "desks" ? (
        <>
      <h2 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">{msg("paperDesks")}</h2>
      <div className="overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-border)]">
        {wallets.map((w) => {
          const rule = rules.find((r) => r.walletId === w.id);
          const enabled = rule?.enabled ?? false;
          return (
            <div key={w.id} className="border-b border-border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{w.name}</span>
                    <HandsChip
                      hands={w.hands}
                      grade={w.grade}
                      label={msg(w.hands === "paper" ? "paperHands" : w.hands)}
                    />
                  </div>
                  <div className="font-mono text-2xs text-muted num">
                    {msg("winRate")} {w.winRate.toFixed(0)}% · {msg("pnl30")}{" "}
                    <span className={w.pnl30 >= 0 ? "text-up" : "text-down"}>{w.pnl30.toFixed(0)}</span>
                    {" · "}
                    {msg("dumpRate")} {w.dumpRate.toFixed(0)}% · {msg("holdMin")} {w.holdMin}m
                    {w.lastTokenId ? (
                      <>
                        {" · "}
                        <Link className="text-accent" to="/token/$id" params={{ id: w.lastTokenId }}>
                          {tokens.find((t) => t.id === w.lastTokenId)?.symbol}
                        </Link>
                      </>
                    ) : null}
                  </div>
                </div>
                <Button variant={enabled ? "buy" : "quiet"} onClick={() => setCopy(w.id, { enabled: !enabled })}>
                  {enabled ? msg("copyOn") : msg("copyOff")}
                </Button>
              </div>
              <RuleFields walletId={w.id} showWeak />
            </div>
          );
        })}
      </div>
        </>
      ) : null}

      {tab === "social" ? (
        <section className="overflow-hidden rounded-lg bg-surface p-3 shadow-[var(--shadow-border)]">
          <h2 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">{msg("kols")}</h2>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-2xs text-muted">
            <label className="flex items-center gap-1.5">
              {msg("size")}
              <input
                type="number"
                min={0.1}
                step={0.1}
                value={settings.socialSol}
                onChange={(e) => patch({ socialSol: Number(e.target.value) || 0.5 })}
                className="h-8 w-16 rounded-sm bg-elevated px-2 font-mono text-fg outline-none"
              />
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={settings.socialNoStack}
                onChange={(e) => patch({ socialNoStack: e.target.checked })}
                className="accent-accent"
              />
              {msg("noStack")}
            </label>
          </div>
          {kols.map((k) => (
            <div key={k.id} className="flex items-center gap-2 border-b border-border py-2 last:border-0">
              <div className="min-w-0 flex-1">
                <div className="text-sm">{k.name}</div>
                <div className="text-2xs text-muted">{k.handle}</div>
              </div>
              <Button size="sm" variant={k.tracked ? "primary" : "quiet"} onClick={() => toggleK(k.id)}>
                {k.tracked ? msg("following") : msg("follow")}
              </Button>
              <Button size="sm" variant={k.tradeOn ? "buy" : "quiet"} onClick={() => toggleTrade(k.id)}>
                {k.tradeOn ? msg("socialOn") : msg("socialOff")}
              </Button>
            </div>
          ))}
        </section>
      ) : null}

      {tab === "fills" ? (
        <>
      {pending.length > 0 ? (
        <>
          <h2 className="mt-6 mb-2 text-xs font-medium tracking-wide text-muted uppercase">{msg("queued")}</h2>
          <div className="overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-border)]">
            {pending.map((p) => {
              const w = wallets.find((x) => x.id === p.walletId);
              const follow = follows.find((f) => f.pk === p.walletId);
              const tk = tokens.find((t) => t.id === p.tokenId);
              const wait = Math.max(0, (p.fireAt - now) / 1000);
              return (
                <div key={p.id} className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-sm">
                  <span className={p.side === "buy" ? "text-up" : "text-down"}>
                    {p.side === "buy" ? msg("buy") : msg("sell")} {tk?.symbol ?? "—"}
                  </span>
                  <span className="truncate text-2xs text-muted">{w?.name ?? (follow ? shortMint(follow.pk) : shortMint(p.walletId))}</span>
                  <span className="font-mono text-2xs text-subtle num">
                    {p.chain ? msg("chainExec") : msg("paperOnly")} · {msg("inSec")} {wait.toFixed(1)}s
                  </span>
                  <Button size="sm" variant="quiet" onClick={() => cancel(p.id)}>
                    {msg("cancel")}
                  </Button>
                </div>
              );
            })}
          </div>
        </>
      ) : null}

      <h2 className="mt-6 mb-2 text-xs font-medium tracking-wide text-muted uppercase">{msg("history")}</h2>
      <div className="overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-border)]">
        {fills.length === 0 && liveFills.length === 0 ? (
          <p className="p-4 text-sm text-muted">{msg("emptyBook")}</p>
        ) : (
          fills.slice(0, 24).map((f) => {
            const tk = tokens.find((t) => t.id === f.tokenId);
            return (
              <div key={f.id} className="flex items-center justify-between border-b border-border px-3 py-2 text-sm">
                <span>
                  <span className={f.side === "buy" ? "text-up" : "text-down"}>
                    {f.side === "buy" ? msg("buy") : msg("sell")}
                  </span>{" "}
                  {tk?.symbol}
                </span>
                <span className="font-mono text-2xs text-muted num">
                  {f.sol.toFixed(3)} · {formatTime(f.ts)}
                </span>
              </div>
            );
          })
        )}
      </div>
        </>
      ) : null}
    </div>
  );
}

function RuleFields({ walletId, showWeak }: { walletId: string; showWeak?: boolean }) {
  const msg = useDesk((s) => s.msg);
  const rule = useDesk((s) => s.copyRules.find((r) => r.walletId === walletId));
  const setCopy = useDesk((s) => s.setCopy);
  const delay = rule?.delaySec ?? 0;
  const sizePct = rule?.sizePct ?? 10;
  const maxSol = rule?.maxSol ?? 2;
  const style = rule?.style ?? "mirror";
  const styles: CopyStyle[] = ["mirror", "shadow", "confirm", "scale"];
  return (
    <>
      {!showWeak ? (
        <div className="mt-3 flex flex-wrap gap-1">
          {styles.map((st) => (
            <button
              key={st}
              type="button"
              onClick={() => setCopy(walletId, { style: st })}
              className={cn(
                "h-9 rounded-sm px-3 text-2xs font-medium",
                style === st ? "bg-elevated text-fg" : "text-muted hover:text-fg",
              )}
            >
              {msg(
                st === "mirror"
                  ? "copyMirror"
                  : st === "shadow"
                    ? "copyShadow"
                    : st === "confirm"
                      ? "copyConfirm"
                      : "copyScale",
              )}
            </button>
          ))}
        </div>
      ) : null}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="flex flex-col gap-1 text-2xs text-muted">
          {msg("size")} %
          <input
            type="number"
            min={1}
            max={100}
            value={sizePct}
            onChange={(e) => setCopy(walletId, { sizePct: Number(e.target.value) || 1 })}
            className="h-9 rounded-sm bg-elevated px-2 font-mono text-fg outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-2xs text-muted">
          {msg("maxSol")}
          <input
            type="number"
            min={0.1}
            step={0.1}
            value={maxSol}
            onChange={(e) => setCopy(walletId, { maxSol: Number(e.target.value) || 0.1 })}
            className="h-9 rounded-sm bg-elevated px-2 font-mono text-fg outline-none"
          />
        </label>
        <div className="col-span-2 flex flex-col gap-1 text-2xs text-muted">
          {msg("delay")}
          <div className="flex gap-1">
            {[0, 1, 2, 5].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setCopy(walletId, { delaySec: s })}
                className={cn(
                  "h-9 min-w-9 rounded-sm px-2 font-mono text-2xs",
                  delay === s ? "bg-elevated text-fg" : "text-muted hover:text-fg",
                )}
              >
                {s}s
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-2xs text-muted">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={rule?.copySells ?? false}
            onChange={(e) => setCopy(walletId, { copySells: e.target.checked })}
            className="accent-accent"
          />
          {msg("copySells")}
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={rule?.skipBundled ?? true}
            onChange={(e) => setCopy(walletId, { skipBundled: e.target.checked })}
            className="accent-accent"
          />
          {msg("skipBundled")}
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={rule?.noStack ?? true}
            onChange={(e) => setCopy(walletId, { noStack: e.target.checked })}
            className="accent-accent"
          />
          {msg("noStack")}
        </label>
        {showWeak ? (
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={rule?.skipWeak ?? true}
              onChange={(e) => setCopy(walletId, { skipWeak: e.target.checked })}
              className="accent-accent"
            />
            {msg("skipWeak")}
          </label>
        ) : null}
      </div>
    </>
  );
}

function HandsChip({ hands, grade, label }: { hands: Hands; grade: number; label: string }) {
  return (
    <span
      className={cn(
        "font-mono text-2xs num",
        hands === "steel" ? "text-accent" : hands === "paper" ? "text-down" : "text-muted",
      )}
    >
      {grade} {label}
    </span>
  );
}
