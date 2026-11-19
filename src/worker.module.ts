import { AuditExport } from "./core/db/audit-export";
import { Global, Module } from "@nestjs/common";
import { TokenService } from "./core/auth/tokens";
import { PasswordService } from "./core/auth/password";
import { CookieService } from "./core/auth/cookies";
import { ConfigModule } from "./core/config/config.module";
import { ContextModule } from "./core/http/context";
import { LoggerModule } from "./core/http/logger";
import { DbModule } from "./core/db/db.module";
import { DiscoveryModule } from "@nestjs/core";
import { QueueModule } from "./core/queue/queue.module";
import { JobExplorer } from "./core/queue/cron";
import { OutboxRelay } from "./core/queue/outbox.relay";
import { WorkerHeartbeat } from "./core/queue/worker-heartbeat";
import { StorageModule } from "./core/storage/storage.module";
import { NotifyModule } from "./core/notify/mail.service";
import { CryptoModule } from "./core/crypto/crypto.service";
import { NotificationsModule } from "./modules/notifications/notifications.module";
import { AuthWorkerModule } from "./modules/auth/auth.worker.module";
import { SystemWorkerModule } from "./modules/system/system.worker.module";
import { BookingWorkerModule } from "./modules/booking/booking.worker.module";
import { SubscriptionsWorkerModule } from "./modules/subscriptions/subscriptions.worker.module";
import { OpsWorkerModule } from "./modules/ops/ops.worker.module";
import { PartnersWorkerModule } from "./modules/partners/partners.module";
import { DocumentsWorkerModule } from "./modules/documents/documents.worker.module";
import { WorkWorkerModule } from "./modules/work/work.worker.module";
import { CmsWorkerModule } from "./modules/cms/cms.worker.module";
import { ReportsWorkerModule } from "./modules/reports/reports.worker.module";
import { FieldWorkerModule } from "./modules/field/field.worker.module";
import { PaymentsWorkerModule } from "./modules/payments/payments.module";
import { MarketingWorkerModule } from "./modules/marketing/marketing.worker.module";
import { ProcurementWorkerModule } from "./modules/procurement/procurement.worker.module";
import { FinanceWorkerModule } from "./modules/finance/finance.worker.module";
import { AssistantWorkerModule } from "./modules/assistant/assistant.worker.module";

/** Feature modules pulled in transitively carry controllers that inject auth services; AuthCoreModule (guards) is HTTP-only. */
@Global()
@Module({ providers: [TokenService, PasswordService, CookieService], exports: [TokenService, PasswordService, CookieService] })
class WorkerAuthModule {}

// Job-running part of the worker; also imported by AppModule when WORKER_MODE=inline (one source of truth).
// Feature modules that own *.jobs.ts are appended here (their providers carry @Job/@Cron).
@Module({
  imports: [DiscoveryModule, NotificationsModule, AuthWorkerModule, SystemWorkerModule, SubscriptionsWorkerModule, OpsWorkerModule, BookingWorkerModule, DocumentsWorkerModule, CmsWorkerModule, ReportsWorkerModule, FieldWorkerModule, WorkWorkerModule, PaymentsWorkerModule, ProcurementWorkerModule, MarketingWorkerModule, FinanceWorkerModule, AssistantWorkerModule, PartnersWorkerModule],
  providers: [JobExplorer, OutboxRelay, WorkerHeartbeat, AuditExport],
})
export class WorkerFeaturesModule {}

@Module({
  imports: [ConfigModule, WorkerAuthModule, ContextModule, LoggerModule, DbModule, QueueModule, StorageModule, NotifyModule, CryptoModule, WorkerFeaturesModule],
})
export class WorkerModule {}
