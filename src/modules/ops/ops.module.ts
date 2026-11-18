import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { ApplicationsModule } from "../applications/applications.module";
import { OpsRunner } from "./ops.runner";
import { OpsCasesController } from "./ops.cases.controller";
import { OpsAssignController } from "./ops.assign.controller";
import { OpsOversightController } from "./ops.oversight.controller";

@Module({
  imports: [NotificationsModule, ApplicationsModule],
  controllers: [OpsCasesController, OpsAssignController, OpsOversightController],
  providers: [OpsRunner],
  exports: [OpsRunner],
})
export class OpsModule {}
