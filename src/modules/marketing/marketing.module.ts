import { Module } from "@nestjs/common";
import { MarketingRunner } from "./marketing.runner";
import { MarketingCrmController } from "./marketing.crm.controller";
import { MarketingCampaignsController } from "./marketing.campaigns.controller";
import { MarketingInsightsController } from "./marketing.insights.controller";

@Module({
  controllers: [MarketingCrmController, MarketingCampaignsController, MarketingInsightsController],
  providers: [MarketingRunner],
})
export class MarketingModule {}
