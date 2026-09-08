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

1. **VPS.** The engine runs on Vultr `vhp-4c-8gb` (4 vCPU, 8 GB, 180 GB NVMe, Amsterdam, 48 USD a month; ordered 2026-09-08), which meets the ADR-0003 floor (4 vCPU, 8 GB, 160 GB); any equivalent works. Pick the region closest to the RPC provider (Frankfurt or Amsterdam for a European RPC, New Jersey for a US one). Debian 12, provider backups off (the nightly dump in section 5 is the backup). Create a non-root user with sudo, SSH keys only, root login and password login off in `sshd_config.d`, `ufw` allowing 22 only, unattended upgrades on, `systemd-timesyncd` enabled (the Vultr image ships with the clock unsynchronized; section 6).
2. **Docker.** Install Docker Engine and the compose plugin from Docker's repository.
3. **Tailscale.** Install Tailscale on the VPS (`tailscale up --ssh`), your phone and your laptop, and log them into the same tailnet. Note the VPS's address (`tailscale ip -4`) and MagicDNS name. Turn on MagicDNS in the admin console. Then close SSH to the public entirely: `ufw allow in on tailscale0 to any port 22 proto tcp`, `ufw allow 41641/udp` (direct paths instead of relays), `ufw delete allow 22/tcp`, and in the provider's firewall replace the SSH rule with UDP 41641. Verify from the laptop that the public address times out and the tailnet address answers before closing the session you came in on.
4. **Checkout.** A read-only deploy key generated on the host (`ssh-keygen -t ed25519 -f ~/.ssh/github_deploy`, its public half under the repository's Deploy keys, write access off), then clone to `/opt/wick` and `cd apps/engine/deploy`.
5. **Secrets.** `cp .env.example .env`, fill every value. `HOLDER_READS_PER_HOUR` and `WALLET_READS_PER_HOUR` cap the supply writer's RPC use (defaults 120 and 300 fit a free tier; raise them with a paid plan). `EQUITY_SOL` is what the execution wallet holds (empty means the wallet cap from `risk.yaml` is assumed for sizing); `WICK_COMMIT` is `git rev-parse --short HEAD` of what is deployed, stamped on every intent. `POSTGRES_PASSWORD`, `GRAFANA_PASSWORD` and `DASHBOARD_TOKEN` from `openssl rand -hex 32`. `TAILSCALE_IP` from step 3. The Telegram bot token from BotFather; the chat id from `https://api.telegram.org/bot<token>/getUpdates` after messaging the bot once.
6. **Dead-man checks.** Create two checks on healthchecks.io (free tier): `engine` with a 2-minute period and `backup` with a 26-hour period. Paste their ping URLs into `HEALTHCHECK_URL` and `HEALTHCHECK_BACKUP_URL`. Point their notifications at the same Telegram chat.
7. **Risk file.** Review `apps/engine/config/risk.yaml`. The engine refuses to start if the tier and the wallet cap disagree with ADR-0005.
   7a. **Vault and second factor.** On the host, `docker compose build engine`, `docker compose up -d db redis`, once `docker compose run --rm -u root engine chown wick:wick /var/lib/wick` (a fresh named volume belongs to root, the engine runs as `wick`), then `docker compose run --rm engine npm run vault:init -- /var/lib/wick/vault.json --totp`. It asks for a passphrase twice, writes the sealed key, prints the execution wallet address and a `TOTP_SECRET` with its `otpauth://` URI. Put the secret in `.env`, scan the URI in an authenticator app, and fund the printed address by hand up to the tier cap. The key never leaves the container; the passphrase is typed only at unseal.
8. **Console.** No Node on the host; build inside a throwaway container from the repository root: `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v /opt/wick:/repo -w /repo node:22-bookworm sh -c "npm ci && npm run build -w @wick/console"`. Caddy serves `apps/console/dist`. Rebuild after every `git pull` that touches the console.
9. **Start.** `docker compose up -d --build`. The engine applies migrations on boot. `docker compose logs -f engine` should show `listening` and then `snapshots` counters moving on `http://<tailscale-ip>/metrics` (send `Authorization: Bearer <DASHBOARD_TOKEN>`).
10. **Prove the alerts.** Stop the engine for two minutes (`docker compose stop engine`) and confirm `EngineDown` arrives on Telegram and the healthchecks.io check goes red, then start it again. Phase 1's exit condition requires one test alert per rule to have reached the phone.

## 3. Day to day

- **Console:** `http://<tailscale-name>/` on the phone and laptop; install it from the browser menu. Paste `DASHBOARD_TOKEN` once under Engine → Operations. Mock mode there shows example data only, never mixed with live.
- **Boards:** `http://<tailscale-name>/grafana/` → WICK folder. Operations answers "is it alive?", Host answers "is the box healthy?". Quality lands with the decision layer.
- **Health:** `http://<tailscale-name>/healthz` returns the same object the risk gate reads: source ages, slot lag, database, and the reasons for a self-halt if any.
- **Logs:** JSON lines. `docker compose logs --since 1h engine | jq`. A token address or wallet appears only under `data`, never in `msg`.
- **Migrations:** applied on boot; to run by hand, `docker compose run --rm engine node --experimental-strip-types src/db/migrate.ts`.
- **Upgrade:** `git pull && docker compose up -d --build engine`. The engine boots sealed: the decision layer runs and writes intents, but nothing executes until the vault is unsealed.
- **Unseal:** Engine → Operations on the console: passphrase and the six-digit code, then Unseal; or `POST /api/vault/unseal` with `{"passphrase": "...", "code": "<TOTP>"}` and the bearer token. `POST /api/vault/seal` locks it again with no factor, since stopping is always allowed. Five wrong attempts lock the vault for a minute.
- **Telegram bot:** the same bot Alertmanager uses, long-polling from the engine (no public endpoint). From the owner's chat only: `/status` (equity, P&L, positions, health, regime, halts, rules) and `/halt [reason]` (immediate, no second factor; clear it from the console). Any other chat is ignored and counted in `wick_telegram_messages_total{outcome="ignored"}`. The daily report arrives at `TELEGRAM_REPORT_HOUR_UTC` (default 00:00 UTC) with yesterday's intents, outcomes, executions, realized P&L, regime minutes, halts and rule stats. Pushes: a suggest-mode intent waiting for approval, an execution or failure, a halt or its clearing, a self-halt and its clearing, the kill switch, vault seal and unseal, a rule disabled or its weight moved.
- **Kill switch:** `touch /var/lib/wick/KILL` on the host (`docker compose exec engine touch /var/lib/wick/KILL` works too; the file's content is the reason shown). The engine sees it within a second, halts entries and keeps exits running. Remove the file to clear; that is the only way.
- **Replay** (ADR-0007): `docker compose run --rm engine npm run replay -- --from 2026-09-08T00:00:00Z --to 2026-09-08T12:00:00Z [--equity 15] [--rules config/rules.yaml]` runs the production rules and gates over the stored rows of that window with the conservative fill model and prints the run id and summary; the Engine screen lists the run under Replay runs. Replay rows carry `replay_run_id` and never appear in a live number. Version 1 scores entries at the 30-minute horizon and does not simulate the exit policy; the run's `exec_model` says so.
- **Re-enable a rule the evaluator disabled:** `POST /api/rules/<id>/enable` with `{"code": "<TOTP>"}` and the bearer token; the rule comes back at weight 0.25 and the reason is written to `rule_stats`. The Engine screen shows the rule as `off` with the reason until then.
- **Clear a halt:** the code alone and Clear halt on the same panel, or `POST /api/halt/clear` with `{"code": "<TOTP>"}`; clears manual and P&L halts. A health self-halt clears itself when the reason goes; a kill-switch halt clears when the file goes.

## 4. Alerts and what to do

| Alert                       | First action                                                                                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EngineDown                  | `docker compose ps`, `logs engine`; if the box is dead, healthchecks.io also fired                                                                                                        |
| IngestStalled               | the collector's tick did not run to the end; `logs engine \| grep stalled` names the phase; the watchdog abandons it and the next tick runs, so a repeat means the phase itself is broken |
| IngestSlow                  | the median tick is over 3 s against a 1 s budget; `wick_ingest_phase_duration_seconds` on the Operations board says which phase                                                           |
| SelfHalt                    | entries are halted on health; `/healthz` lists the reasons, the log has `self-halt` and `self-halt cleared` lines                                                                         |
| SourceStale pump.fun        | pump.fun blocks datacenter IPs at times; check from the laptop; nothing to fix in code                                                                                                    |
| SourceStale rpc             | RPC provider status page; the fallback endpoints are public and slow                                                                                                                      |
| SlotLag                     | primary RPC is behind; the engine self-halts entries above 20 slots                                                                                                                       |
| DecisionSlow / EventLoopLag | look at ingest cycle p99; too many active tokens or a slow database                                                                                                                       |
| DbErrors                    | `logs engine` shows the failing statement; disk full is the usual cause                                                                                                                   |
| DiskFull / DiskWillFill     | check retention policies ran (`SELECT * FROM timescaledb_information.jobs`)                                                                                                               |
| PostgresDown                | `docker compose logs db`                                                                                                                                                                  |
| backup check red            | `docker compose logs backup`; the dump failed or the volume is full                                                                                                                       |

## 5. Backups and restore

Dumps land in the `backups` volume as `wick-<timestamp>.dump`, custom format, 14 kept. A copy that lives only on the host dies with the host, so an off-host copy is part of the setup, not an option: an rclone job to object storage with client-side encryption (`rclone crypt`), or at minimum a nightly `docker compose cp backup:/backups ./` from the laptop over the tailnet into an encrypted volume.

Targets: RPO 24 hours (one nightly dump; the 1-second snapshots lost in between are re-collectable, intents and executions are not, so the executor's rows are also written to the `events` stream), RTO 2 hours from a bare host to a running engine following section 2. A restore drill that misses either number is a failed drill.

Restore drill, quarterly:

```sh
docker compose exec db createdb -U wick wick_restore
docker compose exec db pg_restore -U wick -d wick_restore /backups/wick-<timestamp>.dump
docker compose exec db psql -U wick -d wick_restore -c "select count(*) from token_snapshots"
```

## 6. Time

Everything time-based (copy gap, blockhash expiry, the 5/30/120-minute outcomes, slot lag) trusts the host clock. `timedatectl` must show `System clock synchronized: yes` (the Vultr Debian image boots with it off; step 1 of section 2 enables it); the Host board shows node_exporter's `node_timex_offset_seconds`, and an offset over 100 ms is an alert.

## 7. Failure drills (run in Phase 2 before the first real SOL, then after every custody change)

`apps/engine/deploy/drill.sh` runs each drill, checks the expectation and restores; run it on the host with the stack up and the vault sealed, and paste its PASS/FAIL lines into `docs/STATE.md`.

- **RPC cut** (`./drill.sh rpc-cut`): the RPC host is blocked in `ufw` for 90 s; expect a self-halt on `source rpc stale`, the engine still up, and the halt cleared within a minute of the block lifting.
- **Postgres stopped** (`./drill.sh db-stop`): `docker compose stop db` for 60 s; expect `dbOk=false` and a self-halt on `/healthz`, DbErrors counted, and `dbOk=true` with `self-halt cleared` in the log once it is back.
- **Unattended restart** (`./drill.sh restart`, then `./drill.sh restart-check` after logging back in): `reboot`; expect every service back through `restart: unless-stopped`, migrations a no-op, and the vault sealed with entries halted until the owner unseals it.

Each drill ends in a safe stop: entries halt, exits keep running, nothing signs.
