import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { Route } from "../../core/http/route";
import { CurrentUser, ImpersonationOk } from "../../core/auth/decorators";
import type { SessionUser } from "../../core/http/context";
import { AuthService } from "./auth.service";
import { MfaService } from "./auth.mfa";
import { AuthAdminService } from "./auth.admin";
import { AccountService } from "../account/account.service";
import * as D from "./auth.dto";

const SYS = ["staff:sysadmin"] as const;
type Rq = FastifyRequest;
type Rp = FastifyReply;

@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
    private readonly admin: AuthAdminService,
    private readonly account: AccountService,
  ) {}

  // ── sign-up / sign-in ──
  @Post("auth/signup")
  @Route({ auth: "public", limit: "auth", out: D.AuthFlowData })
  signup(
    @Body() b: D.SignupDto,
    @Req() req: Rq,
    @Res({ passthrough: true }) reply: Rp,
  ) {
    return this.auth.signup({ req, reply }, b);
  }

  @Post("auth/login")
  @Route({ auth: "public", limit: "auth", out: D.AuthFlowData })
  login(
    @Body() b: D.LoginDto,
    @Req() req: Rq,
    @Res({ passthrough: true }) reply: Rp,
  ) {
    return this.auth.login({ req, reply }, b);
  }

  @Post("auth/staff/login")
  @Route({ auth: "public", limit: "auth", out: D.StaffLoginOut })
  staffLogin(
    @Body() b: D.StaffLoginDto,
    @Req() req: Rq,
    @Res({ passthrough: true }) reply: Rp,
  ) {
    return this.auth.staffLogin({ req, reply }, b);
  }

  @Post("auth/verify-otp")
  @Route({ auth: "user", limit: "auth", out: D.Verified })
  verifyOtp(@Body() b: D.OtpDto, @CurrentUser() me: SessionUser) {
    return this.auth.verifyClientOtp(me, b.code);
  }

  @Post("auth/resend-otp")
  @Route({ auth: "user", limit: "auth", out: D.Verified })
  resendOtp(@CurrentUser() me: SessionUser) {
    return this.auth.resendOtp(me);
  }

  @Post("auth/forgot-password")
  @Route({
    auth: "public",
    limit: "auth",
    out: z.object({ maskedEmail: z.string() }),
  })
  forgot(@Body() b: D.ForgotDto) {
    return this.auth.forgotPassword(b);
  }

  @Post("auth/reset-password")
  @Route({ auth: "public", limit: "auth", out: D.Verified })
  reset(@Body() b: D.ResetDto) {
    return this.auth.resetPassword(b);
  }

  @Get("auth/set-password/:token")
  @Route({ auth: "public", limit: "auth", out: D.Preview })
  preview(@Param("token") t: string) {
    return this.auth.setPasswordPreview(t);
  }

  /** Deprecated alias: emails sent before the rename point here. */
  @Get("auth/invite/:token")
  @Route({ auth: "public", limit: "auth", out: D.Preview })
  invitePreview(@Param("token") t: string) {
    return this.auth.setPasswordPreview(t);
  }

  @Post("auth/set-password/:token")
  @Route({ auth: "public", limit: "auth", out: z.object({ ok: z.boolean() }) })
  setPassword(@Param("token") t: string, @Body() b: D.SetPasswordDto) {
    return this.auth.setPassword(t, b);
  }

  @Post("auth/team/access-request")
  @Route({
    auth: "public",
    limit: "auth",
    out: z.object({ reference: z.string(), maskedEmail: z.string() }),
  })
  accessRequest(
    @Body() b: D.AccessRequestDto,
    @Req() req: Rq,
    @Res({ passthrough: true }) reply: Rp,
  ) {
    return this.auth.createTeamAccessRequest({ req, reply }, b);
  }

  // ── session ──
  @Get("auth/session")
  @Route({ auth: "public", limit: "read", out: D.SessionData })
  session(
    @CurrentUser() me: SessionUser | null,
    @Req() req: Rq,
    @Res({ passthrough: true }) reply: Rp,
  ) {
    return this.auth.currentSession({ req, reply }, me);
  }

  @Delete("auth/session") @ImpersonationOk()
  @Route({ auth: "public", out: z.object({ signedOut: z.boolean() }) })
  closeSession(
    @CurrentUser() me: SessionUser | null,
    @Req() req: Rq,
    @Res({ passthrough: true }) reply: Rp,
  ) {
    return this.auth.signOut({ req, reply }, me);
  }

  @Post("auth/sign-out") @ImpersonationOk()
  @Route({ auth: "public", out: z.object({ signedOut: z.boolean() }) })
  signOut(
    @CurrentUser() me: SessionUser | null,
    @Req() req: Rq,
    @Res({ passthrough: true }) reply: Rp,
  ) {
    return this.auth.signOut({ req, reply }, me);
  }

  // ── own account ──
  @Patch("auth/change-password")
  @Route({
    auth: "user",
    limit: "auth",
    out: z.object({ changed: z.boolean() }),
  })
  changePassword(
    @Body() b: D.ChangePasswordDto,
    @CurrentUser() me: SessionUser,
  ) {
    return this.auth.changePassword(me, b);
  }

  @Patch("me/profile")
  @Route({ auth: "user", out: z.object({ session: D.SessionModel }) })
  profile(@Body() b: D.ProfileDto, @CurrentUser() me: SessionUser) {
    return this.auth.updateProfile(me, b);
  }

  @Delete("auth/account")
  @Route({
    auth: "user",
    limit: "auth",
    out: z.object({ deleted: z.boolean(), scheduledAt: z.string() }),
  })
  deleteAccount(
    @Body() b: D.PasswordDto,
    @CurrentUser() me: SessionUser,
    @Req() req: Rq,
    @Res({ passthrough: true }) reply: Rp,
  ) {
    return this.auth.deleteAccount({ req, reply }, me, b, (tx, uid) =>
      this.account.openCaseRefs(tx, uid),
    );
  }

  // F-IAM-01: switch the role this session works as (must be one of the account's roles).
  @Post("auth/active-role")
  @Route({ auth: "user", limit: "write", out: z.object({ activeRole: z.string(), roles: z.array(z.string()) }) })
  activeRole(@Body() b: D.ActiveRoleDto, @CurrentUser() me: SessionUser, @Req() req: Rq, @Res({ passthrough: true }) reply: Rp) {
    return this.auth.setActiveRole(me, { req, reply }, b.role);
  }

  // IAM-11: throttled client ping on real input; returns the new session end for the expiry warning.
  @Post("auth/activity") @ImpersonationOk()
  @Route({ auth: "user", limit: "read", out: z.object({ expiresAt: z.string() }) })
  activity(@CurrentUser() me: SessionUser) {
    return this.auth.activity(me);
  }

  @Get("me/sessions")
  @Route({ auth: "user", out: D.MySessions })
  mySessions(@CurrentUser() me: SessionUser) {
    return this.auth.mySessions(me);
  }

  @Delete("me/sessions/:id")
  @Route({ auth: "user", out: z.object({ revoked: z.boolean() }) })
  revokeMySession(@Param("id") id: string, @CurrentUser() me: SessionUser) {
    return this.auth.revokeMySession(me, id);
  }

  // ── MFA ──
  @Get("auth/mfa/status")
  @Route({
    auth: "user",
    out: D.MfaStatus,
  })
  mfaStatus(
    @CurrentUser() me: SessionUser,
    @Req() req: Rq,
    @Res({ passthrough: true }) reply: Rp,
  ) {
    return this.mfa.status({ req, reply }, me);
  }

  @Post("auth/mfa/enrol")
  @Route({
    auth: "user",
    limit: "auth",
    out: z.object({
      secret: z.string(),
      qrSvg: z.string(),
      periodS: z.number(),
    }),
  })
  enrol(@CurrentUser() me: SessionUser) {
    return this.mfa.enrol(me);
  }

  @Post("auth/mfa/enrol/verify")
  @Route({
    auth: "user",
    limit: "auth",
    out: z.object({ backupCodes: z.array(z.string()) }),
  })
  enrolVerify(@Body() b: D.CodeDto, @CurrentUser() me: SessionUser) {
    return this.mfa.enrolVerify(me, b.code);
  }

  /** Public: the /login/2fa step runs on the pre_2fa cookie, before a session exists. */
  @Post("auth/mfa/verify")
  @Route({
    auth: "public",
    limit: "auth",
    out: z.object({ verified: z.literal(true) }),
  })
  mfaVerify(
    @Body() b: D.MfaVerifyDto,
    @CurrentUser() me: SessionUser | null,
    @Req() req: Rq,
    @Res({ passthrough: true }) reply: Rp,
  ) {
    return this.mfa.verify({ req, reply }, me, b);
  }

  @Post("auth/mfa/step-up")
  @Route({
    auth: "user",
    limit: "auth",
    out: z.object({ token: z.string(), expiresAt: z.string() }),
  })
  stepUp(@Body() b: D.StepUpDto, @CurrentUser() me: SessionUser) {
    return this.mfa.stepUp(me, b);
  }

  @Post("auth/mfa/snooze")
  @Route({ auth: "user", limit: "write", out: z.object({ ok: z.literal(true) }) })
  mfaSnooze(@CurrentUser() me: SessionUser) {
    return this.mfa.snooze(me);
  }

  @Post("auth/mfa/disable")
  @Route({ auth: "user", limit: "auth", out: z.object({ ok: z.literal(true) }) })
  mfaDisable(@Body() b: D.MfaDisableDto, @CurrentUser() me: SessionUser) {
    return this.mfa.disable(me, b);
  }

  @Post("auth/mfa/backup-codes")
  @Route({
    auth: "user",
    stepUp: true,
    out: z.object({ backupCodes: z.array(z.string()) }),
  })
  backupCodes(@CurrentUser() me: SessionUser) {
    return this.mfa.regenerateBackupCodes(me);
  }

  @Get("auth/mfa/devices")
  @Route({ auth: "user", out: D.Devices })
  devices(
    @CurrentUser() me: SessionUser,
    @Req() req: Rq,
    @Res({ passthrough: true }) reply: Rp,
  ) {
    return this.mfa.listDevices({ req, reply }, me);
  }

  @Delete("auth/mfa/devices/:id")
  @Route({
    auth: "user",
    audit: "auth.trusted_device.revoked",
    out: z.object({ ok: z.boolean() }),
  })
  revokeDevice(
    @Param("id") id: string,
    @CurrentUser() me: SessionUser,
    @Req() req: Rq,
    @Res({ passthrough: true }) reply: Rp,
  ) {
    return this.mfa.revokeDevice({ req, reply }, me, id);
  }

  // ── sysadmin identity actions. Note: generic role gate (403 forbidden), and step-up runs in the guard before it. ──
  @Get("staff/users/:id/sessions")
  @Route({ auth: SYS, out: D.AdminSessions })
  userSessions(@Param("id") id: string, @CurrentUser() me: SessionUser) {
    return this.admin.userSessions(me, id);
  }

  @Delete("staff/users/:id/sessions")
  @Route({
    auth: SYS,
    stepUp: true,
    audit: "auth.session.revoked",
    out: z.object({ revoked: z.number() }),
  })
  revokeUserSessions(@Param("id") id: string, @CurrentUser() me: SessionUser) {
    return this.admin.revokeAll(me, id);
  }

  @Delete("staff/users/:id/sessions/:sid")
  @Route({ auth: SYS, out: z.object({ revoked: z.number() }) })
  revokeUserSession(
    @Param("id") id: string,
    @Param("sid") sid: string,
    @CurrentUser() me: SessionUser,
  ) {
    return this.admin.revokeOne(me, id, sid);
  }

  @Get("staff/users/:id/trusted-devices")
  @Route({ auth: SYS, out: D.AdminDevices })
  userDevices(@Param("id") id: string) {
    return this.admin.userDevices(id);
  }

  @Delete("staff/users/:id/trusted-devices/:did")
  @Route({ auth: SYS, out: z.object({}) })
  revokeUserDevice(@Param("id") id: string, @Param("did") did: string) {
    return this.admin.revokeDevice(id, did);
  }

  @Post("staff/users/:id/password-reset")
  @Route({
    auth: SYS,
    stepUp: true,
    idempotent: true,
    audit: "auth.password.reset_forced",
    out: z.object({}),
  })
  forceReset(@Param("id") id: string, @CurrentUser() me: SessionUser) {
    return this.admin.forcePasswordReset(me, id);
  }

  @Post("staff/impersonate")
  @Route({
    auth: SYS,
    stepUp: true,
    idempotent: true,
    out: z.object({ until: z.string(), home: z.string() }),
  })
  impersonate(
    @Body() b: D.ImpersonateDto,
    @CurrentUser() me: SessionUser,
    @Req() req: Rq,
    @Res({ passthrough: true }) reply: Rp,
  ) {
    return this.admin.startImpersonation({ req, reply }, me, b);
  }

  @Delete("staff/impersonate") @ImpersonationOk()
  @Route({
    auth: "user",
    out: z.object({ ended: z.boolean(), targetId: z.string().optional() }),
  })
  endImpersonation(
    @CurrentUser() me: SessionUser,
    @Req() req: Rq,
    @Res({ passthrough: true }) reply: Rp,
  ) {
    return this.admin.endImpersonation({ req, reply }, me);
  }
}
