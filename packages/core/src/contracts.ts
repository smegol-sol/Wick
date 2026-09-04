/**
 * Engine contracts (ENGINE.md §2). These types are shared by the engine, the
 * desk and replay. A change here goes through an ADR.
 *
 * `null` always means "nobody reported it", never zero.
 */

export type EngineChain = "solana"; // ADR-0006: more later, never in v1

export type Stage = "new" | "bonding" | "migrated";

export type Authorities = {
  mint: boolean;
  freeze: boolean;
  program: "token" | "token2022";
};

export type Extensions = {
  transferFeeBps: number;
  hook: boolean;
  permanentDelegate: boolean;
  defaultFrozen: boolean;
};

export type LpState = "burned" | "locked" | "deployer" | "curve";

export type LpEvent = { kind: "add" | "remove" | "burn" | "lock"; pct: number; ts: number };

/** What the LP reader saw in the pool account and the LP mint (ENGINE §7, pool share row). */
export type LpRead = {
  state: LpState | null;
  pool: string;
  dex: string;
  lpMint: string | null;
  /** LP ever minted by the pool program minus what still exists, percent; null without the program's count. */
  burnedPct: number | null;
  /** Largest remaining LP holder (the token account's owner) and its share of what exists. */
  topHolder: string | null;
  topHolderPct: number | null;
};

/** Who holds the supply and where it came from (ENGINE §7). */
export type SupplyMap = {
  at: number;
  devPct: number | null;
  bundlePct: number | null;
  sniperPct: number | null;
  freshWalletPct: number | null;
  lpPct: number | null;
  clusterPct: number | null;
  earlyHoldersTrend: "distributing" | "accumulating" | "flat" | null;
};

/** Flow and depth (ENGINE §10). */
export type Microstructure = {
  at: number;
  netFlowSol1m: number | null;
  netFlowSol5m: number | null;
  organicVolPct5m: number | null;
  depthBuy2PctUsd: number | null;
  depthSell2PctUsd: number | null;
};

/** Free social inputs only at tier 1 (ENGINE §6). Never a gate. */
export type SocialSignals = {
  at: number;
  repliesPerMin: number | null;
  hasSocials: boolean | null;
  paidBoost: boolean | null;
  telegramMembers: number | null;
};

export type WalletClass =
  | "organic"
  | "sniper-bot"
  | "wash-bot"
  | "copy-bot"
  | "dev-adjacent"
  | "exit-liquidity"
  | "early-consistent"
  | "unknown";

export type WalletProfile = {
  wallet: string;
  class: WalletClass;
  confidence: number;
  stats: Record<string, number>;
  profiledAt: number;
};

/** Market-wide state (ENGINE §11). One multiplier for the whole engine. */
export type Regime = {
  at: number;
  solChange1hPct: number | null;
  breadth5m: number | null;
  launchesPerHour: number | null;
  migrationsPerHour: number | null;
  safetyRejectRate1h: number | null;
  sizeMul: 0 | 0.5 | 1;
  reason: string;
};

/** What the engine knows about a token at decision time. */
export type Features = {
  chain: EngineChain;
  mint: string;
  ts: number;
  ageSec: number;
  stage: Stage;
  priceUsd: number;
  mcUsd: number;
  liqUsd: number;
  vol5m: number | null;
  vol24: number | null;
  tx24: number | null;
  buys5m: number | null;
  sells5m: number | null;
  uniqueBuyers5m: number | null;
  holders: number | null;
  holdersDelta30m: number | null;
  top10Pct: number | null;
  authorities: Authorities | null;
  extensions: Extensions | null;
  lp: LpState | null;
  lastLpEvent: LpEvent | null;
  supply: SupplyMap | null;
  micro: Microstructure | null;
  washFlags: string[];
  fundingFlags: string[];
  followBuys3m: number;
  followSells3m: number;
  smartBuys3m: number;
  social: SocialSignals | null;
};

