import { z } from "zod";
import { dto } from "../../core/http/dto";

export const ConsentsIn = z.object({ processing: z.boolean().optional(), marketing: z.boolean().optional(), analytics: z.boolean().optional() });
export const AvatarIn = z.object({ contentType: z.string().max(64), size: z.number().int().positive() });
export const ActiveOrgIn = z.object({ orgId: z.string().max(64).nullable() });
export const InviteIn = z.object({ contact: z.string().trim().min(3).max(255), role: z.enum(["admin", "member"]).optional() });
export const ClaimIn = z.object({ code: z.string().min(4).max(32), phone: z.string().min(6).max(32), otp: z.string().regex(/^\d{6}$/).optional() });
export const UploadIn = z.object({ purpose: z.string().max(32).optional(), name: z.string().min(1).max(255), contentType: z.string().max(64), size: z.number().int().positive() });

export class ConsentsDto extends dto(ConsentsIn) {}
export class AvatarDto extends dto(AvatarIn) {}
export class ActiveOrgDto extends dto(ActiveOrgIn) {}
export class InviteDto extends dto(InviteIn) {}
export class ClaimDto extends dto(ClaimIn) {}
export const ClaimOut = z.object({ claimed: z.boolean(), otpSent: z.boolean() });
export class UploadDto extends dto(UploadIn) {}
