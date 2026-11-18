import { Module, forwardRef } from "@nestjs/common";
import { BookingModule } from "../booking/booking.module";
import { LedgerModule } from "../ledger/ledger.module";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";
import { PaymentsController } from "./payments.controller";
import { PaymentsJobs } from "./payments.jobs";
import { PaymentsProvider } from "./payments.provider";
import { PaymentsService } from "./payments.service";

@Module({
  imports: [LedgerModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, PaymentsProvider],
  exports: [PaymentsService, LedgerModule],
})
export class PaymentsModule {}

/** Worker entry: jobs + the services they consume. */
@Module({
  imports: [LedgerModule, forwardRef(() => BookingModule), forwardRef(() => SubscriptionsModule)], // forwardRef: booking↔payments file cycle when AppModule loads it (WORKER_MODE=inline)
  providers: [PaymentsService, PaymentsProvider, PaymentsJobs],
})
export class PaymentsWorkerModule {}
