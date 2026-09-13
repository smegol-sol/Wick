import assert from "node:assert/strict";
import test from "node:test";
import { loadSolanaPulse, pumpStatus } from "./solana-pulse.ts";

/** Every fetch the pulse makes, answered by URL: pump.fun as the test says, everything else empty and fine. */
function stubFetch(pump: (url: string) => Response): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("pump.fun")) {
      calls.push(url);
      return pump(url);
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
}

test("pulse: a rate-limited pump.fun is reported, not swallowed, and is not asked again during Retry-After", async () => {
  const stub = stubFetch(
    () => new Response("slow down", { status: 429, headers: { "retry-after": "7" } }),
  );
  try {
    const pulse = await loadSolanaPulse();
    assert.equal(pulse.tokens.length, 0);
    assert.equal(pulse.failure, "http 429");
    const st = pumpStatus();
    assert.equal(st.failure, "http 429");
    assert.ok(st.backoffUntil > Date.now() + 5000 && st.backoffUntil <= Date.now() + 7000);
    const asked = stub.calls.length;
    assert.ok(asked >= 1);
    const again = await loadSolanaPulse();
    assert.equal(again.failure, "http 429", "the reason survives the back-off window");
    assert.equal(stub.calls.length, asked, "no request to pump.fun while backing off");
  } finally {
    stub.restore();
  }
});
