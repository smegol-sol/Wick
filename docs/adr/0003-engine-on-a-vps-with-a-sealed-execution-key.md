# ADR-0003: The engine runs on one VPS with a sealed execution key unsealed by hand

- Status: accepted (September 2026)
- Context: an engine that runs 24 hours a day, records and evaluates its decisions, and signs on the owner's behalf. Starting capital is 2,500 USD, so infrastructure must stay a small fraction of it and any extra cloud complexity is unjustified.
- Alternatives rejected:
  - Cloud KMS: the sounder security design, but it adds a cloud account, IAM, cost and complexity that this amount does not justify. Revisited when capital exceeds 25,000 USD (ADR-0005 makes it a tier-3 precondition).
  - Serverless: no place for a permanent worker, a distributed lock or an open WebSocket.
  - The browser: stops when the tab closes.
- Decision:
  - One VPS (Hetzner CPX31 or equivalent, about 15 EUR a month) in Europe, Docker Compose running `engine` (Node 22), Postgres with TimescaleDB, Redis, Prometheus and Grafana. A daily database backup to external storage.
  - **A separate execution wallet** with a funding cap of 15 SOL at first, filled by hand from the main wallet. No service ever touches the main wallet.
  - The execution key is sealed in the same format as the WICK vault (`hot-wallet.ts`) and kept on disk. When `engine` boots the key is locked and trading is halted until the operator enters the passphrase from the control panel over an authenticated connection. An unattended restart means a safe stop, not blind trading.
  - The kill switch is a file on disk the engine checks every second, read by a path independent of the engine's own health, and set over SSH or a signed Telegram command. Money stops in the engine, not in a notification.
  - Wallet-level caps live in code: per transaction, per day, and a maximum operating balance; none can be raised from the control panel, only by a redeploy.
- Consequences: one point of failure (the host), acceptable at this size. Security is host security: SSH keys only, a firewall, automatic updates, no public ports except the control panel behind authentication (ADR-0009 later removes even that: the panel lives on the tailnet). Revisited when capital grows or after the first incident.
