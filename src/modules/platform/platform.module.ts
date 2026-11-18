import { Module } from "@nestjs/common";
import { CatalogueModule } from "../catalogue/catalogue.module";
import { PlatformController } from "./platform.controller";
import { PlatformService } from "./platform.service";
import { StatusService } from "./platform.status";

@Module({
  imports: [CatalogueModule],
  controllers: [PlatformController],
  providers: [PlatformService, StatusService],
  exports: [PlatformService],
})
export class PlatformModule {}
