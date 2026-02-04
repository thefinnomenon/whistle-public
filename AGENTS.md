# AGENTS.md

Project guidance for coding agents.

## Core workflow

- Read existing code and follow local patterns before changing behavior.
- Make minimal, scoped changes; avoid refactors unless requested.
- Prefer `rg` for search and avoid heavy tooling when not needed.
- Run `tsc` and linting after code changes unless explicitly told not to.

## Type safety (required)

- No `any` or `unknown` in new or edited code.
- Keep types in sync with data model changes.
  - If you add a new field to stored data, update shared types.
  - Update both app and admin types when fields are shared.
- Prefer explicit types and small helper type guards over casting.
- Prefer strict typing with explicit errors when required data is missing.

## Questions and state

- Do not change question lifecycles without updating resolver + types + UI.
- If behavior changes in sim, mirror it in live logic (and vice versa).

## Logging and diagnostics

- Keep logs structured and grep-friendly (`[tag] key=value ...`).
- When skipping actions, log the reason and relevant timing.

## UI changes

- Preserve existing visual language unless asked to redesign.
- Keep button text, icons, and spacing consistent with nearby UI.

## Safety

- Never use destructive git commands.
- Do not revert user changes unless explicitly asked.
