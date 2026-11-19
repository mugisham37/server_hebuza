import { forwardRef, Module } from "@nestjs/common";
import { CatalogueModule } from "../catalogue/catalogue.module";
import { LedgerModule } from "../ledger/ledger.module";
import { PaymentsModule } from "../payments/payments.module";
import { BookingController } from "./booking.controller";
import { BookingService } from "./booking.service";
import { CalendarSync, CalendarSyncController } from "./booking.calendar";

@Module({
  imports: [CatalogueModule, LedgerModule, forwardRef(() => PaymentsModule)], // payments.module imports BookingModule (worker)
  controllers: [BookingController, CalendarSyncController],
  providers: [BookingService, CalendarSync],
  exports: [BookingService],
})
export class BookingModule {}
