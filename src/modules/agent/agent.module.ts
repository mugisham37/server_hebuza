import { Module } from "@nestjs/common";
import { ChatModule } from "../chat/chat.module";
import { DocumentsModule } from "../documents/documents.module";
import { OpsModule } from "../ops/ops.module";
import { AgentController } from "./agent.controller";

// HTTP only; no jobs (offer expiry / SLA crons live in ops).
@Module({
  imports: [OpsModule, DocumentsModule, ChatModule],
  controllers: [AgentController],
})
export class AgentModule {}
