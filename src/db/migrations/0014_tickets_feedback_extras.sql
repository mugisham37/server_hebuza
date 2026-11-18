ALTER TABLE "application_feedback" ADD COLUMN "rating_tags" text[];--> statement-breakpoint
ALTER TABLE "application_feedback" ADD COLUMN "rating_comment" text;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "type" varchar(40);--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "contact" varchar(255);--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "case_ref" varchar(64);