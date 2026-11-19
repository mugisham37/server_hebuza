# Build brief (shared by every build agent)

Goal: close spec gaps end to end, at production quality. Spec: `/home/moses/Desktop/cleanup/Project/spec` (05-modules, 04-journeys, 06-cross-cutting). Gap lists with evidence: `server/docs/audit/{A,B,C,D}.md`.

## Repos

- `/home/moses/Desktop/systeme/server`: NestJS 11 + Fastify, Drizzle (Postgres 16), BullMQ. Routes use the `@Route` decorator (authz, audit, rate limits). Domain rules in `src/domain`. Schema in `src/db/schema`.
- `/home/moses/Desktop/systeme/web`: Next.js 16 (app router, `[locale]` rw/en/fr), atoms → molecules → organisms (`scripts/check-layers.mjs`, `scripts/check-design.mjs`). API types: `pnpm api:types:file` after `cd ../server && pnpm openapi` (or the existing script).
- Never read `.env*` files. Never print secrets.

## Rules

1. **Read before you write.** Follow the surrounding code's patterns: same decorators, services, query hooks, atoms, i18n dictionaries. Reuse; don't add dependencies.
2. **Real data only.** No seed JSON, fixtures or dummy stores feeding a screen. If a screen reads a fake store, connect it to the API.
3. **Every feature is full stack:** schema → domain rule (unit test) → route (authz, audit, validation, typed out-schema) → job/notification if the spec says so → web screen with loading/empty/error/forbidden states, responsive at 360 px, rw/en/fr strings, accessible (labels, focus, keyboard).
4. **Schema changes:** edit `src/db/schema/*` only. Do NOT run `db:generate` (the integrator writes one migration per wave). Locally, apply with `pnpm drizzle-kit push --force` against the dev DB if you need the columns to test.
5. **Checks before you finish (both repos you touched):** `pnpm typecheck`, `pnpm lint` (0 errors), `pnpm test`; web also `node scripts/check-layers.mjs && node scripts/check-design.mjs`. Fix what you broke.
6. **Commit only your own paths:** `git add <paths> && git commit -m "<F-IDs>: <what>"` in each repo; on `index.lock` wait and retry. Never `git add -A`, never push, never touch another agent's area.
7. **Mark shortcuts** with `// shortcut: <limit>, <when to upgrade>`.
8. Final reply: F-IDs closed, F-IDs left (why), schema changes made (tables/columns), files touched, checks run and their result.
