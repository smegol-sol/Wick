/**
 * Engine entry point. Phase 1 scope: ingest, health, metrics. No decision
 * layer and nothing that can sign runs here yet.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApi } from "./api/server.ts";
import { makeSolanaAdapter } from "./chains/solana/index.ts";
import { loadRisk, parseEnv } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { makePool, ping } from "./db/pool.ts";
import { evaluateHealth, type Health } from "./health.ts";
import { startHttp } from "./http.ts";
import { Collector } from "./ingest/collector.ts";
import { errText, logger, setLogLevel } from "./log.ts";
import * as m from "./metrics.ts";

const log = logger("main");
const REQUIRED_SOURCES = ["pump.fun", "rpc"];

function version(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
    );
    return String(pkg.version ?? "0");
  } catch {
    return "0";
  }
}

async function main(): Promise<void> {
  const cfg = parseEnv(process.env);
  setLogLevel(cfg.logLevel);
  const risk = loadRisk(cfg.riskFile);
  log.info("starting", {
    version: version(),
    tier: risk.tier,
    walletCapSol: risk.executionWalletCapSol,
  });
  if (cfg.solanaRpcUrl) process.env.SOLANA_RPC_URL = cfg.solanaRpcUrl;
  else log.warn("SOLANA_RPC_URL unset; public RPCs only, unfit for anything but a smoke run");

  const db = makePool(cfg.databaseUrl);
  const applied = await migrate(db);
  if (applied.length) log.info("migrations applied", { applied });
  let dbOk = await ping(db);
  const dbTimer = setInterval(() => void ping(db).then((ok) => (dbOk = ok)), 10_000);

  const chain = makeSolanaAdapter();
  const collector = new Collector(db, chain, {
    activeSampleMs: cfg.activeSampleMs,
    coolingSampleMs: cfg.coolingSampleMs,
    activeWindowMs: cfg.activeWindowMs,
    coolingWindowMs: cfg.coolingWindowMs,
    auditEveryMs: cfg.auditEveryMs,
    slotPollMs: cfg.slotPollMs,
    launchPerTick: 2,
    launchRetryMs: 60_000,
  });

  const health = (): Health =>
    evaluateHealth(
      {
        now: Date.now(),
        lastOk: collector.state.lastOk,
        slotLag: collector.state.slotLag,
        decisionP99Ms: null,
        budgetBreachSince: null,
        dbOk,
      },
      { ...risk.health, requiredSources: REQUIRED_SOURCES },
    );

  const stopLoop = m.watchEventLoop();
  const token = process.env.DASHBOARD_TOKEN?.trim() || null;
  if (!token)
    log.warn("DASHBOARD_TOKEN unset; the API accepts every caller (local development only)");
  const api = createApi({
    db,
    health,
    version: version(),
    tier: risk.tier,
    walletCapSol: risk.executionWalletCapSol,
    solUsd: () => collector.state.solUsd,
    token,
  });
  const server = startHttp(cfg.httpHost, cfg.httpPort, { health, version: version(), api });
  m.up.set(1);
  collector.start();
  log.info("listening", { host: cfg.httpHost, port: cfg.httpPort });

  let deadman: NodeJS.Timeout | null = null;
  if (cfg.healthcheckUrl) {
    const url = cfg.healthcheckUrl;
    const beat = async () => {
      const h = health();
      const target = h.ok ? url : `${url}/fail`;
      try {
        await fetch(target, {
          method: "POST",
          body: h.ok ? "ok" : h.reasons.join("; "),
          signal: AbortSignal.timeout(5000),
        });
      } catch (e) {
        log.warn("dead-man ping failed", { err: errText(e) });
      }
    };
    deadman = setInterval(() => void beat(), 60_000);
    void beat();
  }

  const shutdown = (sig: string) => {
    log.info("stopping", { sig });
    m.up.set(0);
    collector.stop();
    stopLoop();
    clearInterval(dbTimer);
    if (deadman) clearInterval(deadman);
    server.close();
    db.end().finally(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  log.error("fatal", { err: errText(e) });
  process.exit(1);
});
