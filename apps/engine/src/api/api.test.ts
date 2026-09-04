import assert from "node:assert/strict";
import test from "node:test";
import { candleBucketSec } from "./queries.ts";
import { authorized, matchIntentAction } from "./server.ts";

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
