import { createFileRoute } from "@tanstack/react-router";
import { WSOL } from "@/lib/solana-wallet";
import {
  amountRawOk,
  clientKey,
  isB58,
  jsonErr,
  jsonOk,
  quoteLamportsOk,
  rateLimit,
} from "@/lib/guard";
import { fetchJupQuote, impactPct, jupPair } from "@/lib/jup";

export const Route = createFileRoute("/api/quote")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!rateLimit(`quote:${clientKey(request)}`, 30)) {
          return jsonErr("rate", 429);
        }
        const q = new URL(request.url).searchParams;
        const mint = (q.get("mint") ?? "").trim();
        const side = q.get("side") === "sell" ? "sell" : "buy";
        const slip = Number(q.get("slip") ?? 150);
        if (!isB58(mint) || mint === WSOL) return jsonErr("bad", 400);
        const bps = Math.max(10, Math.min(2000, Math.round(Number.isFinite(slip) ? slip : 150)));
        let amount: string;
        if (side === "sell") {
          const raw = (q.get("amount") ?? "").trim();
          if (!amountRawOk(raw)) return jsonErr("bad", 400);
          amount = raw;
        } else {
          const lamports = Number(q.get("lamports") ?? 0);
          if (!quoteLamportsOk(lamports)) return jsonErr("bad", 400);
          amount = String(Math.round(lamports));
        }
        const pair = jupPair(side, mint);
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        try {
          const data = await fetchJupQuote(pair.input, pair.output, amount, bps, ctrl.signal);
          if (!data) return jsonOk({ ok: false }, 502);
          const impact = impactPct(data.priceImpactPct);
          return jsonOk({
            ok: true,
            outAmount: data.outAmount.slice(0, 24),
            inAmount: data.inAmount.slice(0, 24),
            // Percent, not Jupiter's raw fraction.
            priceImpactPct: impact == null ? "0" : impact.toFixed(4),
          });
        } catch {
          return jsonOk({ ok: false }, 502);
        } finally {
          clearTimeout(t);
        }
      },
    },
  },
});
