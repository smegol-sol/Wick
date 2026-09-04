import { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { formatQty, formatSol, formatUsd, shortMint } from "@wick/core/format";
import {
  canSignHot,
  createHot,
  importHot,
  lockHotMem,
  passOk,
  peekSecret,
  toB58,
  unlockHot,
  unlockWait,
} from "@wick/core/hot-wallet";
import { isPubkey } from "@wick/core/solana-wallet";
import { useDesk } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Link } from "@tanstack/react-router";

const panelCls =
  "absolute end-0 top-full z-50 mt-1 w-80 max-h-[min(70dvh,28rem)] max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-md bg-surface p-2 shadow-[var(--shadow-border)]";

export function WatchAddrForm({ onDone }: { onDone?: () => void }) {
  const msg = useDesk((s) => s.msg);
  const setWatchPk = useDesk((s) => s.setWatchPk);
  const [paste, setPaste] = useState("");
  const [err, setErr] = useState<string | null>(null);

  function watch() {
    const next = paste.trim();
    if (!isPubkey(next)) {
      setErr(msg("badPk"));
      return;
    }
    setWatchPk(next);
    setPaste("");
    setErr(null);
    onDone?.();
  }

  return (
    <div>
      <p className="mb-2 text-2xs text-muted">{msg("watchHint")}</p>
      <Input
        value={paste}
        onChange={(e) => setPaste(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") watch();
        }}
        placeholder={msg("watchAddr")}
        className="h-9 font-mono text-2xs"
        autoComplete="off"
        spellCheck={false}
      />
      {err ? <p className={cn("mt-1 text-2xs text-warn")}>{err}</p> : null}
      <Button size="sm" className="mt-2 w-full" onClick={watch}>
        {msg("watchAddr")}
      </Button>
    </div>
  );
}

