# ADR-0006: Chain-agnostic core, Solana first

- Status: accepted (September 2026)

## Context

The owner asked which networks the engine will cover. Every source, the vault format, the signer and the swap path in the current code are Solana-specific, and more than the large majority of meme launch volume and tooling is on Solana today. Base and BNB Chain are the next markets by activity.

Supporting a second chain doubles the attack surface, the source-failure modes and the maintenance load. Doing it before the first chain is profitable would spend the budget on breadth instead of on the evaluator and the supply map that decide whether the engine works at all.

## Decision

1. **Version 1 trades Solana only.** No second chain is built before the engine has 90 days of positive expectancy on Solana at its current tier (ADR-0005).

2. **The core does not know the chain.** `decision`, `gates` (except `execution`), `evaluator`, `replay` and all shared types in `packages/core` operate on `Features`, `Intent`, `Fill` and `Outcome`. Every one of those types carries a `chain` field (`"solana"` for now). Nothing in the core imports a chain SDK.

3. **Everything chain-specific sits behind one interface**, implemented once per chain in `apps/engine/src/chains/<chain>/`:

```ts
interface ChainAdapter {
  chain: Chain;
  sources(): IngestSource[]; // launches, pools, wallet prints, chain events
  audit(token: string): Promise<Audit | null>; // authorities, extensions, LP state, supply map inputs
  launchTx(token: string): Promise<LaunchTx | null>; // first block(s): creator, bundled buyers, snipers
  quote(req: QuoteRequest): Promise<Quote | null>;
  buildTx(quote: Quote, wallet: string): Promise<UnsignedTx>;
  simulate(tx: UnsignedTx): Promise<SimResult>;
  sign(tx: UnsignedTx, key: SealedKeyHandle): Promise<SignedTx>;
  send(tx: SignedTx): Promise<string>;
  confirm(sig: string, timeoutMs: number): Promise<Confirmation>;
  balances(wallet: string, token: string): Promise<{ native: bigint; token: bigint }>;
}
```

`gates.execution` and `executor` call the adapter; they never call an RPC directly.

4. **Reason codes, gate order, sizing and risk numbers are chain-independent.** A chain may add reason codes under its own prefix (for example `SOL_*`), never redefine shared ones.

5. **Order of future chains:** Base first (EVM, Uniswap v3/v4 and the launchpads that migrate there), then BNB Chain. Each addition is its own ADR with its own sources table in README and its own 30-day suggest-mode run.

## Alternatives rejected

- **Multi-chain in version 1.** Rejected: two ingest layers, two signers and two sets of failure modes before the first one has proven anything.
- **A third-party aggregator API that abstracts chains for us.** Rejected for the money path: it puts a vendor between the engine and the transaction it signs, and the data-honesty rule (ADR-0001) needs sources we can name per field.

## Consequences

- Some indirection now (an adapter with one implementation) in exchange for not rewriting the core later.
- `Features.chain`, `Intent.chain` and `Fill.chain` are part of the contracts from Phase 2.
- The README sources table gains a chain column when the second adapter lands, not before.
