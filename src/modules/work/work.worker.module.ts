import { Module } from "@nestjs/common";
import { WorkJobs } from "./work.jobs";

@Module({ providers: [WorkJobs] })
export class WorkWorkerModule {}
