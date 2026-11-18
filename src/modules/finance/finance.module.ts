import { Module } from "@nestjs/common";
import { LedgerModule } from "../ledger/ledger.module";
import { ReportsModule } from "../reports/reports.module";
import { FinanceBillingController } from "./finance.billing.controller";
import { FinanceClientController } from "./finance.client.controller";
import { FinanceCoreController } from "./finance.core.controller";
import { FinancePaymentsController } from "./finance.payments.controller";
import { FinanceRefundsController } from "./finance.refunds.controller";
import { FinanceRevenueController } from "./finance.revenue.controller";
import { AcceptedInterceptor, FinRunner } from "./finance.runner";

@Module({
  imports: [LedgerModule, ReportsModule],
  controllers: [
    FinanceCoreController,
    FinanceBillingController,
    FinancePaymentsController,
    FinanceRefundsController,
    FinanceRevenueController,
    FinanceClientController,
  ],
  providers: [FinRunner, AcceptedInterceptor],
  exports: [FinRunner],
})
export class FinanceModule {}
