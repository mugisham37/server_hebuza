import { Module } from "@nestjs/common";
import { PublicCache } from "./cache";
import { CatalogueController } from "./catalogue.controller";
import { CatalogueService } from "./catalogue.service";

@Module({
  controllers: [CatalogueController],
  providers: [CatalogueService, PublicCache],
  exports: [CatalogueService, PublicCache],
})
export class CatalogueModule {}