function HotPanel({ onDone }: { onDone?: () => void }) {
  const msg = useDesk((s) => s.msg);
  const vault = useDesk((s) => s.hotVault);
  const unlocked = useDesk((s) => s.hotUnlocked);
  const setHotVault = useDesk((s) => s.setHotVault);
  const markHotExported = useDesk((s) => s.markHotExported);
  const unlockHotSession = useDesk((s) => s.unlockHotSession);
  const lockHotSession = useDesk((s) => s.lockHotSession);
  const wipeHot = useDesk((s) => s.wipeHot);
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [seed, setSeed] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedAddr, setCopiedAddr] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pending = !!(vault && !vault.exported && peekSecret());
  const shown = secret ?? (pending ? toB58(peekSecret()!) : null);

  async function create() {
    setErr(null);
    if (!passOk(pass)) {
      setErr(msg("hotPassBad"));
      return;
    }
    if (pass !== pass2) {
      setErr(msg("hotMismatch"));
      return;
    }
    setBusy(true);
    try {
      const made = await createHot(pass);
      setHotVault(made.vault);
      setSecret(made.secretB58);
      setCopied(false);
      setPass("");
      setPass2("");
    } catch {
      setErr(msg("signFail"));
    } finally {
      setBusy(false);
    }
  }

  async function importExisting() {
    setErr(null);
    if (!passOk(pass)) {
      setErr(msg("hotPassBad"));
      return;
    }
    if (pass !== pass2) {
      setErr(msg("hotMismatch"));
      return;
    }
    setBusy(true);
    try {
      const made = await importHot(seed, pass);
      setHotVault(made.vault);
      useDesk.getState().unlockHotSession();
      setSeed("");
      setPass("");
      setPass2("");
      setSecret(null);
      onDone?.();
    } catch {
      setErr(msg("hotImportBad"));
    } finally {
      setBusy(false);
    }
  }

  async function unlock() {
    setErr(null);
    if (!vault) return;
    if (unlockWait() > 0) {
      setErr(msg("hotLockout"));
      return;
    }
    if (!passOk(pass)) {
      setErr(msg("hotPassBad"));
      return;
    }
    setBusy(true);
    try {
      await unlockHot(vault, pass);
      setPass("");
      if (!vault.exported) {
        const s = peekSecret();
        if (s) {
          setSecret(toB58(s));
          setCopied(false);
        }
        return;
      }
      unlockHotSession();
      onDone?.();
    } catch (e) {
      setErr(e instanceof Error && e.message === "lockout" ? msg("hotLockout") : msg("hotPassBad"));
    } finally {
      setBusy(false);
    }
  }

  async function wipe() {
    setErr(null);
    if (!vault) return;
    if (!passOk(pass)) {
      setErr(msg("hotPassBad"));
      return;
    }
    setBusy(true);
    try {
      await unlockHot(vault, pass);
      lockHotMem();
      wipeHot();
      setPass("");
      setSecret(null);
      onDone?.();
    } catch {
      setErr(msg("hotPassBad"));
    } finally {
      setBusy(false);
    }
  }

  function reveal() {
    const s = peekSecret();
    if (!s) return;
    setSecret(toB58(s));
    window.setTimeout(() => setSecret((cur) => (cur ? null : cur)), 20_000);
  }

  async function copyShown(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* user still has the on-screen secret */
    }
  }

  if (!vault) {
    return (
      <div className="mt-2 border-t border-border pt-2">
        <p className="mb-2 text-2xs leading-relaxed text-muted">{msg("hotHint")}</p>
        <p className="mb-2 font-mono text-2xs text-subtle">{msg("hotIdle")}</p>
        <Input
          type="password"
          value={seed}
          onChange={(e) => setSeed(e.target.value)}
          placeholder={msg("hotImport")}
          className="mb-1 h-9 font-mono text-2xs"
          autoComplete="off"
          spellCheck={false}
        />
        <Input
          type="password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          placeholder={msg("hotPass")}
          className="h-9 font-mono text-2xs"
          autoComplete="new-password"
        />
        <Input
          type="password"
          value={pass2}
          onChange={(e) => setPass2(e.target.value)}
          placeholder={msg("hotPass2")}
          className="mt-1 h-9 font-mono text-2xs"
          autoComplete="new-password"
        />
        {err ? <p className="mt-1 text-2xs text-warn">{err}</p> : null}
        <div className="mt-2 flex gap-1">
          <Button size="sm" className="flex-1" disabled={busy} onClick={() => void create()}>
            {msg("hotCreate")}
          </Button>
          <Button
            size="sm"
            variant="quiet"
            className="flex-1"
            disabled={busy || !seed.trim()}
            onClick={() => void importExisting()}
          >
            {msg("hotLoad")}
          </Button>
        </div>
      </div>
    );
  }

  if (shown && !vault.exported) {
    return (
      <div className="mt-2 border-t border-border pt-2">
        <p className="mb-1 text-2xs text-warn">{msg("hotNeedExport")}</p>
        <p className="mb-1 font-mono text-2xs text-muted">{msg("hotAddr")}</p>
        <p className="mb-2 break-all font-mono text-2xs leading-relaxed text-fg">{vault.pub}</p>
        <Button
          size="sm"
          variant="quiet"
          className="mb-2 w-full"
          onClick={() => {
            void copyShown(vault.pub);
            setCopiedAddr(true);
          }}
        >
          {copiedAddr ? msg("copied") : msg("hotAddr")}
        </Button>
        <p className="mb-2 break-all font-mono text-2xs leading-relaxed text-fg">{shown}</p>
        <Button
          size="sm"
          variant="quiet"
          className="mb-2 w-full"
          onClick={() => void copyShown(shown)}
        >
          {msg("hotCopy")}
        </Button>
        <label className="flex items-center gap-1.5 text-2xs text-muted">
          <input
            type="checkbox"
            checked={copied}
            onChange={(e) => setCopied(e.target.checked)}
            className="accent-accent"
          />
          {msg("hotCopied")}
        </label>
        <Button
          size="sm"
          className="mt-2 w-full"
          disabled={!copied}
          onClick={() => {
            markHotExported();
            setSecret(null);
            onDone?.();
          }}
        >
          {msg("hotKeep")}
        </Button>
      </div>
    );
  }

  if (!unlocked) {
    return (
      <div className="mt-2 border-t border-border pt-2">
        <Input
          type="password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void unlock();
          }}
          placeholder={msg("hotPass")}
          className="h-9 font-mono text-2xs"
          autoComplete="current-password"
        />
        {err ? <p className="mt-1 text-2xs text-warn">{err}</p> : null}
        <div className="mt-2 flex gap-1">
          <Button size="sm" className="flex-1" disabled={busy} onClick={() => void unlock()}>
            {msg("hotUnlock")}
          </Button>
          <Button size="sm" variant="quiet" disabled={busy} onClick={() => void wipe()}>
            {msg("hotWipe")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 border-t border-border pt-2">
      <p className="mb-1 text-2xs text-muted">{msg("hotOn")}</p>
      <p className="mb-2 break-all font-mono text-2xs leading-relaxed">{vault.pub}</p>
      {secret ? (
        <p className="mb-2 break-all font-mono text-2xs leading-relaxed">{secret}</p>
      ) : null}
      <Input
        type="password"
        value={pass}
        onChange={(e) => setPass(e.target.value)}
        placeholder={msg("hotPass")}
        className="mb-2 h-9 font-mono text-2xs"
        autoComplete="current-password"
      />
      {err ? <p className="mb-1 text-2xs text-warn">{err}</p> : null}
      <div className="flex gap-1">
        <Button size="sm" variant="quiet" className="flex-1" onClick={reveal}>
          {msg("hotExport")}
        </Button>
        <Button size="sm" variant="quiet" onClick={() => lockHotSession()}>
          {msg("hotLock")}
        </Button>
        <Button size="sm" variant="quiet" onClick={() => void wipe()}>
          {msg("hotWipe")}
        </Button>
      </div>
      {!vault.exported ? <p className="mt-2 text-2xs text-warn">{msg("hotNeedExport")}</p> : null}
    </div>
  );
}

