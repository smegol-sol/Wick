/**
 * The Solana adapter (ADR-0006). Sources: pump.fun and DexScreener through
 * the core pulse, mint accounts through the RPC, quotes through Jupiter.
 * Signing, sending and confirming land in Phase 2 with the executor; until
 * then they throw so nothing can sign by accident.
 */
import type {
  ChainAdapter,
  Confirmation,
  LaunchTx,
  Quote,
  SealedKeyHandle,
  SignedTx,
  SimResult,
  SlotReading,
  SourceBatch,
  SourceToken,
  UnsignedTx,
} from "@wick/core/chain";
import type { Audit, Snapshot } from "@wick/core/contracts";
import { fetchDexStats } from "@wick/core/dex-stats";
import { fetchJupQuote, impactPct, jupPair } from "@wick/core/jup";
import type { Token } from "@wick/core/market";
import { rpcAny, rpcCall, rpcUrls } from "@wick/core/rpc";
import { loadSolanaPulse } from "@wick/core/solana-pulse";
import { readMint, type ParsedMintAccount } from "./extensions.ts";

const NOT_YET = "not implemented until Phase 2 (executor)";

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
        snapshot: tokenToSnapshot(tk, pulse.at),
      }));
      return [{ source: "pump.fun", at: pulse.at, tokens, solUsd: pulse.solUsd }];
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

    async audit(mint, signal): Promise<Audit | null> {
      const res = await rpcAny<{ value?: ParsedMintAccount | null }>(
        "getAccountInfo",
        [mint, { encoding: "jsonParsed", commitment: "confirmed" }],
        signal,
      );
      const read = readMint(res?.value ?? null);
      if (!read) return null;
      return {
        mint,
        at: Date.now(),
        authorities: read.authorities,
        extensions: read.extensions,
        decimals: read.decimals,
        supply: read.supply,
        // LP ownership needs the pool account; lands with the LP reader (roadmap Phase 1).
        lp: null,
      };
    },

    async launchTx(): Promise<LaunchTx | null> {
      // Lands with launch-transaction parsing (roadmap Phase 1).
      return null;
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

    async buildTx(): Promise<UnsignedTx> {
      throw new Error(NOT_YET);
    },
    async simulate(): Promise<SimResult> {
      throw new Error(NOT_YET);
    },
    async sign(_tx: UnsignedTx, _key: SealedKeyHandle): Promise<SignedTx> {
      throw new Error(NOT_YET);
    },
    async send(): Promise<string> {
      throw new Error(NOT_YET);
    },
    async confirm(): Promise<Confirmation> {
      throw new Error(NOT_YET);
    },
    async balances(): Promise<{ native: bigint; token: bigint }> {
      throw new Error(NOT_YET);
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
