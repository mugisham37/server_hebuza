import { Module } from "@nestjs/common";
import { SubscriptionsJobs } from "./subscriptions.jobs";

@Module({ providers: [SubscriptionsJobs] })
export class SubscriptionsWorkerModule {}
