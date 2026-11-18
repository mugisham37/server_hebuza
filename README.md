# HEBUZA server

NestJS API (`src/main.ts`) and worker (`src/worker.ts`): one codebase, one image, two processes.

```bash
pnpm install
cp .env.example .env          # then fill in
pnpm db:migrate && pnpm db:seed   # dev only; pnpm db:reset = drop + migrate + seed
pnpm dev                      # api :4000 + worker
```

- `src/domain` business rules (the authority), `src/db/{schema,migrations,seed}` Drizzle, `@/*` → `src/*`.
- `pnpm build` also writes `openapi.json` (served at `GET /api/openapi.json`); commit it.
- Checks: `pnpm typecheck && pnpm lint && pnpm test`. Authz/abuse/load probes: `npx tsx test/authz/matrix.ts` (set `API_URL`).
- Docker: `docker build -t hebuza-api .`; same image runs `node dist/main.js` (api), `node dist/worker.js` (worker),
  `node dist/migrate.js` (migrations, exits), `node dist/admin-create.js` (first sysadmin). Deploy: `../docs/DEPLOY.md`.
