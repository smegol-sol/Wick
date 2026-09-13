# WICK

An autonomous trading engine for Solana memecoins, run by one owner from a phone. It watches launches on pump.fun and the chain, measures every token it sees once a second, decides through a fixed chain of gates, and executes only what the rules and the owner allow. The console is the control surface; the engine does the work on a small VPS.

**This trades real SOL.** Nothing signs without passing every gate, a number without a source is `null` and renders `n/a`, and every decision is written down with the features it saw and the rules that judged it.

## Read first

- [`docs/STATE.md`](docs/STATE.md): where the project is, what was decided, what is open, how to verify the tree.
- [`docs/ROADMAP.md`](docs/ROADMAP.md): the phases and their exit conditions.
- [`docs/ENGINE.md`](docs/ENGINE.md): the architecture. [`docs/adr/`](docs/adr/): the decisions. [`docs/OPS.md`](docs/OPS.md): the host runbook. [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md): the security model.
- [`CONTRIBUTING.md`](CONTRIBUTING.md): the rules and the checks.

## Where every number comes from

| Field                                                | Source                                               | When missing                      |
| ---------------------------------------------------- | ---------------------------------------------------- | --------------------------------- |
| Launches, bonding progress, market cap               | pump.fun frontend API                                | the pulse is empty, with a reason |
| Mint and freeze authority, supply, Token-2022 flags  | Solana RPC (`getMultipleAccounts`)                   | `SAFETY_UNKNOWN`                  |
| Volume, transactions, pool liquidity after migration | DexScreener                                          | `n/a`                             |
| Holders, the supply map, wallet classes              | RPC (`getTokenLargestAccounts`, transaction history) | `SUPPLY_UNKNOWN`                  |
| Prints of followed wallets, migrations, creates      | the RPC log stream, resumed after every reconnect    | counted as a gap                  |
| Quotes and swap transactions                         | Jupiter                                              | no execution                      |
| SOL/USD                                              | Jupiter price API                                    | no sizing                         |

There are no simulated wallets, prints, holders or prices anywhere.

## Layout

npm workspaces, one lockfile at the root:

- `packages/core`: chain-agnostic contracts and pure logic (gates, sizing, rules, the evaluator, replay, the vault and signer, the sources). Imported as `@wick/core/<module>`; nothing in it touches a browser or a database.
- `apps/engine`: the engine (ingest, decision loop, executor, evaluator, regime, supply map, Telegram bot, replay) and the host stack under `deploy/` (compose, Prometheus and Alertmanager, Grafana, Caddy on the tailnet, backups, the failure drills, `update.sh`).
- `apps/console`: the owner's console (Vite, React, TanStack Router, a PWA): Now, Engine and a token detail, on the API contract in core, with a labelled mock mode.
- `scripts/`: the test loader the workspaces share and the Playwright render smoke.

## Run the checks

All from the repository root; CI runs the same set:

```sh
npm install
npm run typecheck && npm run lint && npm run format:check && npm test && npm run audit
VITE_MOCK=1 npm run build && (cd apps/console && npx vite preview --port 8091 &) && npm run smoke -- http://127.0.0.1:8091/ screenshots/console
```

The engine's database tests run when `TEST_DATABASE_URL` points at a Postgres 16 (CI uses TimescaleDB); the devnet tests run when `DEVNET_RPC_URL` is set. `docs/STATE.md` has both lines.

## Run the engine

Locally, against any Postgres 16 (the TimescaleDB migration skips itself when the extension is missing):

```sh
cd apps/engine
DATABASE_URL=postgres://wick@127.0.0.1:5432/wick npm run migrate
DATABASE_URL=postgres://wick@127.0.0.1:5432/wick SOLANA_RPC_URL=https://... npm start
curl -s http://127.0.0.1:9464/healthz
```

On the host, `docs/OPS.md` is the whole story: one VPS reachable over Tailscale only, the engine sealed until the owner unseals it with a passphrase and a six-digit code, `update.sh` for every deploy, `drill.sh` for the failure drills.

## Safety model, in short

- **Custody.** The execution wallet's key lives in a sealed vault on the host and is opened into memory only, with a second factor. The engine boots sealed; nothing executes until the owner unseals it.
- **Gates.** Every intent passes safety, supply, liquidity, manipulation, quote, risk and execution gates; a reject carries a reason code. Rules run in shadow, then suggest (the owner approves each intent), then auto, and only after the evaluator's numbers earn it.
- **Caps in code.** Per transaction, per day and an operating balance; a kill-switch file the engine reads every second; a self-halt on stale sources, slot lag, a lost database or a lost primary RPC.
- **No secret in the repository.** CI scans the tree and the history.
