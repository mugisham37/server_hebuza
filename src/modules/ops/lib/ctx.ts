// Shims that let the reference ops logic (plain functions over a request ctx) run unchanged inside Nest:
// Exec = the request tx, err/AppError keep the reference call shapes, notify/publish go through the outbox.
import { outbox } from "@/db/schema";
import type { Tx } from "../../../core/db/db";
import type { SessionUser } from "../../../core/http/context";
import { AppError as CoreError } from "../../../core/http/errors";
import type { App } from "./store";
import type { CaseFacts } from "@/domain/ops/transitions";
import type { CaseStatus } from "@/domain/domain/case-status";
import type { NotifyInput } from "../../notifications/notifications.service";

export type Exec = Tx;
/** Reference Session: SessionUser + primary role (history rows store it). */
export type Session = SessionUser & { role: string };
export type Ctx = {
  db: Exec;
  session: Session;
  ip: string | null;
  req: { headers: { get(name: string): string | null } };
  /** Extra audit details a handler attaches (reference ctx.audit). */
  audit: { resourceId?: string | null; details?: Record<string, unknown> };
  /** Valid x-step-up-token on this request (checked by the runner). */
  stepUp: () => Promise<boolean>;
  /** Status change as "manager" through ApplicationsService.transition (shared machine + history + audit + notify). */
  transition: (a: App, to: CaseStatus, facts?: Omit<CaseFacts, "status">, note?: string | null) => Promise<unknown>;
};

export const SYSTEM: Session = {
  id: "system",
  role: "system",
  roles: [],
  scopes: {},
  sid: "cron",
};

export class AppError extends CoreError {
  constructor(
    status: number,
    errorType: string,
    message: string,
    data?: Record<string, unknown> | null,
  ) {
    super(status, errorType, message, undefined, data ?? undefined);
  }
}
export const err = {
  notFound: (message = "Resource not found.") =>
    new AppError(404, "not_found", message),
  forbidden: (
    message = "You do not have permission to access this resource.",
  ) => new AppError(403, "forbidden", message),
  conflict: (message = "Resource conflict.", data?: Record<string, unknown>) =>
    new AppError(409, "conflict", message, data),
  stepUp: () =>
    new AppError(401, "step_up_required", "Confirm it's you first."),
};

export { generateId } from "../../../core/db/ids";

type NewNotification = Omit<NotifyInput, "link" | "data"> & {
  href?: string | null;
  channel?: string;
  data?: unknown;
};
/** Same contract as NotificationsService.notify (outbox `notifications.deliver`), callable from plain functions. */
export const notify = (db: Exec, n: NewNotification) => {
  const { href, channel: _c, data, ...rest } = n;
  return db.insert(outbox).values({
    type: "notifications.deliver",
    payload: {
      ...rest,
      link: href ?? null,
      data: (data as NotifyInput["data"]) ?? null,
    },
    queue: "default",
  });
};

/** Domain event → outbox, one row per audience member so each reaches that user's realtime stream. */
export async function publish(
  db: Exec,
  type: string,
  e: { audience?: string[]; data?: unknown; actorId?: string | null } = {},
) {
  const at = new Date().toISOString();
  const rows = (e.audience?.length ? e.audience : [null]).map((userId) => ({
    type,
    payload: {
      type,
      at,
      actorId: e.actorId ?? null,
      data: e.data ?? null,
      ...(userId && { realtime: { userId } }),
    },
    queue: "default" as const,
  }));
  await db.insert(outbox).values(rows);
}
