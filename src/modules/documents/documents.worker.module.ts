import { Module } from "@nestjs/common";
import { DeadlinesWorkerModule } from "../deadlines/deadlines.worker.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { DocumentsJobs } from "./documents.jobs";

// W3-A worker entry: also carries the deadlines cron (one registration line in worker.module.ts).
@Module({ imports: [NotificationsModule, DeadlinesWorkerModule], providers: [DocumentsJobs] })
export class DocumentsWorkerModule {}
