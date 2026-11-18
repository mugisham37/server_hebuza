import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { FieldJobs } from "./field.jobs";

@Module({ imports: [NotificationsModule], providers: [FieldJobs] })
export class FieldWorkerModule {}
