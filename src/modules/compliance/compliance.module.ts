import { Module } from "@nestjs/common";
import { ClientCalendarController } from "./client-calendar.controller";
import { ComplianceController } from "./compliance.controller";
import { ComplianceService } from "./compliance.service";

@Module({ controllers: [ComplianceController, ClientCalendarController], providers: [ComplianceService] })
export class ComplianceModule {}
