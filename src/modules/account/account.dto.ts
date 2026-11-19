import { z } from "zod";
import { dto } from "../../core/http/dto";

export const ConsentsIn = z.object({ processing: z.boolean().optional(), marketing: z.boolean().optional(), analytics: z.boolean().optional(), profileReuse: z.boolean().optional(),
  // F-CLP-14 per-channel marketing + keep assistant chat history
  marketingEmail: z.boolean().optional(), marketingSms: z.boolean().optional(), marketingWhatsapp: z.boolean().optional(), aiHistory: z.boolean().optional() });
export class PrefillQueryDto extends dto(z.object({ service: z.string().max(128).optional(), party: z.string().max(64).default("me") })) {}
export const AvatarIn = z.object({ contentType: z.string().max(64), size: z.number().int().positive() });
export const ActiveOrgIn = z.object({ orgId: z.string().max(64).nullable() });
export const InviteIn = z.object({ contact: z.string().trim().min(3).max(255), role: z.enum(["admin", "viewer"]).optional() });
const opt = (n: number) => z.string().trim().max(n).nullish();
export const OrgIn = z.object({
  legalName: z.string().trim().min(2).max(255), tradeName: opt(255),
  orgType: z.enum(["sole_proprietor", "ltd", "plc", "cooperative", "ngo", "branch_foreign", "partnership", "other"]),
  tin: z.string().regex(/^\d{9}$/, "TIN must be 9 digits.").nullish(), rdbNumber: opt(64),
  registeredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), sectorCode: opt(16),
  province: opt(64), district: opt(64), sector: opt(64), cell: opt(64), phone: opt(32),
  email: z.string().email().max(255).nullish().or(z.literal("")), website: opt(255), sizeBand: z.enum(["micro", "small", "medium", "large"]).nullish(),
});
export const OrgPatchIn = OrgIn.partial();
export const MemberPatchIn = z.object({ role: z.enum(["admin", "viewer"]).optional(), title: z.string().trim().max(128).nullish() });
export const OrgVerifyIn = z.object({ decision: z.enum(["verified", "rejected"]), note: z.string().trim().max(1000).optional() });
export const OrgAdminQuery = z.object({ q: z.string().max(100).optional(), status: z.enum(["unverified", "pending_verification", "verified", "rejected"]).optional() });
export const ClaimIn = z.object({ code: z.string().min(4).max(32), phone: z.string().min(6).max(32), otp: z.string().regex(/^\d{6}$/).optional() });
export const UploadIn = z.object({ purpose: z.string().max(32).optional(), name: z.string().min(1).max(255), contentType: z.string().max(64), size: z.number().int().positive() });

export class ConsentsDto extends dto(ConsentsIn) {}
export class AvatarDto extends dto(AvatarIn) {}
export class ActiveOrgDto extends dto(ActiveOrgIn) {}
export class InviteDto extends dto(InviteIn) {}
export class ClaimDto extends dto(ClaimIn) {}
export const ClaimOut = z.object({ claimed: z.boolean(), otpSent: z.boolean() });
export class UploadDto extends dto(UploadIn) {}
export class OrgDto extends dto(OrgIn) {}
export class OrgPatchDto extends dto(OrgPatchIn) {}
export class MemberPatchDto extends dto(MemberPatchIn) {}
export class OrgVerifyDto extends dto(OrgVerifyIn) {}
export class OrgAdminQueryDto extends dto(OrgAdminQuery) {}
export class AddressDto extends dto(z.object({ province: z.string().trim().max(64), district: z.string().trim().max(64), sector: z.string().trim().max(64), cell: z.string().trim().max(64), street: z.string().trim().max(255) })) {}
export class ReminderDto extends dto(z.object({ state: z.enum(["done", "snoozed", "open"]), days: z.number().int().min(1).max(30).optional() })) {}
