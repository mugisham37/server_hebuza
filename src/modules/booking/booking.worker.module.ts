import { Module } from "@nestjs/common";
import { CalendarSync } from "./booking.calendar";
import { CatalogueModule } from "../catalogue/catalogue.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PaymentsModule } from "../payments/payments.module";
import { BookingService } from "./booking.service";
import { BookingJobs } from "./booking.jobs";

@Module({ imports: [CatalogueModule, NotificationsModule, PaymentsModule], providers: [BookingService, BookingJobs, CalendarSync] })
export class BookingWorkerModule {}
