# Security policy

WICK signs real Solana transactions from a sealed key on its host. Treat every report as urgent.

## Reporting

Email the owner at smegolsol@gmail.com with the subject `WICK security`. Do not open a public issue for anything that could be exploited. You will get an acknowledgement within 48 hours.

Include: what you found, how to reproduce it, and whether any funds were involved.

## Scope

- Key handling: `packages/core/src/hot-wallet.ts` (vault, signer, fee-payer check) and `apps/engine/src/executor/vault.ts` (the sealed vault, the second factor)
- Execution path: `apps/engine/src/executor/executor.ts` and `apps/engine/src/chains/solana/index.ts` (quote, build, simulate, sign, send, confirm)
- Gates and sizing: `packages/core/src/gates.ts`, `packages/core/src/sizing.ts`, `packages/core/src/risk.ts`, `packages/core/src/guard.ts`
- The control plane: `apps/engine/src/api/server.ts` (bearer token, the second factor on unseal, halt-clear, rule re-enable and wallet follow), the Telegram bot
- Anything that could make the UI show a number that is not from its stated source

## Out of scope

- Losses from market movement, slippage within the configured tolerance, or a token that rugged after passing the on-chain checks. Those are the risks the engine's documents state up front.
- Third-party outages (pump.fun, DexScreener, Jupiter, RPC providers).

## Practices

Dependencies are updated weekly by Dependabot; `npm audit --audit-level=high` fails CI. No secret is ever committed; server-only values live in the deployment environment. See `docs/THREAT-MODEL.md` and `docs/adr/` for the standing custody decisions.
