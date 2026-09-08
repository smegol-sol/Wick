/**
 * Integration test against a real Solana cluster (ROADMAP Phase 2: "the full path on
 * devnet"). Runs only when DEVNET_RPC_URL is set; funds the wallet from the faucet, or
 * from DEVNET_SECRET_B58 (a devnet-only 64-byte secret, never the execution wallet's)
 * when the faucet refuses, as it does from most datacenter addresses.
 *
 * Jupiter does not exist on devnet, so the swap is a SOL self-transfer built by hand:
 * the quote and the transaction are the test's, everything after them (simulate, sign,
 * send, confirm, balances, and the executor around them) is the production code.
 *
 *   DEVNET_RPC_URL=https://api.devnet.solana.com [DEVNET_SECRET_B58=...] \
 *   [TEST_DATABASE_URL=...] npm -w @wick/engine test
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { fromB58, toB58 } from "@wick/core/base58";
import type { ChainAdapter, Quote, SealedKeyHandle, UnsignedTx } from "@wick/core/chain";
import { importHot, lockHotMem } from "@wick/core/hot-wallet";
import { rpcCall } from "@wick/core/rpc";
import { base32Decode, totp } from "@wick/core/totp";
import { loadRisk } from "../../config.ts";
import { makePool } from "../../db/pool.ts";
import { migrate } from "../../db/migrate.ts";
import { Executor } from "../../executor/executor.ts";
import { Vault } from "../../executor/vault.ts";
import { blockhashOf, makeSolanaAdapter } from "./index.ts";

const RPC = process.env.DEVNET_RPC_URL?.trim() || null;
const DB = process.env.TEST_DATABASE_URL?.trim() || null;
const WSOL = "So11111111111111111111111111111111111111112";
const SYSTEM = new Uint8Array(32);
const FEE_LAMPORTS = 5000n;
const PASS = "correct horse battery";
const TOTP_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

type Funded = { seed: Uint8Array; pub: Uint8Array; wallet: string; secretB58: string };

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  return rpcCall<T>(RPC!, method, params, AbortSignal.timeout(15_000));
}

async function lamports(wallet: string): Promise<bigint> {
  const r = await rpc<{ value: number }>("getBalance", [wallet, { commitment: "confirmed" }]);
  return BigInt(r?.value ?? 0);
}

/** A funded devnet key: the env secret, or a fresh one the faucet pays; null when neither works. */
async function fundedKey(): Promise<Funded | null> {
  const env = process.env.DEVNET_SECRET_B58?.trim();
  if (env) {
    const secret = fromB58(env);
    assert.ok(secret && secret.length === 64, "DEVNET_SECRET_B58 must be a 64-byte secret");
    const seed = secret.subarray(0, 32);
    const pub = ed25519.getPublicKey(seed);
    return { seed, pub, wallet: toB58(pub), secretB58: env };
  }
  const seed = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(seed);
  const wallet = toB58(pub);
  const secret = new Uint8Array(64);
  secret.set(seed);
  secret.set(pub, 32);
  const sig = await rpc<string>("requestAirdrop", [wallet, 100_000_000]);
  if (typeof sig !== "string") return null;
  for (let i = 0; i < 20; i++) {
    if ((await lamports(wallet)) > 0n) return { seed, pub, wallet, secretB58: toB58(secret) };
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

/** A legacy transaction that transfers `amount` lamports from the wallet to itself. */
async function selfTransfer(pub: Uint8Array, amount: bigint): Promise<UnsignedTx> {
  const bh = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>(
    "getLatestBlockhash",
    [{ commitment: "confirmed" }],
  );
  assert.ok(bh?.value, "blockhash");
  const data = new Uint8Array(12);
  new DataView(data.buffer).setUint32(0, 2, true); // SystemProgram::Transfer
  new DataView(data.buffer).setBigUint64(4, amount, true);
  const message = Uint8Array.from([
    1, // signatures required
    0, // read-only signed
    1, // read-only unsigned (the system program)
    2, // account keys
    ...pub,
    ...SYSTEM,
    ...fromB58(bh.value.blockhash)!,
    1, // instructions
    1, // program index
    2, // account indexes
    0,
    0,
    data.length,
    ...data,
  ]);
  const bytes = Uint8Array.from([1, ...new Uint8Array(64), ...message]);
  assert.equal(blockhashOf(bytes), bh.value.blockhash, "the adapter reads our blockhash back");
  return {
    bytes,
    blockhash: bh.value.blockhash,
    lastValidBlockHeight: bh.value.lastValidBlockHeight,
  };
}

function withDevnet<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.SOLANA_RPC_URL;
  process.env.SOLANA_RPC_URL = RPC!;
  return fn().finally(() => {
    if (prev == null) delete process.env.SOLANA_RPC_URL;
    else process.env.SOLANA_RPC_URL = prev;
  });
}

test(
  "devnet: the production adapter simulates, signs, sends and confirms a real transaction",
  { skip: !RPC },
  async (t) => {
    const key = await fundedKey();
    if (!key)
      return t.skip("the devnet faucet refused; set DEVNET_SECRET_B58 to a funded devnet key");
    await withDevnet(async () => {
      const chain = makeSolanaAdapter();
      const signal = AbortSignal.timeout(60_000);
      const slots = await chain.slots(signal);
      assert.ok(slots[0]?.slot != null, "the devnet endpoint answers the slot poll");
      const height = await chain.blockHeight(signal);
      assert.ok(height != null && height > 0);
      const before = await chain.balances(key.wallet, WSOL, signal);
      assert.ok(before.native > FEE_LAMPORTS, "funded");
      const tx = await selfTransfer(key.pub, 1_000n);
      const sim = await chain.simulate(tx, signal);
      assert.equal(sim.ok, true, `simulation: ${sim.err}`);
      assert.ok(sim.unitsConsumed != null && sim.unitsConsumed > 0);
      const handle: SealedKeyHandle = {
        wallet: key.wallet,
        sign: (m) => ed25519.sign(m, key.seed),
      };
      const signed = await chain.sign(tx, handle);
      assert.equal(signed.sig.length >= 86 && signed.sig.length <= 88, true, "a base58 signature");
      const sig = await chain.send(signed, signal);
      assert.equal(sig, signed.sig, "the cluster reports the signature we computed");
      const conf = await chain.confirm(sig, 45_000, tx.lastValidBlockHeight, signal);
      assert.equal(conf.status, "confirmed", conf.err ?? "");
      assert.ok(conf.slot != null && conf.slot > 0);
      const after = await chain.balances(key.wallet, WSOL, signal);
      assert.equal(
        before.native - after.native,
        FEE_LAMPORTS,
        "a self-transfer costs the fee alone",
      );
      const summary = await chain.txSummary(sig, signal);
      assert.ok(summary, "the confirmed transaction is readable");
      assert.ok(summary.signers.includes(key.wallet));
      assert.deepEqual(await chain.trades(sig, signal), [], "a transfer is not a trade");
      const dup = await chain.confirm(sig, 5_000, null, signal);
      assert.equal(dup.status, "confirmed", "confirm is idempotent on a landed signature");
    });
  },
);

test(
  "devnet: the executor takes an approved intent through balances, simulate, sign, send, confirm and the fill",
  { skip: !RPC || !DB },
  async (t) => {
    const key = await fundedKey();
    if (!key)
      return t.skip("the devnet faucet refused; set DEVNET_SECRET_B58 to a funded devnet key");
    const db = makePool(DB!);
    const dir = mkdtempSync(join(tmpdir(), "wick-devnet-"));
    const id = `devnet-${Date.now()}`;
    try {
      await migrate(db);
      const { vault: hot } = await importHot(key.secretB58, PASS);
      lockHotMem();
      writeFileSync(join(dir, "vault.json"), JSON.stringify(hot));
      const vault = new Vault(join(dir, "vault.json"), base32Decode(TOTP_B32));
      await vault.unseal(PASS, await totp(base32Decode(TOTP_B32), Date.now()));
      assert.equal(vault.wallet, key.wallet);
      await withDevnet(async () => {
        const real = makeSolanaAdapter();
        // The venue is the test's; the chain is real.
        const chain: ChainAdapter = {
          ...real,
          async quote(req): Promise<Quote> {
            return {
              id: `q-${id}`,
              at: Date.now(),
              inAmount: req.amountRaw,
              outAmount: req.amountRaw,
              impactPct: 0,
              route: { devnet: "self-transfer" },
            };
          },
          async buildTx(quote) {
            return selfTransfer(key.pub, BigInt(quote.inAmount));
          },
        };
        const exec = new Executor(
          {
            db,
            chain,
            vault,
            risk: loadRisk("config/risk.yaml"),
            halted: () => ({ halted: false, reason: null }),
          },
          { tickMs: 1000, confirmTimeoutMs: 45_000, balanceRefreshMs: 0 },
        );
        await db.query(
          `insert into intents (id, chain, ts, kind, strategy, rule_id, mode, mint, side, size_sol, features, why, status, decided_by, decided_at, ttl_ms)
           values ($1, 'solana', now(), 'entry', 'confirmed-entry', 'confirmed-entry', 'suggest', $2, 'buy', 0.001, $3, 'devnet', 'approved', 'owner', now(), 90000)`,
          [id, WSOL, JSON.stringify({ mint: WSOL, priceUsd: 1, liqUsd: 1 })],
        );
        const before = await lamports(key.wallet);
        await exec.tick();
        const ex = await db.query<{ status: string; sig: string | null; err: string | null }>(
          "select status, sig, err from executions where intent_id = $1",
          [id],
        );
        assert.equal(ex.rows[0]?.status, "confirmed", ex.rows[0]?.err ?? "no execution row");
        assert.ok(ex.rows[0]?.sig, "a real signature");
        const conf = await real.confirm(ex.rows[0]!.sig!, 5_000, null, AbortSignal.timeout(15_000));
        assert.equal(
          conf.status,
          "confirmed",
          "the cluster knows the signature the executor wrote",
        );
        const intent = await db.query<{ status: string }>(
          "select status from intents where id = $1",
          [id],
        );
        assert.equal(intent.rows[0]?.status, "executed");
        const fill = await db.query<{ sol_delta: string }>(
          "select sol_delta from fills f join executions e on e.id = f.execution_id where e.intent_id = $1",
          [id],
        );
        assert.ok(
          Math.abs(Number(fill.rows[0]?.sol_delta) + Number(FEE_LAMPORTS) / 1e9) < 1e-9,
          "the fill is the fee",
        );
        assert.equal(before - (await lamports(key.wallet)), FEE_LAMPORTS);
        const gate = await db.query(
          "select passed from gate_results where intent_id = $1 and gate = 'execution'",
          [id],
        );
        assert.equal(gate.rows[0]?.passed, true);
      });
    } finally {
      for (const sql of [
        "delete from fills where execution_id in (select id from executions where intent_id = $1)",
        "delete from positions where intent_id = $1",
        "delete from executions where intent_id = $1",
        "delete from quotes where intent_id = $1",
        "delete from gate_results where intent_id = $1",
        "delete from intents where id = $1",
      ])
        await db.query(sql, [id]).catch(() => {});
      await db.end();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
