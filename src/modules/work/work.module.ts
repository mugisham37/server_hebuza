import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { OpsModule } from "../ops/ops.module";
import { WorkforceModule } from "../workforce/workforce.module";
import { WorkController, WorkJoinController, WorkStaffController } from "./work.controller";
import { WorkRunner } from "./work.runner";

@Module({
  imports: [AuthModule, OpsModule, WorkforceModule],
  controllers: [WorkJoinController, WorkController, WorkStaffController],
  providers: [WorkRunner],
})
export class WorkModule {}
