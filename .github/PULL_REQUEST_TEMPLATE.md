## What

<!-- One paragraph. What changes and why. Link the issue. -->

## Money path

- [ ] This PR does not touch signing, sending, sizing or the risk gates
- [ ] …or it does, and the change is covered by a test that fails without it

## Data honesty

- [ ] No new number is shown without a source; unknown stays `null` and renders n/a
- [ ] README source table updated if a source was added or changed

## Checks

- [ ] `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test` pass locally
- [ ] Architecture decision? An ADR is added under `docs/adr/`
