import { createFileRoute } from "@tanstack/react-router";
import {
  amountRawOk,
  clientKey,
  isB58,
  jsonErr,
  jsonOk,
  priorityLamportsOk,
  quoteLamportsOk,
  rateLimit,
  sameOrigin,
} from "@/lib/guard";
import { fetchJupQuote, fetchJupSwap, impactPct, jupPair } from "@/lib/jup";
import { WSOL } from "@/lib/solana-wallet";

/** Percent. The desk refuses to sign a swap that moves the pool more than this. */
const MAX_IMPACT_PCT = 18;

export const Route = createFileRoute("/api/swap")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!sameOrigin(request)) return jsonErr("origin", 403);
        if (!rateLimit(`swap:${clientKey(request)}`, 8)) {
          return jsonErr("rate", 429);
        }
        let body: {
          mint?: unknown;
          user?: unknown;
          side?: unknown;
          lamports?: unknown;
          amountRaw?: unknown;
          slip?: unknown;
          priorityLamports?: unknown;
        };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return jsonErr("bad", 400);
        }
        const mint = typeof body.mint === "string" ? body.mint.trim() : "";
        const user = typeof body.user === "string" ? body.user.trim() : "";
        const side = body.side === "sell" ? "sell" : body.side === "buy" ? "buy" : null;
        if (!side || !isB58(mint) || !isB58(user) || mint === WSOL || mint === user) {
          return jsonErr("bad", 400);
        }
        const bps = Math.max(10, Math.min(2000, Math.round(Number(body.slip) || 150)));
        const tip = Number(body.priorityLamports) || 0;
        if (!priorityLamportsOk(tip)) return jsonErr("bad", 400);

        let amount: string;
        if (side === "buy") {
          const lamports = Number(body.lamports);
          if (!quoteLamportsOk(lamports)) return jsonErr("bad", 400);
          amount = String(Math.round(lamports));
        } else {
          const raw = typeof body.amountRaw === "string" ? body.amountRaw.trim() : "";
          if (!amountRawOk(raw)) return jsonErr("bad", 400);
          amount = raw;
        }

        const pair = jupPair(side, mint);
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 7000);
        try {
          const quote = await fetchJupQuote(pair.input, pair.output, amount, bps, ctrl.signal);
          if (!quote) return jsonErr("route", 502);
          const impact = impactPct(quote.priceImpactPct);
          // Unknown impact is not "zero impact": refuse rather than guess.
          if (impact == null || impact >= MAX_IMPACT_PCT) return jsonErr("impact", 400);
          const built = await fetchJupSwap(quote, user, tip, ctrl.signal);
          if (!built) return jsonErr("fail", 502);
          return jsonOk({
            ok: true,
            swapTransaction: built.swapTransaction,
            lastValidBlockHeight: built.lastValidBlockHeight ?? 0,
            inAmount: quote.inAmount.slice(0, 24),
            outAmount: quote.outAmount.slice(0, 24),
            priceImpactPct: impact.toFixed(4),
          });
        } catch {
          return jsonErr("fail", 502);
        } finally {
          clearTimeout(t);
        }
      },
    },
  },
});
