# Threat model

Short on purpose (ROADMAP Phase 2, moved up from Phase 5): what we protect, who can hurt it, where they can reach, what stands in the way, and what we accept. Revisited after the first incident and at every custody change (ADR-0003).

## 1. What we protect

| Asset                           | Where it lives                                                  | If lost                                                       |
| ------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------- |
| The execution key               | sealed vault file on the host; bytes in engine memory when open | the execution wallet is drained, capped at 15 SOL (ADR-0003)  |
| The vault passphrase            | the owner's head and password manager only                      | with the vault file, the key                                  |
| The TOTP secret                 | `.env` on the host and the authenticator app                    | with the passphrase, unseal and halt-clear                    |
| `DASHBOARD_TOKEN`               | `.env`, Caddy, the phone's and laptop's browser storage         | read everything, approve intents, halt; not unseal, not clear |
| The RPC key, the Telegram token | `.env`                                                          | quota abuse; messages to the owner's chat as the bot          |
| The database                    | the `db` volume, nightly dumps in `backups`                     | decision memory (ADR-0004 level 1); positions and fills       |
| The host                        | Vultr `wick`, SSH over Tailscale only                           | everything above                                              |

The main wallet is not an asset here: no service touches it, ever.

## 2. Who

- **Anyone on the internet.** Sees one UDP port (Tailscale). No HTTP, no SSH.
- **Anyone on the tailnet.** Today that is the owner's devices only. Sees Caddy on port 80 and, with the bearer token, the API.
- **Providers we call.** The RPC, pump.fun, DexScreener, Jupiter, Telegram. They see our reads and our transactions; a hostile or broken answer is data, never code.
- **The supply chain.** npm packages and Docker images.
- **A token's creator.** Malicious mints, pools and holders are the daily input; they reach the gates, never the signer.
- **The owner's mistake.** A wrong `.env`, a rule left in auto, a phone left unlocked.

## 3. Where they can reach, and what stands there

| Surface                  | Control in place                                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public network           | provider firewall and `ufw` drop everything but UDP 41641; SSH only on `tailscale0`; root and password login off                                                           |
| Tailnet HTTP (Caddy :80) | bearer token on `/api`, `/ws`, `/metrics`, `/prometheus`; `/healthz` open by design (no secret in it); Grafana has its own password                                        |
| Unseal and halt-clear    | passphrase and TOTP; five failures lock the vault a minute; the passphrase never persists in the console                                                                   |
| Signing                  | the key exists only inside the engine process while unsealed; every send passes the gates, a simulation, and the wallet caps in code (per transaction, per day, operating) |
| Stopping                 | the kill-switch file, `/halt` from Telegram, the console's halt: none needs a factor; the vault seals on every restart                                                     |
| Telegram                 | long polling (no inbound endpoint); only the owner's chat id is answered; the bot cannot approve, unseal or clear                                                          |
| Providers' answers       | typed parsing, numbers without a source become null (ADR-0001), abort signals and query timeouts on every call, the tick watchdog                                          |
| Supply chain             | `npm ci` from the lockfile, `npm audit` at high, Dependabot, pinned image tags, secret scanning in CI (gitleaks)                                                           |
| Secrets at rest          | `.env` mode 600, never committed (`.gitignore`, gitleaks), the vault file encrypted (PBKDF2, AES-GCM), backups hold no keys                                                |
| Logs and metrics         | no token address, wallet or signature in a metric label; a wallet appears in logs only under `data`; no secret is ever logged                                              |

## 4. What we accept, and until when

- **The bearer token in browser storage.** A stolen unlocked phone can read and approve until the token is rotated (`DASHBOARD_TOKEN` in `.env`, restart `engine` and `caddy`). Passkeys replace it in Phase 5.
- **Plain HTTP inside the tailnet.** WireGuard encrypts it; a device on the tailnet is trusted. TLS on the tailnet name arrives with passkeys.
- **One host.** A dead host is a stopped engine, not a lost key: the vault is sealed on disk and backed up nowhere else on purpose; the owner keeps the passphrase and can recreate the wallet's contents from the chain.
- **The key in process memory while unsealed.** Root on the host reads it. Root is the owner over Tailscale SSH; a KMS or a separate signer is the tier-3 precondition (ADR-0005).
- **`/halt` from Telegram without a factor.** Stopping is always allowed; the worst a stolen token does is stop trading and read the status.
- **A free RPC tier.** Rate limits degrade freshness, never safety: stale sources self-halt entries.

## 5. When something happens

1. **Stop:** `touch /var/lib/wick/KILL` over SSH, or `/halt` on Telegram, or the console. Entries stop within a second; exits keep running.
2. **Seal:** `POST /api/vault/seal` or restart `engine`. The key leaves memory.
3. **Rotate what was exposed:** `DASHBOARD_TOKEN`, the Telegram token (BotFather), the RPC key (provider), and if the vault file or passphrase may have leaked, `vault:init` a new key and move the funds by hand.
4. **Look:** `events` and `halts` say what the API did and when; the logs say what the engine did; the chain says what the wallet did.
5. **Write it down:** the incident and the change it forces go into `docs/STATE.md` and, if a decision changed, an ADR.
