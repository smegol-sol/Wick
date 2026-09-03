import { useEffect, useMemo, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { formatMc, formatPct, formatSol, formatUsd } from "@/lib/format";
import type { Token } from "@/lib/market";
import { liveSellRaw, liveSpendCap, slipBps } from "@/lib/guard";
import { canSignHot } from "@/lib/hot-wallet";
import { sendLiveSwap } from "@/lib/live-exec";
import { openMark, riskGrade, sizeAutoBuy, tokenQuality, type RiskWhy } from "@/lib/risk";
import { trailStopPrice, useDesk } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { Msg } from "@/lib/i18n";

const WHY: Record<RiskWhy, Msg> = {
  halt: "riskHalt",
  heat: "heat",
  slots: "maxNames",
  loss: "riskLoss",
  streak: "riskStreak",
  token: "riskToken",
  cash: "insufficient",
  cluster: "clusterSkip",
};

const FAIL: Record<string, Msg> = {
  missing: "noToken",
  bad: "insufficient",
  fail: "insufficient",
  flat: "noPosition",
  rate: "signRate",
  route: "noRoute",
  impact: "impactBlock",
  wallet: "execNeed",
  reject: "signReject",
  needWallet: "execNeed",
};

function parsePct(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(90, n);
}

type Quote = { ok: true; outAmount: string; priceImpactPct: string } | { ok: false } | null;

export function TradeTicket({ token }: { token: Token }) {
  const msg = useDesk((s) => s.msg);
  const locale = useDesk((s) => s.locale);
  const settings = useDesk((s) => s.settings);
  const patch = useDesk((s) => s.patchSettings);
  const sol = useDesk((s) => s.sol);
  const positions = useDesk((s) => s.positions);
  const tokens = useDesk((s) => s.tokens);
  const riskHalt = useDesk((s) => s.riskHalt);
  const lossStreak = useDesk((s) => s.lossStreak);
  const dayStart = useDesk((s) => s.dayStart);
  const setExits = useDesk((s) => s.setExits);
  const placeLimit = useDesk((s) => s.placeLimit);
  const cancelLimit = useDesk((s) => s.cancelLimit);
  const armDca = useDesk((s) => s.armDca);
  const cancelDca = useDesk((s) => s.cancelDca);
  const limits = useDesk((s) => s.limits);
  const dcaPlans = useDesk((s) => s.dcaPlans);
  const ladders = useDesk((s) => s.ladders);
  const armLadder = useDesk((s) => s.armLadder);
  const cancelLadder = useDesk((s) => s.cancelLadder);
  const now = useDesk((s) => s.now);
  const execLive = true;
  const walletPk = useDesk((s) => s.walletPk);
  const hotVault = useDesk((s) => s.hotVault);
  const hotUnlocked = useDesk((s) => s.hotUnlocked);
  const chainSol = useDesk((s) => s.chainSol);
  const chainHoldings = useDesk((s) => s.chainHoldings);
  const chainExits = useDesk((s) => s.chainExits);
  const recordLiveFill = useDesk((s) => s.recordLiveFill);
  const patchLiveFill = useDesk((s) => s.patchLiveFill);

  const pos = positions.find((p) => p.tokenId === token.id);
  const cx = chainExits.find((e) => e.tokenId === token.id);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amt, setAmt] = useState(String(settings.quickBuy));
  const [tp, setTp] = useState("");
  const [sl, setSl] = useState("");
  const [scale, setScale] = useState(1);
  const [trail, setTrail] = useState(false);
  const [devExit, setDevExit] = useState(settings.devExit);
  const [trigger, setTrigger] = useState("");
  const [slices, setSlices] = useState(4);
  const [gap, setGap] = useState(24_000);
  const [err, setErr] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setAmt(String(settings.quickBuy));
    setErr(null);
    setQuote(null);
    setSide("buy");
    const src = pos ?? cx;
    if (src) {
      setTp(src.tpPct != null ? String(src.tpPct) : "");
      setSl(src.slPct != null ? String(src.slPct) : "");
      setScale(src.tpScale || 1);
      setTrail(!!src.trailOn);
      setDevExit(!!src.devExit);
    } else {
      setTp("");
      setSl("");
      setScale(1);
      setTrail(false);
      setDevExit(settings.devExit);
    }
    // hydrate once per token
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token.id]);

  const solAmt = Number(amt) || 0;
  const posVal = pos ? pos.amount * token.price : 0;
  const hold = chainHoldings.find((h) => h.mint === token.mint);
  const holdSol = hold ? hold.amount * token.price : 0;
  const avg = pos
    ? pos.costSol / Math.max(pos.amount, 1e-12)
    : cx && hold && cx.basisSol > 0
      ? cx.basisSol / hold.amount
      : 0;
  const pnlPct = avg > 0 ? ((token.price - avg) / avg) * 100 : 0;
  const exits = { tpPct: parsePct(tp), slPct: parsePct(sl), tpScale: scale, trailOn: trail, devExit };
  const armed = pos ?? cx;
  const stopPx = armed
    ? trailStopPrice(
        {
          tokenId: token.id,
          amount: 1,
          costSol: avg || token.price,
          tpPct: armed.tpPct,
          slPct: parsePct(sl) ?? armed.slPct,
          tpScale: armed.tpScale,
          tpRung: armed.tpRung,
          tpNextAt: armed.tpNextAt,
          trailOn: trail,
          peakPrice: armed.peakPrice,
          devExit: armed.devExit,
        },
        token.price,
        avg || token.price,
      )
    : null;

  function saveExits(next: typeof exits) {
    setExits(token.id, next);
  }
  const quality = tokenQuality(token.security, token.liq, !!token.live);
  const grade = riskGrade(quality);
  const liveCash = execLive ? (chainSol ?? 0) : sol;
  const riskBook = {
    riskHalt,
    lossStreak,
    dayStart,
    sol: liveCash,
    positions: execLive ? [] : positions,
    marks: execLive ? 0 : openMark(positions, tokens),
  };
  const sized = sizeAutoBuy(settings, riskBook, token.id, solAmt, {
    auto: false,
    token: { security: token.security, liq: token.liq, live: !!token.live },
  });
  const liveBuy = execLive && side === "buy" ? liveSpendCap(solAmt, chainSol, settings.maxTradeSol) : 0;
  const clip = side === "buy" && solAmt >= 0.05 && (execLive ? liveBuy + 1e-9 < solAmt : sized.spend + 1e-9 < solAmt);
  const openLimits = limits.filter((o) => o.tokenId === token.id && o.status === "open");
  const dca = dcaPlans.find((p) => p.tokenId === token.id && p.status === "live");
  const ladder = ladders.find((p) => p.tokenId === token.id && p.status === "live");
  const preset =
    exits.tpPct === 20 && exits.slPct === 12
      ? 20
      : exits.tpPct === 35 && exits.slPct === 18
        ? 35
        : exits.tpPct === 60 && exits.slPct === 25
          ? 60
          : 0;

  useEffect(() => {
    const needBuy = side === "buy" && solAmt >= 0.05;
    const raw =
      execLive && side === "sell" && hold
        ? liveSellRaw(hold.amount, hold.decimals, solAmt || holdSol, holdSol)
        : null;
    const needSell = execLive && side === "sell" && !!raw;
    if (!token.live || (!needBuy && !needSell)) {
      setQuote(null);
      return;
    }
    const ctrl = new AbortController();
    const id = window.setTimeout(() => {
      const slip = slipBps(settings.slippage, settings.mev);
      const url = needSell
        ? `/api/quote?mint=${encodeURIComponent(token.mint)}&side=sell&amount=${raw}&slip=${slip}`
        : `/api/quote?mint=${encodeURIComponent(token.mint)}&lamports=${Math.round(solAmt * 1e9)}&slip=${slip}`;
      void fetch(url, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((d: { ok?: boolean; outAmount?: string; priceImpactPct?: string }) => {
          if (d.ok && d.outAmount) {
            setQuote({ ok: true, outAmount: d.outAmount, priceImpactPct: d.priceImpactPct ?? "0" });
          } else setQuote({ ok: false });
        })
        .catch(() => setQuote({ ok: false }));
    }, 360);
    return () => {
      ctrl.abort();
      window.clearTimeout(id);
    };
  }, [token.live, token.mint, side, solAmt, settings.slippage, settings.mev, execLive, hold, holdSol]);

  const pctChips = useMemo(() => {
    const cap = side === "buy" ? liveCash : execLive ? holdSol : posVal;
    return [
      { n: 25, sol: cap * 0.25 },
      { n: 50, sol: cap * 0.5 },
      { n: 100, sol: cap },
    ];
  }, [side, liveCash, posVal, execLive, holdSol]);

  function applyPreset(n: 0 | 20 | 35 | 60) {
    if (n === 0) {
      setTp("");
      setSl("");
      setScale(1);
      setTrail(false);
      saveExits({ tpPct: null, slPct: null, tpScale: 1, trailOn: false, devExit });
      return;
    }
    const slN = n === 20 ? 12 : n === 35 ? 18 : 25;
    setTp(String(n));
    setSl(String(slN));
    saveExits({ tpPct: n, slPct: slN, tpScale: scale, trailOn: trail, devExit });
  }

  const impact = quote?.ok ? Number(quote.priceImpactPct) : 0;
  const impactBlock = quote?.ok === true && impact >= 18;
  const freezeBlock = !!(settings.guardMint && token.security.onchain && token.security.freeze);
  const canSign = canSignHot(hotVault, hotUnlocked, walletPk);

  async function submitLive() {
    if (!canSign || !walletPk) {
      setErr(msg(hotVault && !hotUnlocked ? "hotNeed" : hotVault && !hotVault.exported ? "hotNeedExport" : "execNeed"));
      return;
    }
    if (freezeBlock) {
      setErr(msg("riskToken"));
      return;
    }
    if (token.live && quote == null) return;
    if (token.live && quote?.ok === false) {
      setErr(msg("noRoute"));
      return;
    }
    if (impactBlock) {
      setErr(msg("impactBlock"));
      return;
    }
    const tip = Math.round(Math.max(0, Math.min(0.01, settings.priority)) * 1e9);
    const slip = slipBps(settings.slippage, settings.mev);
    if (side === "buy") {
      const spend = liveBuy >= 0.05 ? liveBuy : 0;
      if (spend < 0.05) {
        setErr(msg(sized.why ? ((WHY as Record<string, Msg>)[sized.why] ?? "insufficient") : "insufficient"));
        return;
      }
      setBusy(true);
      const res = await sendLiveSwap({
        mint: token.mint,
        user: walletPk,
        side: "buy",
        lamports: Math.round(spend * 1e9),
        slip,
        priorityLamports: tip,
        vault: hotVault,
        unlocked: hotUnlocked,
      });
      setBusy(false);
      if (!res.ok) {
        setErr(msg((res.error === "fail" ? "signFail" : FAIL[res.error]) ?? "signFail"));
        return;
      }
      recordLiveFill({
        sig: res.sig,
        mint: token.mint,
        tokenId: token.id,
        side: "buy",
        sol: spend,
        status: res.status,
      });
      return;
    }
    if (!hold) {
      setErr(msg("noPosition"));
      return;
    }
    const raw = liveSellRaw(hold.amount, hold.decimals, solAmt || holdSol, holdSol);
    if (!raw) {
      setErr(msg("noPosition"));
      return;
    }
    setBusy(true);
    const res = await sendLiveSwap({
      mint: token.mint,
      user: walletPk,
      side: "sell",
      amountRaw: raw,
      slip,
      priorityLamports: tip,
      vault: hotVault,
      unlocked: hotUnlocked,
    });
    setBusy(false);
    if (!res.ok) {
      setErr(msg((res.error === "fail" ? "signFail" : FAIL[res.error]) ?? "signFail"));
      return;
    }
    recordLiveFill({
      sig: res.sig,
      mint: token.mint,
      tokenId: token.id,
      side: "sell",
      sol: Math.min(solAmt || holdSol, holdSol),
      status: res.status,
    });
    if (res.status === "ok") patchLiveFill(res.sig, "ok");
  }

  function submit() {
    setErr(null);
    void submitLive();
  }

  return (
    <div className="rounded-lg bg-surface p-3 shadow-[var(--shadow-border)]">
      {execLive ? (
        <p className="mb-3 font-mono text-2xs leading-relaxed text-warn">{msg("execHint")}</p>
      ) : null}
      <div className="mb-3 flex items-center gap-1">
        <Button size="sm" variant={side === "buy" ? "buy" : "quiet"} onClick={() => setSide("buy")}>
          {msg("buy")}
        </Button>
        <Button size="sm" variant={side === "sell" ? "sell" : "quiet"} onClick={() => setSide("sell")}>
          {msg("sell")}
        </Button>
        <span
          className={cn(
            "ms-auto font-mono text-2xs uppercase",
            grade === "F" || grade === "D" ? "text-down" : grade === "A" ? "text-up" : "text-muted",
          )}
        >
          {grade}
        </span>
        {clip || settings.riskOn ? (
          <span className="font-mono text-2xs text-muted">
            {msg("riskAuto")} {clip ? msg("riskClip") : msg("riskOk")}
          </span>
        ) : null}
      </div>

      <label className="flex flex-col gap-1 text-2xs text-muted">
        {msg("sol")}
        <Input
          inputMode="decimal"
          value={amt}
          onChange={(e) => setAmt(e.target.value)}
          className="h-10 font-mono"
        />
      </label>
      <div className="mt-2 flex gap-1">
        {pctChips.map((c) => (
          <button
            key={c.n}
            type="button"
            onClick={() => setAmt(c.sol > 0 ? c.sol.toFixed(2) : "0")}
            className="h-9 flex-1 rounded-sm bg-elevated font-mono text-2xs text-muted hover:text-fg"
          >
            {c.n === 100 ? msg("pctMax") : `${c.n}%`}
          </button>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <label className="flex flex-col gap-1 text-2xs text-muted">
          {msg("slippage")}
          <Input
            inputMode="decimal"
            value={settings.slippage}
            onChange={(e) => patch({ slippage: Number(e.target.value) || 0 })}
            className="h-9 font-mono"
          />
        </label>
        <label className="flex items-end gap-1.5 pb-2 text-2xs text-muted">
          <input
            type="checkbox"
            checked={settings.mev}
            onChange={(e) => patch({ mev: e.target.checked })}
            className="accent-accent"
          />
          {msg("mev")}
        </label>
        <label className="flex flex-col gap-1 text-2xs text-muted">
          {msg("priority")}
          <Input
            inputMode="decimal"
            value={settings.priority}
            onChange={(e) => patch({ priority: Number(e.target.value) || 0 })}
            className="h-9 font-mono"
          />
        </label>
      </div>

      <p className="mt-2 font-mono text-2xs text-muted num">
        {msg("jup")}{" "}
        {quote?.ok ? (
          <>
            {solAmt.toFixed(2)} → {Number(quote.outAmount).toExponential(2)}{" "}
            <span className={impact >= 8 ? "text-down" : "text-subtle"}>{impact.toFixed(2)}%</span>
            {settings.mev && settings.slippage > 18 ? (
              <span className="ms-2 text-subtle">{msg("mevCapped")}</span>
            ) : null}
          </>
        ) : (
          <span className="text-subtle">{msg("noRoute")}</span>
        )}
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-2xs text-muted">
          {msg("takeProfit")} %
          <Input inputMode="decimal" value={tp} onChange={(e) => setTp(e.target.value)} className="h-9 font-mono" />
        </label>
        <div className="flex flex-col gap-1 text-2xs text-muted">
          {msg("tpScale")}
          <div className="flex gap-1">
            {[1, 2, 3, 4].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => {
                  setScale(n);
                  saveExits({ ...exits, tpScale: n });
                }}
                className={cn(
                  "h-9 flex-1 rounded-sm font-mono text-2xs",
                  scale === n ? "bg-elevated text-fg" : "text-muted hover:text-fg",
                )}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        <label className="flex flex-col gap-1 text-2xs text-muted">
          {msg("stopLoss")} %
          <Input inputMode="decimal" value={sl} onChange={(e) => setSl(e.target.value)} className="h-9 font-mono" />
        </label>
        <label className="flex items-end gap-1.5 pb-2 text-2xs text-muted">
          <input
            type="checkbox"
            checked={trail}
            onChange={(e) => {
              const on = e.target.checked;
              setTrail(on);
              saveExits({ ...exits, trailOn: on });
            }}
            className="accent-accent"
          />
          {msg("trail")}
        </label>
      </div>
      {scale > 1 ? (
        <p className="mt-1 font-mono text-2xs text-subtle">
          {locale === "ar" ? `جني ${scale} شرائح · كل ٢–٤ ث` : `TWAP ${scale} slices · ~2–4s apart`}
        </p>
      ) : null}
      {trail && stopPx != null ? (
        <p className="mt-1 font-mono text-2xs text-down num">
          {msg("trail")} {formatUsd(stopPx, 6)}
        </p>
      ) : null}

      <label className="mt-2 flex items-center gap-1.5 text-2xs text-muted">
        <input
          type="checkbox"
          checked={devExit}
          onChange={(e) => {
            const on = e.target.checked;
            setDevExit(on);
            saveExits({ ...exits, devExit: on });
          }}
          className="accent-accent"
        />
        {msg("devExit")}
      </label>

      <div className="mt-3">
        <p className="mb-1 text-2xs text-muted">{msg("exits")}</p>
        <div className="flex gap-1">
          {([0, 20, 35, 60] as const).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => applyPreset(n)}
              className={cn(
                "h-9 flex-1 rounded-sm font-mono text-2xs",
                preset === n ? "bg-elevated text-fg" : "text-muted hover:text-fg",
              )}
            >
              {n === 0 ? msg("clearExit") : `${n}%`}
            </button>
          ))}
        </div>
      </div>

      <Button
        variant={side === "buy" ? "buy" : "sell"}
        className="mt-3 w-full"
        disabled={
          busy ||
          freezeBlock ||
          (execLive && impactBlock) ||
          (execLive && token.live && quote?.ok === false) ||
          (execLive && token.live && quote == null) ||
          (side === "buy"
            ? execLive
              ? liveBuy < 0.05
              : sized.spend < 0.05 && solAmt < 0.05
            : execLive
              ? !hold
              : !pos)
        }
        onClick={submit}
      >
        {busy
          ? msg("signing")
          : execLive
            ? `${side === "buy" ? msg("signBuy") : msg("signSell")} ${formatSol(side === "buy" ? (clip ? liveBuy : solAmt) : solAmt)}`
            : side === "buy"
              ? `${msg("buy")} ${formatSol(clip ? sized.spend : solAmt)}`
              : `${msg("sell")} ${formatSol(solAmt)}`}
      </Button>
      {err ? <p className="mt-2 text-2xs text-down">{err}</p> : null}
      {execLive && !canSign ? <p className="mt-2 text-2xs text-warn">{msg(hotVault ? "hotNeed" : "execNeed")}</p> : null}

      {execLive && hold ? (
        <div className="mt-3 border-t border-border pt-3">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-2xs text-muted">{msg("holdings")}</span>
            <span className="font-mono text-2xs num">{formatSol(holdSol)}</span>
          </div>
          <div className="flex gap-1">
            {[25, 50, 100].map((n) => (
              <Button
                key={n}
                size="sm"
                variant="sell"
                className="h-10 flex-1 font-mono"
                disabled={busy}
                onClick={() => {
                  setSide("sell");
                  setAmt((holdSol * (n / 100)).toFixed(4));
                }}
              >
                {n === 100 ? msg("pctMax") : `${n}%`}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {(armed?.tpPct != null || armed?.slPct != null || armed?.devExit) && (
        <p className="mt-3 font-mono text-2xs uppercase tracking-wide text-accent">
          {msg("armed")}
          {cx?.pendingKind ? <span className="ms-2 text-warn">{msg("signing")}</span> : null}
          {armed.tpPct != null ? (
            <span className="ms-2 text-up">
              {msg("sourceTp")} {armed.tpPct}%
              {armed.tpScale > 1 ? ` ${armed.tpRung}/${armed.tpScale}` : ""}
            </span>
          ) : null}
          {armed.slPct != null ? (
            <span className="ms-2 text-down">
              {armed.trailOn ? msg("sourceTrail") : msg("sourceSl")} −{armed.slPct}%
            </span>
          ) : null}
          {armed.devExit ? <span className="ms-2 text-warn">{msg("devExit")}</span> : null}
        </p>
      )}

      <div className="mt-3 border-t border-border pt-3">
        <p className="mb-1 text-2xs text-muted">{msg("limit")}</p>
        <label className="flex flex-col gap-1 text-2xs text-muted">
          {msg("triggerMc")}
          <Input
            inputMode="decimal"
            value={trigger}
            onChange={(e) => setTrigger(e.target.value)}
            className="h-9 font-mono"
          />
        </label>
        <Button
          variant="quiet"
          className="mt-2 w-full"
          onClick={() => {
            const mc = Number(trigger);
            if (!mc || solAmt < 0.05) return;
            placeLimit(token.id, side, mc, solAmt);
            setTrigger("");
          }}
        >
          {msg("placeLimit")}
        </Button>
        {openLimits.map((o) => (
          <div key={o.id} className="mt-2 flex items-center justify-between text-2xs text-muted">
            <span className="font-mono num">
              {msg("orderResting")} · {msg("mcap")} {formatMc(o.triggerMc)}
            </span>
            <button type="button" className="text-fg" onClick={() => cancelLimit(o.id)}>
              {msg("cancel")}
            </button>
          </div>
        ))}
      </div>

      <div className="mt-3 border-t border-border pt-3">
        <p className="mb-1 text-2xs text-muted">
          {msg("ladder")} {ladder?.chain || (execLive && !ladder) ? <span className="text-subtle">· {msg("chainExec")}</span> : null}
        </p>
        <div className="flex flex-wrap items-center gap-1">
          {ladder ? (
            <Button size="sm" variant="quiet" onClick={() => cancelLadder(token.id)}>
              {msg("cancel")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              onClick={() => armLadder(token.id, Math.max(0.15, solAmt || settings.quickBuy))}
            >
              {msg("ladderOn")}
            </Button>
          )}
        </div>
        {ladder ? (
          <p className="mt-2 font-mono text-2xs text-muted num">
            {msg(
              ladder.phase === "confirm" ? "phaseConfirm" : ladder.phase === "dip" ? "phaseDip" : "phaseTwap",
            )}{" "}
            {ladder.phase === "confirm"
              ? `${ladder.confirms}/${ladder.confirmNeed}`
              : ladder.phase === "dip"
                ? `${ladder.dipDone}/${ladder.dipNeed}`
                : `${ladder.twapDone}/${ladder.twapNeed}`}{" "}
            · {msg("dcaNext")} {Math.max(0, Math.ceil((ladder.nextAt - now) / 1000))}s
            {ladder.pendingSol >= 0.05 ? ` · ${msg("signing")}` : ""}
          </p>
        ) : (
          <p className="mt-2 font-mono text-2xs text-subtle">{msg("ladderHint")}</p>
        )}
      </div>

      <div className="mt-3 border-t border-border pt-3">
        <p className="mb-1 text-2xs text-muted">
          {msg("dca")} {dca?.chain || (execLive && !dca) ? <span className="text-subtle">· {msg("chainExec")}</span> : null}
        </p>
        <div className="flex flex-wrap items-center gap-1">
          {[2, 4].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setSlices(n)}
              className={cn(
                "h-9 min-w-9 rounded-sm px-2 font-mono text-2xs",
                slices === n ? "bg-elevated text-fg" : "text-muted hover:text-fg",
              )}
            >
              {n}
            </button>
          ))}
          {[12_000, 24_000].map((ms) => (
            <button
              key={ms}
              type="button"
              onClick={() => setGap(ms)}
              className={cn(
                "h-9 min-w-9 rounded-sm px-2 font-mono text-2xs",
                gap === ms ? "bg-elevated text-fg" : "text-muted hover:text-fg",
              )}
            >
              {ms / 1000}s
            </button>
          ))}
          {dca ? (
            <Button size="sm" variant="quiet" className="ms-auto" onClick={() => cancelDca(token.id)}>
              {msg("cancel")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="quiet"
              className="ms-auto"
              onClick={() => armDca(token.id, Math.max(0.05, solAmt || settings.quickBuy), gap, slices)}
            >
              {msg("dca")}
            </Button>
          )}
        </div>
        {dca ? (
          <p className="mt-2 font-mono text-2xs text-muted num">
            {msg("dca")} {dca.done}/{dca.slices} · {msg("dcaNext")} {Math.max(0, Math.ceil((dca.nextAt - now) / 1000))}s
            {dca.pendingSol >= 0.05 ? ` · ${msg("signing")}` : ""}
          </p>
        ) : null}
      </div>
    </div>
  );
}
