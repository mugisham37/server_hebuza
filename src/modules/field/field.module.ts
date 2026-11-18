import { Module } from "@nestjs/common";
import { PaymentsModule } from "../payments/payments.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { FieldController } from "./field.controller";
import { FieldService } from "./field.service";

@Module({ imports: [NotificationsModule, PaymentsModule], controllers: [FieldController], providers: [FieldService], exports: [FieldService] })
export class FieldModule {}
