// ORG rules: who may do what in a company (spec company-profiles §2), TIN format, invite lifetime.
export const ORG_TYPES = ["sole_proprietor", "ltd", "plc", "cooperative", "ngo", "branch_foreign", "partnership", "other"] as const;
export const ORG_ROLES = ["owner", "admin", "viewer"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];
export type OrgAction = "edit" | "invite" | "remove" | "submit" | "pay" | "view";
export const INVITE_TTL_MS = 7 * 86_400_000;

export function orgCan(role: OrgRole | null | undefined, action: OrgAction): boolean {
  if (!role) return false;
  if (action === "view") return true;
  return role === "owner" || role === "admin";
}

/** Admins manage reps except the owner; nobody removes or demotes the owner here (ownership transfer is out of scope). */
export function canManageMember(actor: OrgRole | null | undefined, target: OrgRole): boolean {
  return orgCan(actor, "invite") && target !== "owner";
}

export const isTin = (s: string) => /^\d{9}$/.test(s);
