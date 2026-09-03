import { liveSellRaw, liveSpendCap, slipBps } from "./guard";
import { canSignHot } from "./hot-wallet";
import { sendLiveSwap } from "./live-exec";
import { styleOf, styleSize } from "./live-copy";
import { isRug, type Side } from "./market";
import { useDesk } from "./store";
import type { ExitKind } from "./exits";

let busy = false;
const STALE = 28_000;

export type ChainJob = {
  kind: "ladder" | "dca" | "exit" | "copy" | "snipe";
  tokenId: string;
  mint: string;
  sol?: number;
  frac?: number;
  side?: Side;
  jobId?: string;
  exitKind?: ExitKind;
};

export function nextChainJob(): ChainJob | null {
  const s = useDesk.getState();
  if (!s.settings.execLive) return null;
  const now = Date.now();
  const ex = s.chainExits.find((e) => e.pendingFrac >= 0.05 && e.pendingKind);
  if (ex) {
    return { kind: "exit", tokenId: ex.tokenId, mint: ex.mint, frac: ex.pendingFrac, exitKind: ex.pendingKind ?? undefined };
  }
  const sn = s.snipeJobs.find((j) => !(j.pendingSince ?? 0));
  if (sn && s.settings.snipeLive) {
    return { kind: "snipe", tokenId: sn.tokenId, mint: sn.mint, sol: sn.sol, jobId: sn.id };
  }
  const copy = s.copyPending.find((p) => p.chain && p.fireAt <= now && !!p.mint && !(p.pendingSince ?? 0));
  if (copy?.mint) {
    const rule = s.copyRules.find((r) => r.walletId === copy.walletId);
    const sol = styleSize(styleOf(rule?.style), rule?.sizePct ?? 10, rule?.maxSol ?? 2, copy.srcSol ?? 0);
    return { kind: "copy", tokenId: copy.tokenId, mint: copy.mint, sol, side: copy.side, jobId: copy.id };
  }
  const lad = s.ladders.find((l) => l.status === "live" && l.chain && l.pendingSol >= 0.05);
  if (lad) {
    const tk = s.tokens.find((t) => t.id === lad.tokenId);
    if (tk?.mint) return { kind: "ladder", tokenId: lad.tokenId, mint: tk.mint, sol: lad.pendingSol };
  }
  const dca = s.dcaPlans.find((p) => p.status === "live" && p.chain && p.pendingSol >= 0.05);
  if (dca) {
    const tk = s.tokens.find((t) => t.id === dca.tokenId);
    if (tk?.mint) return { kind: "dca", tokenId: dca.tokenId, mint: tk.mint, sol: dca.pendingSol };
  }
  return null;
}

function failJob(job: ChainJob): void {
  const s = useDesk.getState();
  if (job.kind === "exit") s.finishChainExit(job.tokenId, false);
  else if (job.kind === "copy" && job.jobId) s.finishCopyJob(job.jobId, false);
  else if (job.kind === "snipe" && job.jobId) s.finishSnipeJob(job.jobId, false);
  else if (job.kind === "ladder" || job.kind === "dca") s.finishChainSlice(job.kind, job.tokenId, false);
}

export async function pumpLiveAuto(): Promise<void> {
  if (busy || typeof window === "undefined") return;
  const s0 = useDesk.getState();
  if (!s0.settings.execLive) return;
  if (!canSignHot(s0.hotVault, s0.hotUnlocked, s0.walletPk) || !s0.walletPk) return;
  const now = Date.now();
  for (const p of s0.copyPending) {
    if (p.chain && (p.pendingSince ?? 0) > 0 && now - (p.pendingSince ?? 0) > STALE) {
      s0.finishCopyJob(p.id, false);
    }
  }
  for (const j of s0.snipeJobs) {
    if ((j.pendingSince ?? 0) > 0 && now - (j.pendingSince ?? 0) > STALE) {
      s0.finishSnipeJob(j.id, false);
    }
  }
  const job = nextChainJob();
  if (!job) return;
  const s = useDesk.getState();
  const tk = s.tokens.find((t) => t.id === job.tokenId);
  if (!tk) {
    failJob(job);
    return;
  }

  const tip = Math.round(Math.max(0, Math.min(0.01, s.settings.priority)) * 1e9);
  const slip = slipBps(s.settings.slippage, s.settings.mev);
  const user = s.walletPk;
  if (!user) return;

  if (job.kind === "copy" && job.jobId) s.armCopyJob(job.jobId);
  if (job.kind === "snipe" && job.jobId) s.armSnipeJob(job.jobId);

  const sellCopy = job.kind === "copy" && job.side === "sell";
  if (job.kind === "exit" || sellCopy) {
    const hold = s.chainHoldings.find((h) => h.mint === job.mint);
    const holdSol = hold ? hold.amount * tk.price : 0;
    const want = sellCopy ? liveSpendCap(job.sol ?? 0, holdSol, s.settings.maxTradeSol) : holdSol * Math.min(1, job.frac ?? 1);
    if (!hold || want < 0.05) {
      failJob(job);
      return;
    }
    const raw = liveSellRaw(hold.amount, hold.decimals, want, holdSol);
    if (!raw) {
      failJob(job);
      return;
    }
    busy = true;
    try {
      const res = await sendLiveSwap({
        mint: job.mint,
        user,
        side: "sell",
        amountRaw: raw,
        slip,
        priorityLamports: tip,
        vault: s.hotVault,
        unlocked: s.hotUnlocked,
      });
      if (!res.ok) {
        failJob(job);
        return;
      }
      if (job.kind === "exit") s.finishChainExit(job.tokenId, true);
      else if (job.jobId) s.finishCopyJob(job.jobId, true);
      s.recordLiveFill({
        sig: res.sig,
        mint: job.mint,
        tokenId: job.tokenId,
        side: "sell",
        sol: want,
        status: res.status,
      });
    } finally {
      busy = false;
    }
    return;
  }

  if (s.riskHalt || (s.settings.guardMint && tk.security.onchain && tk.security.freeze) || (s.settings.hideRugs && isRug(tk.security))) {
    failJob(job);
    return;
  }
  const feeReserve = s.chainSol == null ? null : Math.max(0, s.chainSol - 0.015);
  const spend = liveSpendCap(job.sol ?? 0, feeReserve, s.settings.maxTradeSol);
  if (spend < 0.05) {
    failJob(job);
    return;
  }
  busy = true;
  try {
    const res = await sendLiveSwap({
      mint: job.mint,
      user,
      side: "buy",
      lamports: Math.round(spend * 1e9),
      slip,
      priorityLamports: tip,
      vault: s.hotVault,
      unlocked: s.hotUnlocked,
    });
    if (!res.ok) {
      failJob(job);
      return;
    }
    if (job.kind === "copy" && job.jobId) s.finishCopyJob(job.jobId, true);
    else if (job.kind === "snipe" && job.jobId) s.finishSnipeJob(job.jobId, true);
    else if (job.kind === "ladder" || job.kind === "dca") s.finishChainSlice(job.kind, job.tokenId, true, tk.price);
    s.recordLiveFill({
      sig: res.sig,
      mint: job.mint,
      tokenId: job.tokenId,
      side: "buy",
      sol: spend,
      status: res.status,
    });
  } finally {
    busy = false;
  }
}
