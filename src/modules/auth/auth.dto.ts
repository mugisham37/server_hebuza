import { z } from "zod";
import { dto } from "../../core/http/dto";

const IdType = z.enum(["email", "phone"]);
const Audience = z.enum(["client", "partner"]);
const Lang = z.enum(["en", "rw", "fr"]);
export const SessionModel = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  role: z.string(),
  isEmailVerified: z.boolean(),
  language: z.string(),
  customerNo: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
});
const SessionWithRoles = SessionModel.extend({ roles: z.array(z.string()) });
export const AuthFlowData = z
  .object({
    session: SessionModel,
    maskedEmail: z.string(),
    mfaRequired: z.boolean().optional(),
  })
  .meta({ id: "AuthFlowData" });
export const SessionData = z
  .object({ session: SessionWithRoles })
  .meta({ id: "SessionData" });
export const Verified = z.object({ verified: z.boolean(), mfaRequired: z.boolean().optional() });
const Code = z.string().trim().min(6).max(16);

export const SignupIn = z
  .object({
    name: z.string().trim().min(2).max(255),
    identifierType: IdType.optional(),
    identifier: z.string().min(1).max(255),
    password: z.string().min(10).max(256),
    language: Lang.default("rw"),
    terms: z.boolean().optional(),
    audience: Audience.optional(),
  })
  .refine((b) => b.terms !== false, {
    message: "Terms must be accepted",
    path: ["terms"],
  });
export const LoginIn = z.object({
  identifierType: IdType.optional(),
  identifier: z.string().min(1).max(255),
  password: z.string().min(1).max(256),
  rememberMe: z.boolean().optional(),
  audience: Audience.optional(),
});
export const StaffLoginIn = z.object({
  email: z.email(),
  password: z.string().min(1),
  role: z.enum(["agent", "admin"]).optional(),
});
export const StaffLoginOut = z.object({
  session: SessionModel,
  mfaRequired: z.boolean().optional(),
});
export const OtpIn = z.object({
  code: z.string().regex(/^\d{6}$/, "OTP code must be exactly 6 digits"),
});
export const ForgotIn = z.object({
  identifierType: IdType.optional(),
  identifier: z.string().min(1).max(255),
  audience: Audience.optional(),
});
export const ResetIn = z.object({
  token: z.string().min(1).max(256),
  password: z.string().min(10).max(256),
  confirmPassword: z.string().optional(),
});
export const SetPasswordIn = z.object({
  name: z.string().trim().max(255).optional(),
  phone: z.string().max(32).optional(),
  password: z.string().min(1).max(256),
});
export const Preview = z
  .object({
    name: z.string(),
    email: z.string(),
    role: z.enum(["agent", "admin"]),
    issuedBy: z.string(),
    issuedAt: z.string(),
    expiresAt: z.string(),
  })
  .meta({ id: "SetPasswordPreview" });
export const AccessRequestIn = z.object({
  email: z.email(),
  kind: z.enum(["password", "unlock", "two_factor", "other"]),
  note: z.string().max(500).nullish(),
});
export const ChangePasswordIn = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1).max(256),
  confirmPassword: z.string().optional(),
});
export const ProfileIn = z.object({
  name: z.string().max(255).nullish(),
  phone: z.string().max(32).nullish(),
  /** CLP-03: preferred language for mail/SMS and the portal. */
  language: z.enum(["rw", "en", "fr"]).nullish(),
});
export const PasswordIn = z.object({ password: z.string().min(1) });
export const MySessions = z.object({
  sessions: z.array(
    z.object({
      id: z.string(),
      device: z.string(),
      place: z.string().nullable(),
      lastActive: z.string(),
      current: z.boolean(),
    }),
  ),
});
export const CodeIn = z.object({ code: Code });
export const MfaVerifyIn = z.object({
  code: Code,
  backup: z.boolean().optional(),
  trust: z.boolean().optional(),
  trustDevice: z.boolean().optional(),
});
export const StepUpIn = z.object({
  code: Code,
  backup: z.boolean().optional(),
  action: z.string().max(120).optional(),
});
export const Devices = z.object({
  devices: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      place: z.string(),
      lastSeen: z.string(),
      current: z.boolean(),
    }),
  ),
});
export const AdminSessions = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      userId: z.string(),
      device: z.string(),
      ip: z.string(),
      city: z.string().nullable(),
      createdAt: z.string(),
      lastSeenAt: z.string(),
      current: z.boolean(),
    }),
  ),
});
export const AdminDevices = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      userId: z.string(),
      label: z.string(),
      addedAt: z.string(),
      lastUsedAt: z.string(),
    }),
  ),
});
export const ImpersonateIn = z.object({
  targetId: z.string().max(64).optional(),
  reason: z.string().max(500).optional(),
  minutes: z.number().int().optional(),
});

export class SignupDto extends dto(SignupIn) {}
export class LoginDto extends dto(LoginIn) {}
export class StaffLoginDto extends dto(StaffLoginIn) {}
export class OtpDto extends dto(OtpIn) {}
export class ForgotDto extends dto(ForgotIn) {}
export class ResetDto extends dto(ResetIn) {}
export class SetPasswordDto extends dto(SetPasswordIn) {}
export class AccessRequestDto extends dto(AccessRequestIn) {}
export class ChangePasswordDto extends dto(ChangePasswordIn) {}
export class ProfileDto extends dto(ProfileIn) {}
export class PasswordDto extends dto(PasswordIn) {}
export class CodeDto extends dto(CodeIn) {}
export class MfaVerifyDto extends dto(MfaVerifyIn) {}
export class StepUpDto extends dto(StepUpIn) {}
export class ImpersonateDto extends dto(ImpersonateIn) {}
