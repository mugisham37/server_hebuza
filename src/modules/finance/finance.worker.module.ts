import { Module } from "@nestjs/common";
import { PaymentsModule } from "../payments/payments.module";
import { FinanceJobs } from "./finance.jobs";

@Module({ imports: [PaymentsModule], providers: [FinanceJobs] })
export class FinanceWorkerModule {}
