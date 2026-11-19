import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { ApplicationsModule } from "../applications/applications.module";
import { ObligationCases } from "./deadlines.autocase";
import { DeadlinesJobs } from "./deadlines.jobs";

@Module({ imports: [NotificationsModule, ApplicationsModule], providers: [DeadlinesJobs, ObligationCases] })
export class DeadlinesWorkerModule {}
