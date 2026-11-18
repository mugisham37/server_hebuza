import { Module } from "@nestjs/common";
import { MarketingJobs } from "./marketing.jobs";

@Module({ providers: [MarketingJobs] })
export class MarketingWorkerModule {}
