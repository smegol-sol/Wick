import assert from "node:assert/strict";
import test from "node:test";
import type { Db } from "../db/pool.ts";
import { candleBucketSec, followWallet, isPublicKey } from "./queries.ts";
import { authorized, matchIntentAction, modeCounts } from "./server.ts";

test("bearer auth is exact and optional only when no token is configured", () => {
  assert.equal(authorized(undefined, null), true);
  assert.equal(authorized(undefined, "secret"), false);
  assert.equal(authorized("Bearer secret", "secret"), true);
  assert.equal(authorized("Bearer secre", "secret"), false);
  assert.equal(authorized("Bearer secret2", "secret"), false);
  assert.equal(authorized("Basic secret", "secret"), false);
});

test("intent action routes parse and reject anything else", () => {
  assert.deepEqual(matchIntentAction("/api/intents/abc/approve"), { id: "abc", action: "approve" });
  assert.deepEqual(matchIntentAction("/api/intents/a%2Fb/reject"), { id: "a/b", action: "reject" });
  assert.equal(matchIntentAction("/api/intents/abc"), null);
  assert.equal(matchIntentAction("/api/intents/abc/delete"), null);
});

test("candle bucket keeps a range near 180 bars", () => {
  assert.equal(candleBucketSec(30 * 60), 10);
  assert.equal(candleBucketSec(6 * 3600), 300);
  assert.equal(candleBucketSec(24 * 3600), 900);
  assert.equal(candleBucketSec(30 * 86_400), 3600);
});

test("mode counts come from the rules, every mode present", () => {
  assert.deepEqual(modeCounts([]), { shadow: 0, suggest: 0, auto: 0 });
  const rule = {
    strategy: "confirmed-entry",
    weight: 1,
    stats: null,
    eligibleForAuto: false,
    disabled: false,
    disabledReason: null,
  } as const;
  assert.deepEqual(
    modeCounts([
      { ...rule, id: "a", mode: "shadow" },
      { ...rule, id: "b", mode: "shadow" },
      { ...rule, id: "c", mode: "suggest" },
    ]),
    { shadow: 2, suggest: 1, auto: 0 },
  );
});

test("followed wallets: a public key is base58 of 32 bytes, and the cap holds", async () => {
  assert.equal(isPublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), true);
  assert.equal(isPublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wE"), false, "too short for 32 bytes");
  assert.equal(isPublicKey("0OIl"), false, "not base58");
  assert.equal(isPublicKey(""), false);
  const writes: string[] = [];
  const dbWith = (following: number): Db =>
    ({
      query: async (sql: string) => {
        if (sql.includes("count(*)")) return { rows: [{ n: String(following) }], rowCount: 1 };
        writes.push(sql);
        return { rows: [], rowCount: 1 };
      },
    }) as unknown as Db;
  assert.equal(await followWallet(dbWith(0), "nope", null, 6), "invalid");
  assert.equal(
    await followWallet(dbWith(6), "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", null, 6),
    "full",
  );
  assert.equal(writes.length, 0, "nothing written when refused");
  assert.equal(
    await followWallet(dbWith(5), "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "x", 6),
    "ok",
  );
  assert.equal(writes.length, 1);
  assert.match(writes[0]!, /insert into wallets/);
});
