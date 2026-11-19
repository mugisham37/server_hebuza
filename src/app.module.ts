import { InfraCheck } from "./core/http/infra-check";
import { Module } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";
import { TerminusModule } from "@nestjs/terminus";
import { ZodValidationPipe } from "nestjs-zod";
import { ConfigModule } from "./core/config/config.module";
import { ContextModule } from "./core/http/context";
import { EnvelopeInterceptor } from "./core/http/envelope.interceptor";
import { AppExceptionFilter } from "./core/http/errors";
import { HealthController } from "./core/http/health.controller";
import { OpenApiController } from "./core/http/openapi.controller";
import { DbModule } from "./core/db/db.module";
import { AuthCoreModule } from "./core/auth/auth-core.module";
import { QueueModule } from "./core/queue/queue.module";
import { StorageModule } from "./core/storage/storage.module";
import { NotifyModule } from "./core/notify/mail.service";
import { CryptoModule } from "./core/crypto/crypto.service";
import { LoggerModule } from "./core/http/logger";
import { NotificationsModule } from "./modules/notifications/notifications.module";
import { CatalogueModule } from "./modules/catalogue/catalogue.module";
import { SubscriptionsModule } from "./modules/subscriptions/subscriptions.module";
import { PlatformModule } from "./modules/platform/platform.module";
import { AuthModule } from "./modules/auth/auth.module";

import { SystemModule } from "./modules/system/system.module";
import { BookingModule } from "./modules/booking/booking.module";
import { ComplianceModule } from "./modules/compliance/compliance.module";
import { DocumentsModule } from "./modules/documents/documents.module";
import { OpsModule } from "./modules/ops/ops.module";
import { ChatModule } from "./modules/chat/chat.module";
import { WorkforceModule } from "./modules/workforce/workforce.module";
import { WorkModule } from "./modules/work/work.module";
import { CmsModule } from "./modules/cms/cms.module";
import { ReportsModule } from "./modules/reports/reports.module";
import { FieldModule } from "./modules/field/field.module";
import { AgentModule } from "./modules/agent/agent.module";
import { PaymentsModule } from "./modules/payments/payments.module";
import { MarketingModule } from "./modules/marketing/marketing.module";
import { ProcurementModule } from "./modules/procurement/procurement.module";
import { FinanceModule } from "./modules/finance/finance.module";
import { AssistantModule } from "./modules/assistant/assistant.module";
import { PartnersModule } from "./modules/partners/partners.module";
import { WorkerMonitorModule } from "./core/queue/worker-monitor";
import { WorkerFeaturesModule } from "./worker.module";
@Module({
  imports: [
    ConfigModule,
    ContextModule,
    LoggerModule,
    TerminusModule,
    DbModule,
    AuthCoreModule,
    QueueModule,
    WorkerMonitorModule,
    StorageModule,
    NotifyModule,
    CryptoModule,
    // feature modules (Wave 2+)
    NotificationsModule,
    CatalogueModule,
    SubscriptionsModule,
    PlatformModule,
    AuthModule,
    SystemModule,
    ComplianceModule,
    DocumentsModule,
    OpsModule,
    BookingModule,
    ChatModule,
    WorkforceModule,
    WorkModule,
    CmsModule,
    ReportsModule,
    FieldModule,
    AgentModule,
    PaymentsModule,
    MarketingModule,
    ProcurementModule,
    FinanceModule,
    AssistantModule,
    PartnersModule,
    // Read raw env at decoration time (ConfigModule validates the same value at boot).
    ...(process.env.WORKER_MODE === "inline" ? [WorkerFeaturesModule] : []),
  ],
  controllers: [HealthController, OpenApiController],
  providers: [
    InfraCheck,
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
  ],
})
export class AppModule {}
