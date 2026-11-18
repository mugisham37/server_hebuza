import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { WorkforceController } from "./workforce.controller";
import { WorkforceService } from "./workforce.service";

@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [WorkforceController],
  providers: [WorkforceService],
  exports: [WorkforceService],
})
export class WorkforceModule {}
