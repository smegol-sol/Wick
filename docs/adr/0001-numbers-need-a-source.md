# ADR-0001: Every number has a source or renders n/a

- Status: accepted (September 2026)
- Context: the original WICK generated holders, volume, transaction counts and bundle ratios from hash functions and showed them as real numbers next to real money.
- Decision: every field in the `Token` model either comes from a documented source (pump.fun, DexScreener, RPC, Jupiter) or is `null` and renders n/a. Any filter or rule on a `null` field rejects the token instead of passing it. Analysis cards (fraud, mood, setups) state how many of their checks had data.
- Consequences: longer lists of n/a in a token's first minutes, and a UI that can be trusted. Every new source enters with a row in the README sources table and a test that proves the `null` behaviour.
