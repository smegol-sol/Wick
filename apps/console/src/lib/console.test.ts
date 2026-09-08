import assert from "node:assert/strict";
import test from "node:test";
import { adjustedMulOf, rejectedBy, ttlLeftMs } from "@wick/core/api";
import { ApiFailure } from "./api.ts";
import { mockFunnel, mockIntents, mockState, mockToken, mockWallets } from "./mock.ts";
import { failureText, normalizeCode, passphraseOk } from "./second-factor.ts";

test("mock data is deterministic and labelled as example", () => {
  const now = 1_800_000_000_000;
  const a = mockIntents(now);
  const b = mockIntents(now);
  assert.deepEqual(a, b);
  assert.ok(mockState(now).example);
  assert.ok(mockFunnel(now).example);
  assert.ok(mockToken(a[0]!.intent.mint, now).example);
  assert.ok(a.every((v) => v.intent.mint.startsWith("ExAmpLe")));
  assert.ok(mockWallets(now).every((w) => w.pk.startsWith("ExAmpLe")));
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

test("second factor: six digits with spaces tolerated, passphrase bounds, and the failure line", () => {
  assert.equal(normalizeCode("123 456"), "123456");
  assert.equal(normalizeCode(" 000000 "), "000000");
  assert.equal(normalizeCode("12345"), null);
  assert.equal(normalizeCode("1234567"), null);
  assert.equal(normalizeCode("12a456"), null);
  assert.equal(passphraseOk("short"), false);
  assert.equal(passphraseOk("correct horse battery"), true);
  assert.equal(passphraseOk("x".repeat(129)), false);
  assert.equal(
    failureText(new ApiFailure(403, "second factor rejected")),
    "second factor rejected",
  );
  assert.equal(failureText(new ApiFailure(403, "locked for 42 s")), "locked for 42 s");
  assert.match(failureText(new ApiFailure(409, "")), /no vault/);
  assert.match(failureText(new ApiFailure(401, "Unauthorized")), /token/);
  assert.equal(failureText(new ApiFailure(500, "internal")), "500: internal");
  assert.equal(failureText(new Error("boom")), "boom");
  assert.equal(failureText("x"), "request failed");
});
