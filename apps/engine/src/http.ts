/**
 * The engine's own HTTP surface: /metrics for Prometheus and /healthz for
 * the dashboard and the dead-man check. Bound to localhost; the reverse
 * proxy on the tailnet is the only other reader (ADR-0009).
 */
import { createServer, type Server } from "node:http";
import { registry } from "./metrics.ts";
import type { Health } from "./health.ts";

export type HttpDeps = { health: () => Health; version: string };

export function startHttp(host: string, port: number, deps: HttpDeps): Server {
  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    if (url === "/metrics") {
      const body = await registry.metrics();
      res.writeHead(200, { "content-type": registry.contentType }).end(body);
      return;
    }
    if (url === "/healthz") {
      const h = deps.health();
      res
        .writeHead(h.ok ? 200 : 503, { "content-type": "application/json" })
        .end(JSON.stringify({ version: deps.version, ...h }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, host);
  return server;
}
