# Operations: the engine host

How the engine runs on one VPS (ADR-0003), how it is watched (ADR-0009), and how the owner reaches it. English, like the rest of the engine documents.

## 1. What runs where

`apps/engine/deploy/docker-compose.yml` starts, on one host:

| Service           | Role                                                             | Reachable from       |
| ----------------- | ---------------------------------------------------------------- | -------------------- |
| engine            | ingest, health, metrics; later decision and executor             | caddy only           |
| db                | Postgres 16 + TimescaleDB, the source of truth                   | compose network      |
| redis             | immediate hand-off only, no persistence                          | compose network      |
| prometheus        | scrapes engine and exporters, 30-day retention                   | caddy (token)        |
| alertmanager      | routes alerts to Telegram                                        | compose network      |
| grafana           | Operations, Quality, Host boards                                 | caddy at `/grafana/` |
| node-exporter     | CPU, memory, disk, network                                       | prometheus           |
| postgres-exporter | connections, size, activity                                      | prometheus           |
| redis-exporter    | redis health                                                     | prometheus           |
| caddy             | reverse proxy bound to the Tailscale IP only; serves the console | your tailnet devices |
| backup            | nightly `pg_dump`, 14 days kept, pings a check                   | none                 |

Nothing listens on a public interface. The only public port on the host is SSH, key-only.

## 2. First-time setup

1. **VPS.** Hetzner CPX31 or equivalent (4 vCPU, 8 GB, 160 GB). Debian 12. Create a non-root user with sudo, SSH keys only, `ufw` allowing 22 only, unattended upgrades on.
2. **Docker.** Install Docker Engine and the compose plugin from Docker's repository.
3. **Tailscale.** Install Tailscale on the VPS, your phone and your laptop, and log them into the same tailnet. Note the VPS's address (`tailscale ip -4`) and MagicDNS name. Turn on MagicDNS in the admin console. Optionally enable Tailscale SSH and close port 22 to the public entirely.
4. **Checkout.** Clone the repository to `/opt/wick` and `cd apps/engine/deploy`.
5. **Secrets.** `cp .env.example .env`, fill every value. `POSTGRES_PASSWORD`, `GRAFANA_PASSWORD` and `DASHBOARD_TOKEN` from `openssl rand -hex 32`. `TAILSCALE_IP` from step 3. The Telegram bot token from BotFather; the chat id from `https://api.telegram.org/bot<token>/getUpdates` after messaging the bot once.
6. **Dead-man checks.** Create two checks on healthchecks.io (free tier): `engine` with a 2-minute period and `backup` with a 26-hour period. Paste their ping URLs into `HEALTHCHECK_URL` and `HEALTHCHECK_BACKUP_URL`. Point their notifications at the same Telegram chat.
7. **Risk file.** Review `apps/engine/config/risk.yaml`. The engine refuses to start if the tier and the wallet cap disagree with ADR-0005.
8. **Console.** From the repository root, `npm ci && npm run build -w @wick/console`; Caddy serves `apps/console/dist`. Rebuild after every `git pull` that touches the console.
9. **Start.** `docker compose up -d --build`. The engine applies migrations on boot. `docker compose logs -f engine` should show `listening` and then `snapshots` counters moving on `http://<tailscale-ip>/metrics` (send `Authorization: Bearer <DASHBOARD_TOKEN>`).
10. **Prove the alerts.** Stop the engine for two minutes (`docker compose stop engine`) and confirm `EngineDown` arrives on Telegram and the healthchecks.io check goes red, then start it again. Phase 1's exit condition requires one test alert per rule to have reached the phone.

## 3. Day to day

- **Console:** `http://<tailscale-name>/` on the phone and laptop; install it from the browser menu. Paste `DASHBOARD_TOKEN` once under Engine → Operations. Mock mode there shows example data only, never mixed with live.
- **Boards:** `http://<tailscale-name>/grafana/` → WICK folder. Operations answers "is it alive?", Host answers "is the box healthy?". Quality lands with the decision layer.
- **Health:** `http://<tailscale-name>/healthz` returns the same object the risk gate reads: source ages, slot lag, database, and the reasons for a self-halt if any.
- **Logs:** JSON lines. `docker compose logs --since 1h engine | jq`. A token address or wallet appears only under `data`, never in `msg`.
- **Migrations:** applied on boot; to run by hand, `docker compose run --rm engine node --experimental-strip-types src/db/migrate.ts`.
- **Upgrade:** `git pull && docker compose up -d --build engine`. The engine starts halted-on-unseal in Phase 2 and later; in Phase 1 there is nothing to unseal.

## 4. Alerts and what to do

| Alert                       | First action                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------- |
| EngineDown                  | `docker compose ps`, `logs engine`; if the box is dead, healthchecks.io also fired     |
| SourceStale pump.fun        | pump.fun blocks datacenter IPs at times; check from the laptop; nothing to fix in code |
| SourceStale rpc             | RPC provider status page; the fallback endpoints are public and slow                   |
| SlotLag                     | primary RPC is behind; the engine self-halts entries above 20 slots                    |
| DecisionSlow / EventLoopLag | look at ingest cycle p99; too many active tokens or a slow database                    |
| DbErrors                    | `logs engine` shows the failing statement; disk full is the usual cause                |
| DiskFull / DiskWillFill     | check retention policies ran (`SELECT * FROM timescaledb_information.jobs`)            |
| PostgresDown                | `docker compose logs db`                                                               |
| backup check red            | `docker compose logs backup`; the dump failed or the volume is full                    |

## 5. Backups and restore

Dumps land in the `backups` volume as `wick-<timestamp>.dump`, custom format, 14 kept. Copy them off the host from your laptop over the tailnet (`docker compose cp backup:/backups ./`), or add an rclone job to object storage. Restore drill, quarterly:

```sh
docker compose exec db createdb -U wick wick_restore
docker compose exec db pg_restore -U wick -d wick_restore /backups/wick-<timestamp>.dump
docker compose exec db psql -U wick -d wick_restore -c "select count(*) from token_snapshots"
```

## 6. Failure drills (Phase 5 rehearses these; Phase 1 documents them)

- **RPC cut:** block the RPC host in `ufw`; expect SourceStale rpc, slot lag null, self-halt reasons on `/healthz`, no crash.
- **Postgres stopped:** `docker compose stop db`; expect DbErrors, `dbOk=false` on `/healthz`, engine keeps polling and resumes writes when the database returns.
- **Unattended restart:** `reboot`; expect every service back through `restart: unless-stopped`, migrations no-op, and (from Phase 2) the vault sealed with trading halted until the owner unseals it.
