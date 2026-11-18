import { Module } from "@nestjs/common";
import { RealtimeModule } from "../realtime/realtime.module";
import { NotificationsController } from "./notifications.controller";
import { NotificationsJobs } from "./notifications.jobs";
import { NotificationsService } from "./notifications.service";

// Imported by both AppModule and WorkerModule; @Job/@Cron only run in the worker (JobExplorer).
@Module({
  imports: [RealtimeModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsJobs],
  exports: [NotificationsService],
})
export class NotificationsModule {}
