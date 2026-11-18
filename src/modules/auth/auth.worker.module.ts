import { Module } from "@nestjs/common";
import { AuthJobs } from "./auth.jobs";

@Module({ providers: [AuthJobs] })
export class AuthWorkerModule {}
