import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { ReportsJobs } from "./reports.jobs";
import { ReportsService } from "./reports.service";

@Module({ imports: [NotificationsModule], providers: [ReportsService, ReportsJobs] })
export class ReportsWorkerModule {}
