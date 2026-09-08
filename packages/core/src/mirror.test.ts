import assert from "node:assert/strict";
import test from "node:test";
import { copyGapMs, mirrorDemotion } from "@wick/core/mirror";
import { mirrorRule, validateRules } from "@wick/core/rules";

test("mirror: copy gap, demotion on ten measured copies with a negative mean, and the rule's validation", () => {
  assert.equal(copyGapMs(1000, 1800), 800);
  assert.equal(copyGapMs(2000, 1800), 0, "a clock ahead of the block is not a negative gap");
  assert.equal(copyGapMs(null, 1800), null);
  const good = Array.from({ length: 12 }, (_, i) => ({ retPct: i % 3 === 0 ? -2 : 4 }));
  assert.deepEqual(mirrorDemotion(good).demote, false);
  const bad = [...Array(5).fill({ retPct: 3 }), ...Array(10).fill({ retPct: -1.5 })];
  const d = mirrorDemotion(bad);
  assert.equal(d.demote, true, "only the last ten count");
  assert.equal(d.meanRetPct, -1.5);
  assert.match(d.reason, /last 10 copies/);
  const thin = mirrorDemotion([{ retPct: -9 }, { retPct: null }, { retPct: -9 }]);
  assert.equal(thin.demote, false);
  assert.equal(thin.copies, 2);
  assert.match(thin.reason, /10 needed/);
  const file = validateRules({
    version: 1,
    intentTtlMs: 90_000,
    intentCooldownMs: 1000,
    rules: {
      "mirror-follow": {
        strategy: "mirror-follow",
        mode: "shadow",
        weight: 1,
        params: { maxCopyGapMs: 30_000, sizeMul: 0.5, maxWallets: 6 },
      },
    },
  });
  assert.equal(mirrorRule(file)?.params.sizeMul, 0.5);
  assert.throws(
    () =>
      validateRules({
        version: 1,
        intentTtlMs: 90_000,
        intentCooldownMs: 1000,
        rules: {
          mirror: {
            strategy: "mirror-follow",
            mode: "shadow",
            weight: 1,
            params: { maxCopyGapMs: 1, sizeMul: 0.5, maxWallets: 7 },
          },
        },
      }),
    /maxWallets cannot exceed 6/,
  );
});
