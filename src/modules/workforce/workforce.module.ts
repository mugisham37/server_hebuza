import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { WorkforceController } from "./workforce.controller";
import { WorkforceService } from "./workforce.service";
import { TeamController, TeamService } from "./workforce.team";

@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [WorkforceController, TeamController],
  providers: [WorkforceService, TeamService],
  exports: [WorkforceService],
})
export class WorkforceModule {}
