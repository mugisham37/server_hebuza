import { Module } from "@nestjs/common";
import { TokenService } from "../../core/auth/tokens";
import { PasswordService } from "../../core/auth/password";
import { CookieService } from "../../core/auth/cookies";
import { AuthService } from "../auth/auth.service";
import { PublicCache } from "../catalogue/cache";
import { SystemStore } from "./system.store";
import { SystemJobs } from "./system.jobs";
// Side-effect imports: each logic file registers its change appliers (onApply) at load.
import "./system.users";
import "./system.governance";
import "./system.config";
import "./system.ops";

/** Worker side: crons + the template provider-review job. Token/Password/Cookie/Auth services complete SystemDeps (AuthCoreModule is HTTP-only). */
@Module({ providers: [SystemStore, SystemJobs, TokenService, PasswordService, CookieService, AuthService, PublicCache] })
export class SystemWorkerModule {}
