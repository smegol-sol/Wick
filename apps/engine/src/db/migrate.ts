/**
 * Applies `migrations/*.sql` in name order, once each, outside a transaction
 * (see sql.ts for why). Run with `npm -w @wick/engine run migrate`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { splitSql } from "./sql.ts";
import { makePool, type Db } from "./pool.ts";
import { logger } from "../log.ts";

const log = logger("migrate");
const LOCK_KEY = 0x77_69_63_6b; // "wick"

/** A first-line `-- requires: <extension>` header makes a migration conditional. */
export function requiredExtension(text: string): string | null {
  const m = text.match(/^--\s*requires:\s*([a-z_]+)\s*$/im);
  return m ? m[1] : null;
}

async function extensionAvailable(
  client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }> },
  name: string,
): Promise<boolean> {
  const res = await client.query("select 1 from pg_available_extensions where name = $1", [name]);
  return res.rows.length > 0;
}

export function migrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
}

export async function migrate(db: Db, dir = migrationsDir()): Promise<string[]> {
  const applied: string[] = [];
  const client = await db.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const done = new Set(
      (await client.query<{ name: string }>("select name from schema_migrations")).rows.map(
        (r) => r.name,
      ),
    );
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const text = readFileSync(join(dir, file), "utf8");
      const requires = requiredExtension(text);
      if (requires && !(await extensionAvailable(client, requires))) {
        log.warn("skipping migration: extension not available on this server", {
          file,
          requires,
        });
        continue;
      }
      const statements = splitSql(text);
      log.info("applying", { file, statements: statements.length });
      for (const s of statements) await client.query(s);
      await client.query("insert into schema_migrations(name) values ($1)", [file]);
      applied.push(file);
    }
    await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]);
  } finally {
    client.release();
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    log.error("DATABASE_URL is required");
    process.exit(2);
  }
  const db = makePool(url);
  migrate(db)
    .then((applied) => {
      log.info("done", { applied });
      return db.end();
    })
    .catch((e) => {
      log.error("failed", { err: String(e) });
      process.exit(1);
    });
}
