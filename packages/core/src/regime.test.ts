import assert from "node:assert/strict";
import test from "node:test";
import { regimeOf } from "@wick/core/regime";

const base = {
  at: 1,
  solChange1hPct: 0.4,
  breadth5m: 0.55,
  launchesPerHour: 120,
  launchesMedian7d: 110,
  migrationsPerHour: 8,
  safetyRejectRate1h: 0.2,
};

test("regime: normal, half and halt from the ENGINE §11 table, with the numbers in the reason", () => {
  const ok = regimeOf(base);
  assert.equal(ok.sizeMul, 1);
  assert.match(
    ok.reason,
    /^normal \(SOL \+0\.4% 1h, breadth 55%, safety rejects 20%, launches 120\/h \(median 110\), migrations 8\/h\)$/,
  );
  assert.equal(regimeOf({ ...base, solChange1hPct: -2 }).sizeMul, 0.5, "−2% is the half edge");
  assert.equal(regimeOf({ ...base, solChange1hPct: -1.9 }).sizeMul, 1);
  assert.equal(regimeOf({ ...base, solChange1hPct: -5 }).sizeMul, 0, "−5% halts");
  assert.equal(regimeOf({ ...base, breadth5m: 0.44 }).sizeMul, 0.5);
  assert.equal(regimeOf({ ...base, breadth5m: 0.29 }).sizeMul, 0);
  assert.equal(regimeOf({ ...base, safetyRejectRate1h: 0.81 }).sizeMul, 0);
  assert.equal(regimeOf({ ...base, safetyRejectRate1h: 0.8 }).sizeMul, 1, "over, not at, 80%");
  const quiet = regimeOf({ ...base, launchesPerHour: 30 });
  assert.equal(quiet.sizeMul, 0.5);
  assert.match(quiet.reason, /^half size: launches 30\/h under a third of the 7d median 110/);
  const both = regimeOf({ ...base, solChange1hPct: -3, breadth5m: 0.2 });
  assert.equal(both.sizeMul, 0, "the worst condition wins");
  assert.match(both.reason, /^no new entries: breadth 20%/);
});

test("regime: unknown inputs never trigger and are named", () => {
  const r = regimeOf({
    at: 1,
    solChange1hPct: null,
    breadth5m: null,
    launchesPerHour: null,
    launchesMedian7d: null,
    migrationsPerHour: null,
    safetyRejectRate1h: null,
  });
  assert.equal(r.sizeMul, 1);
  assert.equal(
    r.reason,
    "normal, nothing measured yet (SOL 1h, breadth, safety rejects, launches unknown)",
  );
  const partial = regimeOf({ ...base, launchesMedian7d: null, breadth5m: null });
  assert.equal(partial.sizeMul, 1);
  assert.match(partial.reason, /launches 120\/h \(no 7d median yet\)/);
  assert.match(partial.reason, /breadth unknown\)$/);
});
