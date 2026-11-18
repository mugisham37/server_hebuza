ALTER TABLE "field_scans" ADD COLUMN "scan_status" varchar(16) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "application_documents" ADD COLUMN "scan_status" varchar(16) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "client_document_versions" ADD COLUMN "scan_status" varchar(16) DEFAULT 'pending' NOT NULL;