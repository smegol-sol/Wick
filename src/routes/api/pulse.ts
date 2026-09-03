import { createFileRoute } from "@tanstack/react-router";
import { clientKey, jsonErr, jsonOk, rateLimit } from "@/lib/guard";
import { loadSolanaPulse } from "@/lib/solana-pulse";

export const Route = createFileRoute("/api/pulse")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!rateLimit(`pulse:${clientKey(request)}`, 24)) {
          return jsonErr("rate", 429);
        }
        const tokens = await loadSolanaPulse();
        return jsonOk({ tokens });
      },
    },
  },
});
