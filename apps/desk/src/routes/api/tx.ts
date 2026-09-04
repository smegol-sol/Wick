import { createFileRoute } from "@tanstack/react-router";
import { clientKey, isSig, jsonErr, jsonOk, rateLimit } from "@wick/core/guard";

const RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];

export const Route = createFileRoute("/api/tx")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!rateLimit(`tx:${clientKey(request)}`, 40)) {
          return jsonErr("rate", 429);
        }
        const sig = new URL(request.url).searchParams.get("sig")?.trim() ?? "";
        if (!isSig(sig)) return jsonErr("bad", 400);
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        try {
          for (const url of RPCS) {
            try {
              const res = await fetch(url, {
                method: "POST",
                signal: ctrl.signal,
                headers: { "content-type": "application/json", "user-agent": "WICK/1" },
                redirect: "error",
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "getSignatureStatuses",
                  params: [[sig], { searchTransactionHistory: true }],
                }),
              });
              if (!res.ok) continue;
              const data = (await res.json()) as {
                result?: { value?: Array<{ confirmationStatus?: string; err?: unknown } | null> };
              };
              const st = data.result?.value?.[0];
              if (!st) return jsonOk({ ok: false, pending: true });
              if (st.err) return jsonOk({ ok: false, err: true });
              const conf = st.confirmationStatus;
              return jsonOk({ ok: conf === "confirmed" || conf === "finalized", pending: !conf });
            } catch {
              continue;
            }
          }
          return jsonOk({ ok: false, pending: true }, 502);
        } finally {
          clearTimeout(t);
        }
      },
    },
  },
});
