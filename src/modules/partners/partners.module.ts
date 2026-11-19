import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { PartnersController } from "./partners.controller";
import { PartnersService } from "./partners.service";

@Module({ imports: [NotificationsModule], controllers: [PartnersController], providers: [PartnersService] })
export class PartnersModule {}

/** Worker side: the partners.daily cron (reminders, dormancy, commissions). */
@Module({ imports: [NotificationsModule], providers: [PartnersService] })
export class PartnersWorkerModule {}
