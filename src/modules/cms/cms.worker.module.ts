import { Module } from "@nestjs/common";
import { CatalogueModule } from "../catalogue/catalogue.module";
import { CmsJobs } from "./cms.jobs";

@Module({ imports: [CatalogueModule], providers: [CmsJobs] })
export class CmsWorkerModule {}
