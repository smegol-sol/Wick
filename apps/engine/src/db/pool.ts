import pg from "pg";

const { Pool } = pg;
export type Db = InstanceType<typeof Pool>;

/** Upper bound on any statement from the engine; migrations lift it on their own client. */
export const QUERY_TIMEOUT_MS = 30_000;

export function makePool(databaseUrl: string): Db {
  return new Pool({
    connectionString: databaseUrl,
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // No statement may hang the caller: the first night on the VPS saw the collector's tick
    // stall silently, and a database query is the one unbounded await in it.
    query_timeout: QUERY_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
    application_name: "wick-engine",
  });
}

export async function ping(db: Db, timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await Promise.race([
      db.query("select 1 as ok"),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
    ]);
    return res.rows[0]?.ok === 1;
  } catch {
    return false;
  }
}
