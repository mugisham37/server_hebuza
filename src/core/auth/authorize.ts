// F-IAM-03: the one resource gate — permission + ownership through domain `can()`; a refusal reads as 404 so a
// non-owner learns nothing about whether the resource exists.
import { can, type Permission, type ResourceContext } from "@/domain/auth/permissions";
import { AppError } from "../http/errors";
import type { SessionUser } from "../http/context";

export function authorize(user: SessionUser | null, perm: Permission, ctx?: ResourceContext, what = "Resource"): void {
  if (!user || !can({ id: user.id, roles: user.roles }, perm, ctx)) throw new AppError(404, "not_found", `${what} not found`);
}
