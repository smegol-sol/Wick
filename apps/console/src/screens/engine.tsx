import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatPct } from "@wick/core/format";
import { useState } from "react";
import { Button, Empty, Kicker, Pill } from "@/components/ui";
import { api, isMock, readToken, setMock, writeToken } from "@/lib/api";
import { failureText, normalizeCode, passphraseOk } from "@/lib/second-factor";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

function pct(v: number | null | undefined, digits = 0): string {
  return v == null ? "n/a" : formatPct(v * 100, digits);
}

const shortPk = (pk: string) => `${pk.slice(0, 4)}…${pk.slice(-4)}`;
/** Base58 alphabet and a plausible length; the engine checks the 32 bytes. */
const pkLooksValid = (pk: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pk.trim());

export function EngineScreen() {
  const qc = useQueryClient();
  const state = useQuery({ queryKey: ["state"], queryFn: api.state, retry: 1 });
  const rules = useQuery({ queryKey: ["rules"], queryFn: api.rules, retry: 1 });
  const funnel = useQuery({ queryKey: ["funnel"], queryFn: api.funnel, retry: 1 });
  const replays = useQuery({ queryKey: ["replays"], queryFn: api.replays, retry: 1 });
  const wallets = useQuery({ queryKey: ["wallets"], queryFn: api.wallets, retry: 1 });
  const [walletPk, setWalletPk] = useState("");
  const [walletLabel, setWalletLabel] = useState("");
  const [walletCode, setWalletCode] = useState("");
  const [walletNotice, setWalletNotice] = useState<{ tone: "up" | "down"; text: string } | null>(
    null,
  );
  const refreshWallets = () => void qc.invalidateQueries({ queryKey: ["wallets"] });
  const follow = useMutation({
    mutationFn: (v: { pk: string; label: string; code: string }) =>
      api.followWallet(v.pk, v.label, v.code),
    onSuccess: (_r, v) => {
      setWalletPk("");
      setWalletLabel("");
      setWalletCode("");
      setWalletNotice({ tone: "up", text: `${t("following")} ${v.label || v.pk}` });
      refreshWallets();
    },
    onError: (e) => setWalletNotice({ tone: "down", text: failureText(e) }),
  });
  const walletStatus = useMutation({
    mutationFn: (v: { pk: string; status: "follow" | "watch"; code?: string }) =>
      api.walletStatus(v.pk, v.status, v.code),
    onSuccess: (_r, v) => {
      setWalletCode("");
      setWalletNotice({
        tone: v.status === "follow" ? "up" : "down",
        text: `${v.status === "follow" ? t("following") : t("watching")} ${v.pk}`,
      });
      refreshWallets();
    },
    onError: (e) => setWalletNotice({ tone: "down", text: failureText(e) }),
  });
  const removeWallet = useMutation({
    mutationFn: (pk: string) => api.removeWallet(pk),
    onSuccess: (_r, pk) => {
      setWalletNotice({ tone: "down", text: `${t("remove").toLowerCase()} ${pk}` });
      refreshWallets();
    },
    onError: (e) => setWalletNotice({ tone: "down", text: failureText(e) }),
  });
  const walletCodeOk = normalizeCode(walletCode) != null;
  const walletBusy = follow.isPending || walletStatus.isPending || removeWallet.isPending;
  const [reason, setReason] = useState("");
  const [token, setToken] = useState(readToken());
  const [mock, setMockState] = useState(isMock());
  const [code, setCode] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [notice, setNotice] = useState<{ tone: "up" | "down"; text: string } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["state"] });
  const halt = useMutation({
    mutationFn: () => api.halt(reason || "manual"),
    onSuccess: () => {
      setNotice({ tone: "down", text: `${t("halted")} · ${reason || "manual"}` });
      refresh();
    },
    onError: (e) => setNotice({ tone: "down", text: failureText(e) }),
  });
  const clearHalt = useMutation({
    mutationFn: (c: string) => api.clearHalt(c),
    onSuccess: (r) => {
      setCode("");
      setNotice({ tone: "up", text: `${t("clearHalt")} · ${r.cleared} ${t("cleared")}` });
      refresh();
    },
    onError: (e) => setNotice({ tone: "down", text: failureText(e) }),
  });
  const unseal = useMutation({
    mutationFn: (v: { passphrase: string; code: string }) => api.unseal(v.passphrase, v.code),
    onSuccess: (r) => {
      setNotice({ tone: "up", text: `${t("unsealedAs")} ${r.wallet ?? ""}`.trim() });
      refresh();
    },
    onError: (e) => setNotice({ tone: "down", text: failureText(e) }),
    // The passphrase leaves the form either way; only the code stays for a retry.
    onSettled: () => setPassphrase(""),
  });
  const seal = useMutation({
    mutationFn: () => api.seal(),
    onSuccess: () => {
      setNotice({ tone: "down", text: t("vaultSealed") });
      refresh();
    },
    onError: (e) => setNotice({ tone: "down", text: failureText(e) }),
  });
  const codeOk = normalizeCode(code) != null;
  const busy = halt.isPending || clearHalt.isPending || unseal.isPending || seal.isPending;
  const sealed = state.data?.vault === "sealed";
  const unsealed = state.data?.vault === "unsealed";
  const openHalts = (state.data?.halts ?? []).filter((h) => h.clearedAt == null);
  const maxEntered = Math.max(1, ...(funnel.data?.layers.map((l) => l.entered) ?? [1]));
  const maxRej = Math.max(1, ...(funnel.data?.rejections.map((r) => r.n) ?? [1]));

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <Kicker>{t("rules")}</Kicker>
        <div className="panel overflow-hidden">
          {rules.isError ? (
            <Empty>{t("offline")}</Empty>
          ) : (rules.data ?? []).length === 0 ? (
            <Empty>{t("noRules")}</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-start font-mono text-2xs text-subtle">
                <tr>
                  <th className="px-4 py-2 text-start font-medium">{t("rules")}</th>
                  <th className="px-2 py-2 text-start font-medium">{t("mode")}</th>
                  <th className="px-2 py-2 text-end font-medium">{t("weight")}</th>
                  <th className="px-2 py-2 text-end font-medium">{t("n")}</th>
                  <th className="px-2 py-2 text-end font-medium">{t("winRate")}</th>
                  <th className="px-2 py-2 text-end font-medium">{t("expectancy")}</th>
                  <th className="px-4 py-2 text-end font-medium">{t("worstDd")}</th>
                </tr>
              </thead>
              <tbody>
                {rules.data!.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="px-4 py-2">
                      <div className="font-mono text-xs">{r.id}</div>
                      <div className="text-2xs text-subtle">
                        {r.disabled
                          ? t("disabled")
                          : r.eligibleForAuto
                            ? t("eligibleAuto")
                            : t("notEligible")}
                      </div>
                      {r.stats?.changeReason ? (
                        <div
                          className="max-w-[16rem] truncate text-2xs text-subtle"
                          title={r.stats.changeReason}
                        >
                          {r.stats.changeReason}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-2 py-2">
                      <Pill
                        tone={
                          r.disabled
                            ? "down"
                            : r.mode === "auto"
                              ? "up"
                              : r.mode === "suggest"
                                ? "accent"
                                : "muted"
                        }
                      >
                        {r.disabled ? "off" : r.mode}
                      </Pill>
                    </td>
                    <td className="px-2 py-2 text-end font-mono text-xs num">{r.weight}</td>
                    <td className="px-2 py-2 text-end font-mono text-xs num">
                      {r.stats?.n ?? "n/a"}
                    </td>
                    <td className="px-2 py-2 text-end font-mono text-xs num">
                      {pct(r.stats?.winRate)}
                    </td>
                    <td
                      className={cn(
                        "px-2 py-2 text-end font-mono text-xs num",
                        r.stats?.expectancy != null &&
                          (r.stats.expectancy >= 0 ? "text-up" : "text-down"),
                      )}
                    >
                      {pct(r.stats?.expectancy, 1)}
                    </td>
                    <td className="px-4 py-2 text-end font-mono text-xs num text-down">
                      {pct(r.stats?.worstDd, 1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Kicker>{t("funnel")}</Kicker>
          <div className="panel flex flex-col gap-2 px-4 py-3">
            {funnel.data ? (
              funnel.data.layers.map((l) => (
                <div
                  key={l.layer}
                  className="grid grid-cols-[6rem_minmax(0,1fr)_7rem] items-center gap-2 text-2xs"
                >
                  <span className="font-mono text-muted">{l.layer}</span>
                  <div className="h-2 overflow-hidden rounded-full bg-elevated">
                    <div
                      className="h-full rounded-full bg-accent/70"
                      style={{ width: `${(l.passed / maxEntered) * 100}%` }}
                    />
                  </div>
                  <span className="text-end font-mono num">
                    {l.entered} → {l.passed}
                  </span>
                </div>
              ))
            ) : (
              <Empty>{funnel.isError ? t("offline") : t("na")}</Empty>
            )}
            {funnel.data?.example ? <Pill tone="accent">{t("example")}</Pill> : null}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Kicker>{t("rejections")}</Kicker>
          <div className="panel flex flex-col gap-2 px-4 py-3">
            {(funnel.data?.rejections ?? []).length === 0 ? (
              <Empty>{t("na")}</Empty>
            ) : (
              funnel.data!.rejections.map((r) => (
                <div
                  key={r.reason}
                  className="grid grid-cols-[8.5rem_minmax(0,1fr)_2.5rem] items-center gap-2 text-2xs"
                >
                  <span className="font-mono text-muted">{r.reason}</span>
                  <div className="h-2 overflow-hidden rounded-full bg-elevated">
                    <div
                      className="h-full rounded-full bg-down/70"
                      style={{ width: `${(r.n / maxRej) * 100}%` }}
                    />
                  </div>
                  <span className="text-end font-mono num">{r.n}</span>
                </div>
              ))
            )}
            {(funnel.data?.adjustments ?? []).length > 0 ? (
              <div className="flex flex-wrap gap-1 border-t border-border pt-2">
                {funnel.data!.adjustments.map((a) => (
                  <Pill key={a.gate} tone="warn">
                    {a.gate} ×0.5 · {a.n}
                  </Pill>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <Kicker>{t("replays")}</Kicker>
        <div className="panel overflow-hidden">
          {(replays.data ?? []).length === 0 ? (
            <Empty>{t("noReplays")}</Empty>
          ) : (
            replays.data!.map((r) => (
              <div
                key={r.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-b border-border px-4 py-2.5 last:border-b-0 text-2xs"
              >
                <div>
                  <div className="font-mono">{r.rulesVersion}</div>
                  <div className="text-subtle">
                    {t("window")} {new Date(r.windowStart).toLocaleDateString()} –{" "}
                    {new Date(r.windowEnd).toLocaleDateString()}
                  </div>
                </div>
                <div className="text-end font-mono num">
                  {r.summary ? (
                    <>
                      <div>
                        {r.summary.intents} {t("intents")} · {r.summary.executed}{" "}
                        {t("executed").toLowerCase()}
                      </div>
                      <div
                        className={cn(
                          r.summary.expectancy != null &&
                            (r.summary.expectancy >= 0 ? "text-up" : "text-down"),
                        )}
                      >
                        {t("expectancy")} {pct(r.summary.expectancy, 1)} · {t("winRate")}{" "}
                        {pct(r.summary.winRate)}
                      </div>
                    </>
                  ) : (
                    t("na")
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <Kicker>{t("wallets")}</Kicker>
        <div className="panel flex flex-col gap-3 p-4">
          {wallets.isError ? (
            <Empty>{t("offline")}</Empty>
          ) : (wallets.data ?? []).length === 0 ? (
            <Empty>{t("noWallets")}</Empty>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {wallets.data!.map((w) => (
                <li
                  key={w.pk}
                  className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{w.label ?? shortPk(w.pk)}</span>
                      <Pill tone={w.status === "follow" ? "up" : "muted"}>
                        {w.status === "follow" ? t("following") : t("watching")}
                      </Pill>
                    </div>
                    <div className="font-mono text-2xs text-muted">{w.pk}</div>
                    <div className="text-2xs text-muted">
                      {w.copies} {t("copies")} · {t("meanRet")}{" "}
                      {w.meanRetPct == null ? "n/a" : formatPct(w.meanRetPct, 1)} · {t("lastCopy")}{" "}
                      {w.lastCopyAt == null ? "n/a" : new Date(w.lastCopyAt).toLocaleString()}
                      {w.demotedReason ? ` · ${w.demotedReason}` : ""}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {w.status === "follow" ? (
                      <Button
                        disabled={walletBusy}
                        onClick={() => walletStatus.mutate({ pk: w.pk, status: "watch" })}
                      >
                        {t("watch")}
                      </Button>
                    ) : (
                      <Button
                        variant="up"
                        disabled={walletBusy || !walletCodeOk}
                        onClick={() =>
                          walletStatus.mutate({
                            pk: w.pk,
                            status: "follow",
                            code: normalizeCode(walletCode)!,
                          })
                        }
                      >
                        {t("follow")}
                      </Button>
                    )}
                    <Button
                      variant="danger"
                      disabled={walletBusy}
                      onClick={() => removeWallet.mutate(w.pk)}
                    >
                      {t("remove")}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={walletPk}
              onChange={(e) => setWalletPk(e.target.value)}
              placeholder={t("walletPk")}
              autoComplete="off"
              className="h-10 flex-1 rounded-sm bg-elevated px-3 font-mono text-sm outline-none"
            />
            <input
              value={walletLabel}
              onChange={(e) => setWalletLabel(e.target.value)}
              placeholder={t("walletLabel")}
              maxLength={40}
              className="h-10 rounded-sm bg-elevated px-3 text-sm outline-none sm:w-40"
            />
            <input
              value={walletCode}
              onChange={(e) => setWalletCode(e.target.value)}
              placeholder={t("code")}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              className="h-10 w-full rounded-sm bg-elevated px-3 font-mono text-sm outline-none sm:w-36"
            />
            <Button
              variant="up"
              disabled={walletBusy || !walletCodeOk || !pkLooksValid(walletPk)}
              onClick={() =>
                follow.mutate({
                  pk: walletPk.trim(),
                  label: walletLabel.trim(),
                  code: normalizeCode(walletCode)!,
                })
              }
            >
              {t("follow")}
            </Button>
          </div>
          {walletNotice ? (
            <p
              className={cn(
                "font-mono text-2xs",
                walletNotice.tone === "up" ? "text-up" : "text-down",
              )}
            >
              {walletNotice.text}
            </p>
          ) : null}
          <p className="text-2xs text-subtle">{t("walletHint")}</p>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <Kicker>{t("ops")}</Kicker>
        <div className="panel flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Pill>
              {t("tier")} {state.data?.tier ?? "n/a"} · ≤ {state.data?.walletCapSol ?? "n/a"} SOL
            </Pill>
            <Pill tone={state.data?.vault === "unsealed" ? "up" : "warn"}>
              {t("vault")}:{" "}
              {state.data
                ? state.data.vault === "sealed"
                  ? t("vaultSealed")
                  : state.data.vault === "unsealed"
                    ? t("vaultUnsealed")
                    : t("vaultNone")
                : "n/a"}
            </Pill>
            {(state.data?.halts ?? [])
              .filter((h) => h.clearedAt == null)
              .map((h) => (
                <Pill key={`${h.ts}:${h.kind}`} tone="down">
                  {t("halted")} · {h.kind} · {h.reason}
                </Pill>
              ))}
          </div>
          {state.data?.health.selfHalt ? (
            <div className="flex flex-wrap gap-1">
              {state.data.health.reasons.map((r) => (
                <Pill key={r} tone="warn">
                  {t("selfHalt")} · {r}
                </Pill>
              ))}
            </div>
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("haltReason")}
              className="h-10 flex-1 rounded-sm bg-elevated px-3 text-sm outline-none"
            />
            <Button variant="danger" disabled={busy} onClick={() => halt.mutate()}>
              {t("halt")}
            </Button>
            {unsealed ? (
              <Button variant="danger" disabled={busy} onClick={() => seal.mutate()}>
                {t("seal")}
              </Button>
            ) : null}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder={t("passphrase")}
              type="password"
              autoComplete="off"
              disabled={!sealed}
              className="h-10 flex-1 rounded-sm bg-elevated px-3 text-sm outline-none disabled:opacity-40"
            />
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t("code")}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              className="h-10 w-full rounded-sm bg-elevated px-3 font-mono text-sm outline-none sm:w-36"
            />
            <Button
              disabled={busy || !codeOk || openHalts.length === 0}
              onClick={() => clearHalt.mutate(normalizeCode(code)!)}
            >
              {t("clearHalt")}
            </Button>
            <Button
              variant="up"
              disabled={busy || !codeOk || !sealed || !passphraseOk(passphrase)}
              onClick={() => unseal.mutate({ passphrase, code: normalizeCode(code)! })}
            >
              {t("unseal")}
            </Button>
          </div>
          {notice ? (
            <p className={cn("font-mono text-2xs", notice.tone === "up" ? "text-up" : "text-down")}>
              {notice.text}
            </p>
          ) : null}
          <p className="text-2xs text-subtle">{t("secondFactorHint")}</p>
          <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center">
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t("apiToken")}
              type="password"
              autoComplete="off"
              className="h-10 flex-1 rounded-sm bg-elevated px-3 font-mono text-sm outline-none"
            />
            <Button
              onClick={() => {
                writeToken(token.trim());
                void qc.invalidateQueries();
              }}
            >
              {t("save")}
            </Button>
            <label className="flex items-center gap-2 text-2xs text-muted">
              <input
                type="checkbox"
                checked={mock}
                onChange={(e) => {
                  setMock(e.target.checked);
                  setMockState(e.target.checked);
                  void qc.invalidateQueries();
                }}
                className="accent-accent"
              />
              {t("mock")}
            </label>
          </div>
        </div>
      </section>
    </div>
  );
}
