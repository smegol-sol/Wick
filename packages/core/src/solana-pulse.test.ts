import assert from "node:assert/strict";
import test from "node:test";
import { loadSolanaPulse, pumpStatus, resetPumpState } from "./solana-pulse.ts";

/** Every fetch the pulse makes, answered by URL: pump.fun as the test says, everything else empty and fine. */
function stubFetch(
  pump: (url: string) => Response,
  honorAbort = false,
): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("pump.fun")) {
      calls.push(url);
      const answer = Promise.resolve(pump(url));
      const signal = init?.signal;
      if (!honorAbort || !signal) return answer;
      return Promise.race([
        answer,
        new Promise<Response>((_, reject) =>
          signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          ),
        ),
      ]);
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
}

test("pulse: a rate-limited pump.fun is reported, not swallowed, and is not asked again during Retry-After", async () => {
  resetPumpState();
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

test("pulse: an attempt that never settles is dropped at the deadline and the next call starts fresh", async () => {
  resetPumpState();
  // A fetch that ignores its abort signal: the shape of the four silent days on the VPS.
  const stub = stubFetch(() => new Promise<Response>(() => {}) as unknown as Response);
  try {
    const t0 = Date.now();
    const first = await loadSolanaPulse({ deadlineMs: 150 });
    assert.ok(Date.now() - t0 < 1000, "settled by the deadline, not by the hang");
    assert.equal(first.tokens.length, 0);
    assert.equal(first.failure, "deadline");
    assert.equal(pumpStatus().failure, "deadline");
    const asked = stub.calls.length;
    assert.ok(asked >= 1);
    const second = await loadSolanaPulse({ deadlineMs: 150 });
    assert.equal(second.failure, "deadline");
    assert.ok(stub.calls.length > asked, "a fresh attempt, not the stuck one");
  } finally {
    stub.restore();
  }
});

test("pulse: an aborted caller gets an empty pulse with the reason, never a rejection", async () => {
  resetPumpState();
  const stub = stubFetch(() => new Promise<Response>(() => {}) as unknown as Response, true);
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    const pulse = await loadSolanaPulse({ signal: ctrl.signal, deadlineMs: 5000 });
    assert.equal(pulse.failure, "timeout");
  } finally {
    stub.restore();
  }
});
