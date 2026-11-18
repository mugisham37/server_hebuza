import { Module } from "@nestjs/common";
import { ApplicationsModule } from "../applications/applications.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { DocumentsController } from "./documents.controller";
import { DocumentsService } from "./documents.service";

// W3-A HTTP entry: imports ApplicationsModule (its controllers register through this import).
@Module({
  imports: [ApplicationsModule, NotificationsModule],
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService, ApplicationsModule],
})
export class DocumentsModule {}
