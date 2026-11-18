import { Module } from "@nestjs/common";
import { LedgerModule } from "../ledger/ledger.module";
import { ProcurementStore } from "./procurement.store";
import { PROC_CONTROLLERS } from "./procurement.controller";

@Module({
  imports: [LedgerModule],
  controllers: PROC_CONTROLLERS,
  providers: [ProcurementStore],
  exports: [ProcurementStore],
})
export class ProcurementModule {}
