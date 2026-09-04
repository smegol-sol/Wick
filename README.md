# WICK

Self-custodied Solana meme spot desk. Live pump.fun pulse, on-chain audit, Jupiter execution from a browser hot wallet, wallet copy trading, snipes, ladders, DCA, exits and risk limits.

**This is a real-money desk.** Every buy, sell, snipe, copy, ladder slice and DCA slice signs and broadcasts a Jupiter swap from the desk wallet. There is no paper mode.

## Where every number comes from

| Field                                                                     | Source                                           | When missing                        |
| ------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------- |
| Launches, bonding %, market cap, replies, X handle                        | pump.fun frontend API                            | token not listed                    |
| Mint / freeze authority, supply                                           | Solana RPC `getMultipleAccounts` on the mint     | audit "not read yet"                |
| 24h volume, 5m volume, tx counts, 5m/1h change, pool liquidity (migrated) | DexScreener                                      | `n/a`                               |
| Top holders, top-10 share                                                 | RPC `getTokenLargestAccounts` + `getTokenSupply` | `n/a`; public RPCs refuse this call |
| Holder count                                                              | RPC `getProgramAccounts` (dedicated RPC only)    | `n/a`                               |
| Followed-wallet swaps ("smart money")                                     | RPC `getSignaturesForAddress` + `getTransaction` | empty list                          |
| Quotes and swap transactions                                              | Jupiter lite-api                                 | "No Jupiter route"                  |
| SOL/USD                                                                   | Jupiter price API                                | equity shows cash only              |

A field nobody reported is `null` in the model and `n/a` in the UI. A filter or sieve rule on an unreported field fails rather than passing. Sentiment, setups and fraud cards are heuristics over reported fields only; each card says how many checks had data.

There are no simulated wallets, tweets, prints or holders anywhere in the app.

## Project state

Progress, decisions and open items live in [`docs/STATE.md`](docs/STATE.md). Read it first; the roadmap is [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Run it

```sh
cp apps/desk/.env.example apps/desk/.env   # set SOLANA_RPC_URL
npm install                                # one install for every workspace
npm run dev                                # http://127.0.0.1:8080
```

Checks, all from the repository root:

```sh
npm run typecheck      # every workspace
npm run lint
npm test               # packages/core and apps/desk, node --test
npm run build          # the desk; nitro, vercel preset by default
npm run smoke          # Playwright render check against a running server
```

Engine, locally (any Postgres 16; the TimescaleDB migration skips itself when the extension is missing):

```sh
cd apps/engine
DATABASE_URL=postgres://wick@127.0.0.1:5432/wick npm run migrate
DATABASE_URL=postgres://wick@127.0.0.1:5432/wick SOLANA_RPC_URL=https://... npm start
curl -s http://127.0.0.1:9464/healthz
TEST_DATABASE_URL=postgres://wick@127.0.0.1:5432/wick npm test   # adds the database integration test
```

Deploying the desk to Vercel: set the project's Root Directory to `apps/desk` (the build still runs from the workspace root through npm).

## Configuration

Server-only environment variables (never `VITE_` prefixed):

- `SOLANA_RPC_URL`: a dedicated RPC (Helius, Triton, QuickNode). Strongly recommended. Without it the app falls back to the public endpoints, which are rate-limited, refuse holder queries, and are too slow to win a snipe.
- `NITRO_PRESET`: deploy target, defaults to `vercel`. Use `node-server` for a plain Node host.
- `HOST`, `PORT`: dev server bind, defaults `127.0.0.1:8080`.

## Safety model

- **Custody.** The desk wallet is an ed25519 key generated or imported in the browser, sealed with PBKDF2 (400k iterations) and AES-GCM bound to the public key, stored in `localStorage`. It unlocks into memory only, auto-locks after 8 minutes idle or 45 seconds hidden, and lockouts after repeated bad passphrases. Keep only what you are ready to lose in it.
- **No third-party scripts.** The page loads no external JavaScript. Fonts come from Google Fonts as CSS only.
- **Signing.** The signer refuses any transaction whose fee payer is not the desk wallet. Buys are capped by max trade size, book heat and the fee reserve. Sells never exceed the on-chain balance.
- **Arming.** Manual tickets always sign (with a confirmation step you can turn off). Auto snipes, copies, ladder and DCA slices sign only while "Live snipe" is on in the desk panel.
- **Server routes.** `/api/swap` and `/api/send` only relay unsigned and signed transactions the caller already controls, require a same-origin browser caller, and are rate-limited in memory per instance. On serverless hosts the in-memory limiter resets per instance; put a real limiter (Upstash, a WAF) in front for public deployments.

## Layout

npm workspaces, one lockfile at the root:

- `packages/core`: chain-agnostic contracts and the pure logic both apps share. Sources (`solana-pulse.ts`, `dex-stats.ts`, `mint-audit.ts`, `sol-price.ts`, `rpc.ts`), risk and exits, entry ladders, guards, the vault and signer (`hot-wallet.ts`), Jupiter, fraud and tape heuristics, copy rules. Imported as `@wick/core/<module>`. Tests in `src/core.test.ts`.
- `apps/desk`: the browser desk (TanStack Start). `src/lib/store.ts` is desk state and the tick loop and queues intent only; `src/lib/live-auto.ts` is the one place in the desk that signs; `src/routes/api/*` are pulse, holders, quote, swap, send and wallet bag. Tests in `src/lib/desk.test.ts`.
- `apps/engine`: the autonomous engine (see `docs/ENGINE.md`). Phase 1 so far: config with the capital ladder check, ingest into Postgres/TimescaleDB (tokens, second-resolution snapshots, mint audits with Token-2022 extensions), health and `/metrics`, and the host stack under `deploy/` (compose, Prometheus alerts, Alertmanager to Telegram, Grafana boards, Caddy on the tailnet, nightly backups). `docs/OPS.md` is the runbook.
- `scripts/`: the test loader shared by the workspaces and the Playwright smoke.

## Known limits

- pump.fun's frontend API is unofficial and sometimes blocks datacenter IPs. When it fails the pulse is empty, not made up.
- Very new tokens are not on DexScreener yet, so volume and tx show `n/a` for the first minutes.
- Candles are built from live polls while the desk is open. There is no historical OHLC source.
- Rate limiting and the caches are per server instance.
