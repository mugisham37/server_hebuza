# HEBUZA API contract

The frontend (this repo) is backend-free. It talks only to `/api/*` over HTTP, as described in `openapi.json`.
Until the real backend exists, MSW dummy data in `src/mocks` answers every path.

## Files

| File              | Use                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `openapi.json`    | Source of truth for paths and shapes. `npm run api:types` regenerates `src/lib/api/schema.d.ts` from it. |
| `JOBS.md`         | Background jobs and crons the worker service must run.                                                   |
| `BACKEND-PLAN.md` | The original backend design: schemas, modules, security.                                                 |

The previous in-app implementation (Drizzle, pg-boss, Redis, S3) is kept in git under tag `backend-in-next-final`, in `src/server/`. Use it as the reference implementation.

## Wire rules the frontend relies on

- **Envelope.** Every JSON response is `{ success, message, errorType, data }`. `errorType` values drive the user-facing copy in `src/lib/api/error-copy.ts`: `validation`, `forbidden`, `rate_limited`, `step_up_required`, `unverified`, …
- **Validation errors.** A 422 carries `detail: [{ loc: ["body", field], msg }]`.
- **Status codes.** 401 means re-auth; 403 means forbidden; 404; 409 means a stale version or conflict; 422; 423 means locked; 429.
- **Auth.** Uses httpOnly cookies `hebuza_access` (a JWT whose payload carries `roles`; `src/proxy.ts` reads it for route guards) and `hebuza_refresh`.
  - On a 401, the client calls `GET /api/auth/session` once to refresh, then retries.
- **Request headers:**
  - `x-request-id`: sent on every request.
  - `idempotency-key`: sent on money and submit POSTs.
  - `x-step-up-token`: sent on sensitive actions after re-auth.
- **Pagination.** Keyset pagination: pass `?cursor=&limit=`. The response is `{ items, nextCursor }`, where the cursor is opaque.
- **Realtime.** `GET /api/realtime/stream` is SSE. Each line is `data: {"type", "at", ...payload}` and is addressed to the user. `POST /api/realtime/focus` reports what the user is viewing.
- **Uploads.** `POST /api/uploads` takes multipart `file` + `purpose` and returns `{ id, href, name, mime, size }`.

## Switching the frontend to the real backend

1. Set `NEXT_PUBLIC_API_MOCKING=off`.
2. Serve the API same-origin under `/api`, or set `NEXT_PUBLIC_API_URL` and allow CORS with credentials.
3. `npm run check:mocks` keeps every contract path mocked, so the demo build keeps working.
