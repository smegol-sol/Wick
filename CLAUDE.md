# WICK

Read `docs/STATE.md` first in every session: it says which roadmap phase is current, what was decided, what is open, and how to verify the tree is green. Update it in the same change that moves the project forward.

Then, as needed: `docs/ROADMAP.md` (phases), `docs/ENGINE.md` (architecture), `docs/adr/` (decisions), `docs/OPS.md` (the host), `CONTRIBUTING.md` (rules and checks).

The whole platform is English: code, identifiers, strings, documents, the state ledger and the roadmap. No second language anywhere in the repository; the owner's chat is the only place Arabic is used.

Non-negotiable: a number without a source is `null` and renders n/a; nothing signs without passing every gate; no model identifiers in committed files.

Merging is the assistant's job, but never without permission: ask the owner before every merge to `main`, and treat each permission as valid for that one merge only. Opening a pull request needs no further permission (standing permission from the owner, 2026-09-04). This rule is permanent.
