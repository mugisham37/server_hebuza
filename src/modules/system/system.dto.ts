// Request schemas of the system console (moved verbatim from the reference route table).
import { z } from "zod";
import { dto } from "../../core/http/dto";

const str = z.string().max(2000);
const loose = z.record(z.string(), z.unknown());
export class LooseDto extends dto(loose) {}
export class ReasonDto extends dto(
  z.object({ reason: z.string().max(2000).optional() }),
) {}
export class AccessRequestRefDto extends dto(
  z.object({ accessRequestId: z.string().max(64).optional() }),
) {}

export const auditQuery = z
  .object({
    category: str,
    actor: str,
    action: str,
    resource_type: str,
    resource_id: str,
    ip: str,
    from: str,
    to: str,
    privileged: str,
    q: str,
    cursor: str,
  })
  .partial();
export class AuditQueryDto extends dto(auditQuery) {}
export class AuditExportDto extends dto(
  z.object({ format: z.enum(["csv", "pdf"]) }),
) {}

// ---------------------------------------------------------------- shell + approvals
export class AlertsReadDto extends dto(
  z.object({
    ids: z.union([z.literal("all"), z.array(z.string().max(96)).max(500)]),
  }),
) {}
export class SearchQueryDto extends dto(
  z.object({ q: z.string().max(100).optional() }),
) {}
export class ChangesQueryDto extends dto(
  z.object({
    area: z.string().max(16).optional(),
    state: z.string().max(16).optional(),
  }),
) {}
export const DecisionIn = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().max(2000).optional(),
});
export type DecisionIn = z.infer<typeof DecisionIn>;
export class DecisionDto extends dto(DecisionIn) {}

// ---------------------------------------------------------------- users + identity
export class UsersQueryDto extends dto(
  z
    .object({
      kind: z.enum(["staff", "agent", "client", "service"]).optional(),
      role: str,
      status: str,
      mfa: str,
      last: str,
      q: z.string().max(100),
    })
    .partial(),
) {}
export class InviteDto extends dto(
  z
    .object({
      name: z.string().max(200),
      email: z.string().max(255),
      phone: z.string().max(32),
      roles: z.array(z.string().max(40)).max(10),
      reason: z.string().max(2000),
    })
    .partial(),
) {}
export const RoleOpIn = z.object({
  action: z.enum(["grant", "revoke"]),
  role: z.string().max(60),
  reason: z.string().max(2000).optional(),
  expiresAt: z.string().max(40).nullable().optional(),
});
export type RoleOpIn = z.infer<typeof RoleOpIn>;
export class RoleOpDto extends dto(RoleOpIn) {}
export const StatusIn = z.object({
  action: z.enum([
    "suspend",
    "reactivate",
    "deactivate",
    "unlock",
    "resend",
    "revoke_invite",
  ]),
  reason: z.string().max(2000).optional(),
});
export type StatusIn = z.infer<typeof StatusIn>;
export class StatusDto extends dto(StatusIn) {}
export class OffboardDto extends dto(
  z.object({
    reason: z.string().max(2000).optional(),
    revokeSessions: z.boolean().optional(),
  }),
) {}
export class IdentityDecisionDto extends dto(
  z.object({
    checklist: z.record(z.string(), z.boolean()).optional(),
    reason: z.string().max(2000).optional(),
    note: z.string().max(2000).optional(),
  }),
) {}

// ---------------------------------------------------------------- roles, SoD, reviews, break-glass
export class SodCheckQueryDto extends dto(
  z.object({ roles: z.string().max(500).optional() }),
) {}
export class WaiverDto extends dto(
  z
    .object({
      userId: z.string().max(64),
      pair: z.tuple([z.string().max(40), z.string().max(40)]),
      why: z.string().max(2000),
      expiresAt: z.string().max(40),
    })
    .partial(),
) {}
export class ReviewItemDto extends dto(
  z.object({
    decision: z
      .enum(["pending", "kept", "role_removed", "suspended"])
      .optional(),
    reviewerId: z.string().max(64).optional(),
  }),
) {}
export class BulkKeepDto extends dto(
  z.object({ ids: z.array(z.string().max(32)).max(2000) }),
) {}
export class BreakGlassDto extends dto(
  z
    .object({
      reason: z.string().max(2000),
      minutes: z.number().int(),
      incidentId: z.string().max(64),
    })
    .partial(),
) {}
export class NoteDto extends dto(
  z.object({ note: z.string().max(4000).optional() }),
) {}

// ---------------------------------------------------------------- settings, integrations, notifications
export const SettingsPatchIn = z.object({
  values: z.record(z.string(), z.unknown()),
  reason: z.string().max(2000).optional(),
  effectiveAt: z.string().max(40).nullable().optional(),
});
export type SettingsPatchIn = z.infer<typeof SettingsPatchIn>;
export class SettingsPatchDto extends dto(SettingsPatchIn) {}
export class LanguageDto extends dto(
  z.object({ code: z.string().max(8), name: z.string().max(80) }).partial(),
) {}
export class PayLaterDto extends dto(z.object({ on: z.boolean() })) {}
export class CredentialDto extends dto(
  z
    .object({
      name: z.string().max(60),
      value: z.string().max(4000),
      reason: z.string().max(2000),
    })
    .partial(),
) {}
export class EnvDto extends dto(
  z.object({ env: z.string().max(16) }),
) {}
export class RulesDto extends dto(
  z.object({ items: z.array(loose).max(200) }),
) {}
export class TemplateDto extends dto(
  z.object({
    languages: z.record(
      z.string(),
      z
        .object({
          subject: str.optional(),
          header: str.optional(),
          body: z.string().max(4096),
          footer: str.optional(),
          button: str.optional(),
        })
        .nullable(),
    ),
    category: z.enum(["utility", "marketing", "authentication"]),
  }),
) {}
export class DeliveriesQueryDto extends dto(
  z
    .object({ status: z.string().max(16), channel: z.string().max(16) })
    .partial(),
) {}
export class BudgetDto extends dto(z.object({ budget: z.number() })) {}

// ---------------------------------------------------------------- privacy + operations
export class RetentionChangeDto extends dto(
  z
    .object({
      category: z.string().max(80),
      keep: z.string().max(80),
      reason: z.string().max(2000),
    })
    .partial(),
) {}
export class RestoreDto extends dto(
  z
    .object({
      target: z.enum(["staging", "production"]),
      backupId: z.string().max(64),
      reason: z.string().max(2000),
    })
    .partial(),
) {}
export class StatusPostDto extends dto(
  z
    .object({
      component: z.string().max(40),
      state: z.string().max(16),
      message: z.record(z.string(), z.string().max(500)),
    })
    .partial(),
) {}
export class IncidentEventDto extends dto(
  z.object({ text: z.string().max(2000).optional() }),
) {}
