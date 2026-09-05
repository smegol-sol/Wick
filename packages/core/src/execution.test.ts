import { ed25519 } from "@noble/curves/ed25519";
import assert from "node:assert/strict";
import test from "node:test";
import { applyFill, fillOf, mevSuspect, type PositionRow } from "@wick/core/fills";
import { feePayerOf, messageOf, placeSignature, signTxBytes, toB58 } from "@wick/core/hot-wallet";
import { base32Decode, base32Encode, hotp, otpauthUri, totp, verifyTotp } from "@wick/core/totp";

const RFC_SECRET = new TextEncoder().encode("12345678901234567890");

test("totp: RFC 6238 vectors, base32 round trip, and a one-step window", async () => {
  assert.equal(await hotp(RFC_SECRET, 0), "755224");
  assert.equal(await hotp(RFC_SECRET, 1), "287082");
  assert.equal(await totp(RFC_SECRET, 59_000), "287082");
  assert.equal(await totp(RFC_SECRET, 1_111_111_109_000), "081804");
  assert.equal(await totp(RFC_SECRET, 1_234_567_890_000), "005924");
  assert.equal(await totp(RFC_SECRET, 2_000_000_000_000), "279037");
  const b32 = base32Encode(RFC_SECRET);
  assert.equal(b32, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.deepEqual([...base32Decode(b32)], [...RFC_SECRET]);
  assert.deepEqual([...base32Decode("gezd gnbv-gy3tqojqgezdgnbvgy3tqojq====")], [...RFC_SECRET]);
  assert.throws(() => base32Decode("not!base32"), /bad character/);
  const now = 1_234_567_890_000;
  assert.equal(await verifyTotp(RFC_SECRET, "005924", now), true, "current step");
  assert.equal(await verifyTotp(RFC_SECRET, "005 924", now), true, "spaces tolerated");
  assert.equal(await verifyTotp(RFC_SECRET, await totp(RFC_SECRET, now - 30_000), now), true);
  assert.equal(await verifyTotp(RFC_SECRET, await totp(RFC_SECRET, now + 30_000), now), true);
  assert.equal(await verifyTotp(RFC_SECRET, await totp(RFC_SECRET, now - 60_000), now), false);
  assert.equal(await verifyTotp(RFC_SECRET, "00592", now), false, "five digits");
  assert.equal(await verifyTotp(RFC_SECRET, "000000", now), false);
  assert.match(
    otpauthUri("ABC", "wallet"),
    /^otpauth:\/\/totp\/WICK:wallet\?secret=ABC&issuer=WICK/,
  );
});

test("fills: buy and sell from balance deltas, quoted versus realized, mev-suspect", () => {
  // Buy 0.2 SOL for 1,000 tokens quoted; 990 landed and the wallet paid 0.2005 SOL with fees.
  const buy = fillOf({
    side: "buy",
    before: { native: 5_000_000_000n, token: 0n },
    after: { native: 4_799_500_000n, token: 990_000_000n },
    decimals: 6,
    quote: { inAmount: "200000000", outAmount: "1000000000" },
    feeLamports: null,
  });
  assert.equal(buy.solDelta, -0.2005);
  assert.equal(buy.tokenDelta, 990);
  assert.equal(buy.quotedPrice, 0.0002);
  assert.ok(Math.abs(buy.realizedPrice! - 0.2005 / 990) < 1e-12);
  assert.ok(Math.abs(buy.realizedSlippagePct! - 1.2626) < 1e-3, `${buy.realizedSlippagePct}`);
  assert.equal(mevSuspect(buy, 3), false);
  assert.equal(mevSuspect(buy, 1), true);
  // With the fee known the realized price excludes it.
  const buyFee = fillOf({
    side: "buy",
    before: { native: 5_000_000_000n, token: 0n },
    after: { native: 4_799_500_000n, token: 990_000_000n },
    decimals: 6,
    quote: { inAmount: "200000000", outAmount: "1000000000" },
    feeLamports: 500_000,
  });
  assert.ok(Math.abs(buyFee.realizedPrice! - 0.2 / 990) < 1e-12);
  // Sell 990 tokens quoted at 0.19 SOL; 0.1895 SOL landed.
  const sell = fillOf({
    side: "sell",
    before: { native: 4_799_500_000n, token: 990_000_000n },
    after: { native: 4_989_000_000n, token: 0n },
    decimals: 6,
    quote: { inAmount: "990000000", outAmount: "190000000" },
    feeLamports: null,
  });
  assert.equal(sell.solDelta, 0.1895);
  assert.equal(sell.tokenDelta, -990);
  assert.ok(Math.abs(sell.quotedPrice! - 0.19 / 990) < 1e-15);
  assert.ok(Math.abs(sell.realizedSlippagePct! - 0.2632) < 1e-3, `${sell.realizedSlippagePct}`);
  const nothing = fillOf({
    side: "buy",
    before: { native: 1n, token: 0n },
    after: { native: 1n, token: 0n },
    decimals: 6,
    quote: { inAmount: "0", outAmount: "0" },
    feeLamports: null,
  });
  assert.equal(nothing.quotedPrice, null);
  assert.equal(nothing.realizedPrice, null);
  assert.equal(nothing.realizedSlippagePct, null);
});

test("fills: a position opens, adds, sells in part with realized P&L, and closes", () => {
  const x = { mint: "M", wallet: "W", at: 1000 };
  const open = applyFill(
    null,
    {
      solDelta: -0.2,
      tokenDelta: 1000,
      quotedPrice: null,
      realizedPrice: null,
      realizedSlippagePct: null,
    },
    x,
  );
  assert.deepEqual(open, {
    mint: "M",
    wallet: "W",
    openedAt: 1000,
    costSol: 0.2,
    qty: 1000,
    exits: [],
    realizedPnlSol: null,
    status: "open",
  });
  const added = applyFill(
    open,
    {
      solDelta: -0.1,
      tokenDelta: 400,
      quotedPrice: null,
      realizedPrice: null,
      realizedSlippagePct: null,
    },
    { ...x, at: 2000 },
  );
  assert.equal(added.openedAt, 1000, "an add keeps the position");
  assert.ok(Math.abs(added.costSol - 0.3) < 1e-12);
  assert.equal(added.qty, 1400);
  const half = applyFill(
    added,
    {
      solDelta: 0.25,
      tokenDelta: -700,
      quotedPrice: null,
      realizedPrice: null,
      realizedSlippagePct: null,
    },
    { ...x, at: 3000 },
  );
  assert.equal(half.status, "open");
  assert.equal(half.qty, 700);
  assert.ok(Math.abs(half.costSol - 0.15) < 1e-12, "half the cost leaves with half the tokens");
  assert.ok(Math.abs(half.realizedPnlSol! - 0.1) < 1e-12, "0.25 in for 0.15 of cost");
  assert.deepEqual(half.exits, [{ at: 3000, qty: 700, sol: 0.25 }]);
  const closed = applyFill(
    half,
    {
      solDelta: 0.1,
      tokenDelta: -700,
      quotedPrice: null,
      realizedPrice: null,
      realizedSlippagePct: null,
    },
    { ...x, at: 4000 },
  );
  assert.equal(closed.status, "closed");
  assert.equal(closed.qty, 0);
  assert.equal(closed.costSol, 0);
  assert.ok(Math.abs(closed.realizedPnlSol! - 0.05) < 1e-12);
  const reopened = applyFill(
    closed,
    {
      solDelta: -0.1,
      tokenDelta: 10,
      quotedPrice: null,
      realizedPrice: null,
      realizedSlippagePct: null,
    },
    { ...x, at: 5000 },
  );
  assert.equal(reopened.openedAt, 5000, "a buy after a close is a new position");
  const stale: PositionRow = { ...open, qty: 100 };
  const over = applyFill(
    stale,
    {
      solDelta: 0.5,
      tokenDelta: -150,
      quotedPrice: null,
      realizedPrice: null,
      realizedSlippagePct: null,
    },
    { ...x, at: 6000 },
  );
  assert.equal(over.status, "closed", "selling more than the book holds closes it");
  assert.throws(
    () =>
      applyFill(
        null,
        {
          solDelta: 1,
          tokenDelta: -1,
          quotedPrice: null,
          realizedPrice: null,
          realizedSlippagePct: null,
        },
        x,
      ),
    /without a position/,
  );
});

/** A minimal legacy transaction: one signature slot, one account (the fee payer), a blockhash, no instructions. */
function syntheticTx(payer: Uint8Array): Uint8Array {
  const blockhash = new Uint8Array(32).fill(7);
  return Uint8Array.from([1, ...new Uint8Array(64), 1, 0, 0, 1, ...payer, ...blockhash, 0]);
}

test("signing helpers: the message starts after the signature table and the fee payer must match", () => {
  const seed = new Uint8Array(32).fill(9);
  const pub = ed25519.getPublicKey(seed);
  const tx = syntheticTx(pub);
  assert.deepEqual([...feePayerOf(tx)!], [...pub]);
  const msg = messageOf(tx);
  assert.equal(msg.length, tx.length - 65);
  assert.equal(msg[0], 1, "header starts the message");
  const signed = signTxBytes(tx, (m) => ed25519.sign(m, seed), pub);
  assert.equal(signed.length, tx.length);
  assert.ok(ed25519.verify(signed.subarray(1, 65), messageOf(signed), pub));
  assert.equal(toB58(signed.subarray(1, 65)).length > 80, true);
  const other = ed25519.getPublicKey(new Uint8Array(32).fill(3));
  assert.throws(() => signTxBytes(tx, (m) => ed25519.sign(m, seed), other), /payer/);
  assert.throws(() => placeSignature(tx, new Uint8Array(10)), /bad/);
  assert.throws(() => messageOf(Uint8Array.from([1, 2, 3])), /bad/);
});
