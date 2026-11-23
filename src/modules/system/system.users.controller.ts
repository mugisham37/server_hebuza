// Users, invitations, service accounts and identity checks (reference handlers-system-b). Role checks run in the
// services (403 forbidden_role before step-up, as the UI expects), so routes are `auth: "user"`.
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseInterceptors,
} from "@nestjs/common";
import { Route } from "../../core/http/route";
import {
  AcceptedInterceptor,
  Sys,
  SystemStore,
  type RawCaller,
} from "./system.store";
import * as users from "./system.users";
import { userActivity } from "./system.audit";
import {
  AccessRequestRefDto,
  IdentityDecisionDto,
  InviteDto,
  OffboardDto,
  RoleOpDto,
  AllWorkspacesDto,
  type RoleOpIn,
  StatusDto,
  type StatusIn,
  UsersQueryDto,
} from "./system.dto";

const R = { auth: "user" } as const;
const W = { auth: "user", idempotent: true } as const;

@Controller()
@UseInterceptors(AcceptedInterceptor)
export class SystemUsersController {
  constructor(private readonly s: SystemStore) {}

  @Get("staff/users")
  @Route(R)
  list(@Sys() c: RawCaller, @Query() q: UsersQueryDto) {
    return users.listUsers(this.s.on(c), q);
  }
  @Post("staff/users/export")
  @Route({ ...R, limit: "write" })
  export(@Sys() c: RawCaller) {
    return users.exportUsers(this.s.on(c));
  }
  @Get("staff/users/:id")
  @Route(R)
  detail(@Sys() c: RawCaller, @Param("id") id: string) {
    return users.userDetail(this.s.on(c), id);
  }
  @Get("staff/users/:id/activity")
  @Route(R)
  activity(@Sys() c: RawCaller, @Param("id") id: string) {
    return userActivity(this.s.on(c), id);
  }
  @Post("staff/users/invitations")
  @Route(W)
  invite(@Sys() c: RawCaller, @Body() b: InviteDto) {
    return users.invite(this.s.on(c), b);
  }
  @Post("staff/users/invitations/:id/:op")
  @Route(W)
  invitationOp(
    @Sys() c: RawCaller,
    @Param("id") id: string,
    @Param("op") op: string,
  ) {
    return users.invitationOp(this.s.on(c), id, op);
  }
  @Post("staff/users/:id/roles")
  @Route(W)
  roles(@Sys() c: RawCaller, @Param("id") id: string, @Body() b: RoleOpDto) {
    return users.changeRole(this.s.on(c), id, b as RoleOpIn);
  }
  @Post("staff/users/:id/all-workspaces")
  @Route(W)
  allWorkspaces(@Sys() c: RawCaller, @Param("id") id: string, @Body() b: AllWorkspacesDto) {
    return users.allWorkspaces(this.s.on(c), id, b);
  }
  @Post("staff/users/:id/status")
  @Route(W)
  status(@Sys() c: RawCaller, @Param("id") id: string, @Body() b: StatusDto) {
    return users.setStatus(this.s.on(c), id, b as StatusIn);
  }
  @Post("staff/users/:id/mfa-reset")
  @Route(W)
  mfaReset(
    @Sys() c: RawCaller,
    @Param("id") id: string,
    @Body() b: AccessRequestRefDto,
  ) {
    return users.mfaReset(this.s.on(c), id, b.accessRequestId);
  }
  @Post("staff/users/:id/unlock")
  @Route(W)
  unlock(
    @Sys() c: RawCaller,
    @Param("id") id: string,
    @Body() b: AccessRequestRefDto,
  ) {
    return users.unlock(this.s.on(c), id, b.accessRequestId);
  }
  @Post("staff/users/:id/offboard")
  @Route(W)
  offboard(
    @Sys() c: RawCaller,
    @Param("id") id: string,
    @Body() b: OffboardDto,
  ) {
    return users.offboard(this.s.on(c), id, b);
  }
  @Get("staff/x/service-accounts")
  @Route(R)
  serviceAccounts(@Sys() c: RawCaller) {
    return users.serviceAccounts(this.s.on(c));
  }
  @Post("staff/x/service-accounts/:id/rotate")
  @Route(W)
  rotate(@Sys() c: RawCaller, @Param("id") id: string) {
    return users.rotateServiceAccount(this.s.on(c), id);
  }
  @Get("admin/access-requests")
  @Route(R)
  identity(@Sys() c: RawCaller) {
    return users.listIdentity(this.s.on(c));
  }
  @Post("admin/access-requests/:id/:op")
  @Route(W)
  decideIdentity(
    @Sys() c: RawCaller,
    @Param("id") id: string,
    @Param("op") op: string,
    @Body() b: IdentityDecisionDto,
  ) {
    return users.decideIdentity(this.s.on(c), id, op, b);
  }
}
