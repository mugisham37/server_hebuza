// Console shell + change approvals (handlers-system, -a), privacy and operations (handlers-system-f), public status feed.
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseInterceptors,
} from "@nestjs/common";
import { Route } from "../../core/http/route";
import {
  AcceptedInterceptor,
  Sys,
  SystemStore,
  type RawCaller,
} from "./system.store";
import * as ops from "./system.ops";
import type { Health } from "@/domain/system/types";
import {
  AlertsReadDto,
  ChangesQueryDto,
  DecisionDto,
  type DecisionIn,
  IncidentEventDto,
  LooseDto,
  ReasonDto,
  RestoreDto,
  RetentionChangeDto,
  SearchQueryDto,
  StatusPostDto,
} from "./system.dto";

const R = { auth: "user" } as const;
const W = { auth: "user", idempotent: true } as const;
const X = "staff/x";

@Controller()
@UseInterceptors(AcceptedInterceptor)
export class SystemOpsController {
  constructor(private readonly s: SystemStore) {}

  @Get(`${X}/summary`)
  @Route(R)
  summary(@Sys() c: RawCaller) {
    return ops.summary(this.s.on(c));
  }
  @Get(`${X}/alerts`)
  @Route(R)
  alerts(@Sys() c: RawCaller) {
    return ops.alerts(this.s.on(c));
  }
  @Post(`${X}/alerts/read`)
  @Route(R)
  markAlerts(@Sys() c: RawCaller, @Body() b: AlertsReadDto) {
    return ops.markAlerts(this.s.on(c), b.ids);
  }
  @Get(`${X}/setup`)
  @Route(R)
  setup(@Sys() c: RawCaller) {
    return ops.setup(this.s.on(c));
  }
  @Get(`${X}/search`)
  @Route(R)
  search(@Sys() c: RawCaller, @Query() q: SearchQueryDto) {
    return ops.search(this.s.on(c), q.q ?? "");
  }
  @Get(`${X}/overview`)
  @Route(R)
  overview(@Sys() c: RawCaller) {
    return ops.overview(this.s.on(c));
  }
  @Get(`${X}/changes`)
  @Route(R)
  changes(@Sys() c: RawCaller, @Query() q: ChangesQueryDto) {
    return ops.changes(this.s.on(c), q);
  }
  @Get(`${X}/changes/:id`)
  @Route(R)
  change(@Sys() c: RawCaller, @Param("id") id: string) {
    return ops.change(this.s.on(c), id);
  }
  @Post(`${X}/changes/:id/decision`)
  @Route(W)
  decide(@Sys() c: RawCaller, @Param("id") id: string, @Body() b: DecisionDto) {
    return ops.decideChange(this.s.on(c), id, b as DecisionIn);
  }
  @Post(`${X}/changes/:id/withdraw`)
  @Route(W)
  withdraw(@Sys() c: RawCaller, @Param("id") id: string) {
    return ops.withdrawChange(this.s.on(c), id);
  }
  @Post(`${X}/changes/:id/repropose`)
  @Route(W)
  repropose(@Sys() c: RawCaller, @Param("id") id: string) {
    return ops.repropose(this.s.on(c), id);
  }

