import { Body, Controller, Get, Patch, Post, Put, Query } from "@nestjs/common";
import { CurrentUser } from "../../core/auth/decorators";
import type { SessionUser } from "../../core/http/context";
import { Route } from "../../core/http/route";
import { ListOut, ListQueryDto, PrefsDto, PrefsOut, ReadDto, ReadOut } from "./notifications.dto";
import { NotificationsService } from "./notifications.service";

@Controller()
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get("notifications")
  @Route({ auth: "user", permission: "ntf.own", out: ListOut })
  list(@Query() q: ListQueryDto, @CurrentUser() me: SessionUser) {
    return this.svc.list(me.id, { limit: q.limit, unread: q.unread === "true" });
  }

  @Post("notifications/read")
  @Route({ auth: "user", permission: "ntf.own", out: ReadOut })
  read(@Body() b: ReadDto, @CurrentUser() me: SessionUser) {
    return this.svc.markRead(me.id, b.ids);
  }

  @Get(["me/notification-preferences", "notifications/preferences"]) // second path = Python alias
  @Route({ auth: "user", permission: "ntf.own", out: PrefsOut })
  prefs(@CurrentUser() me: SessionUser) {
    return this.svc.preferences(me.id);
  }

  @Put("me/notification-preferences")
  @Route({ auth: "user", permission: "ntf.own", out: PrefsOut, audit: "notifications.preferences.updated" })
  putPrefs(@Body() b: PrefsDto, @CurrentUser() me: SessionUser) {
    return this.svc.updatePreferences(me.id, b);
  }

  @Patch("notifications/preferences") // Python alias
  @Route({ auth: "user", permission: "ntf.own", out: PrefsOut, audit: "notifications.preferences.updated" })
  patchPrefs(@Body() b: PrefsDto, @CurrentUser() me: SessionUser) {
    return this.svc.updatePreferences(me.id, b);
  }
}
