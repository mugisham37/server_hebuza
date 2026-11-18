import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { DeadlinesJobs } from "./deadlines.jobs";

@Module({ imports: [NotificationsModule], providers: [DeadlinesJobs] })
export class DeadlinesWorkerModule {}
