import { Module } from "@nestjs/common";
import { TokenService } from "../../core/auth/tokens";
import { LedgerModule } from "../ledger/ledger.module";
import { ProcurementStore } from "./procurement.store";
import { ProcurementJobs } from "./procurement.jobs";

/** Worker side: crons + PO PDF job. TokenService completes ProcDeps (AuthCoreModule is HTTP-only). */
@Module({
  imports: [LedgerModule],
  providers: [ProcurementStore, ProcurementJobs, TokenService],
})
export class ProcurementWorkerModule {}
