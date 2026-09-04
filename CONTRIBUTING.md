# Contributing

## Branches and merging

- `main` is protected: no direct pushes, one review, green CI, squash merge.
- Work on a branch named `feat/...`, `fix/...`, `chore/...` or `docs/...`.
- Open a PR early. The PR template asks whether the change touches the money path; answer it honestly.
- Every PR that moves the project forward updates `docs/STATE.md` (phase table, open items, session log).

Branch protection is a repository setting, not code. Settings → Branches → Add rule for `main`: require a pull request with 1 approval, require status checks `checks` and `build-and-smoke`, require linear history, block force pushes.

## Commits

Conventional Commits. `main` is squash-merged, so the PR title is what lands there; CI lints the PR title with commitlint, and `npx commitlint --edit` checks a local commit message:

```
feat(engine): add liquidity gate
fix(ticket): convert jupiter impact fraction to percent
chore(deps): bump vite
docs(adr): record custody decision
```

Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `ci`, `style`, `build`. A breaking change adds `!` after the type and a `BREAKING CHANGE:` footer.

## Local checks

```sh
npm run typecheck
npm run lint
npm run format:check   # or npm run format to fix
npm test
npm run build
```

All four of the first commands must pass before a PR is opened; CI runs the same set. They run from the repository root and cover every workspace (`packages/core`, `apps/desk`, `apps/engine`). Shared pure logic goes in `packages/core` and is imported as `@wick/core/<module>`; nothing in core may import a browser or React module. The engine's database test runs when `TEST_DATABASE_URL` points at a Postgres 16; CI runs it on TimescaleDB.

## Rules that do not bend

0. Everything in the repository is English: code, strings, documents. No second language in the UI.

1. A number without a source is `null` and renders n/a. Filters reject unknown, never pass it.
2. Nothing signs without passing every gate. Human approval does not skip a gate.
3. Money stops in the engine, never in a notification.
4. No file grows without a test; coverage does not go down.
5. An architectural decision is an ADR in `docs/adr/`, numbered, with status and consequences.

## Releases

Tags follow semver. `CHANGELOG.md` is generated from commit messages at release time.
