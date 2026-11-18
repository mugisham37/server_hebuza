import { Module } from "@nestjs/common";
import { OpsJobs } from "./ops.jobs";

@Module({ providers: [OpsJobs] })
export class OpsWorkerModule {}
