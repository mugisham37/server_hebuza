import { Module } from "@nestjs/common";
import { MarketingClientController } from "./marketing.client.controller";
import { MarketingRunner } from "./marketing.runner";
import { MarketingCrmController } from "./marketing.crm.controller";
import { MarketingCampaignsController } from "./marketing.campaigns.controller";
import { MarketingInsightsController } from "./marketing.insights.controller";

@Module({
  controllers: [MarketingCrmController, MarketingCampaignsController, MarketingInsightsController, MarketingClientController],
  providers: [MarketingRunner],
})
export class MarketingModule {}
