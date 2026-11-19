import { Module } from "@nestjs/common";
import { AccountController } from "./account.controller";
import { AccountService } from "./account.service";
import { OrgService } from "./org.service";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({ imports: [NotificationsModule], controllers: [AccountController], providers: [AccountService, OrgService], exports: [AccountService, OrgService] })
export class AccountModule {}
