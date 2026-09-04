/**
 * Read mint authorities and Token-2022 extensions from a `jsonParsed` mint
 * account. Pure over the RPC's JSON so it can be tested without a chain.
 */
import type { Authorities, Extensions } from "@wick/core/contracts";

export type ParsedMintAccount = {
  owner?: string;
  data?: {
    program?: string;
    parsed?: {
      type?: string;
      info?: {
        mintAuthority?: string | null;
        freezeAuthority?: string | null;
        decimals?: number;
        supply?: string;
        extensions?: { extension?: string; state?: Record<string, unknown> }[];
      };
    };
  };
};

export type MintRead = {
  authorities: Authorities;
  extensions: Extensions;
  decimals: number;
  supply: number;
};

const TOKEN_2022 = "spl-token-2022";

function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

export function readMint(acc: ParsedMintAccount | null | undefined): MintRead | null {
  const parsed = acc?.data?.parsed;
  if (parsed?.type !== "mint") return null;
  const info = parsed.info ?? {};
  const program = acc?.data?.program === TOKEN_2022 ? "token2022" : "token";
  const decimals = num(info.decimals);
  const supply = num(info.supply) / 10 ** decimals;
  const ext: Extensions = {
    transferFeeBps: 0,
    hook: false,
    permanentDelegate: false,
    defaultFrozen: false,
  };
  for (const e of info.extensions ?? []) {
    const state = e.state ?? {};
    switch (e.extension) {
      case "transferFeeConfig": {
        const newer = state.newerTransferFee as { transferFeeBasisPoints?: number } | undefined;
        const older = state.olderTransferFee as { transferFeeBasisPoints?: number } | undefined;
        ext.transferFeeBps = Math.max(
          num(newer?.transferFeeBasisPoints),
          num(older?.transferFeeBasisPoints),
        );
        break;
      }
      case "transferHook":
        ext.hook = typeof state.programId === "string" && state.programId.length > 0;
        break;
      case "permanentDelegate":
        ext.permanentDelegate = typeof state.delegate === "string" && state.delegate.length > 0;
        break;
      case "defaultAccountState":
        ext.defaultFrozen = state.accountState === "frozen";
        break;
      default:
        break;
    }
  }
  return {
    authorities: {
      mint: typeof info.mintAuthority === "string" && info.mintAuthority.length > 0,
      freeze: typeof info.freezeAuthority === "string" && info.freezeAuthority.length > 0,
      program,
    },
    extensions: ext,
    decimals,
    supply,
  };
}
