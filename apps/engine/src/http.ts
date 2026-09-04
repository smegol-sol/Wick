/**
 * The engine's HTTP surface: /metrics for Prometheus, /healthz for the
 * dashboard and the dead-man check, and the API + WebSocket (api/server.ts).
 * Bound to localhost in development; in compose only Caddy on the tailnet
 * reaches it (ADR-0009).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { registry } from "./metrics.ts";
import type { Health } from "./health.ts";

export type HttpDeps = {
  health: () => Health;
  version: string;
  api?: {
    handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
    attach: (server: Server) => () => void;
  };
};

export function startHttp(host: string, port: number, deps: HttpDeps): Server {
  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    if (deps.api && (await deps.api.handle(req, res))) return;
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
  const detach = deps.api?.attach(server);
  server.on("close", () => detach?.());
  server.listen(port, host);
  return server;
}