  @Get(`${X}/privacy/map`)
  @Route(R)
  dataMap(@Sys() c: RawCaller) {
    return ops.dataMap(this.s.on(c));
  }
  @Get(`${X}/privacy/processors`)
  @Route(R)
  processors(@Sys() c: RawCaller) {
    return ops.processors(this.s.on(c));
  }
  @Post(`${X}/privacy/processors`)
  @Route(W)
  addProcessor(@Sys() c: RawCaller, @Body() b: LooseDto) {
    return ops.addProcessor(this.s.on(c), b as ops.ProcessorIn);
  }
  @Patch(`${X}/privacy/processors/:id`)
  @Route(R)
  patchProcessor(
    @Sys() c: RawCaller,
    @Param("id") id: string,
    @Body() b: LooseDto,
  ) {
    return ops.patchProcessor(this.s.on(c), id, b as ops.ProcessorIn);
  }
  @Get(`${X}/privacy/retention`)
  @Route(R)
  retention(@Sys() c: RawCaller) {
    return ops.retention(this.s.on(c));
  }
  @Post(`${X}/privacy/retention/dry-run`)
  @Route(R)
  dryRun(@Sys() c: RawCaller) {
    return ops.retentionDryRun(this.s.on(c));
  }
  @Post(`${X}/privacy/retention/changes`)
  @Route(W)
  proposeRetention(@Sys() c: RawCaller, @Body() b: RetentionChangeDto) {
    return ops.proposeRetention(this.s.on(c), b);
  }
  @Get("staff/privacy/requests")
  @Route(R)
  dsrs(@Sys() c: RawCaller) {
    return ops.dsrs(this.s.on(c));
  }
  @Get("staff/privacy/requests/:id")
  @Route(R)
  dsr(@Sys() c: RawCaller, @Param("id") id: string) {
    return ops.dsr(this.s.on(c), id);
  }
  @Post("staff/privacy/requests/:id/:action")
  @Route(R)
  dsrAction(
    @Sys() c: RawCaller,
    @Param("id") id: string,
    @Param("action") action: string,
    @Body() b: ReasonDto,
  ) {
    return ops.dsrAction(this.s.on(c), id, action, b.reason);
  }

  @Get(`${X}/ops/monitoring`)
  @Route(R)
  monitoring(@Sys() c: RawCaller) {
    return ops.monitoring(this.s.on(c));
  }
  @Get(`${X}/ops/backups`)
  @Route(R)
  backups(@Sys() c: RawCaller) {
    return ops.backups(this.s.on(c));
  }
  @Get(`${X}/ops/drills`)
  @Route(R)
  drills(@Sys() c: RawCaller) {
    return ops.drills(this.s.on(c));
  }
  @Post(`${X}/ops/restore`)
  @Route(W)
  restore(@Sys() c: RawCaller, @Body() b: RestoreDto) {
    return ops.restore(this.s.on(c), b);
  }
  @Get(`${X}/ops/posture`)
  @Route(R)
  posture(@Sys() c: RawCaller) {
    return ops.posture(this.s.on(c));
  }
  @Get(`${X}/ops/dependencies`)
  @Route(R)
  dependencies(@Sys() c: RawCaller) {
    return ops.dependencies(this.s.on(c));
  }
  @Post(`${X}/ops/status-updates`)
  @Route(W)
  postStatus(@Sys() c: RawCaller, @Body() b: StatusPostDto) {
    return ops.postStatus(this.s.on(c), {
      ...b,
      state: b.state as Health | undefined,
    });
  }
  @Get(`${X}/ops/incidents`)
  @Route(R)
  incidents(@Sys() c: RawCaller) {
    return ops.incidents(this.s.on(c));
  }
  @Post(`${X}/ops/incidents`)
  @Route(W)
  openIncident(@Sys() c: RawCaller, @Body() b: LooseDto) {
    return ops.openIncident(
      this.s.on(c),
      b as Parameters<typeof ops.openIncident>[1],
    );
  }
  @Get(`${X}/ops/incidents/:id`)
  @Route(R)
  incident(@Sys() c: RawCaller, @Param("id") id: string) {
    return ops.incident(this.s.on(c), id);
  }
  @Patch(`${X}/ops/incidents/:id`)
  @Route(R)
  patchIncident(
    @Sys() c: RawCaller,
    @Param("id") id: string,
    @Body() b: LooseDto,
  ) {
    return ops.patchIncident(this.s.on(c), id, b as ops.IncidentPatchIn);
  }
  @Post(`${X}/ops/incidents/:id/events`)
  @Route(W)
  incidentEvent(
    @Sys() c: RawCaller,
    @Param("id") id: string,
    @Body() b: IncidentEventDto,
  ) {
    return ops.incidentEvent(this.s.on(c), id, b.text);
  }
}
