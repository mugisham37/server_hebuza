import { SetMetadata, createParamDecorator, applyDecorators, type ExecutionContext } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Permission } from "@/domain/auth/permissions";
import type { SessionUser } from "../http/context";

export const PUBLIC = "auth:public";
export const NO_CSRF = "auth:no_csrf";
export const PERMIT = "auth:permit";
export const STEP_UP = "auth:step_up";
export const IMPERSONATION_OK = "auth:impersonation_ok";

export const Public = () => SetMetadata(PUBLIC, true);
/** Signed provider callbacks: no session, no Origin check (verify the signature in the handler). */
export const Webhook = () => applyDecorators(SetMetadata(PUBLIC, true), SetMetadata(NO_CSRF, true));
/** Passes when the user's roles grant ANY of the listed permissions (MATRIX). */
export const Permit = (...perms: Permission[]) => SetMetadata(PERMIT, perms);
export const StepUp = () => SetMetadata(STEP_UP, true);
/** Writes allowed under a view-as token (sign-out, end view-as); every other non-GET is 403 `impersonation_read_only`. */
export const ImpersonationOk = () => SetMetadata(IMPERSONATION_OK, true);
export type LimitName = "auth" | "write" | "read";
export const Limit = (name: LimitName) => Throttle({ default: { limit: { auth: 10, write: 60, read: 600 }[name], ttl: 60_000 } });

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): SessionUser | null => ctx.switchToHttp().getRequest<{ user?: SessionUser }>().user ?? null,
);
