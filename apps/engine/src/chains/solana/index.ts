/**
 * The Solana adapter (ADR-0006). Sources: pump.fun and DexScreener through
 * the core pulse, mint accounts through the RPC, quotes and swap transactions
 * through Jupiter. Simulation, sending and confirmation go through the RPC;
 * signing takes a `SealedKeyHandle` and never sees the key bytes.
 */
import type {
  BuildOpts,
  ChainAdapter,
  Confirmation,
  HolderRead,
  LaunchTx,
  Quote,
  SealedKeyHandle,
  SignedTx,
  SimResult,
  SlotReading,
  SourceBatch,
  SourceToken,
  UnsignedTx,
  WalletBalances,
} from "@wick/core/chain";
import type { Audit, Snapshot } from "@wick/core/contracts";
import { fetchDexStats } from "@wick/core/dex-stats";
import { b64of, b64to, signTxBytes, toB58 } from "@wick/core/hot-wallet";
import { fromB58 } from "@wick/core/base58";
import { fetchJupQuote, fetchJupSwap, impactPct, jupPair, type JupQuote } from "@wick/core/jup";
import type { Token } from "@wick/core/market";
import { rpcAny, rpcCall, rpcUrls } from "@wick/core/rpc";
import { loadSolanaPulse } from "@wick/core/solana-pulse";
import { readMint, type ParsedMintAccount } from "./extensions.ts";
import { fetchLaunch } from "./launch.ts";
import { readLp } from "./lp.ts";
import { fetchTx, summaryOf, tradesOf } from "./trades.ts";

const CONFIRM_POLL_MS = 1500;

type SigStatus = {
  slot: number;
  err: unknown;
  confirmationStatus?: "processed" | "confirmed" | "finalized";
} | null;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
}

export function tokenToSnapshot(tk: Token, at: number): Snapshot {
  return {
    ts: at,
    mint: tk.mint,
    price: tk.price > 0 ? tk.price : null,
    mc: tk.mc > 0 ? tk.mc : null,
    liq: tk.liq >= 0 ? tk.liq : null,
    vol5m: tk.vol5m,
    vol24: tk.vol,
    tx24: tk.tx,
    buys5m: tk.buys5m,
    sells5m: tk.sells5m,
    holders: tk.holders,
    top10: tk.security.top10,
    source: tk.statsAt != null ? "pump.fun+dexscreener" : "pump.fun",
    statsAt: tk.statsAt,
  };
}

