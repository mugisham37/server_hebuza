import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { PlatformModule } from "../platform/platform.module";
import { ApplicationsController, SupportController } from "./applications.controller";
import { ApplicationsService } from "./applications.service";
import { SupportService } from "./support.service";

@Module({
  imports: [NotificationsModule, PlatformModule],
  controllers: [ApplicationsController, SupportController],
  providers: [ApplicationsService, SupportService],
  exports: [ApplicationsService, SupportService],
})
export class ApplicationsModule {}
