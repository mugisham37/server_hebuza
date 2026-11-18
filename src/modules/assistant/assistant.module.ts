import { Module } from "@nestjs/common";
import { BookingModule } from "../booking/booking.module";
import { CatalogueModule } from "../catalogue/catalogue.module";
import { ChatModule } from "../chat/chat.module";
import { AssistantController } from "./assistant.controller";
import { AssistantService } from "./assistant.service";

@Module({ imports: [CatalogueModule, BookingModule, ChatModule], controllers: [AssistantController], providers: [AssistantService], exports: [AssistantService] })
export class AssistantModule {}
