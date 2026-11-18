# Porting a reference module to NestJS

Reference: `.ref/server/modules/<name>.*` (git tag `backend-in-next-final`). The reference route tables are the
**real API surface** (≈744 routes) the frontend uses. Port every route; the frontend dummy handlers in
`web/src/mocks/handlers-*.ts` show which fields the UI reads.

## Files per module (`server/src/modules/<name>/`)

| Old                                 | New                                                                                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `<name>.routes.ts` (route table)    | `<name>.controller.ts` (one or more controllers) + `<name>.dto.ts` (Zod schemas moved verbatim)                                    |
| `<name>.service.ts` (+ split files) | `<name>.service.ts` — `@Injectable()` class; keep the logic, drop globals                                                          |
| `<name>.rules.ts`                   | `server/src/domain/<name>/…` if the frontend also needs it, else stays in the module                                             |
| `<name>.jobs.ts`                    | `<name>.jobs.ts` — provider with `@Job("x")` / `@Cron("x", "*/5 * * * *")` methods; listed in the module and in `worker.module.ts` |
| `<name>.seed.ts`                    | `server/src/db/seed/<name>.ts` exporting `seed<Name>(db)`                                                                        |
| —                                   | `<name>.module.ts`                                                                                                                 |

## Route mapping

```ts
// old
route("POST", "/api/admin/services/:id/publish", { auth: SM, permission: "cat.publish", idempotent: true, audit: "service.publish", body: PublishIn, out: ServiceOut,
  handler: (ctx, { id }, body) => svc.publish(ctx.db, ctx.session!, id, body) })
// new
@Post("admin/services/:id/publish")          // global prefix "api" is already applied
@Route({ auth: SM, permission: "cat.publish", idempotent: true, audit: "service.publish", out: ServiceOut })
publish(@Param("id") id: string, @Body() body: PublishDto, @CurrentUser() me: SessionUser) { return this.svc.publish(id, body, me); }
```

- `body: X` → `class XDto extends dto(X) {}` (`dto` from `core/http/dto`; never `createZodDto` directly — nestjs-zod 4.3 is typed for zod 3, `dto()` types the instance as `z.infer<X>`; no merged interfaces) and `@Body() b: XDto`; `query` → `@Query() q: XQueryDto`.
- `auth: "user"` → `@Route({ auth: "user" })`; `"public"` → `{ auth: "public" }`; roles array → `{ auth: ROLES }`.
- `stepUp/rateLimit/idempotent/ifMatch/out/audit/emit/status` → same names in `@Route` (`rateLimit` → `limit`).
- `ctx.ifMatch` → `@IfMatch() v: string | null`. `ctx.session` → `@CurrentUser()`. `ctx.ip/requestId` → inject `ClsService` (`RequestContext`).
- `ctx.resHeaders` Set-Cookie → `@Res({ passthrough: true }) reply: FastifyReply` + `CookieService`.
- Files/streams → `@RawResponse()` and return a stream / redirect to a presigned URL.

## Service mapping

| Old global                          | New (inject)                                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.db` / `db` / `Exec`            | `TxService.run(tx => …)` for writes (RLS context set); `@Inject(DB) db` for plain reads of non-RLS tables                                                     |
| `err.notFound()` etc.               | `AppError(status, type, msg, fields?, data?)` / `notFound()` … from `core/http/errors` (`data` → envelope `data`)                                                                                                           |
| `appendAudit`                       | `AuditService.record(tx, …)` — last statement in the tx                                                                                                       |
| `publish(type, e)`                  | `OutboxService.add(tx, { type, payload: { …, realtime: { userId } } })`                                                                                       |
| `enqueue(name, data)` / `queueMail` | `OutboxService.add(tx, …)` (preferred, transactional) or `QueueService.add`                                                                                   |
| `sendMail`                          | `MailService.send` (only from jobs)                                                                                                                           |
| `presignPut/Get`                    | `StorageService`                                                                                                                                              |
| `encrypt/decrypt/blindIndex`        | `CryptoService` (secrets in outbox payloads: `crypto.seal(payload, ["code"])` before `OutboxService.add`, `unseal` in the job)                                                                                                                                               |
| `page/decodeCursor/PageQuery`       | `core/db/pagination`                                                                                                                                          |
| `assertVersion`                     | `versioned()` in `core/db/db`                                                                                                                                 |
| `env.X`                             | `ConfigService<Env, true>.get("X", { infer: true })` (add new keys to `core/config/env.ts` — tell the Conductor)                                              |
| `@/lib/...` imports                 | `@/domain/...` (only pure files moved there); anything else the module needs from web lib → copy into the module or move to domain (tell the Conductor) |
| `@/mocks/...` world data in seeds   | copy the data into the seed file                                                                                                                              |

## Rules

- RLS tables (applications, client_documents, payments, conversation_participants, notifications): owners pass via `app.user_id`; cross-owner reads a public/claim flow needs go through a SECURITY DEFINER SQL function (migration 0005: `public_service_volume`, `guest_application`, `claim_application`), never `runAsSystem` in HTTP.
- Mutating routes are blocked under a view-as token (`act` claim) unless marked `@ImpersonationOk()`.

- Thin controllers; logic in services; no duplicated helpers across modules — if two modules need it, it belongs in `core/` or `server/src/domain` (ask the Conductor).
- No `any`, no `as unknown as` except where Drizzle typing truly needs it (comment why).
- Keep every Zod `out` schema: it is the field-level security filter.
- Don't run tests/lint/servers. Verify with `cd server && npx tsc --noEmit` (fix errors in your files only).
- Register your module in `app.module.ts` / `worker.module.ts` by adding exactly one import line + array entry each (re-read the file right before editing; others edit it too).
- Report ≤ 15 lines: routes ported (count vs reference), files, anything skipped and why, interface notes.
