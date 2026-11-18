import { Module } from "@nestjs/common";
import { CatalogueModule } from "../catalogue/catalogue.module";
import { CmsController } from "./cms.controller";
import { CmsService } from "./cms.service";

@Module({ imports: [CatalogueModule], controllers: [CmsController], providers: [CmsService], exports: [CmsService] })
export class CmsModule {}
