import { createFileRoute } from "@tanstack/react-router";
import { clientKey, isSig, jsonErr, jsonOk, rateLimit, sameOrigin } from "@wick/core/guard";
import { rpcCall, rpcUrls, withTimeout } from "@wick/core/rpc";

const B64 = /^[A-Za-z0-9+/]+=*$/;

export const Route = createFileRoute("/api/send")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!sameOrigin(request)) return jsonErr("origin", 403);
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
        const { signal, done } = withTimeout(8000);
        try {
          for (const url of rpcUrls()) {
            try {
              const sig = await rpcCall<string>(
                url,
                "sendRawTransaction",
                [tx, { encoding: "base64", skipPreflight: false, maxRetries: 2 }],
                signal,
              );
              if (typeof sig === "string" && isSig(sig)) return jsonOk({ ok: true, sig });
            } catch {
              continue;
            }
          }
          return jsonErr("fail", 502);
        } finally {
          done();
        }
      },
    },
  },
});
