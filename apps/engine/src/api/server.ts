/**
 * The engine's HTTP + WebSocket API (ADR-0009 §2). Reads come from Postgres,
 * the collector and the executor; every mutation (approve or reject an
 * intent, halt, halt-clear, unseal, seal) writes an `events` row. Halt-clear
 * and unseal need the second factor (TOTP); halt and seal never do, since
 * stopping money is always allowed.
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  API_ROUTES,
  type ApiState,
  type FunnelView,
  type RuleView,
  type VaultState,
  type WsMessage,
} from "@wick/core/api";
import { WebSocketServer, type WebSocket } from "ws";
import type { Regime } from "@wick/core/contracts";
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
  /** The rules the decision layer runs, for `/api/rules` and the mode counts. */
  rules: () => RuleView[];
  /** The regime writer's current row, null before its first minute. */
  regime: () => Regime | null;
  /** The operator re-enables a rule the evaluator disabled; false when it was not disabled. */
  enableRule: (id: string, by: string) => Promise<boolean>;
  /** One line to the owner's phone for what changed (the Telegram bot); optional. */
  notify?: (text: string) => void;
  /** Followed wallets at most (the mirror rule's cap; ENGINE §9 says six). */
  maxFollowed?: number;
  /** Bearer token; when null (local dev) every caller is the owner. */
  token: string | null;
  /** The executor's side: vault state, wallet reads and the second factor. */
  exec: ExecDeps;
};

