# ADR-0002: A browser hot wallet for the desk's manual ticket

- Status: accepted (September 2026); revisited when the engine goes live (ADR-0004)
- Context: the manual desk needs to sign without a server, and custody is the owner's.
- Decision: an ed25519 key is generated or imported in the browser, sealed with PBKDF2 (400,000 iterations) and AES-GCM bound to the public key, stored in localStorage, opened in memory only, and locked after 8 minutes idle or 45 seconds hidden. The signer refuses any transaction whose fee payer is not the wallet. The page loads no external script.
- Consequences: suitable for small amounts only, and the UI says so. The engine (ADR-0003) does not use this wallet; it has a separate execution wallet.