export type Strategy =
  "confirmed-entry" | "migration-snipe" | "mirror-follow" | "smart-copy" | "exit-policy";

export type Mode = "shadow" | "suggest" | "auto";

export type Sizing = {
  equityTerm: number;
  poolTerm: number;
  capTerm: number;
  binding: "equity" | "pool" | "cap";
  regimeMul: number;
  socialMul: number;
};

export type Intent = {
  id: string;
  chain: EngineChain;
  ts: number;
  kind: "entry" | "exit" | "add";
  strategy: Strategy;
  ruleId: string;
  mode: Mode;
  mint: string;
  side: "buy" | "sell";
  sizeSol: number;
  sizing: Sizing | null;
  features: Features;
  why: string;
  ttlMs: number;
  replayRunId: string | null;
};

export const GATES = [
  "safety",
  "supply",
  "liquidity",
  "manipulation",
  "quote",
  "risk",
  "execution",
] as const;
export type Gate = (typeof GATES)[number];

/** ENGINE §4. Twenty-four codes; the cap is 25 (ADR-0008). */
export const REASON_CODES = [
  "SAFETY_MINT",
  "SAFETY_FREEZE",
  "SAFETY_EXT",
  "SAFETY_LP",
  "SAFETY_UNKNOWN",
  "SUPPLY_DEV",
  "SUPPLY_BUNDLE",
  "SUPPLY_SNIPERS",
  "SUPPLY_UNKNOWN",
  "LIQ_DEPTH",
  "LIQ_EXIT",
  "LIQ_PULL",
  "MANIP_WASH",
  "MANIP_TOP10",
  "MANIP_FUNDING",
  "MANIP_CIRCULAR",
  "QUOTE_STALE",
  "QUOTE_IMPACT",
  "RISK_HALT",
  "RISK_SLOTS",
  "RISK_TOKEN_CAP",
  "RISK_CLUSTER",
  "RISK_YOUNG",
  "RISK_CASH",
  "EXEC_SIM",
  "EXEC_EXPIRED",
  "EXEC_UNCONFIRMED",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];
export const REASON_CODE_CAP = 25;

export type GateResult = {
  gate: Gate;
  passed: boolean;
  reasonCode: ReasonCode | null;
  adjustment: { sizeMul: number; reason: string } | null;
  ms: number;
};

export type Execution = {
  intentId: string;
  quoteId: string;
  wallet: string;
  sig: string | null;
  sentAt: number;
  landedAt: number | null;
  status: "simulated" | "sent" | "confirmed" | "failed" | "expired";
  err: string | null;
  feeLamports: number;
  tipLamports: number;
  route: "rpc" | "jito";
};

export type Fill = {
  executionId: string;
  chain: EngineChain;
  mint: string;
  side: "buy" | "sell";
  solDelta: number;
  tokenDelta: number;
  quotedPrice: number;
  realizedPrice: number;
  realizedSlippagePct: number;
};

export type Outcome = {
  intentId: string;
  horizonSec: 300 | 1800 | 7200;
  retPct: number;
  maxRetPct: number;
  minRetPct: number;
};

/** One row of `token_snapshots`: what a source said about a mint at `ts`. */
export type Snapshot = {
  ts: number;
  mint: string;
  price: number | null;
  mc: number | null;
  liq: number | null;
  vol5m: number | null;
  vol24: number | null;
  tx24: number | null;
  buys5m: number | null;
  sells5m: number | null;
  holders: number | null;
  top10: number | null;
  source: string;
  /** The source's own timestamp for the stats, when it has one. */
  statsAt: number | null;
};

/** Result of reading a mint account and its pool (ENGINE §4 safety inputs). */
export type Audit = {
  mint: string;
  at: number;
  authorities: Authorities | null;
  extensions: Extensions | null;
  decimals: number | null;
  supply: number | null;
  lp: LpState | null;
  /** The reading behind `lp`, when a pool was read; absent in API views. */
  lpRead?: LpRead | null;
};
