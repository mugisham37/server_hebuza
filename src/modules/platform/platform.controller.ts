import { Controller, Get } from "@nestjs/common";
import { Route } from "../../core/http/route";
import { PlatformSettingsOut, PublicSettingsOut, StatusOut } from "./platform.dto";
import { PlatformService } from "./platform.service";
import { StatusService } from "./platform.status";

@Controller()
export class PlatformController {
  constructor(private readonly svc: PlatformService, private readonly status: StatusService) {}

  @Get("admin/settings")
  @Route({ auth: ["staff:sysadmin"], permission: "set.configure", out: PlatformSettingsOut })
  settings() {
    return this.svc.getSettings();
  }
  @Get("platform/public-settings")
  @Route({ auth: "public", limit: "read", out: PublicSettingsOut })
  publicSettings() {
    return this.svc.getPublicSettings();
  }
  @Get("status")
  @Route({ auth: "public", limit: "read", out: StatusOut })
  getStatus() {
    return this.status.get();
  }
}
