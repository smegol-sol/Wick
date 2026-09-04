import { isB58, isSig } from "@wick/core/guard";
import { canSignHot, signHotTx } from "@wick/core/hot-wallet";
import type { HotVault } from "@wick/core/hot-wallet";

export type LiveSwapReq = {
  mint: string;
  user: string;
  side: "buy" | "sell";
  lamports?: number;
  amountRaw?: string;
  slip: number;
  priorityLamports: number;
  vault?: HotVault | null;
  unlocked?: boolean;
};

export type LiveSwapOk = { ok: true; sig: string; status: "sent" | "ok" };
export type LiveSwapErr = {
  ok: false;
  error: "rate" | "bad" | "route" | "wallet" | "reject" | "fail" | "needWallet" | "impact";
};
export type LiveSwapResult = LiveSwapOk | LiveSwapErr;

async function waitTx(sig: string): Promise<"sent" | "ok"> {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 400 + i * 200));
    try {
      const res = await fetch(`/api/tx?sig=${encodeURIComponent(sig)}`);
      if (!res.ok) continue;
      const data = (await res.json()) as { ok?: boolean; err?: boolean };
      if (data.err) return "sent";
      if (data.ok) return "ok";
    } catch {
      /* keep polling */
    }
  }
  return "sent";
}

async function broadcast(signed: string): Promise<LiveSwapResult> {
  try {
    const res = await fetch("/api/send", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ tx: signed }),
    });
    if (res.status === 429) return { ok: false, error: "rate" };
    const data = (await res.json().catch(() => null)) as { ok?: boolean; sig?: string } | null;
    if (!data?.ok || typeof data.sig !== "string" || !isSig(data.sig))
      return { ok: false, error: "fail" };
    const status = await waitTx(data.sig);
    return { ok: true, sig: data.sig, status };
  } catch {
    return { ok: false, error: "fail" };
  }
}

export async function sendLiveSwap(req: LiveSwapReq): Promise<LiveSwapResult> {
  if (!isB58(req.mint) || !isB58(req.user)) return { ok: false, error: "bad" };
  if (!canSignHot(req.vault ?? null, !!req.unlocked, req.user))
    return { ok: false, error: "needWallet" };

  let res: Response;
  try {
    res = await fetch("/api/swap", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        mint: req.mint,
        user: req.user,
        side: req.side,
        lamports: req.lamports,
        amountRaw: req.amountRaw,
        slip: req.slip,
        priorityLamports: req.priorityLamports,
      }),
    });
  } catch {
    return { ok: false, error: "fail" };
  }
  if (res.status === 429) return { ok: false, error: "rate" };
  const data = (await res.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    swapTransaction?: string;
  } | null;
  if (!data || data.ok !== true || typeof data.swapTransaction !== "string") {
    if (data?.error === "route") return { ok: false, error: "route" };
    if (data?.error === "bad") return { ok: false, error: "bad" };
    if (data?.error === "impact") return { ok: false, error: "impact" };
    return { ok: false, error: "fail" };
  }

  try {
    const signed = await signHotTx(data.swapTransaction);
    return broadcast(signed);
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    if (/reject|denied|cancel/i.test(text)) return { ok: false, error: "reject" };
    return { ok: false, error: "fail" };
  }
}
