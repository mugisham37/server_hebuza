import { forwardRef, Module } from "@nestjs/common";
import { CatalogueModule } from "../catalogue/catalogue.module";
import { LedgerModule } from "../ledger/ledger.module";
import { PaymentsModule } from "../payments/payments.module";
import { BookingController } from "./booking.controller";
import { BookingService } from "./booking.service";

@Module({
  imports: [CatalogueModule, LedgerModule, forwardRef(() => PaymentsModule)], // payments.module imports BookingModule (worker)
  controllers: [BookingController],
  providers: [BookingService],
  exports: [BookingService],
})
export class BookingModule {}
