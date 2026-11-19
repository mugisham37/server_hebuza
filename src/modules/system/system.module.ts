import { Module } from "@nestjs/common";
import { SystemStore } from "./system.store";
import { AuthModule } from "../auth/auth.module";
import { CatalogueModule } from "../catalogue/catalogue.module";
import { SystemUsersController } from "./system.users.controller";
import { SystemGovernanceController } from "./system.governance.controller";
import { SystemConfigController } from "./system.config.controller";
import { SystemAuditController } from "./system.audit.controller";
import { SystemOpsController } from "./system.ops.controller";
import { NotificationsModule } from "../notifications/notifications.module";
// Side-effect imports: each logic file registers its change appliers (onApply) at load.
import "./system.users";
import "./system.governance";
import "./system.config";
import "./system.ops";

@Module({
  imports: [AuthModule, CatalogueModule, NotificationsModule],
  controllers: [
    SystemUsersController,
    SystemGovernanceController,
    SystemConfigController,
    SystemAuditController,
    SystemOpsController,
  ],
  providers: [SystemStore],
  exports: [SystemStore],
})
export class SystemModule {}