export type ExecDeps = {
  vault: () => VaultState;
  wallet: () => string | null;
  /** Free SOL from the last wallet read; null while sealed. */
  cashSol: () => number | null;
  /** Cost of the open positions, so equity = cash + deployed. */
  deployedSol: () => Promise<number>;
  unseal: (passphrase: string, code: string) => Promise<void>;
  seal: () => void;
  /** True when `code` is a valid second factor right now. */
  secondFactor: (code: string) => Promise<boolean>;
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

export function modeCounts(rules: RuleView[]): ApiState["modes"] {
  const modes: ApiState["modes"] = { shadow: 0, suggest: 0, auto: 0 };
  for (const r of rules) modes[r.mode]++;
  return modes;
}

export function createApi(deps: ApiDeps) {
  const sockets = new Set<WebSocket>();

  async function state(): Promise<ApiState> {
    const now = Date.now();
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    const [openPositions, pendingIntents, halts, deployed, dayPnlSol] = await Promise.all([
      q.countOpenPositions(deps.db),
      q.countPending(deps.db),
      q.activeHalts(deps.db),
      deps.exec.deployedSol(),
      q.realizedPnl(deps.db, dayStart.getTime(), now),
    ]);
    const cash = deps.exec.cashSol();
    const equitySol = cash == null ? null : cash + deployed;
    return {
      version: deps.version,
      now,
      chain: "solana",
      tier: deps.tier,
      walletCapSol: deps.walletCapSol,
      equitySol,
      solUsd: deps.solUsd(),
      dayPnlSol,
      dayPnlPct:
        dayPnlSol == null || equitySol == null || equitySol <= 0
          ? null
          : (dayPnlSol / equitySol) * 100,
      openPositions,
      pendingIntents,
      modes: modeCounts(deps.rules()),
      regime: deps.regime(),
      halts,
      health: deps.health(),
      vault: deps.exec.vault(),
    };
  }

  async function audit(msg: string, data: Record<string, unknown>): Promise<void> {
    await deps.db.query(
      "insert into events (ts, level, component, msg, data) values (now(), 'info', 'api', $1, $2)",
      [msg, JSON.stringify(data)],
    );
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
        if (path === API_ROUTES.rules) return (json(res, 200, deps.rules()), true);
        if (path === API_ROUTES.replays)
          return (json(res, 200, await q.listReplays(deps.db)), true);
        if (path === API_ROUTES.wallets)
          return (json(res, 200, await q.listWallets(deps.db)), true);
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
        const en = path.match(/^\/api\/rules\/([^/]+)\/enable$/);
        if (en) {
          const body = await readJson(req);
          const code = typeof body.code === "string" ? body.code : "";
          if (!(await deps.exec.secondFactor(code)))
            return (json(res, 403, { error: "second factor rejected", status: 403 }), true);
          const id = decodeURIComponent(en[1]!);
          const ok = await deps.enableRule(id, "owner");
          if (!ok) return (json(res, 409, { error: "rule is not disabled", status: 409 }), true);
          await audit("rule re-enabled", { rule: id });
          deps.notify?.(`rule ${id} re-enabled`);
          broadcast({ type: "alert", level: "warn", msg: `rule ${id} re-enabled`, ts: Date.now() });
          broadcast({ type: "state", state: await state() });
          return (json(res, 200, { ok: true }), true);
        }
        if (path === API_ROUTES.wallets) {
          const body = await readJson(req);
          const pk = typeof body.pk === "string" ? body.pk.trim() : "";
          const label =
            typeof body.label === "string" && body.label.trim()
              ? body.label.trim().slice(0, 40)
              : null;
          const code = typeof body.code === "string" ? body.code : "";
          if (!(await deps.exec.secondFactor(code)))
            return (json(res, 403, { error: "second factor rejected", status: 403 }), true);
          const r = await q.followWallet(deps.db, pk, label, deps.maxFollowed ?? 6);
          if (r === "invalid")
            return (json(res, 400, { error: "not a Solana public key", status: 400 }), true);
          if (r === "full")
            return (
              json(res, 409, { error: `already following ${deps.maxFollowed ?? 6}`, status: 409 }),
              true
            );
          await audit("wallet followed", { wallet: pk, label });
          deps.notify?.(`following ${label ?? pk}`);
          broadcast({
            type: "alert",
            level: "info",
            msg: `following ${label ?? pk}`,
            ts: Date.now(),
          });
          return (json(res, 200, { ok: true }), true);
        }
        const ws = path.match(/^\/api\/wallets\/([^/]+)\/status$/);
        if (ws) {
          const pk = decodeURIComponent(ws[1]!);
          const body = await readJson(req);
          const status =
            body.status === "follow" ? "follow" : body.status === "watch" ? "watch" : null;
          if (!status)
            return (json(res, 400, { error: "status must be follow or watch", status: 400 }), true);
          if (status === "follow") {
            const code = typeof body.code === "string" ? body.code : "";
            if (!(await deps.exec.secondFactor(code)))
              return (json(res, 403, { error: "second factor rejected", status: 403 }), true);
            const r = await q.followWallet(deps.db, pk, null, deps.maxFollowed ?? 6);
            if (r === "invalid")
              return (json(res, 400, { error: "not a Solana public key", status: 400 }), true);
            if (r === "full")
              return (
                json(res, 409, {
                  error: `already following ${deps.maxFollowed ?? 6}`,
                  status: 409,
                }),
                true
              );
          } else if (!(await q.watchWallet(deps.db, pk, "set to watch by the owner")))
            return (json(res, 404, { error: "unknown wallet", status: 404 }), true);
          await audit("wallet status", { wallet: pk, status });
          deps.notify?.(`wallet ${pk.slice(0, 4)}…${pk.slice(-4)} now ${status}`);
          return (json(res, 200, { ok: true }), true);
        }
        if (path === API_ROUTES.halt) {
          const body = await readJson(req);
          const reason =
            typeof body.reason === "string" && body.reason ? body.reason.slice(0, 200) : "manual";
          await q.addHalt(deps.db, "manual", reason);
          m.halted.set({ kind: "manual" }, 1);
          deps.notify?.(`halt from the console: ${reason}`);
          broadcast({ type: "alert", level: "warn", msg: `halt: ${reason}`, ts: Date.now() });
          broadcast({ type: "state", state: await state() });
          return (json(res, 200, { ok: true }), true);
        }
        if (path === API_ROUTES.haltClear) {
          const body = await readJson(req);
          const code = typeof body.code === "string" ? body.code : "";
          if (!(await deps.exec.secondFactor(code)))
            return (json(res, 403, { error: "second factor rejected", status: 403 }), true);
          const n = await q.clearHalts(deps.db, ["manual", "pnl"], "owner");
          m.halted.set({ kind: "manual" }, 0);
          await audit("halt cleared", { cleared: n });
          deps.notify?.(`halt cleared from the console (${n})`);
          broadcast({ type: "alert", level: "info", msg: `halt cleared (${n})`, ts: Date.now() });
          broadcast({ type: "state", state: await state() });
          return (json(res, 200, { ok: true, cleared: n }), true);
        }
        if (path === API_ROUTES.unseal) {
          const body = await readJson(req);
          const passphrase = typeof body.passphrase === "string" ? body.passphrase : "";
          const code = typeof body.code === "string" ? body.code : "";
          try {
            await deps.exec.unseal(passphrase, code);
          } catch (e) {
            const kind = (e as { kind?: string }).kind ?? "error";
            const status = kind === "no-vault" || kind === "second-factor-unset" ? 409 : 403;
            await audit("unseal refused", { kind });
            return (json(res, status, { error: errText(e), status }), true);
          }
          await audit("vault unsealed", { wallet: deps.exec.wallet() });
          deps.notify?.(`vault unsealed: ${deps.exec.wallet() ?? ""}`);
          broadcast({ type: "alert", level: "info", msg: "vault unsealed", ts: Date.now() });
          broadcast({ type: "state", state: await state() });
          return (json(res, 200, { ok: true, wallet: deps.exec.wallet() }), true);
        }
        if (path === API_ROUTES.seal) {
          deps.exec.seal();
          await audit("vault sealed", {});
          deps.notify?.("vault sealed");
          broadcast({ type: "alert", level: "warn", msg: "vault sealed", ts: Date.now() });
          broadcast({ type: "state", state: await state() });
          return (json(res, 200, { ok: true }), true);
        }
      }
      if (req.method === "DELETE") {
        const w = path.match(/^\/api\/wallets\/([^/]+)$/);
        if (w) {
          const pk = decodeURIComponent(w[1]!);
          if (!(await q.removeWallet(deps.db, pk)))
            return (json(res, 404, { error: "unknown wallet", status: 404 }), true);
          await audit("wallet removed", { wallet: pk });
          deps.notify?.(`wallet ${pk.slice(0, 4)}…${pk.slice(-4)} removed`);
          return (json(res, 200, { ok: true }), true);
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
