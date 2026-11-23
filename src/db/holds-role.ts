// "Does this account hold role X?" — main role OR an unexpired user_roles grant OR a System-UI overlay grant (userMeta.extraRoles).
// Use for "who can do X" lists (assignees, approvers, notify-all-finance). Keep users.role for "is this a client account" checks.
import { sql } from "drizzle-orm";
import { users } from "@/db/schema";

export function holdsRole(...roles: string[]) {
  const rs = sql.join(roles.map((r) => sql`${r}`), sql`, `);
  return sql`(${users.role} in (${rs})
    or exists (select 1 from user_roles ur where ur.user_id = ${users.userId} and ur.role in (${rs}) and (ur.expires_at is null or ur.expires_at > now()))
    or exists (select 1 from system_records sr, jsonb_array_elements(coalesce(sr.data->'extraRoles', '[]'::jsonb)) g
               where sr.kind = 'userMeta' and sr.id = ${users.userId} and g->>'role' in (${rs})))`;
}
