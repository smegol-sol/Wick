# ADR-0009: Control plane and operations: a private PWA, a Telegram bot, and host monitoring

- Status: accepted (September 2026)

## Context

The owner asked three things: how server performance will be checked, how they will talk to the engine, and whether the control surface is a dashboard or an app.

The engine runs unattended on one VPS (ADR-0003) and signs with a sealed key. Whatever talks to it is part of the money path. The current WICK web app already renders real data, has Arabic and English, and ships a web manifest, so it installs on a phone as a progressive web app.

## Decision

### 1. Host and service monitoring is part of Phase 1, not an afterthought

- Exporters on the VPS: `node_exporter` (CPU, memory, disk, I/O, network), `postgres_exporter`, `redis_exporter`, plus the engine's own `/metrics` (ENGINE §15). Grafana has three boards: Operations (is it alive?), Quality (is it working?) and Host (is the box healthy?).
- Alertmanager routes to Telegram. Alert rules, all with a written threshold:

| Alert                   | Condition                                   |
| ----------------------- | ------------------------------------------- |
| engine down             | `wick_up == 0` for 60 s                     |
| source stale            | `wick_source_heartbeat_age_seconds > 30`    |
| slot lag                | `wick_slot_lag > 20`                        |
| decision slow           | p99 `wick_decision_duration_seconds > 0.05` |
| event loop lag          | > 100 ms for 30 s                           |
| disk                    | > 80% used, or < 7 days at current growth   |
| memory                  | > 85% for 5 min                             |
| backup failed           | last successful backup older than 26 h      |
| unconfirmed transaction | any `EXEC_UNCONFIRMED` in the last hour     |

- **Dead-man switch:** the engine pings an external uptime service (healthchecks.io or equivalent, free tier) every minute. If the whole VPS dies, the alert still arrives, because it comes from outside.
- **Self-halt on bad health:** the engine stops opening positions on its own when slot lag > 20, a source is stale > 30 s, or the decision p99 exceeds budget for 5 minutes. Health is a gate input, not only an alert.

### 2. The engine exposes one small API on the host; nothing else is public

HTTP plus WebSocket, served on localhost behind a reverse proxy:

```
GET  /api/state             equity, positions, halts, tier, health, source ages
GET  /api/intents?status=   intents with why, gate results, adjustments
POST /api/intents/:id/approve | /reject      suggest mode only
POST /api/halt              always allowed, no second factor
POST /api/halt/clear        second factor required
POST /api/vault/unseal      password; second factor required
GET  /api/funnel            per-layer counts for the last 24 h
GET  /api/rules             rules, modes, weights, stats
WS   /ws                    live intents, executions, alerts
```

Every mutating call is written to `events` with who, when and from where.

### 3. Reach it over a private network, not the public internet

- The VPS joins a Tailscale (WireGuard) tailnet with the owner's phone and laptop. The reverse proxy listens only on the tailnet address. No public port exists except SSH, and SSH is key-only.
- Inside the tailnet the dashboard still requires login: a passkey (WebAuthn) from Phase 5, a long random bearer token stored in the PWA until then. Halt-clear, unseal and tier changes require a second factor (TOTP).
- Why not a public HTTPS dashboard with a password: it is a 24/7 attack surface on the money path for the convenience of not installing Tailscale. Rejected.

### 4. The control surface is the WICK web app as an installed PWA, plus a Telegram bot. No native app in v1.

- **PWA:** the existing app becomes the read-and-approve client (ENGINE §17): intents with their reasons, approve/reject, funnel, rule stats, halt, unseal. Installed on the phone it behaves like an app, works over the tailnet, and needs no store review. Push notifications come from the bot, not from the browser.
- **Telegram bot:** alerts, the daily report, and two commands restricted to the owner's chat id: `/halt` (immediate, no second factor) and `/status`. The bot never approves, never unseals the vault and never clears a halt; those need the PWA and a second factor. (Amended 2026-09-04: `/approve <id> <totp>` was in the first version; it was removed for v1 because a command that stops money is worth exposing to a chat bot and a command that moves money is not. Revisited in Phase 5.)
- **Native app:** rejected for v1. It would cost weeks, need store review for a crypto trading app, and add a second client to secure, for nothing the PWA over Tailscale does not already give on the phone. Revisit only if the PWA proves inadequate in daily use.

## Consequences

- Phase 1 gains exporters, Alertmanager, the dead-man ping and Tailscale. Phase 2 gains the API, the PWA approve flow and the bot. Phase 5 replaces the bearer token with passkeys.
- The desk app gains a "server" mode next to its current local mode: it reads from the API instead of calling sources itself.
- One more component to keep alive (Alertmanager), covered by the dead-man switch.
