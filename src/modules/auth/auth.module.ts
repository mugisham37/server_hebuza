import { Module } from "@nestjs/common";
import { AccountModule } from "../account/account.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { MfaService } from "./auth.mfa";
import { AuthAdminService } from "./auth.admin";

@Module({
  imports: [AccountModule],
  controllers: [AuthController],
  providers: [AuthService, MfaService, AuthAdminService],
  exports: [AuthService, MfaService],
})
export class AuthModule {}
