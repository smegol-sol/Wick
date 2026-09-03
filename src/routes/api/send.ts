import { createFileRoute } from "@tanstack/react-router";
import { clientKey, isSig, jsonErr, jsonOk, rateLimit } from "@/lib/guard";

const RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
const B64 = /^[A-Za-z0-9+/]+=*$/;

export const Route = createFileRoute("/api/send")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!rateLimit(`send:${clientKey(request)}`, 8)) {
          return jsonErr("rate", 429);
        }
        let body: { tx?: unknown };
        try {
          body = (await request.json()) as { tx?: unknown };
        } catch {
          return jsonErr("bad", 400);
        }
        const tx = typeof body.tx === "string" ? body.tx.trim() : "";
        if (tx.length < 64 || tx.length > 12_000 || !B64.test(tx)) return jsonErr("bad", 400);
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
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
                  method: "sendRawTransaction",
                  params: [tx, { encoding: "base64", skipPreflight: false, maxRetries: 2 }],
                }),
              });
              if (!res.ok) continue;
              const data = (await res.json()) as { result?: string; error?: { message?: string } };
              if (typeof data.result === "string" && isSig(data.result)) {
                return jsonOk({ ok: true, sig: data.result });
              }
            } catch {
              continue;
            }
          }
          return jsonErr("fail", 502);
        } finally {
          clearTimeout(t);
        }
      },
    },
  },
});
