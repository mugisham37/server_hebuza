import { Module } from "@nestjs/common";
import { BookingModule } from "../booking/booking.module";
import { CatalogueModule } from "../catalogue/catalogue.module";
import { ChatModule } from "../chat/chat.module";
import { AssistantJobs } from "./assistant.jobs";
import { AssistantService } from "./assistant.service";

@Module({ imports: [CatalogueModule, BookingModule, ChatModule], providers: [AssistantService, AssistantJobs] })
export class AssistantWorkerModule {}
