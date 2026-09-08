/**
 * Engine entry point: ingest, the decision loop, the executor behind the
 * sealed vault and the kill switch, health, metrics and the API. The engine
 * boots sealed: nothing signs until the owner unseals from the console.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApi } from "./api/server.ts";
import { makeSolanaAdapter } from "./chains/solana/index.ts";
import { loadRisk, loadRules, parseEnv } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { makePool, ping } from "./db/pool.ts";
import { DecisionLoop } from "./decision/loop.ts";
import { Evaluator } from "./evaluator/evaluator.ts";
import { RegimeWriter } from "./decision/regime.ts";
import { Executor } from "./executor/executor.ts";
import { KillSwitch } from "./executor/killswitch.ts";
import { Vault } from "./executor/vault.ts";
import { addHalt, clearHalts } from "./api/queries.ts";
import { verifyTotp } from "@wick/core/totp";
import { evaluateHealth, healthTransition, type Health } from "./health.ts";
import { startHttp } from "./http.ts";
import { Collector } from "./ingest/collector.ts";
import { LogStream, wsUrlOf } from "./ingest/stream.ts";
import type { RuleView } from "@wick/core/api";
import { rpcUrls } from "@wick/core/rpc";
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
  const loaded = loadRules(cfg.rulesFile);
  const codeVersion = cfg.codeVersion ?? version();
  log.info("starting", {
    version: version(),
    codeVersion,
    tier: risk.tier,
    walletCapSol: risk.executionWalletCapSol,
    rules: loaded.rules.rules.map((r) => `${r.id}:${r.mode}`),
    rulesHash: loaded.hash,
  });
  if (cfg.equitySol == null)
    log.warn("EQUITY_SOL unset; sizing assumes the wallet cap until the vault is unsealed");
  const vault = new Vault(cfg.vaultFile, cfg.totpSecret);
  if (vault.state === "none")
    log.warn("no vault file; nothing can execute", { file: cfg.vaultFile });
  else log.info("vault sealed", { wallet: vault.wallet });
  if (!cfg.totpSecret)
    log.warn("TOTP_SECRET unset; the vault cannot be unsealed and halts cannot be cleared");
  if (cfg.solanaRpcUrl) process.env.SOLANA_RPC_URL = cfg.solanaRpcUrl;
  else log.warn("SOLANA_RPC_URL unset; public RPCs only, unfit for anything but a smoke run");

  const db = makePool(cfg.databaseUrl);
  const applied = await migrate(db);
  if (applied.length) log.info("migrations applied", { applied });
  let dbOk = await ping(db);
  const dbTimer = setInterval(() => void ping(db).then((ok) => (dbOk = ok)), 10_000);

  const chain = makeSolanaAdapter();
  const wsUrl = cfg.solanaWsUrl ?? wsUrlOf(rpcUrls()[0]!);
  const stream = new LogStream(wsUrl, {
    onEvent: (e) => void collector.onLog(e),
    onReconnect: (seen) => void collector.resume(seen),
    pingMs: 20_000,
  });
  const collector = new Collector(
    db,
    chain,
    {
      activeSampleMs: cfg.activeSampleMs,
      coolingSampleMs: cfg.coolingSampleMs,
      activeWindowMs: cfg.activeWindowMs,
      coolingWindowMs: cfg.coolingWindowMs,
      auditEveryMs: cfg.auditEveryMs,
      slotPollMs: cfg.slotPollMs,
      launchPerTick: 2,
      launchRetryMs: 60_000,
      followRefreshMs: cfg.followRefreshMs,
      migrationAuthority: cfg.migrationAuthority,
    },
    stream,
  );

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

  // Every self-halt transition is said once, and the gauge the alert reads is published.
  for (const kind of ["health", "kill", "manual"]) m.halted.set({ kind }, 0);
  let lastHealth: { selfHalt: boolean; reasons: string[]; since: number } | null = null;
  const healthTimer = setInterval(() => {
    const now = Date.now();
    const h = health();
    const t = healthTransition(lastHealth, h, now);
    if (t?.kind === "halt") log.warn("self-halt", { reasons: t.reasons });
    else if (t?.kind === "changed") log.warn("self-halt reasons changed", { reasons: t.reasons });
    else if (t?.kind === "clear") log.info("self-halt cleared", { afterMs: t.sinceMs });
    m.halted.set({ kind: "health" }, h.selfHalt ? 1 : 0);
    if (t?.kind === "halt" || lastHealth == null)
      lastHealth = { selfHalt: h.selfHalt, reasons: h.reasons, since: now };
    else lastHealth = { ...lastHealth, selfHalt: h.selfHalt, reasons: h.reasons };
  }, 1000);
  healthTimer.unref();

  const kill = new KillSwitch(cfg.killSwitchFile, (k) => {
    if (k.active) {
      log.error("kill switch set", { reason: k.reason });
      m.halted.set({ kind: "kill" }, 1);
      void addHalt(db, "kill", k.reason ?? "kill file present").catch((e) =>
        log.error("kill halt write failed", { err: errText(e) }),
      );
    } else {
      log.warn("kill switch removed");
      m.halted.set({ kind: "kill" }, 0);
      void clearHalts(db, ["kill"], "kill file removed").catch((e) =>
        log.error("kill halt clear failed", { err: errText(e) }),
      );
    }
  });

  const evaluator = new Evaluator(
    { db, rules: loaded.rules },
    { outcomesEveryMs: 60_000, statsEveryMs: 3_600_000 },
  );
  const rulesView = (): RuleView[] => evaluator.view();
  const regime = new RegimeWriter({
    db,
    solUsd: () => collector.state.solUsd,
    activeMints: () => collector.sampler.active(Date.now()),
  });
  const stopLoop = m.watchEventLoop();
  const token = process.env.DASHBOARD_TOKEN?.trim() || null;
  if (!token)
    log.warn("DASHBOARD_TOKEN unset; the API accepts every caller (local development only)");
  const deployedSol = async (): Promise<number> => {
    const r = await db.query<{ sum: number | null }>(
      "select sum(cost_sol) as sum from positions where status = 'open'",
    );
    return Number(r.rows[0]?.sum ?? 0);
  };
  const api = createApi({
    db,
    health,
    version: version(),
    tier: risk.tier,
    walletCapSol: risk.executionWalletCapSol,
    solUsd: () => collector.state.solUsd,
    rules: rulesView,
    regime: () => regime.current(),
    enableRule: (id, by) => evaluator.enable(id, by),
    token,
    exec: {
      vault: () => vault.state,
      wallet: () => vault.wallet,
      cashSol: () => executor.state.walletSol,
      deployedSol,
      unseal: async (passphrase, code) => {
        await vault.unseal(passphrase, code);
        m.vaultUnsealed.set(1);
        log.info("vault unsealed", { wallet: vault.wallet });
        await executor
          .refreshBalance(Date.now(), true)
          .catch((e) => log.warn("balance read after unseal failed", { err: errText(e) }));
      },
      seal: () => {
        vault.seal();
        m.vaultUnsealed.set(0);
        log.warn("vault sealed by the owner");
      },
      secondFactor: (code) =>
        cfg.totpSecret ? verifyTotp(cfg.totpSecret, code, Date.now()) : Promise.resolve(false),
    },
  });
  const executor = new Executor(
    {
      db,
      chain,
      vault,
      risk,
      halted: () => {
        const h = health();
        if (kill.state.active) return { halted: true, reason: kill.state.reason ?? "kill" };
        if (h.selfHalt) return { halted: true, reason: "health" };
        return { halted: false, reason: null };
      },
      onIntent: (view) => api.broadcast({ type: "intent", intent: view }),
      onPosition: (view) => api.broadcast({ type: "position", position: view }),
    },
    { tickMs: 1000, confirmTimeoutMs: 60_000, balanceRefreshMs: 30_000 },
  );
  const decision = new DecisionLoop(
    {
      db,
      chain,
      book: collector.book,
      activeMints: () => collector.sampler.active(Date.now()),
      rules: loaded.rules,
      rulesHash: loaded.hash,
      codeVersion,
      risk,
      solUsd: () => collector.state.solUsd,
      equitySol: () => cfg.equitySol ?? risk.executionWalletCapSol,
      cashSol: () => executor.state.walletSol,
      selfHalt: () => health().selfHalt || kill.state.active,
      ruleState: (id) => evaluator.state(id),
      regime: () => regime.current(),
      pin: (mint) => collector.sampler.pin(mint, true, Date.now()),
      onIntent: (view) => api.broadcast({ type: "intent", intent: view }),
    },
    { tickMs: cfg.decisionTickMs, quotesPerMinute: cfg.quotesPerMinute, bookRefreshMs: 5000 },
  );
  const server = startHttp(cfg.httpHost, cfg.httpPort, { health, version: version(), api });
  m.up.set(1);
  await collector.seedResume();
  stream.start();
  collector.start();
  regime.start();
  decision.start();
  evaluator.start();
  kill.start();
  executor.start();
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
    executor.stop();
    kill.stop();
    vault.seal();
    decision.stop();
    evaluator.stop();
    regime.stop();
    collector.stop();
    stream.stop();
    stopLoop();
    clearInterval(dbTimer);
    clearInterval(healthTimer);
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
