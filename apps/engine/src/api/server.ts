/**
 * The engine's HTTP + WebSocket API (ADR-0009 §2). Reads come from Postgres
 * and the collector; the two mutations that exist in Phase 1 (approve or
 * reject an intent, halt) write an `events` row. Unseal and halt-clear
 * answer 501 until the executor and the second factor land.
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { API_ROUTES, type ApiState, type FunnelView, type WsMessage } from "@wick/core/api";
import { WebSocketServer, type WebSocket } from "ws";
import type { Db } from "../db/pool.ts";
import type { Health } from "../health.ts";
import { errText, logger } from "../log.ts";
import * as m from "../metrics.ts";
import * as q from "./queries.ts";

const log = logger("api");

export type ApiDeps = {
  db: Db;
  health: () => Health;
  version: string;
  tier: 1 | 2 | 3;
  walletCapSol: number;
  solUsd: () => number | null;
  /** Bearer token; when null (local dev) every caller is the owner. */
  token: string | null;
};

export function authorized(header: string | undefined, token: string | null): boolean {
  if (token == null) return true;
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Matches `/api/intents/:id/approve` style paths. */
export function matchIntentAction(
  path: string,
): { id: string; action: "approve" | "reject" } | null {
  const mm = path.match(/^\/api\/intents\/([^/]+)\/(approve|reject)$/);
  return mm ? { id: decodeURIComponent(mm[1]!), action: mm[2] as "approve" | "reject" } : null;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res
    .writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
    .end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) {
    chunks.push(c as Buffer);
    if (chunks.reduce((n, b) => n + b.length, 0) > 16_384) throw new Error("body too large");
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function funnelLayers(): Promise<FunnelView["layers"]> {
  const metric = await m.funnel.get();
  const by = new Map<string, { entered: number; passed: number }>();
  for (const v of metric.values) {
    const layer = String(v.labels.layer);
    const cur = by.get(layer) ?? { entered: 0, passed: 0 };
    if (v.labels.outcome === "in") cur.entered += v.value;
    else cur.passed += v.value;
    by.set(layer, cur);
  }
  const order = ["activity", "sieve", "regime", "decision", "gates", "execution"] as const;
  return order.map((layer) => ({ layer, ...(by.get(layer) ?? { entered: 0, passed: 0 }) }));
}

export function createApi(deps: ApiDeps) {
  const sockets = new Set<WebSocket>();

  async function state(): Promise<ApiState> {
    const [openPositions, pendingIntents, halts] = await Promise.all([
      q.countOpenPositions(deps.db),
      q.countPending(deps.db),
      q.activeHalts(deps.db),
    ]);
    return {
      version: deps.version,
      now: Date.now(),
      chain: "solana",
      tier: deps.tier,
      walletCapSol: deps.walletCapSol,
      equitySol: null, // the executor's wallet balance (Phase 2)
      solUsd: deps.solUsd(),
      dayPnlSol: null,
      dayPnlPct: null,
      openPositions,
      pendingIntents,
      modes: { shadow: 0, suggest: 0, auto: 0 }, // rules land with the decision layer
      regime: null,
      halts,
      health: deps.health(),
      vault: "none",
    };
  }

  function broadcast(msg: WsMessage): void {
    const text = JSON.stringify(msg);
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(text);
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://engine");
    const path = url.pathname;
    if (!path.startsWith("/api/")) return false;
    if (!authorized(req.headers.authorization, deps.token)) {
      json(res, 401, { error: "unauthorized", status: 401 });
      return true;
    }
    try {
      if (req.method === "GET") {
        if (path === API_ROUTES.state) return (json(res, 200, await state()), true);
        if (path === API_ROUTES.intents) {
          const status = url.searchParams.get("status");
          const limit = Math.min(200, Number(url.searchParams.get("limit")) || 50);
          return (json(res, 200, await q.listIntents(deps.db, status, limit)), true);
        }
        if (path === API_ROUTES.positions)
          return (json(res, 200, await q.listPositions(deps.db)), true);
        if (path === API_ROUTES.funnel) {
          const since = Date.now() - 24 * 3600_000;
          return (json(res, 200, await q.funnelView(deps.db, await funnelLayers(), since)), true);
        }
        if (path === API_ROUTES.rules) return (json(res, 200, []), true);
        if (path === API_ROUTES.replays)
          return (json(res, 200, await q.listReplays(deps.db)), true);
        const tk = path.match(/^\/api\/tokens\/([^/]+)$/);
        if (tk) {
          const view = await q.tokenView(deps.db, decodeURIComponent(tk[1]!));
          return (
            view ? json(res, 200, view) : json(res, 404, { error: "unknown token", status: 404 }),
            true
          );
        }
        const one = path.match(/^\/api\/intents\/([^/]+)$/);
        if (one) {
          const view = await q.getIntent(deps.db, decodeURIComponent(one[1]!));
          return (
            view ? json(res, 200, view) : json(res, 404, { error: "unknown intent", status: 404 }),
            true
          );
        }
      }
      if (req.method === "POST") {
        const act = matchIntentAction(path);
        if (act) {
          const body = await readJson(req);
          const decidedBy =
            typeof body.decidedBy === "string" && body.decidedBy
              ? body.decidedBy.slice(0, 40)
              : "owner";
          const view = await q.decideIntent(
            deps.db,
            act.id,
            act.action === "approve" ? "approved" : "rejected",
            decidedBy,
          );
          if (!view) return (json(res, 409, { error: "intent is not waiting", status: 409 }), true);
          broadcast({ type: "intent", intent: view });
          return (json(res, 200, view), true);
        }
        if (path === API_ROUTES.halt) {
          const body = await readJson(req);
          const reason =
            typeof body.reason === "string" && body.reason ? body.reason.slice(0, 200) : "manual";
          await q.addHalt(deps.db, "manual", reason);
          m.halted.set({ kind: "manual" }, 1);
          broadcast({ type: "alert", level: "warn", msg: `halt: ${reason}`, ts: Date.now() });
          broadcast({ type: "state", state: await state() });
          return (json(res, 200, { ok: true }), true);
        }
        if (path === API_ROUTES.haltClear || path === API_ROUTES.unseal) {
          return (
            json(res, 501, { error: "needs the second factor; lands in Phase 2", status: 501 }),
            true
          );
        }
      }
      json(res, 404, { error: "not found", status: 404 });
    } catch (e) {
      log.error("request failed", { path, err: errText(e) });
      json(res, 500, { error: "internal", status: 500 });
    }
    return true;
  }

  function attach(server: Server): () => void {
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://engine");
      if (url.pathname !== API_ROUTES.ws) {
        socket.destroy();
        return;
      }
      const header =
        req.headers.authorization ??
        (url.searchParams.get("token") ? `Bearer ${url.searchParams.get("token")}` : undefined);
      if (!authorized(header, deps.token)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        sockets.add(ws);
        ws.on("close", () => sockets.delete(ws));
        void state().then((s) =>
          ws.send(JSON.stringify({ type: "state", state: s } satisfies WsMessage)),
        );
      });
    });
    const tick = setInterval(() => {
      if (sockets.size === 0) return;
      void state()
        .then((s) => broadcast({ type: "state", state: s }))
        .catch((e) => log.warn("state tick failed", { err: errText(e) }));
    }, 5000);
    return () => {
      clearInterval(tick);
      for (const ws of sockets) ws.close();
      wss.close();
    };
  }

  return { handle, attach, broadcast, state };
}
