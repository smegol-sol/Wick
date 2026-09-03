import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageTabs } from "@/components/page-tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatSol, formatTime, shortMint } from "@/lib/format";
import { MAX_FOLLOWS, type CopyStyle } from "@/lib/live-copy";
import { useDesk } from "@/lib/store";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/copy")({ component: CopyPage });

function CopyPage() {
  const msg = useDesk((s) => s.msg);
  const rules = useDesk((s) => s.copyRules);
  const setCopy = useDesk((s) => s.setCopy);
  const pending = useDesk((s) => s.copyPending);
  const cancel = useDesk((s) => s.cancelCopy);
  const now = useDesk((s) => s.now);
  const liveFills = useDesk((s) => s.liveFills);
  const tokens = useDesk((s) => s.tokens);
  const follows = useDesk((s) => s.follows);
  const followTape = useDesk((s) => s.followTape);
  const addFollow = useDesk((s) => s.addFollow);
  const removeFollow = useDesk((s) => s.removeFollow);
  const snipeLive = useDesk((s) => s.settings.snipeLive);
  const [tab, setTab] = useState<"live" | "fills">("live");
  const [pk, setPk] = useState("");
  const [label, setLabel] = useState("");
  const [err, setErr] = useState<string | null>(null);

  function follow() {
    const why = addFollow(pk, label);
    if (why) {
      setErr(msg(why));
      return;
    }
    setPk("");
    setLabel("");
    setErr(null);
  }

  return (
    <div className="mx-auto max-w-5xl p-2">
      <h1 className="mb-1 text-sm font-medium tracking-tight">{msg("copyDesk")}</h1>
      <p className="mb-3 max-w-2xl text-sm text-muted">{msg("followHint")}</p>
      {!snipeLive ? (
        <p className="mb-3 font-mono text-2xs text-warn">{msg("copyNeedsLive")}</p>
      ) : null}
      <PageTabs
        value={tab}
        onChange={setTab}
        items={[
          { id: "live", label: msg("liveFollows"), count: follows.length },
          { id: "fills", label: msg("deskFills"), count: liveFills.length + pending.length },
        ]}
      />

      {tab === "live" ? (
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
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={msg("followLabel")}
              className="h-9 font-mono text-2xs sm:w-32"
              autoComplete="off"
              spellCheck={false}
            />
            <Button size="sm" disabled={follows.length >= MAX_FOLLOWS} onClick={follow}>
              {msg("follow")}
            </Button>
          </div>
          {err ? <p className="px-3 py-2 text-2xs text-warn">{err}</p> : null}
          {follows.length === 0 ? (
            <p className="p-4 text-sm text-muted">{msg("emptyFollow")}</p>
          ) : (
            follows.map((f) => {
              const rule = rules.find((r) => r.walletId === f.pk);
              const tape = followTape[f.pk] ?? [];
              const swaps = tape.filter((p) => p.side === "buy" || p.side === "sell");
              return (
                <div key={f.pk} className="border-b border-border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{f.label}</div>
                      <a
                        href={`https://solscan.io/account/${f.pk}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-2xs text-muted num hover:text-fg"
                      >
                        {shortMint(f.pk)}
                      </a>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant={rule?.enabled ? "buy" : "quiet"}
                        onClick={() => setCopy(f.pk, { enabled: !rule?.enabled })}
                      >
                        {rule?.enabled ? msg("copyOn") : msg("copyOff")}
                      </Button>
                      <Button size="sm" variant="quiet" onClick={() => removeFollow(f.pk)}>
                        {msg("close")}
                      </Button>
                    </div>
                  </div>
                  <ul className="mt-2">
                    {swaps.length === 0 ? (
                      <li className="text-2xs text-subtle">{msg("emptyTape")}</li>
                    ) : (
                      swaps.slice(0, 4).map((p) => {
                        const tk = p.mint ? tokens.find((t) => t.mint === p.mint) : undefined;
                        const name = tk?.symbol ?? p.symbol ?? shortMint(p.mint ?? "");
                        return (
                          <li
                            key={p.sig}
                            className="flex items-center justify-between gap-2 py-0.5 font-mono text-2xs num"
                          >
                            <span className={p.side === "buy" ? "text-up" : "text-down"}>
                              {p.side === "buy" ? msg("buy") : msg("sell")}{" "}
                              {tk ? (
                                <Link to="/token/$id" params={{ id: tk.id }} className="text-fg">
                                  {name}
                                </Link>
                              ) : (
                                name
                              )}
                            </span>
                            <span className="text-muted">
                              {formatSol(p.sol)} · {formatTime(p.ts)}
                            </span>
                          </li>
                        );
                      })
                    )}
                  </ul>
                  <RuleFields walletId={f.pk} />
                </div>
              );
            })
          )}
        </div>
      ) : null}

      {tab === "fills" ? (
        <>
          {pending.length > 0 ? (
            <>
              <h2 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">
                {msg("queued")}
              </h2>
              <div className="overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-border)]">
                {pending.map((p) => {
                  const follow = follows.find((f) => f.pk === p.walletId);
                  const tk = tokens.find((t) => t.id === p.tokenId);
                  const wait = Math.max(0, (p.fireAt - now) / 1000);
                  return (
                    <div
                      key={p.id}
                      className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-sm"
                    >
                      <span className={p.side === "buy" ? "text-up" : "text-down"}>
                        {p.side === "buy" ? msg("buy") : msg("sell")} {tk?.symbol ?? "—"}
                      </span>
                      <span className="truncate text-2xs text-muted">
                        {follow?.label ?? shortMint(p.walletId)}
                      </span>
                      <span className="font-mono text-2xs text-subtle num">
                        {p.pendingSince ? msg("signing") : `${msg("inSec")} ${wait.toFixed(1)}s`}
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

          <h2 className="mt-6 mb-2 text-xs font-medium tracking-wide text-muted uppercase">
            {msg("history")}
          </h2>
          <div className="overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-border)]">
            {liveFills.length === 0 ? (
              <p className="p-4 text-sm text-muted">{msg("emptyLiveFills")}</p>
            ) : (
              liveFills.slice(0, 24).map((f) => {
                const tk = tokens.find((t) => t.id === f.tokenId || t.mint === f.mint);
                return (
                  <div
                    key={f.id}
                    className="flex items-center justify-between border-b border-border px-3 py-2 text-sm"
                  >
                    <span>
                      <span className={f.side === "buy" ? "text-up" : "text-down"}>
                        {f.side === "buy" ? msg("buy") : msg("sell")}
                      </span>{" "}
                      {tk?.symbol ?? shortMint(f.mint)}
                    </span>
                    <a
                      href={`https://solscan.io/tx/${f.sig}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-2xs text-muted num hover:text-fg"
                    >
                      {f.sol.toFixed(3)} · {f.status} · {formatTime(f.ts)}
                    </a>
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

function RuleFields({ walletId }: { walletId: string }) {
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
            checked={rule?.noStack ?? true}
            onChange={(e) => setCopy(walletId, { noStack: e.target.checked })}
            className="accent-accent"
          />
          {msg("noStack")}
        </label>
      </div>
    </>
  );
}
