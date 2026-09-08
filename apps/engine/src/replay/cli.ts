/**
 * Replay from the command line (ADR-0007):
 *
 *   npm -w @wick/engine run replay -- --from 2026-09-08T00:00:00Z --to 2026-09-08T12:00:00Z [--equity 15] [--rules config/rules.yaml]
 *
 * Uses DATABASE_URL. Prints the run id and the summary; the console lists the run.
 */
import { fileURLToPath } from "node:url";
import { loadRisk, loadRules, parseEnv } from "../config.ts";
import { makePool } from "../db/pool.ts";
import { replay } from "./replay.ts";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const cfg = parseEnv(process.env);
  const from = arg("from");
  const to = arg("to");
  if (!from || !to) {
    console.error("usage: replay --from <iso> --to <iso> [--equity <sol>] [--rules <file>]");
    process.exit(2);
  }
  const risk = loadRisk(cfg.riskFile);
  const loaded = loadRules(arg("rules") ?? cfg.rulesFile);
  const db = makePool(cfg.databaseUrl);
  try {
    const view = await replay(db, {
      fromMs: Date.parse(from),
      toMs: Date.parse(to),
      rules: loaded.rules,
      rulesHash: loaded.hash,
      risk,
      equitySol: Number(arg("equity") ?? cfg.equitySol ?? risk.executionWalletCapSol),
      codeVersion: cfg.codeVersion,
    });
    console.log(JSON.stringify(view, null, 2));
  } finally {
    await db.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
