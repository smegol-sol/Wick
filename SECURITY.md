# Security policy

WICK signs real Solana transactions from a browser-held key. Treat every report as urgent.

## Reporting

Email the owner at smegolsol@gmail.com with the subject `WICK security`. Do not open a public issue for anything that could be exploited. You will get an acknowledgement within 48 hours.

Include: what you found, how to reproduce it, and whether any funds were involved.

## Scope

- Key handling: `packages/core/src/hot-wallet.ts` (vault, signer, fee-payer check)
- Execution path: `apps/desk/src/lib/live-exec.ts`, `apps/desk/src/lib/live-auto.ts`, `apps/desk/src/routes/api/swap.ts`, `apps/desk/src/routes/api/send.ts`
- Risk gates: `packages/core/src/risk.ts`, `packages/core/src/guard.ts`
- Anything that could make the UI show a number that is not from its stated source

## Out of scope

- Losses from market movement, slippage within the configured tolerance, or a token that rugged after passing the on-chain checks. Those are the risks the desk states up front.
- Third-party outages (pump.fun, DexScreener, Jupiter, RPC providers).

## Practices

Dependencies are updated weekly by Dependabot; `npm audit --audit-level=high` fails CI. No secret is ever committed; server-only values live in the deployment environment. See `docs/adr/` for the standing custody decisions.
