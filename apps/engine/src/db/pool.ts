import pg from "pg";

const { Pool } = pg;
export type Db = InstanceType<typeof Pool>;

export function makePool(databaseUrl: string): Db {
  return new Pool({
    connectionString: databaseUrl,
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
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
