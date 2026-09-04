# ADR-0010: The console: two screens and a detail, on the engine's API

- Status: accepted (September 2026)

## Context

The desk (`apps/desk`) was built for a browser that does everything: polls sources every few seconds, computes the sieve, lab and sentiment locally, and signs. With the engine, all of that moves to the server, and what the owner needs is a read-and-approve client (ADR-0009). The desk's TanStack Start + Nitro server layer, its 60 KB store with a tick loop, and its browser-side auto-signing loop are weight the new job does not need.

A first proposal listed seven screens. The owner objected that seven equal tabs would be noise. They were right: those were features, not screens, and sorting them by topic instead of by how often they are used is what creates the noise.

## Decision

### 1. A new app, `apps/console`, replaces the desk as the control surface

- Vite + React 19 + TanStack Router in SPA mode, no SSR; Tailwind 4 with the desk's design tokens; TanStack Query for the API and a WebSocket for pushes; lightweight-charts for candles built from our own snapshots; installable as a PWA. Arabic and English, phone first, bundle target under 300 KB gzipped.
- Static files served by Caddy on the tailnet next to the engine's API. No Vercel, no API routes of its own, nothing that signs.
- Reused from the desk: design tokens, the token mark, number formatting, i18n keys where they still apply. Not reused: the store, browser polling, `live-auto`, the desk's API routes.
- The desk is frozen to bug fixes and retired at the end of Phase 2, once the console covers approve, halt and unseal. Two UIs are not maintained past that.

### 2. Screens are sorted by frequency of use: two screens and one detail

| Surface            | Used           | Holds                                                                                                                                                                                                                             |
| ------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Now** (home)     | hourly, phone  | The intents waiting for the owner, one card each: what, why, size, gates and adjustments, time left, approve and reject. Open positions below. One status strip above: equity, day P&L, regime multiplier, health and halt state. |
| **Token** (detail) | from a card    | Opened from an intent or a position, never from navigation: candles from our snapshots, supply map, top holders with their profiler class, the token's gate history.                                                              |
| **Engine**         | weekly, laptop | Sections on one page: rules with mode, weight and stats; the funnel and rejection distribution; replay runs; then vault, halt and tier at the bottom.                                                                             |

What the seven-screen list had that lives elsewhere: host health and operations stay in Grafana and Telegram (ADR-0009), with only the status strip in the console; funnel, regime and replay are sections, not screens; the desk's scan, lab and tape do not come back, because the engine now scans and the owner sees the result as intents.

### 3. Rule for adding a screen

A screen is added only for a question the owner asks daily that **Now** cannot answer. Anything else is a section on **Engine** or a row in Grafana.

### 4. The API contract lives in `packages/core/src/api.ts`

Both the engine and the console import the same types for every endpoint and WebSocket message (ADR-0009 §2 lists the routes). The console has a mock mode that generates example data from those types, plainly labelled as examples, so screens are built and tested before the decision layer produces real intents.

## Alternatives rejected

- **Rewriting the desk in place.** Rejected: its architecture (browser does everything) is the thing being replaced, and a rewrite inside it keeps the server layer and the store it does not need.
- **Seven tabs.** Rejected for the reason above.
- **Grafana as the whole control surface.** Rejected: approve, reject, halt and unseal are actions on the money path with their own audit trail, not dashboard panels.

## Consequences

- Phase 1 gains the API contract, the engine's read endpoints and the console scaffold on mock data; Phase 2 wires approve, reject, halt and unseal to the executor and retires the desk.
- ADR-0009 §4's "the WICK web app as an installed PWA" now means the console, not the desk.
