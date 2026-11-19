import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { ChatController } from "./chat.controller";
import { ChatJobs } from "./chat.jobs";
import { ChatService } from "./chat.service";

@Module({
  imports: [NotificationsModule, RealtimeModule],
  controllers: [ChatController],
  providers: [ChatService, ChatJobs],
  exports: [ChatService],
})
export class ChatModule {}
