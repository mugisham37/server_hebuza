// Work route inputs, moved verbatim from the reference route table. Outputs are the service projections (the reference
// declared them z.any(), so no `out` filter here).
import { z } from "zod";
import { dto } from "../../core/http/dto";
import { UploadIn } from "../documents/documents.files";

export const EXT = ["ext:agent"] as const;
export const SM_READ = ["staff:service_manager", "staff:executive"] as const;
export const SM = ["staff:service_manager"] as const;
export const FIN = ["staff:finance", "staff:service_manager"] as const;
export const FIN_ONLY = ["staff:finance"] as const;

const Sign = z.object({
  typedName: z.string().max(200),
  readPct: z.number().min(0).max(100),
  agree: z.boolean(),
});
export const Draft = z.object({
  kind: z.enum(["individual", "firm"]),
  name: z.string().max(200),
  email: z.email().max(200),
  phone: z.string().max(40),
  district: z.string().max(80).default(""),
  firmName: z.string().max(200).default(""),
  firmCode: z.string().max(80).default(""),
  services: z.array(z.string().max(80)).max(40),
  expertise: z.string().max(4000).default(""),
  rates: z
    .record(
      z.string(),
      z.object({
        mode: z.enum(["pct", "flat", "hourly"]),
        value: z.string().max(20),
      }),
    )
    .default({}),
  grid: z.array(z.string().max(12)).max(20).default([]),
  maxJobs: z.string().max(4).default("3"),
  start: z.string().max(20).default(""),
  body: z.string().max(80).default(""),
  bodyOther: z.string().max(200).default(""),
  regNumber: z.string().max(80).default(""),
  regExpiry: z.string().max(20).default(""),
  files: z
    .array(
      z.object({ name: z.string().max(255), size: z.number().int().min(0) }),
    )
    .max(10)
    .default([]),
  refs: z
    .array(
      z.object({
        name: z.string().max(200),
        org: z.string().max(200),
        contact: z.string().max(200),
        ok: z.boolean(),
      }),
    )
    .max(5)
    .default([]),
  consentPrivacy: z.boolean(),
  consentRetention: z.boolean().default(false),
  consentAccuracy: z.boolean(),
});
export type Draft = z.infer<typeof Draft>;

// ── join ──
export class JoinSubmitDto extends dto(
  z.object({ draft: Draft, client_op_id: z.string().min(8).max(80) }),
) {}
export class JoinOtpDto extends dto(z.object({ email: z.string().max(200) })) {}
export class JoinVerifyDto extends dto(
  z.object({ email: z.string().max(200), code: z.string().max(12) }),
) {}
export class JoinResubmitDto extends dto(
  z.object({ email: z.string().max(200), patch: Draft.partial() }),
) {}
export class JoinDecisionDto extends dto(
  z.object({
    decision: z.enum(["approve", "reject", "request_info", "expire_invite"]),
    note: z.string().max(2000).optional(),
    fields: z.array(z.string().max(40)).max(30).optional(),
  }),
) {}

// ── onboarding ──
export class OnboardingDto extends dto(
  z.object({
    step: z.enum(["identity", "payout", "services"]),
    data: z.record(z.string(), z.unknown()),
  }),
) {}
export class KycDto extends dto(
  z.object({
    slot: z.enum(["id_front", "id_back", "selfie"]),
    fileName: z.string().min(1).max(255),
    size: UploadIn.shape.size,
    type: UploadIn.shape.mime,
  }),
) {}
export class SignDto extends dto(Sign) {}
export class CredentialDto extends dto(
  z.object({
    kind: z
      .enum(["degree", "certificate", "license", "professional_body"])
      .optional(),
    title: z.string().max(200).optional(),
    issuer: z.string().max(200).optional(),
    number: z.string().max(80).optional(),
    issuedOn: z.string().max(20).optional(),
    expiresOn: z.string().max(20).optional(),
    fileName: z.string().max(255).optional(),
    size: UploadIn.shape.size,
    type: UploadIn.shape.mime,
    services: z.array(z.string().max(80)).max(40).optional(),
  }),
) {}
export class CredentialReplaceDto extends dto(
  z.object({
    expiresOn: z.string().max(20).optional(),
    issuedOn: z.string().max(20).optional(),
    fileName: z.string().max(255).optional(),
    size: UploadIn.shape.size,
    type: UploadIn.shape.mime,
  }),
) {}

// ── jobs ──
export class CounterDto extends dto(
  z.object({
    due: z.string().max(40).optional(),
    reason: z.string().max(1000).optional(),
  }),
) {}
export class AccessRequestDto extends dto(
  z.object({
    reason: z.string().min(1).max(40),
    note: z.string().max(1000).optional(),
    client_op_id: z.string().min(4).max(80),
  }),
) {}
export class HandbackDto extends dto(
  z.object({
    reason: z.string().max(40),
    note: z.string().max(1000).optional(),
  }),
) {}

// ── money / contract ──
export class FileQueryDto extends dto(
  z.object({ format: z.enum(["pdf", "csv"]).optional() }),
) {}
export class InvoiceDto extends dto(
  z.object({
    number: z.string().max(60).optional(),
    period: z.string().max(7).optional(),
    amount: z.number().optional(),
    fileName: z.string().max(255).optional(),
    size: UploadIn.shape.size,
    type: UploadIn.shape.mime,
  }),
) {}
export class RenewDto extends dto(
  z.object({ acknowledge: z.boolean().optional() }),
) {}
export class NoticeDto extends dto(
  z.object({ reason: z.string().max(2000) }),
) {}
export class RateRequestDto extends dto(
  z.object({
    serviceId: z.string().max(80),
    bps: z.number().optional(),
    flat: z.number().optional(),
    reason: z.string().max(1000),
  }),
) {}
export class LicenceDto extends dto(
  z.object({ phone: z.string().max(30).optional() }),
) {}
export class PayoutDestDto extends dto(
  z.object({
    method: z.enum(["momo", "airtel", "bank"]),
    account: z.string().max(40),
    name: z.string().max(120),
    otp: z.string().max(10),
    stepUp: z.string().max(200).optional(),
  }),
) {}

// ── firm ──
export class InviteMemberDto extends dto(
  z.object({
    name: z.string().max(200),
    email: z.string().max(200),
    phone: z.string().max(40).optional(),
    services: z.array(z.string().max(80)).max(40),
  }),
) {}
export class ReasonDto extends dto(
  z.object({ reason: z.string().max(1000) }),
) {}
export class FirmAssignDto extends dto(
  z.object({ memberId: z.string().max(64) }),
) {}

// ── staff ──
export class OnboardingDecisionDto extends dto(
  z.object({
    decision: z.enum(["approve", "changes"]),
    items: z.array(z.string().max(20)).max(6).optional(),
    note: z.string().max(1000).optional(),
  }),
) {}
export class GrantDto extends dto(z.object({ grant: z.boolean() })) {}
export class InstructionsDto extends dto(
  z.object({ text: z.string().min(1).max(8000) }),
) {}
export class InvoiceDecisionDto extends dto(
  z.object({
    decision: z.enum(["accepted", "rejected"]),
    note: z.string().max(1000).optional(),
  }),
) {}