export function WalletChip() {
  const msg = useDesk((s) => s.msg);
  const pk = useDesk((s) => s.walletPk);
  const chainSol = useDesk((s) => s.chainSol);
  const holdings = useDesk((s) => s.chainHoldings);
  const tape = useDesk((s) => s.chainTape);
  const bagAt = useDesk((s) => s.chainBagAt);
  const tokensOk = useDesk((s) => s.chainTokensOk);
  const tokens = useDesk((s) => s.tokens);
  const setWallet = useDesk((s) => s.setWallet);
  const vault = useDesk((s) => s.hotVault);
  const unlocked = useDesk((s) => s.hotUnlocked);
  const lockHotSession = useDesk((s) => s.lockHotSession);
  const [open, setOpen] = useState(false);
  const hot = canSignHot(vault, unlocked, pk);

  function disconnect() {
    lockHotSession();
    if (vault) setWallet(vault.pub);
    else setWallet(null);
    setOpen(false);
  }

  if (pk && vault && vault.pub === pk) {
    const loading = bagAt === 0;
    const failed = bagAt > 0 && chainSol == null && holdings.length === 0;
    const top = holdings.slice(0, 4);
    const status = hot ? msg("hotOn") : msg("hotLocked");
    return (
      <div className="relative">
        <button
          type="button"
          title={pk}
          onClick={() => setOpen((v) => !v)}
          className="h-9 max-w-[11rem] truncate rounded-sm px-2 text-start font-mono text-2xs text-accent num"
        >
          {shortMint(pk)}
          {chainSol != null ? ` · ${formatSol(chainSol)}` : ""}
        </button>
        {open ? (
          <div className={panelCls}>
            <p className="mb-1 font-mono text-2xs text-muted">{status}</p>
            {loading ? (
              <p className="py-2 text-2xs text-muted">{msg("loadingHoldings")}</p>
            ) : failed ? (
              <p className="py-2 text-2xs text-warn">{msg("holdingsFail")}</p>
            ) : (
              <ul className="mb-2">
                <li className="flex items-center justify-between py-1 font-mono text-2xs num">
                  <span>SOL</span>
                  <span>{chainSol != null ? formatSol(chainSol) : "—"}</span>
                </li>
                {top.map((h) => {
                  const tk = tokens.find((t) => t.mint === h.mint || t.id === h.mint);
                  const label = tk?.symbol || h.symbol || shortMint(h.mint);
                  return (
                    <li
                      key={h.mint}
                      className="flex items-center justify-between gap-2 py-1 text-2xs"
                    >
                      {tk ? (
                        <Link to="/token/$id" params={{ id: tk.id }} className="truncate text-fg">
                          {label}
                        </Link>
                      ) : (
                        <span className="truncate font-mono text-muted num">{label}</span>
                      )}
                      <span className="shrink-0 font-mono num">
                        {h.usd != null ? formatUsd(h.usd) : formatQty(h.amount)}
                      </span>
                    </li>
                  );
                })}
                {holdings.length > 4 ? (
                  <li className="py-1 font-mono text-2xs text-subtle num">
                    +{holdings.length - 4} {msg("moreHoldings")}
                  </li>
                ) : null}
                {tape.slice(0, 3).map((p) => {
                  const tk = p.mint
                    ? tokens.find((t) => t.mint === p.mint || t.id === p.mint)
                    : undefined;
                  const label = tk?.symbol || p.symbol || (p.mint ? shortMint(p.mint) : "SOL");
                  const buyish = p.side === "buy" || p.side === "in";
                  return (
                    <li
                      key={p.sig}
                      className="flex items-center justify-between gap-2 py-1 text-2xs"
                    >
                      <span className={buyish ? "text-up" : "text-down"}>
                        {p.side === "buy"
                          ? msg("buy")
                          : p.side === "sell"
                            ? msg("sell")
                            : buyish
                              ? msg("bought")
                              : msg("sold")}{" "}
                        {label}
                      </span>
                      <span className="shrink-0 font-mono num">
                        {p.sol > 0 ? formatSol(p.sol) : "—"}
                      </span>
                    </li>
                  );
                })}
                {holdings.length === 0 ? (
                  <li className="py-1 text-2xs text-muted">
                    {tokensOk ? msg("emptyHoldings") : msg("holdingsPartial")}
                  </li>
                ) : null}
              </ul>
            )}
            <div className="flex gap-1">
              <Link
                to="/book"
                className="flex h-8 flex-1 items-center justify-center rounded-sm bg-elevated text-2xs font-medium"
                onClick={() => setOpen(false)}
              >
                {msg("holdings")}
              </Link>
              <Button size="sm" variant="quiet" onClick={disconnect}>
                {msg("hotLock")}
              </Button>
            </div>
            <HotPanel onDone={() => setOpen(false)} />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="relative">
      <Button size="sm" variant="quiet" onClick={() => setOpen((v) => !v)}>
        {vault ? (vault.exported ? msg("hotUnlock") : msg("hotExport")) : msg("hotCreate")}
      </Button>
      {open ? (
        <div className={panelCls}>
          <HotPanel onDone={() => setOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}
