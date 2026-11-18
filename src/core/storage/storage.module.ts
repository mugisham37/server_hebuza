import { Global, Module } from "@nestjs/common";
import { StorageService } from "./storage.service";
import { ScanProcessor } from "./scan.processor";

@Global()
@Module({ providers: [StorageService, ScanProcessor], exports: [StorageService] })
export class StorageModule {}
