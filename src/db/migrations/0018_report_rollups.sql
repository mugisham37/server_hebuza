CREATE TABLE "rpt_daily_facts" (
	"day" varchar(10) NOT NULL,
	"metric" varchar(32) NOT NULL,
	"value" double precision NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pk_rpt_daily_facts" PRIMARY KEY("day","metric")
);
