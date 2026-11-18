import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard } from "@nestjs/throttler";
import { PasswordService } from "./password";
import { TokenService } from "./tokens";
import { CookieService } from "./cookies";
import { AuthGuard } from "./guards";
import { CsrfGuard } from "./csrf";
import { ThrottleModule } from "./throttle";

/** Guard order: rate limit → CSRF → auth/permissions/step-up. */
@Global()
@Module({
  imports: [ThrottleModule],
  providers: [
    PasswordService, TokenService, CookieService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [PasswordService, TokenService, CookieService],
})
export class AuthCoreModule {}
