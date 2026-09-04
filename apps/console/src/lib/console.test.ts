import assert from "node:assert/strict";
import test from "node:test";
import { adjustedMulOf, rejectedBy, ttlLeftMs } from "@wick/core/api";
import { mockFunnel, mockIntents, mockState, mockToken } from "./mock.ts";

test("mock data is deterministic and labelled as example", () => {
  const now = 1_800_000_000_000;
  const a = mockIntents(now);
  const b = mockIntents(now);
  assert.deepEqual(a, b);
  assert.ok(mockState(now).example);
  assert.ok(mockFunnel(now).example);
  assert.ok(mockToken(a[0]!.intent.mint, now).example);
  assert.ok(a.every((v) => v.intent.mint.startsWith("ExAmpLe")));
});

test("contract helpers: ttl, adjusted size and rejecting gate", () => {
  const now = 1_800_000_000_000;
  const views = mockIntents(now);
  for (const v of views) {
    assert.equal(v.adjustedMul, adjustedMulOf(v.gates));
    const rej = rejectedBy(v.gates);
    if (v.status === "rejected") assert.ok(rej && rej.reasonCode);
    else assert.equal(rej, null);
  }
  assert.equal(ttlLeftMs({ expiresAt: now + 5000 }, now), 5000);
  assert.equal(ttlLeftMs({ expiresAt: now - 5000 }, now), 0);
});

test("funnel layers never pass more than entered", () => {
  const f = mockFunnel(Date.now());
  for (const l of f.layers) assert.ok(l.passed <= l.entered, l.layer);
});
