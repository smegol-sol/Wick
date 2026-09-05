import { ed25519 } from "@noble/curves/ed25519";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHot, fromB58, lockHotMem } from "@wick/core/hot-wallet";
import { base32Decode, totp } from "@wick/core/totp";
import { checkCaps, dayKeyOf, WALLET_CAPS } from "./caps.ts";
import { KillSwitch } from "./killswitch.ts";
import { Vault, VaultError } from "./vault.ts";

const PASS = "correct horse battery";
const TOTP_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const T0 = 1_700_000_000_000;

test("wallet caps: entries are capped per transaction, per day and by the operating balance; exits never", () => {
  assert.equal(checkCaps({ side: "buy", sizeSol: 0.3, sentTodaySol: 1, walletSol: 10 }), null);
  assert.match(
    checkCaps({ side: "buy", sizeSol: 0.6, sentTodaySol: 0, walletSol: 10 })!,
    /per-transaction/,
  );
  assert.match(
    checkCaps({ side: "buy", sizeSol: 0.3, sentTodaySol: 4.8, walletSol: 10 })!,
    /daily cap/,
  );
  assert.match(
    checkCaps({ side: "buy", sizeSol: 0.3, sentTodaySol: 0, walletSol: 15.5 })!,
    /operating cap/,
  );
  assert.equal(
    checkCaps({ side: "buy", sizeSol: 0.3, sentTodaySol: 0, walletSol: null }),
    null,
    "unknown balance is not a cap breach",
  );
  assert.equal(checkCaps({ side: "sell", sizeSol: 9, sentTodaySol: 9, walletSol: 99 }), null);
  assert.equal(WALLET_CAPS.maxOperatingSol, 15, "matches the tier-1 wallet cap");
  assert.equal(dayKeyOf(Date.UTC(2026, 8, 5, 23, 59)), "2026-09-05");
  assert.equal(dayKeyOf(Date.UTC(2026, 8, 6, 0, 0)), "2026-09-06");
});

test("vault: sealed at boot, unseals with passphrase and TOTP, signs, locks out after five failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wick-vault-"));
  const file = join(dir, "vault.json");
  try {
    const { vault: hot } = await createHot(PASS);
    lockHotMem();
    const none = new Vault(file, base32Decode(TOTP_B32), () => T0);
    assert.equal(none.state, "none");
    assert.equal(none.wallet, null);
    await assert.rejects(none.unseal(PASS, "000000"), (e: VaultError) => e.kind === "no-vault");
    writeFileSync(file, JSON.stringify(hot));
    const v = new Vault(file, base32Decode(TOTP_B32), () => T0);
    assert.equal(v.state, "sealed");
    assert.equal(v.wallet, hot.pub);
    assert.equal(v.handle(), null);
    const code = await totp(base32Decode(TOTP_B32), T0);
    await assert.rejects(v.unseal(PASS, "123456"), (e: VaultError) => e.kind === "bad-code");
    await assert.rejects(
      v.unseal("wrong passphrase!", code),
      (e: VaultError) => e.kind === "bad-passphrase",
    );
    const handle = await v.unseal(PASS, code);
    assert.equal(v.state, "unsealed");
    assert.equal(handle.wallet, hot.pub);
    const msg = new TextEncoder().encode("hello");
    const sig = handle.sign(msg);
    assert.equal(sig.length, 64);
    v.seal();
    assert.equal(v.state, "sealed");
    assert.throws(() => handle.sign(msg), /sealed/, "an old handle dies with the seal");
    const again = await v.unseal(PASS, code);
    assert.equal(again.wallet, hot.pub);
    assert.ok(ed25519.verify(again.sign(msg), msg, fromB58(hot.pub)!), "signs with the vault key");
    v.seal();
    for (let i = 0; i < 5; i++)
      await assert.rejects(v.unseal(PASS, "000000"), (e: VaultError) => e.kind === "bad-code");
    await assert.rejects(v.unseal(PASS, code), (e: VaultError) => e.kind === "lockout");
    const noFactor = new Vault(file, null, () => T0);
    assert.equal(noFactor.secondFactorConfigured, false);
    await assert.rejects(
      noFactor.unseal(PASS, code),
      (e: VaultError) => e.kind === "second-factor-unset",
    );
    writeFileSync(file, JSON.stringify({ not: "a vault" }));
    assert.throws(() => new Vault(file, null), /not a WICK vault/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kill switch: a file on disk halts, its content is the reason, removal clears", () => {
  const dir = mkdtempSync(join(tmpdir(), "wick-kill-"));
  const file = join(dir, "KILL");
  const seen: boolean[] = [];
  try {
    const k = new KillSwitch(file, (s) => seen.push(s.active));
    assert.equal(k.check(T0), false);
    assert.equal(k.state.active, false);
    writeFileSync(file, "owner: stop everything\n");
    assert.equal(k.check(T0 + 1000), true);
    assert.deepEqual(k.state, { active: true, reason: "owner: stop everything", since: T0 + 1000 });
    assert.equal(k.check(T0 + 2000), false, "no flip while it stays");
    writeFileSync(file, "");
    k.check(T0 + 3000);
    assert.equal(k.state.reason, "kill file present");
    unlinkSync(file);
    assert.equal(k.check(T0 + 4000), true);
    assert.deepEqual(k.state, { active: false, reason: null, since: null });
    assert.deepEqual(seen, [true, false]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
