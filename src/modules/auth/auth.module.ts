import { Module } from "@nestjs/common";
import { AccountModule } from "../account/account.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { MfaService } from "./auth.mfa";
import { AuthAdminService } from "./auth.admin";
import { GoogleAuthController, GoogleAuthService } from "./auth.google";

@Module({
  imports: [AccountModule],
  controllers: [AuthController, GoogleAuthController],
  providers: [AuthService, MfaService, AuthAdminService, GoogleAuthService],
  exports: [AuthService, MfaService],
})
export class AuthModule {}