export function makeSolanaAdapter(): ChainAdapter {
  return {
    chain: "solana",

    async poll(): Promise<SourceBatch[]> {
      const pulse = await loadSolanaPulse();
      const tokens: SourceToken[] = pulse.tokens.map((tk) => ({
        mint: tk.mint,
        symbol: tk.symbol,
        name: tk.name,
        creator: null,
        createdAt: tk.createdAt,
        stage: tk.stage,
        pair: tk.pair,
        snapshot: tokenToSnapshot(tk, pulse.at),
      }));
      return [
        { source: "pump.fun", at: pulse.at, tokens, solUsd: pulse.solUsd, failure: pulse.failure },
      ];
    },

    async stats(mints, signal): Promise<Snapshot[]> {
      const got = await fetchDexStats(mints, signal);
      const out: Snapshot[] = [];
      for (const [mint, st] of got) {
        out.push({
          ts: st.at,
          mint,
          price: st.priceUsd,
          mc: st.mc,
          liq: st.liqUsd,
          vol5m: st.vol5m,
          vol24: st.vol24,
          tx24: st.tx24,
          buys5m: st.buys5m,
          sells5m: st.sells5m,
          holders: null,
          top10: null,
          source: "dexscreener",
          statsAt: st.at,
        });
      }
      return out;
    },

    async audit(ref, signal): Promise<Audit | null> {
      const { mint } = ref;
      const res = await rpcAny<{ value?: ParsedMintAccount | null }>(
        "getAccountInfo",
        [mint, { encoding: "jsonParsed", commitment: "confirmed" }],
        signal,
      );
      const read = readMint(res?.value ?? null);
      if (!read) return null;
      // On the bonding curve the program holds the liquidity and there is no LP token.
      // After migration the pool account says who holds the LP; without a known pool, unknown.
      const lpRead =
        ref.stage === "migrated" && ref.pair ? await readLp(mint, ref.pair, signal) : null;
      return {
        mint,
        at: Date.now(),
        authorities: read.authorities,
        extensions: read.extensions,
        decimals: read.decimals,
        supply: read.supply,
        lp: ref.stage === "migrated" ? (lpRead?.state ?? null) : "curve",
        lpRead,
      };
    },

    async launchTx(mint, signal): Promise<LaunchTx | null> {
      return fetchLaunch(mint, signal);
    },

    async trades(sig, signal) {
      return tradesOf(sig, await fetchTx(sig, signal));
    },

    async holders(mint, signal) {
      const largest = await rpcAny<{ value?: { address: string; amount: string }[] }>(
        "getTokenLargestAccounts",
        [mint, { commitment: "confirmed" }],
        signal,
      );
      const accounts = largest?.value ?? [];
      if (!accounts.length) return [];
      const infos = await rpcAny<{
        value?: ({ data?: { parsed?: { info?: { owner?: string } } } } | null)[];
      }>(
        "getMultipleAccounts",
        [accounts.map((a) => a.address), { encoding: "jsonParsed", commitment: "confirmed" }],
        signal,
      );
      const out: HolderRead[] = [];
      accounts.forEach((a, i) => {
        const owner = infos?.value?.[i]?.data?.parsed?.info?.owner;
        if (!owner) return;
        out.push({ account: a.address, owner, amount: Number(a.amount) });
      });
      return out;
    },

    async signaturesSince(address, untilSig, limit, signal) {
      const res = await rpcAny<
        { signature: string; slot: number; err: unknown; blockTime: number | null }[]
      >(
        "getSignaturesForAddress",
        [address, { limit, commitment: "confirmed", ...(untilSig ? { until: untilSig } : {}) }],
        signal,
      );
      return (res ?? []).map((r) => ({
        signature: r.signature,
        slot: r.slot,
        err: r.err ?? null,
        blockTime: r.blockTime ?? null,
      }));
    },

    async txSummary(sig, signal) {
      return summaryOf(sig, await fetchTx(sig, signal));
    },

    async quote(req, signal): Promise<Quote | null> {
      const { input, output } = jupPair(req.side, req.mint);
      const q = await fetchJupQuote(input, output, req.amountRaw, req.slippageBps, signal);
      if (!q) return null;
      return {
        id: `${req.mint}:${Date.now()}`,
        at: Date.now(),
        inAmount: String(q.inAmount),
        outAmount: String(q.outAmount),
        impactPct: impactPct(q.priceImpactPct),
        route: q,
      };
    },

    async buildTx(quote, wallet, opts: BuildOpts, signal): Promise<UnsignedTx> {
      const built = await fetchJupSwap(
        quote.route as JupQuote,
        wallet,
        { maxLamports: opts.priorityFeeCapLamports },
        signal,
      );
      if (!built) throw new Error("swap build failed");
      const bytes = b64to(built.swapTransaction);
      const blockhash = blockhashOf(bytes);
      if (built.lastValidBlockHeight == null)
        throw new Error("swap build lacks lastValidBlockHeight");
      return { bytes, blockhash, lastValidBlockHeight: built.lastValidBlockHeight };
    },

    async simulate(tx, signal): Promise<SimResult> {
      const res = await rpcAny<{
        value?: { err?: unknown; unitsConsumed?: number; logs?: string[] | null };
      }>(
        "simulateTransaction",
        [
          b64of(tx.bytes),
          {
            encoding: "base64",
            sigVerify: false,
            replaceRecentBlockhash: true,
            commitment: "confirmed",
          },
        ],
        signal,
      );
      if (!res?.value) return { ok: false, err: "simulation unanswered", unitsConsumed: null };
      const v = res.value;
      const err = v.err == null ? null : errOf(v.err, v.logs ?? null);
      return { ok: err == null, err, unitsConsumed: v.unitsConsumed ?? null };
    },

    async sign(tx, key: SealedKeyHandle): Promise<SignedTx> {
      const pub = fromB58(key.wallet);
      if (!pub) throw new Error("bad wallet");
      const signed = signTxBytes(tx.bytes, key.sign, pub);
      return { bytes: signed, sig: toB58(signed.subarray(1, 65)) };
    },

    async send(tx, signal): Promise<string> {
      const sig = await rpcAny<string>(
        "sendTransaction",
        [
          b64of(tx.bytes),
          {
            encoding: "base64",
            skipPreflight: true,
            maxRetries: 3,
            preflightCommitment: "confirmed",
          },
        ],
        signal,
      );
      if (typeof sig !== "string") throw new Error("send unanswered");
      return sig;
    },

    async confirm(sig, timeoutMs, lastValidBlockHeight, signal): Promise<Confirmation> {
      const deadline = Date.now() + timeoutMs;
      while (!signal.aborted) {
        const res = await rpcAny<{ value?: SigStatus[] }>(
          "getSignatureStatuses",
          [[sig], { searchTransactionHistory: false }],
          signal,
        );
        const st = res?.value?.[0] ?? null;
        if (st) {
          if (st.err != null) return { status: "failed", slot: st.slot, err: errOf(st.err, null) };
          if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")
            return { status: "confirmed", slot: st.slot, err: null };
        } else if (lastValidBlockHeight != null) {
          const height = await this.blockHeight(signal);
          if (height != null && height > lastValidBlockHeight)
            return { status: "expired", slot: null, err: "blockhash expired" };
        }
        if (Date.now() >= deadline)
          return { status: "expired", slot: null, err: `not confirmed in ${timeoutMs} ms` };
        await sleep(CONFIRM_POLL_MS, signal);
      }
      return { status: "expired", slot: null, err: "aborted" };
    },

    async blockHeight(signal): Promise<number | null> {
      const h = await rpcAny<number>("getBlockHeight", [{ commitment: "confirmed" }], signal);
      return typeof h === "number" ? h : null;
    },

    async balances(wallet, mint, signal): Promise<WalletBalances> {
      const [native, accounts] = await Promise.all([
        rpcAny<{ value?: number }>("getBalance", [wallet, { commitment: "confirmed" }], signal),
        rpcAny<{
          value?: {
            account?: {
              data?: {
                parsed?: { info?: { tokenAmount?: { amount?: string; decimals?: number } } };
              };
            };
          }[];
        }>(
          "getTokenAccountsByOwner",
          [wallet, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }],
          signal,
        ),
      ]);
      if (native?.value == null) throw new Error("balance unanswered");
      let token = 0n;
      let decimals: number | null = null;
      for (const a of accounts?.value ?? []) {
        const amt = a.account?.data?.parsed?.info?.tokenAmount;
        if (!amt?.amount) continue;
        token += BigInt(amt.amount);
        if (typeof amt.decimals === "number") decimals = amt.decimals;
      }
      return { native: BigInt(native.value), token, decimals };
    },

    async slots(signal): Promise<SlotReading[]> {
      const urls = rpcUrls();
      return Promise.all(
        urls.map(async (url) => {
          const t0 = performance.now();
          try {
            const slot = await rpcCall<number>(
              url,
              "getSlot",
              [{ commitment: "processed" }],
              signal,
            );
            return {
              url,
              slot: typeof slot === "number" ? slot : null,
              ms: performance.now() - t0,
            };
          } catch {
            return { url, slot: null, ms: performance.now() - t0 };
          }
        }),
      );
    },
  };
}

/** The recent blockhash inside a serialized v0 or legacy transaction, base58. */
export function blockhashOf(bin: Uint8Array): string {
  let i = 0;
  const sigs = compact(bin, i);
  i = sigs.size + sigs.n * 64;
  if (bin[i]! & 0x80) i += 1; // v0 prefix
  i += 3; // header
  const keys = compact(bin, i);
  i += keys.size + keys.n * 32;
  if (i + 32 > bin.length) throw new Error("bad transaction");
  return toB58(bin.subarray(i, i + 32));
}

function compact(bytes: Uint8Array, offset: number): { n: number; size: number } {
  let n = 0;
  for (let size = 0; size < 3; size++) {
    const b = bytes[offset + size];
    if (b == null) break;
    n |= (b & 0x7f) << (size * 7);
    if ((b & 0x80) === 0) return { n, size: size + 1 };
  }
  throw new Error("bad transaction");
}

function errOf(err: unknown, logs: string[] | null): string {
  const text = typeof err === "string" ? err : JSON.stringify(err);
  const last = logs?.filter((l) => /error|failed/i.test(l)).slice(-1)[0];
  return last ? `${text}: ${last}`.slice(0, 500) : text.slice(0, 500);
}
