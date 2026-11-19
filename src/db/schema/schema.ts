import { type PgTableExtraConfigValue, pgTable, index, foreignKey, check, varchar, text, boolean, timestamp, uniqueIndex, jsonb, bigint, integer, unique, date, numeric, primaryKey } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const chatTemplates = pgTable("chat_templates", {
	templateId: varchar("template_id", { length: 64 }).primaryKey().notNull(),
	title: varchar({ length: 120 }).notNull(),
	bodyRw: text("body_rw").notNull(),
	bodyEn: text("body_en").notNull(),
	bodyFr: text("body_fr").notNull(),
	scope: varchar({ length: 16 }).default('all').notNull(),
	createdBy: varchar("created_by", { length: 64 }),
	isActive: boolean("is_active").default(true).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_chat_templates_scope").using("btree", table.scope.asc().nullsLast()),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.userId],
			name: "fk_chat_templates_created_by_users"
		}).onDelete("set null"),
	check("ck_chat_templates_ck_chat_templates_scope", sql`(scope)::text = ANY ((ARRAY['agent'::character varying, 'admin'::character varying, 'all'::character varying])::text[])`),
]);

export const staffProfiles = pgTable("staff_profiles", {
	userId: varchar("user_id", { length: 64 }).primaryKey().notNull(),
	totpSecretEncrypted: text("totp_secret_encrypted"),
	totpLastStep: integer("totp_last_step"), // last accepted TOTP time-step (replay guard)
	twofaEnabled: boolean("twofa_enabled").notNull(),
	smsPhoneE164: varchar("sms_phone_e164", { length: 32 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.userId],
			name: "fk_staff_profiles_user_id_users"
		}).onDelete("cascade"),
]);

export const applicationMessages = pgTable("application_messages", {
	messageId: varchar("message_id", { length: 64 }).primaryKey().notNull(),
	applicationId: varchar("application_id", { length: 64 }),
	senderId: varchar("sender_id", { length: 64 }),
	senderRole: varchar("sender_role", { length: 32 }),
	content: text().notNull(),
	isInternal: boolean("is_internal").notNull(),
	isSystem: boolean("is_system").notNull(),
	attachments: jsonb().notNull(),
	isReadByClient: boolean("is_read_by_client").notNull(),
	readByAgentAt: timestamp("read_by_agent_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	assignmentId: varchar("assignment_id", { length: 64 }),
	lane: varchar({ length: 16 }).notNull(),
	conversationId: varchar("conversation_id", { length: 64 }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	seq: bigint({ mode: "number" }).notNull(),
	clientMsgId: varchar("client_msg_id", { length: 64 }),
	kind: varchar({ length: 24 }).default('text').notNull(),
	payload: jsonb(),
	replyToId: varchar("reply_to_id", { length: 64 }),
	editedAt: timestamp("edited_at", { withTimezone: true, mode: 'string' }),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
	deletedBy: varchar("deleted_by", { length: 64 }),
	pinnedAt: timestamp("pinned_at", { withTimezone: true, mode: 'string' }),
	pinnedBy: varchar("pinned_by", { length: 64 }),
}, (table) => [
	index("ix_application_messages_application_id").using("btree", table.applicationId.asc().nullsLast()),
	index("ix_application_messages_conversation_id").using("btree", table.conversationId.asc().nullsLast()),
	uniqueIndex("uq_application_messages_client_msg").using("btree", table.senderId.asc().nullsLast(), table.clientMsgId.asc().nullsLast()).where(sql`(client_msg_id IS NOT NULL)`),
	uniqueIndex("uq_application_messages_conversation_seq").using("btree", table.conversationId.asc().nullsLast(), table.seq.asc().nullsLast()),
	foreignKey({
			columns: [table.applicationId],
			foreignColumns: [applications.applicationId],
			name: "fk_application_messages_application_id_applications"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.assignmentId],
			foreignColumns: [applicationAssignmentHistory.id],
			name: "fk_application_messages_assignment_id"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversations.conversationId],
			name: "fk_application_messages_conversation_id"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.deletedBy],
			foreignColumns: [users.userId],
			name: "fk_application_messages_deleted_by"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.pinnedBy],
			foreignColumns: [users.userId],
			name: "fk_application_messages_pinned_by"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.replyToId],
			foreignColumns: [table.messageId],
			name: "fk_application_messages_reply_to_id"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.senderId],
			foreignColumns: [users.userId],
			name: "fk_application_messages_sender_id_users"
		}),
	check("ck_application_messages_kind", sql`(kind)::text = ANY ((ARRAY['text'::character varying, 'system'::character varying, 'doc_request'::character varying, 'doc_shared'::character varying, 'status_update'::character varying, 'payment_request'::character varying, 'appointment'::character varying, 'handoff'::character varying, 'dispute_opened'::character varying, 'dispute_resolved'::character varying, 'admin_joined'::character varying, 'admin_left'::character varying])::text[])`),
	check("ck_application_messages_lane", sql`(lane)::text = ANY ((ARRAY['client'::character varying, 'team'::character varying, 'internal'::character varying, 'direct'::character varying])::text[])`),
]);

export const partnerDocuments = pgTable("partner_documents", {
	documentId: varchar("document_id", { length: 64 }).primaryKey().notNull(),
	partnerId: varchar("partner_id", { length: 64 }).notNull(),
	kind: varchar({ length: 32 }).notNull(),
	originalFilename: varchar("original_filename", { length: 512 }).notNull(),
	storagePath: varchar("storage_path", { length: 1024 }).notNull(),
	mimeType: varchar("mime_type", { length: 128 }).notNull(),
	fileSizeBytes: integer("file_size_bytes").notNull(),
	note: text(),
	uploadedBy: varchar("uploaded_by", { length: 64 }),
	isActive: boolean("is_active").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	status: varchar({ length: 16 }).notNull(),
	reviewNote: text("review_note"),
	reviewedBy: varchar("reviewed_by", { length: 64 }),
	reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("ix_partner_documents_partner_id").using("btree", table.partnerId.asc().nullsLast()),
	foreignKey({
			columns: [table.partnerId],
			foreignColumns: [users.userId],
			name: "fk_partner_documents_partner_id_users"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.reviewedBy],
			foreignColumns: [users.userId],
			name: "fk_partner_documents_reviewed_by"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.uploadedBy],
			foreignColumns: [users.userId],
			name: "fk_partner_documents_uploaded_by_users"
		}).onDelete("set null"),
	check("ck_partner_documents_kind", sql`(kind)::text = ANY ((ARRAY['cv'::character varying, 'contract'::character varying])::text[])`),
	check("ck_partner_documents_status", sql`(status)::text = ANY ((ARRAY['pending'::character varying, 'accepted'::character varying, 'rejected'::character varying])::text[])`),
]);

export const auditLog = pgTable("audit_log", {
	id: varchar({ length: 64 }).primaryKey().notNull(),
	actorId: varchar("actor_id", { length: 64 }),
	actorRole: varchar("actor_role", { length: 32 }),
	action: varchar({ length: 128 }).notNull(),
	resourceType: varchar("resource_type", { length: 64 }).notNull(),
	resourceId: varchar("resource_id", { length: 128 }),
	details: jsonb().notNull(),
	ipAddress: varchar("ip_address", { length: 64 }),
	kind: varchar({ length: 32 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	// P13: hash chain in columns (migration 0004 backfills from details._chain; a trigger makes the table append-only).
	chainSeq: bigint("chain_seq", { mode: "number" }),
	chainPrev: varchar("chain_prev", { length: 64 }),
	chainHash: varchar("chain_hash", { length: 64 }),
}, (table) => [
	uniqueIndex("ux_audit_log_chain_seq").on(table.chainSeq),
	index("ix_audit_log_actor_id").using("btree", table.actorId.asc().nullsLast()),
	index("ix_audit_log_created_at").using("btree", table.createdAt.asc().nullsLast()),
	index("ix_audit_log_kind").using("btree", table.kind.asc().nullsLast()),
	foreignKey({
			columns: [table.actorId],
			foreignColumns: [users.userId],
			name: "fk_audit_log_actor_id_users"
		}).onDelete("set null"),
]);

export const clientDocumentVersions = pgTable("client_document_versions", {
	versionId: varchar("version_id", { length: 64 }).primaryKey().notNull(),
	documentId: varchar("document_id", { length: 64 }).notNull(),
	version: integer().notNull(),
	storagePath: varchar("storage_path", { length: 1024 }).notNull(),
	originalFilename: varchar("original_filename", { length: 512 }).notNull(),
	mimeType: varchar("mime_type", { length: 128 }).notNull(),
	scanStatus: varchar("scan_status", { length: 16 }).default('pending').notNull(), // pending | clean | infected (storage.scan)
	fileSizeBytes: integer("file_size_bytes").notNull(),
	contentSha256: varchar("content_sha256", { length: 64 }).notNull(),
	uploadedAt: timestamp("uploaded_at", { withTimezone: true, mode: 'string' }).notNull(),
	orphanedAt: timestamp("orphaned_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("ix_client_document_versions_content_sha256").using("btree", table.contentSha256.asc().nullsLast()),
	foreignKey({
			columns: [table.documentId],
			foreignColumns: [clientDocuments.documentId],
			name: "fk_client_document_versions_document_id_client_documents"
		}).onDelete("cascade"),
	unique("uq_client_document_versions_document_version").on(table.documentId, table.version),
]);

export const serviceSubcategories = pgTable("service_subcategories", {
	id: varchar({ length: 64 }).primaryKey().notNull(),
	categoryId: varchar("category_id", { length: 64 }).notNull(),
	slug: varchar({ length: 64 }).notNull(),
	nameRw: varchar("name_rw", { length: 128 }).notNull(),
	nameEn: varchar("name_en", { length: 128 }).notNull(),
	nameFr: varchar("name_fr", { length: 128 }).notNull(),
	description: text(),
	descriptionRw: text("description_rw"),
	descriptionEn: text("description_en"),
	descriptionFr: text("description_fr"),
	icon: varchar({ length: 64 }),
	color: varchar({ length: 16 }),
	sortOrder: integer("sort_order").notNull(),
	isActive: boolean("is_active").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	index("ix_service_subcategories_category_id").using("btree", table.categoryId.asc().nullsLast()),
	foreignKey({
			columns: [table.categoryId],
			foreignColumns: [serviceCategories.id],
			name: "fk_service_subcategories_category_id_service_categories"
		}).onDelete("restrict"),
	unique("uq_service_subcategories_slug").on(table.slug),
	check("ck_service_subcategories_color", sql`(color IS NULL) OR ((color)::text = ANY ((ARRAY['marigold'::character varying, 'pink'::character varying, 'green'::character varying, 'blue'::character varying, 'red'::character varying, 'cream'::character varying])::text[]))`),
]);

export const serviceDeadlineRules = pgTable("service_deadline_rules", {
	id: varchar({ length: 64 }).primaryKey().notNull(),
	serviceId: varchar("service_id", { length: 64 }).notNull(),
	label: jsonb().notNull(),
	recurrence: jsonb().notNull(),
	leadDays: integer("lead_days").notNull(),
	remindOffsets: jsonb("remind_offsets").notNull(),
	active: boolean().notNull(),
	sortOrder: integer("sort_order").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	index("ix_service_deadline_rules_service_id").using("btree", table.serviceId.asc().nullsLast()),
	foreignKey({
			columns: [table.serviceId],
			foreignColumns: [services.serviceId],
			name: "fk_service_deadline_rules_service_id_services"
		}).onDelete("cascade"),
]);

export const teamAccessRequests = pgTable("team_access_requests", {
	id: varchar({ length: 64 }).primaryKey().notNull(),
	reference: varchar({ length: 32 }).notNull(),
	email: varchar({ length: 255 }).notNull(),
	kind: varchar({ length: 32 }).notNull(),
	note: text(),
	status: varchar({ length: 32 }).notNull(),
	userAgent: varchar("user_agent", { length: 512 }),
	location: varchar({ length: 128 }),
	resolvedBy: varchar("resolved_by", { length: 64 }),
	resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	index("ix_team_access_requests_email").using("btree", table.email.asc().nullsLast()),
	index("ix_team_access_requests_status").using("btree", table.status.asc().nullsLast()),
	foreignKey({
			columns: [table.resolvedBy],
			foreignColumns: [users.userId],
			name: "fk_team_access_requests_resolved_by_users"
		}).onDelete("set null"),
	unique("uq_team_access_requests_reference").on(table.reference),
	check("ck_team_access_requests_kind", sql`(kind)::text = ANY ((ARRAY['password'::character varying, 'two_factor'::character varying, 'unlock'::character varying, 'other'::character varying])::text[])`),
	check("ck_team_access_requests_status", sql`(status)::text = ANY ((ARRAY['open'::character varying, 'approved'::character varying, 'declined'::character varying])::text[])`),
]);

export const services = pgTable("services", {
	serviceId: varchar("service_id", { length: 64 }).primaryKey().notNull(),
	slug: varchar({ length: 128 }).notNull(),
	name: varchar({ length: 255 }).notNull(),
	category: varchar({ length: 64 }).notNull(),
	shortDescription: text("short_description"),
	description: text(),
	color: varchar({ length: 16 }),
	icon: varchar({ length: 64 }),
	status: varchar({ length: 32 }).notNull(),
	publishedVersion: integer("published_version").notNull(),
	isFeatured: boolean("is_featured").notNull(),
	createdBy: varchar("created_by", { length: 64 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	categoryId: varchar("category_id", { length: 64 }),
	nameRw: varchar("name_rw", { length: 255 }),
	nameEn: varchar("name_en", { length: 255 }),
	nameFr: varchar("name_fr", { length: 255 }),
	shortDescriptionRw: text("short_description_rw"),
	shortDescriptionEn: text("short_description_en"),
	shortDescriptionFr: text("short_description_fr"),
	descriptionRw: text("description_rw"),
	descriptionEn: text("description_en"),
	descriptionFr: text("description_fr"),
	subcategoryId: varchar("subcategory_id", { length: 64 }),
	handler: varchar({ length: 16 }).notNull(),
	deadlineMode: varchar("deadline_mode", { length: 16 }).notNull(),
	pricingMode: varchar("pricing_mode", { length: 16 }).notNull(),
	rangeBasisLabel: jsonb("range_basis_label"),
	planCovered: boolean("plan_covered").notNull(),
	urgentSurchargeType: varchar("urgent_surcharge_type", { length: 16 }),
	urgentSurchargeValue: integer("urgent_surcharge_value"),
}, (table) => [
	index("ix_services_category_id").using("btree", table.categoryId.asc().nullsLast()),
	index("ix_services_subcategory_id").using("btree", table.subcategoryId.asc().nullsLast()),
	foreignKey({
			columns: [table.categoryId],
			foreignColumns: [serviceCategories.id],
			name: "fk_services_category_id_service_categories"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.userId],
			name: "fk_services_created_by_users"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.subcategoryId],
			foreignColumns: [serviceSubcategories.id],
			name: "fk_services_subcategory_id_service_subcategories"
		}).onDelete("restrict"),
	unique("uq_services_slug").on(table.slug),
]);

export const partnerProfiles = pgTable("partner_profiles", {
	userId: varchar("user_id", { length: 64 }).primaryKey().notNull(),
	orgName: varchar("org_name", { length: 255 }).notNull(),
	orgType: varchar("org_type", { length: 64 }).notNull(),
	registrationNumber: varchar("registration_number", { length: 64 }),
	referralCode: varchar("referral_code", { length: 64 }),
	referredByAgentId: varchar("referred_by_agent_id", { length: 64 }),
	status: varchar({ length: 32 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	startingPercent: integer("starting_percent"),
	payoutPhone: varchar("payout_phone", { length: 32 }),
	payoutBankName: varchar("payout_bank_name", { length: 128 }),
	payoutBankAccount: varchar("payout_bank_account", { length: 64 }),
	payoutAccountName: varchar("payout_account_name", { length: 255 }),
}, (table) => [
	index("ix_partner_profiles_referred_by_agent_id").using("btree", table.referredByAgentId.asc().nullsLast()),
	index("ix_partner_profiles_status").using("btree", table.status.asc().nullsLast()),
	foreignKey({
			columns: [table.referredByAgentId],
			foreignColumns: [users.userId],
			name: "fk_partner_profiles_referred_by_agent_id_users"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.userId],
			name: "fk_partner_profiles_user_id_users"
		}).onDelete("cascade"),
	check("ck_partner_profiles_org_type", sql`(org_type)::text = ANY ((ARRAY['law-firm'::character varying, 'accounting'::character varying, 'notary'::character varying, 'business-centre'::character varying, 'consultancy'::character varying, 'other'::character varying])::text[])`),
	check("ck_partner_profiles_starting_percent", sql`(starting_percent IS NULL) OR ((starting_percent >= 0) AND (starting_percent <= 100))`),
	check("ck_partner_profiles_status", sql`(status)::text = ANY ((ARRAY['active'::character varying, 'suspended'::character varying])::text[])`),
]);

export const applicationEscalations = pgTable("application_escalations", {
	id: varchar({ length: 64 }).primaryKey().notNull(),
	applicationId: varchar("application_id", { length: 64 }).notNull(),
	escalatedBy: varchar("escalated_by", { length: 64 }).notNull(),
	reason: text().notNull(),
	oversightStatus: varchar("oversight_status", { length: 32 }).notNull(),
	resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: 'string' }),
	resolvedBy: varchar("resolved_by", { length: 64 }),
	resolutionNote: text("resolution_note"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	kind: varchar({ length: 32 }),
	relatedUserId: varchar("related_user_id", { length: 64 }),
}, (table) => [
	index("ix_application_escalations_application_id").using("btree", table.applicationId.asc().nullsLast()),
	index("ix_application_escalations_oversight_status").using("btree", table.oversightStatus.asc().nullsLast()),
	foreignKey({
			columns: [table.applicationId],
			foreignColumns: [applications.applicationId],
			name: "fk_application_escalations_application_id_applications"
		}),
	foreignKey({
			columns: [table.escalatedBy],
			foreignColumns: [users.userId],
			name: "fk_application_escalations_escalated_by_users"
		}),
	foreignKey({
			columns: [table.relatedUserId],
			foreignColumns: [users.userId],
			name: "fk_application_escalations_related_user_id"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.resolvedBy],
			foreignColumns: [users.userId],
			name: "fk_application_escalations_resolved_by_users"
		}),
]);

export const applicationDocuments = pgTable("application_documents", {
	documentId: varchar("document_id", { length: 64 }).primaryKey().notNull(),
	applicationId: varchar("application_id", { length: 64 }).notNull(),
	requirementKey: varchar("requirement_key", { length: 128 }).notNull(),
	originalFilename: varchar("original_filename", { length: 512 }).notNull(),
	storagePath: varchar("storage_path", { length: 1024 }).notNull(),
	mimeType: varchar("mime_type", { length: 128 }).notNull(),
	scanStatus: varchar("scan_status", { length: 16 }).default('pending').notNull(), // pending | clean | infected (storage.scan)
	fileSizeBytes: integer("file_size_bytes").notNull(),
	uploadedBy: varchar("uploaded_by", { length: 64 }),
	uploadedByRole: varchar("uploaded_by_role", { length: 32 }).notNull(),
	version: integer().notNull(),
	qcStatus: varchar("qc_status", { length: 32 }).notNull(),
	qcNotes: jsonb("qc_notes"),
	isActive: boolean("is_active").notNull(),
	replacedBy: varchar("replaced_by", { length: 64 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	vaultDocumentId: varchar("vault_document_id", { length: 64 }),
	vaultVersion: integer("vault_version"),
	removedAt: timestamp("removed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("ix_application_documents_active_req").using("btree", table.applicationId.asc().nullsLast(), table.requirementKey.asc().nullsLast()),
	index("ix_application_documents_application_id").using("btree", table.applicationId.asc().nullsLast()),
	index("ix_application_documents_vault_document_id").using("btree", table.vaultDocumentId.asc().nullsLast()),
	foreignKey({
			columns: [table.applicationId],
			foreignColumns: [applications.applicationId],
			name: "fk_application_documents_application_id_applications"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.replacedBy],
			foreignColumns: [table.documentId],
			name: "fk_application_documents_replaced_by_application_documents"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.uploadedBy],
			foreignColumns: [users.userId],
			name: "fk_application_documents_uploaded_by_users"
		}),
	foreignKey({
			columns: [table.vaultDocumentId],
			foreignColumns: [clientDocuments.documentId],
			name: "fk_application_documents_vault_document_id"
		}).onDelete("set null"),
]);

export const clientDocuments = pgTable("client_documents", {
	documentId: varchar("document_id", { length: 64 }).primaryKey().notNull(),
	clientId: varchar("client_id", { length: 64 }).notNull(),
	originalFilename: varchar("original_filename", { length: 512 }).notNull(),
	storagePath: varchar("storage_path", { length: 1024 }).notNull(),
	mimeType: varchar("mime_type", { length: 128 }).notNull(),
	fileSizeBytes: integer("file_size_bytes").notNull(),
	label: varchar({ length: 255 }),
	kind: varchar({ length: 64 }),
	isActive: boolean("is_active").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	currentVersion: integer("current_version").default(1).notNull(),
	contentSha256: varchar("content_sha256", { length: 64 }),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("ix_client_documents_client_active").using("btree", table.clientId.asc().nullsLast(), table.isActive.asc().nullsLast()),
	index("ix_client_documents_client_id").using("btree", table.clientId.asc().nullsLast()),
	foreignKey({
			columns: [table.clientId],
			foreignColumns: [users.userId],
			name: "fk_client_documents_client_id"
		}),
]);

export const clientSubscriptions = pgTable("client_subscriptions", {
	subscriptionId: varchar("subscription_id", { length: 64 }).primaryKey().notNull(),
	clientId: varchar("client_id", { length: 64 }).notNull(),
	planId: varchar("plan_id", { length: 64 }).notNull(),
	status: varchar({ length: 32 }).notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).notNull(),
	currentPeriodEnd: timestamp("current_period_end", { withTimezone: true, mode: 'string' }).notNull(),
	lastRecordedPaymentAt: timestamp("last_recorded_payment_at", { withTimezone: true, mode: 'string' }),
	dedicatedAgentId: varchar("dedicated_agent_id", { length: 64 }),
	assignedBy: varchar("assigned_by", { length: 64 }),
	assignedAt: timestamp("assigned_at", { withTimezone: true, mode: 'string' }),
	note: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	// F-SUB-07 self-cancel: honoured by the expiry cron at period end.
	cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
	cancelReason: text("cancel_reason"),
	cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: 'string' }),
	// F-SUB-05/12: reminder offsets already sent this period, and the 80 % usage warning (once per period).
	remindersSent: jsonb("reminders_sent").default([]).notNull(),
	usageWarnedAt: timestamp("usage_warned_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("ix_client_subscriptions_dedicated_agent_id").using("btree", table.dedicatedAgentId.asc().nullsLast()),
	index("ix_client_subscriptions_status").using("btree", table.status.asc().nullsLast()),
	foreignKey({
			columns: [table.assignedBy],
			foreignColumns: [users.userId],
			name: "fk_client_subscriptions_assigned_by_users"
		}),
	foreignKey({
			columns: [table.clientId],
			foreignColumns: [users.userId],
			name: "fk_client_subscriptions_client_id_users"
		}),
	foreignKey({
			columns: [table.dedicatedAgentId],
			foreignColumns: [users.userId],
			name: "fk_client_subscriptions_dedicated_agent_id_users"
		}),
	foreignKey({
			columns: [table.planId],
			foreignColumns: [subscriptionPlans.planId],
			name: "fk_client_subscriptions_plan_id_plans"
		}),
	unique("uq_client_subscriptions_client_id").on(table.clientId),
	check("ck_client_subscriptions_ck_client_subscriptions_status", sql`(status)::text = ANY ((ARRAY['active'::character varying, 'past_due'::character varying, 'paused'::character varying, 'cancelled'::character varying, 'expired'::character varying, 'trial'::character varying])::text[])`),
]);

export const users = pgTable("users", {
	userId: varchar("user_id", { length: 64 }).primaryKey().notNull(),
	name: varchar({ length: 255 }).notNull(),
	email: varchar({ length: 255 }),
	phoneE164: varchar("phone_e164", { length: 32 }),
	passwordHash: text("password_hash").notNull(),
	role: varchar({ length: 32 }).notNull(),
	isActive: boolean("is_active").notNull(),
	isEmailVerified: boolean("is_email_verified").notNull(),
	language: varchar({ length: 8 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	/** CRM-01/IAM-24: HBC-YYYY-NNNNNN-C, assigned at signup (clients) and on guest claim. */
	customerNo: varchar("customer_no", { length: 24 }).unique("uq_users_customer_no"),
	/** IAM-20: account deletion runs at this time unless the user signs in / cancels first. */
	deletionScheduledAt: timestamp("deletion_scheduled_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	unique("uq_users_email_role").on(table.email, table.role),
	unique("uq_users_phone_role").on(table.phoneE164, table.role),
]);

export const messageReferences = pgTable("message_references", {
	id: varchar({ length: 64 }).primaryKey().notNull(),
	messageId: varchar("message_id", { length: 64 }).notNull(),
	refType: varchar("ref_type", { length: 32 }).notNull(),
	refId: varchar("ref_id", { length: 64 }).notNull(),
	snapshot: jsonb().notNull(),
}, (table) => [
	index("ix_message_references_message_id").using("btree", table.messageId.asc().nullsLast()),
	foreignKey({
			columns: [table.messageId],
			foreignColumns: [applicationMessages.messageId],
			name: "fk_message_references_message_id"
		}).onDelete("cascade"),
	check("ck_message_references_ref_type", sql`(ref_type)::text = ANY ((ARRAY['application_document'::character varying, 'library_document'::character varying, 'attachment'::character varying, 'message'::character varying, 'application'::character varying, 'requirement'::character varying])::text[])`),
]);

export const messageEdits = pgTable("message_edits", {
	id: varchar({ length: 64 }).primaryKey().notNull(),
	messageId: varchar("message_id", { length: 64 }).notNull(),
	previousContent: text("previous_content").notNull(),
	editedAt: timestamp("edited_at", { withTimezone: true, mode: 'string' }).notNull(),
	editedBy: varchar("edited_by", { length: 64 }),
}, (table) => [
	index("ix_message_edits_message_id").using("btree", table.messageId.asc().nullsLast()),
	foreignKey({
			columns: [table.editedBy],
			foreignColumns: [users.userId],
			name: "fk_message_edits_edited_by"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.messageId],
			foreignColumns: [applicationMessages.messageId],
			name: "fk_message_edits_message_id"
		}).onDelete("cascade"),
]);

export const dedicatedAgentFocus = pgTable("dedicated_agent_focus", {
	id: varchar({ length: 64 }).primaryKey().notNull(),
	subscriptionId: varchar("subscription_id", { length: 64 }).notNull(),
	categorySlug: varchar("category_slug", { length: 64 }),
	serviceId: varchar("service_id", { length: 64 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	uniqueIndex("uq_dedicated_agent_focus_category").using("btree", table.subscriptionId.asc().nullsLast(), table.categorySlug.asc().nullsLast()).where(sql`(category_slug IS NOT NULL)`),
	uniqueIndex("uq_dedicated_agent_focus_service").using("btree", table.subscriptionId.asc().nullsLast(), table.serviceId.asc().nullsLast()).where(sql`(service_id IS NOT NULL)`),
	foreignKey({
			columns: [table.serviceId],
			foreignColumns: [services.serviceId],
			name: "fk_dedicated_agent_focus_service_id_services"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.subscriptionId],
			foreignColumns: [clientSubscriptions.subscriptionId],
			name: "fk_dedicated_agent_focus_subscription_id_client_subscriptions"
		}).onDelete("cascade"),
	check("ck_dedicated_agent_focus_ck_dedicated_agent_focus_one_target", sql`(category_slug IS NULL) <> (service_id IS NULL)`),
]);

export const clientObligations = pgTable("client_obligations", {
	id: varchar({ length: 64 }).primaryKey().notNull(),
	clientId: varchar("client_id", { length: 64 }).notNull(),
	serviceId: varchar("service_id", { length: 64 }).notNull(),
	ruleId: varchar("rule_id", { length: 64 }),
	periodKey: varchar("period_key", { length: 128 }).notNull(),
	label: jsonb().notNull(),
	dueDate: date("due_date").notNull(),
	leadDays: integer("lead_days").notNull(),
	remindOffsets: jsonb("remind_offsets").notNull(),
	status: varchar({ length: 16 }).notNull(),
	applicationId: varchar("application_id", { length: 64 }),
	note: text(),
	resolvedBy: varchar("resolved_by", { length: 64 }),
	resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	index("ix_client_obligations_client_id").using("btree", table.clientId.asc().nullsLast()),
	index("ix_client_obligations_due_date").using("btree", table.dueDate.asc().nullsLast()),
	foreignKey({
			columns: [table.applicationId],
			foreignColumns: [applications.applicationId],
			name: "fk_client_obligations_application_id_applications"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.clientId],
			foreignColumns: [users.userId],
			name: "fk_client_obligations_client_id_users"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.resolvedBy],
			foreignColumns: [users.userId],
			name: "fk_client_obligations_resolved_by_users"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.ruleId],
			foreignColumns: [serviceDeadlineRules.id],
			name: "fk_client_obligations_rule_id_service_deadline_rules"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.serviceId],
			foreignColumns: [services.serviceId],
			name: "fk_client_obligations_service_id_services"
		}).onDelete("cascade"),
	unique("uq_client_obligations_period").on(table.clientId, table.serviceId, table.periodKey),
	check("ck_client_obligations_ck_client_obligations_status", sql`(status)::text = ANY ((ARRAY['upcoming'::character varying, 'in_progress'::character varying, 'done'::character varying, 'missed'::character varying, 'skipped'::character varying])::text[])`),
]);

export const deadlineNotifications = pgTable("deadline_notifications", {
	id: varchar({ length: 64 }).primaryKey().notNull(),
	targetType: varchar("target_type", { length: 32 }).notNull(),
	targetId: varchar("target_id", { length: 128 }).notNull(),
	offsetDays: integer("offset_days").notNull(),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	unique("uq_deadline_notifications_target").on(table.targetType, table.targetId, table.offsetDays),
]);

export const subscriptionPlans = pgTable("subscription_plans", {
	planId: varchar("plan_id", { length: 64 }).primaryKey().notNull(),
	name: varchar({ length: 255 }).notNull(),
	interval: varchar({ length: 16 }).notNull(),
	amountRwf: integer("amount_rwf").notNull(),
	isActive: boolean("is_active").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	kind: varchar({ length: 32 }).notNull(),
	maxApplicationsPerMonth: integer("max_applications_per_month"),
	trialDays: integer("trial_days"),
	description: text(),
	features: jsonb().notNull(),
	badge: varchar({ length: 64 }),
	sortOrder: integer("sort_order").notNull(),
	isPublic: boolean("is_public").notNull(),
	archivedAt: timestamp("archived_at", { withTimezone: true, mode: 'string' }),
}, () => [
	check("ck_subscription_plans_ck_subscription_plans_amount", sql`amount_rwf >= 0`),
	check("ck_subscription_plans_ck_subscription_plans_interval", sql`("interval")::text = 'month'::text`),
	check("ck_subscription_plans_ck_subscription_plans_kind", sql`(kind)::text = ANY ((ARRAY['trial'::character varying, 'paid'::character varying, 'retainer'::character varying])::text[])`),
]);

export const applicationStatusHistory = pgTable("application_status_history", {
	id: varchar({ length: 64 }).primaryKey().notNull(),
	applicationId: varchar("application_id", { length: 64 }).notNull(),
	status: varchar({ length: 32 }).notNull(),
	changedBy: varchar("changed_by", { length: 64 }),
	changedByRole: varchar("changed_by_role", { length: 32 }),
	note: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	index("ix_app_status_history_application_id").using("btree", table.applicationId.asc().nullsLast()),
	foreignKey({
			columns: [table.applicationId],
			foreignColumns: [applications.applicationId],
			name: "fk_application_status_history_application_id_applications"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.changedBy],
			foreignColumns: [users.userId],
			name: "fk_application_status_history_changed_by_users"
		}),
]);

export const applications = pgTable("applications", {
	applicationId: varchar("application_id", { length: 64 }).primaryKey().notNull(),
	code: varchar({ length: 32 }).notNull(),
	serviceId: varchar("service_id", { length: 64 }).notNull(),
	structureVersionId: varchar("structure_version_id", { length: 64 }).notNull(),
	serviceSlug: varchar("service_slug", { length: 128 }).notNull(),
	serviceName: varchar("service_name", { length: 255 }).notNull(),
	tier: varchar({ length: 32 }).notNull(),
	status: varchar({ length: 32 }).notNull(),
	clientId: varchar("client_id", { length: 64 }),
	assignedAgentId: varchar("assigned_agent_id", { length: 64 }),
	assignedAt: timestamp("assigned_at", { withTimezone: true, mode: 'string' }),
	personalInfo: jsonb("personal_info").notNull(),
	serviceData: jsonb("service_data").notNull(),
	paymentStatus: varchar("payment_status", { length: 32 }).notNull(),
	paymentAmount: integer("payment_amount"),
	submissionIp: varchar("submission_ip", { length: 64 }),
	slaDeadline: timestamp("sla_deadline", { withTimezone: true, mode: 'string' }),
	slaBreachedAt: timestamp("sla_breached_at", { withTimezone: true, mode: 'string' }),
	submittedAt: timestamp("submitted_at", { withTimezone: true, mode: 'string' }).notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	rejectedAt: timestamp("rejected_at", { withTimezone: true, mode: 'string' }),
	cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: 'string' }),
	rejectionReason: text("rejection_reason"),
	cancellationReason: text("cancellation_reason"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	currentAssignmentId: varchar("current_assignment_id", { length: 64 }),
	handler: varchar({ length: 16 }).notNull(),
	ending: varchar({ length: 16 }).notNull(),
	assignedPartnerId: varchar("assigned_partner_id", { length: 64 }),
	quoteStatus: varchar("quote_status", { length: 32 }),
	agreedAmountRwf: integer("agreed_amount_rwf"),
	hebuzaPercent: integer("hebuza_percent"),
	idempotencyKey: varchar("idempotency_key", { length: 128 }),
	partnerClientLaneOpen: boolean("partner_client_lane_open").notNull(),
	dueAt: timestamp("due_at", { withTimezone: true, mode: 'string' }),
	dueSource: varchar("due_source", { length: 16 }).notNull(),
	dueSetBy: varchar("due_set_by", { length: 64 }),
	clientPreferredDate: date("client_preferred_date"),
	isUrgent: boolean("is_urgent").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	basisAmountRwf: bigint("basis_amount_rwf", { mode: "number" }),
	priceBandId: varchar("price_band_id", { length: 64 }),
	priceBandSnapshot: jsonb("price_band_snapshot"),
	/** REQ-08: set while the case sits in a pausesSla status; slaPausedMs = total paused time so far. */
	slaPausedAt: timestamp("sla_paused_at", { withTimezone: true, mode: 'string' }),
	slaPausedMs: bigint("sla_paused_ms", { mode: "number" }).default(0).notNull(),
	/** REQ-16: frozen snapshot written once on completed_delivered. */
	completionRecord: jsonb("completion_record"),
	/** REQ-06: what the external institution decided, as the agent recorded it. */
	externalOutcome: varchar("external_outcome", { length: 32 }),
	externalOutcomeRef: varchar("external_outcome_ref", { length: 128 }),
	externalOutcomeInstitution: varchar("external_outcome_institution", { length: 255 }),
	externalOutcomeAt: timestamp("external_outcome_at", { withTimezone: true, mode: 'string' }),
	/** REQ-02: the basket submission this case belongs to (request_groups.id). */
	groupId: varchar("group_id", { length: 64 }),
}, (table): PgTableExtraConfigValue[] => [ // annotated: applications ⇄ assignment history FK cycle
	index("ix_applications_assigned_agent_id").using("btree", table.assignedAgentId.asc().nullsLast()),
	index("ix_applications_assigned_partner_id").using("btree", table.assignedPartnerId.asc().nullsLast()),
	index("ix_applications_client_id").using("btree", table.clientId.asc().nullsLast()),
	index("ix_applications_due_at").using("btree", table.dueAt.asc().nullsLast()),
	index("ix_applications_service_id").using("btree", table.serviceId.asc().nullsLast()),
	index("ix_applications_status").using("btree", table.status.asc().nullsLast()),
	index("ix_applications_structure_version_id").using("btree", table.structureVersionId.asc().nullsLast()),
	index("ix_applications_submitted_at").using("btree", table.submittedAt.asc().nullsLast()),
	uniqueIndex("uq_applications_idempotency_key").using("btree", table.idempotencyKey.asc().nullsLast()).where(sql`(idempotency_key IS NOT NULL)`),
	foreignKey({
			columns: [table.assignedAgentId],
			foreignColumns: [users.userId],
			name: "fk_applications_assigned_agent_id_users"
		}),
	foreignKey({
			columns: [table.assignedPartnerId],
			foreignColumns: [users.userId],
			name: "fk_applications_assigned_partner_id_users"
		}),
	foreignKey({
			columns: [table.clientId],
			foreignColumns: [users.userId],
			name: "fk_applications_client_id_users"
		}),
	foreignKey({
			columns: [table.currentAssignmentId],
			foreignColumns: [applicationAssignmentHistory.id],
			name: "fk_applications_current_assignment_id"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.dueSetBy],
			foreignColumns: [users.userId],
			name: "fk_applications_due_set_by"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.priceBandId],
			foreignColumns: [servicePriceBands.id],
			name: "fk_applications_price_band_id"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.serviceId],
			foreignColumns: [services.serviceId],
			name: "fk_applications_service_id_services"
		}),
	foreignKey({
			columns: [table.structureVersionId],
			foreignColumns: [serviceStructureVersions.id],
			name: "fk_applications_structure_version_id_service_structure_versions"
		}),
	unique("uq_applications_code").on(table.code),
]);

export const termsAcceptances = pgTable("terms_acceptances", {
	id: varchar({ length: 64 }).primaryKey().notNull(),
	userId: varchar("user_id", { length: 64 }).notNull(),
	policyVersion: varchar("policy_version", { length: 64 }).notNull(),
	acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	index("ix_terms_acceptances_user_id").using("btree", table.userId.asc().nullsLast()),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.userId],
			name: "fk_terms_acceptances_user_id_users"
		}).onDelete("cascade"),
]);

export const messageAttachments = pgTable("message_attachments", {
	id: varchar({ length: 64 }).primaryKey().notNull(),
	applicationId: varchar("application_id", { length: 64 }),
	messageId: varchar("message_id", { length: 64 }),
	uploadedBy: varchar("uploaded_by", { length: 64 }),
	lane: varchar({ length: 16 }).notNull(),
	storagePath: varchar("storage_path", { length: 1024 }).notNull(),
	filename: varchar({ length: 512 }).notNull(),
	mime: varchar({ length: 128 }).notNull(),
	size: integer().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	conversationId: varchar("conversation_id", { length: 64 }),
	sha256: varchar({ length: 64 }),
	scanStatus: varchar("scan_status", { length: 16 }).default('skipped').notNull(),
	thumbnailPath: varchar("thumbnail_path", { length: 1024 }),
	width: integer(),
	height: integer(),
}, (table) => [
	index("ix_message_attachments_application_id").using("btree", table.applicationId.asc().nullsLast()),
	index("ix_message_attachments_conversation_id").using("btree", table.conversationId.asc().nullsLast()),
	index("ix_message_attachments_message_id").using("btree", table.messageId.asc().nullsLast()),
	foreignKey({
			columns: [table.applicationId],
			foreignColumns: [applications.applicationId],
			name: "fk_message_attachments_application_id_applications"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversations.conversationId],
			name: "fk_message_attachments_conversation_id"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.messageId],
			foreignColumns: [applicationMessages.messageId],
			name: "fk_message_attachments_message_id_application_messages"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.uploadedBy],
			foreignColumns: [users.userId],
			name: "fk_message_attachments_uploaded_by_users"
		}).onDelete("set null"),
	check("ck_message_attachments_scan_status", sql`(scan_status)::text = ANY ((ARRAY['pending'::character varying, 'clean'::character varying, 'infected'::character varying, 'skipped'::character varying])::text[])`),
]);

export const paymentSplits = pgTable("payment_splits", {
	id: varchar({ length: 64 }).primaryKey().notNull(),
	paymentId: varchar("payment_id", { length: 64 }).notNull(),
	source: varchar({ length: 16 }).notNull(),
	applicationCode: varchar("application_code", { length: 64 }),
	workerId: varchar("worker_id", { length: 64 }),
	workerRole: varchar("worker_role", { length: 16 }),
	ratePercent: integer("rate_percent").notNull(),
	baseAmountRwf: integer("base_amount_rwf").notNull(),
	hebuzaAmountRwf: integer("hebuza_amount_rwf").notNull(),
	workerAmountRwf: integer("worker_amount_rwf").notNull(),
	governmentFeeRwf: integer("government_fee_rwf").notNull(),
	frozenAt: timestamp("frozen_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	index("ix_payment_splits_application_code").using("btree", table.applicationCode.asc().nullsLast()),
	index("ix_payment_splits_payment_id").using("btree", table.paymentId.asc().nullsLast()),
	index("ix_payment_splits_worker_id").using("btree", table.workerId.asc().nullsLast()),
	foreignKey({
			columns: [table.paymentId],
			foreignColumns: [payments.paymentId],
			name: "fk_payment_splits_payment_id_payments"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.workerId],
			foreignColumns: [users.userId],
			name: "fk_payment_splits_worker_id_users"
		}).onDelete("set null"),
	check("ck_payment_splits_rate_percent", sql`(rate_percent >= 0) AND (rate_percent <= 100)`),
	check("ck_payment_splits_source", sql`(source)::text = ANY ((ARRAY['plan'::character varying, 'service'::character varying, 'partner'::character varying])::text[])`),
]);

export const contactInquiries = pgTable("contact_inquiries", {
	id: varchar({ length: 64 }).primaryKey().notNull(),
	name: varchar({ length: 255 }).notNull(),
	contact: varchar({ length: 255 }).notNull(),
	topic: varchar({ length: 128 }).notNull(),
	message: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
});

export const refreshTokens = pgTable("refresh_tokens", {
	id: varchar({ length: 64 }).primaryKey().notNull(),
	userId: varchar("user_id", { length: 64 }).notNull(),
	familyId: varchar("family_id", { length: 64 }).notNull(),
	tokenHash: varchar("token_hash", { length: 64 }).notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
	replacedByTokenId: varchar("replaced_by_token_id", { length: 64 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("ix_refresh_tokens_family_id").using("btree", table.familyId.asc().nullsLast()),
	index("ix_refresh_tokens_user_id").using("btree", table.userId.asc().nullsLast()),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.userId],
			name: "fk_refresh_tokens_user_id_users"
		}).onDelete("cascade"),
	unique("uq_refresh_tokens_token_hash").on(table.tokenHash),
]);

export const platformSettings = pgTable("platform_settings", {
	id: varchar({ length: 16 }).primaryKey().notNull(),
	acceptNewApps: boolean("accept_new_apps").notNull(),
	guestApps: boolean("guest_apps").notNull(),
	dataRetention: varchar("data_retention", { length: 32 }).notNull(),
	compactTables: boolean("compact_tables").notNull(),
	enforce2Fa: boolean("enforce_2fa").notNull(),
	sessionTimeoutMinutes: integer("session_timeout_minutes").notNull(),
	ipAllowlist: text("ip_allowlist"),
	maintenanceMode: boolean("maintenance_mode").notNull(),
	updatedBy: varchar("updated_by", { length: 64 }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	defaultMonthlyPercent: integer("default_monthly_percent").notNull(),
	defaultOneOffPercent: integer("default_one_off_percent").notNull(),
	requireAgentPapers: boolean("require_agent_papers").notNull(),
	paymentsEnabled: boolean("payments_enabled").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.updatedBy],
			foreignColumns: [users.userId],
			name: "fk_platform_settings_updated_by_users"
		}),
]);

export const passwordResetTokens = pgTable("password_reset_tokens", {
	id: varchar({ length: 64 }).primaryKey().notNull(),
	userId: varchar("user_id", { length: 64 }).notNull(),
	tokenHash: varchar("token_hash", { length: 64 }).notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	usedAt: timestamp("used_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	purpose: varchar({ length: 16 }).notNull(),
}, (table) => [
	index("ix_password_reset_tokens_user_id").using("btree", table.userId.asc().nullsLast()),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.userId],
			name: "fk_password_reset_tokens_user_id_users"
		}).onDelete("cascade"),
	unique("uq_password_reset_tokens_token_hash").on(table.tokenHash),
	check("ck_password_reset_tokens_purpose", sql`(purpose)::text = ANY ((ARRAY['invite'::character varying, 'reset'::character varying])::text[])`),
]);

export const serviceStructureVersions = pgTable("service_structure_versions", {
	id: varchar({ length: 64 }).primaryKey().notNull(),
	serviceId: varchar("service_id", { length: 64 }).notNull(),
	version: integer().notNull(),
	status: varchar({ length: 32 }).notNull(),
	definition: jsonb().notNull(),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.serviceId],
			foreignColumns: [services.serviceId],
			name: "fk_service_structure_versions_service_id_services"
		}).onDelete("cascade"),
	unique("uq_service_structure_versions_service_version").on(table.serviceId, table.version),
]);

export const applicationAssignmentHistory = pgTable("application_assignment_history", {
	id: varchar({ length: 64 }).primaryKey().notNull(),
	applicationId: varchar("application_id", { length: 64 }).notNull(),
	previousAgentId: varchar("previous_agent_id", { length: 64 }),
	newAgentId: varchar("new_agent_id", { length: 64 }),
	performedBy: varchar("performed_by", { length: 64 }).notNull(),
	performedByRole: varchar("performed_by_role", { length: 32 }).notNull(),
	note: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [ // annotated: applications ⇄ assignment history FK cycle
	index("ix_app_assignment_history_application_id").using("btree", table.applicationId.asc().nullsLast()),
	foreignKey({
			columns: [table.applicationId],
			foreignColumns: [applications.applicationId],
			name: "fk_application_assignment_history_application_id_applications"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.newAgentId],
			foreignColumns: [users.userId],
			name: "fk_application_assignment_history_new_agent_id_users"
		}),
	foreignKey({
			columns: [table.performedBy],
			foreignColumns: [users.userId],
			name: "fk_application_assignment_history_performed_by_users"
		}),
	foreignKey({
			columns: [table.previousAgentId],
			foreignColumns: [users.userId],
			name: "fk_application_assignment_history_previous_agent_id_users"
		}),
]);

export const agentSettings = pgTable("agent_settings", {
	userId: varchar("user_id", { length: 64 }).primaryKey().notNull(),
	acceptingCases: boolean("accepting_cases").notNull(),
	dailyCaseCap: integer("daily_case_cap"),
	notificationNewCase: boolean("notification_new_case").notNull(),
	notificationClientReply: boolean("notification_client_reply").notNull(),
	notificationSlaAlert: boolean("notification_sla_alert").notNull(),
	notificationDailySummary: boolean("notification_daily_summary").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	monthlyPercent: integer("monthly_percent"),
	oneOffPercent: integer("one_off_percent"),
	payoutPhone: varchar("payout_phone", { length: 32 }),
	payoutBankName: varchar("payout_bank_name", { length: 128 }),
	payoutBankAccount: varchar("payout_bank_account", { length: 64 }),
	payoutAccountName: varchar("payout_account_name", { length: 255 }),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.userId],
			name: "fk_agent_settings_user_id_users"
		}).onDelete("cascade"),
	check("ck_agent_settings_monthly_percent", sql`(monthly_percent IS NULL) OR ((monthly_percent >= 0) AND (monthly_percent <= 100))`),
	check("ck_agent_settings_one_off_percent", sql`(one_off_percent IS NULL) OR ((one_off_percent >= 0) AND (one_off_percent <= 100))`),
]);

export const agentServiceSkills = pgTable("agent_service_skills", {
	id: varchar({ length: 64 }).primaryKey().notNull(),
	agentId: varchar("agent_id", { length: 64 }).notNull(),
	serviceCategory: varchar("service_category", { length: 64 }).notNull(),
	proficiencyLevel: integer("proficiency_level").notNull(),
	notes: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	index("ix_agent_service_skills_agent_id").using("btree", table.agentId.asc().nullsLast()),
	foreignKey({
			columns: [table.agentId],
			foreignColumns: [users.userId],
			name: "fk_agent_service_skills_agent_id_users"
		}).onDelete("cascade"),
	unique("uq_agent_service_skills_agent_category").on(table.agentId, table.serviceCategory),
	check("ck_agent_service_skills_proficiency_level", sql`(proficiency_level >= 1) AND (proficiency_level <= 5)`),
]);

export const loginAttempts = pgTable("login_attempts", {
	id: varchar({ length: 64 }).primaryKey().notNull(),
	identifier: varchar({ length: 255 }).notNull(),
	ipAddress: varchar("ip_address", { length: 64 }),
	success: boolean().notNull(),
	attemptedAt: timestamp("attempted_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	index("ix_login_attempts_attempted_at").using("btree", table.attemptedAt.asc().nullsLast()),
	index("ix_login_attempts_identifier").using("btree", table.identifier.asc().nullsLast()),
]);

export const conversations = pgTable("conversations", {
	conversationId: varchar("conversation_id", { length: 64 }).primaryKey().notNull(),
	kind: varchar({ length: 16 }).notNull(),
	applicationId: varchar("application_id", { length: 64 }),
	title: varchar({ length: 255 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastSeq: bigint("last_seq", { mode: "number" }).default(sql`'0'`).notNull(),
	lastMessageAt: timestamp("last_message_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	closedAt: timestamp("closed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("ix_conversations_kind").using("btree", table.kind.asc().nullsLast()),
	index("ix_conversations_last_message_at").using("btree", table.lastMessageAt.asc().nullsLast()),
	uniqueIndex("uq_conversations_application_id").using("btree", table.applicationId.asc().nullsLast()).where(sql`(application_id IS NOT NULL)`),
	foreignKey({
			columns: [table.applicationId],
			foreignColumns: [applications.applicationId],
			name: "fk_conversations_application_id"
		}).onDelete("cascade"),
	check("ck_conversations_kind", sql`(kind)::text = ANY ((ARRAY['case'::character varying, 'direct_staff'::character varying, 'direct_partner'::character varying, 'support'::character varying])::text[])`),
]);

export const serviceCategories = pgTable("service_categories", {
	id: varchar({ length: 64 }).primaryKey().notNull(),
	slug: varchar({ length: 64 }).notNull(),
	nameRw: varchar("name_rw", { length: 128 }).notNull(),
	nameEn: varchar("name_en", { length: 128 }).notNull(),
	nameFr: varchar("name_fr", { length: 128 }).notNull(),
	description: text(),
	icon: varchar({ length: 64 }),
	color: varchar({ length: 16 }),
	sortOrder: integer("sort_order").notNull(),
	isActive: boolean("is_active").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	descriptionRw: text("description_rw"),
	descriptionEn: text("description_en"),
	descriptionFr: text("description_fr"),
}, (table) => [
	unique("uq_service_categories_slug").on(table.slug),
	check("ck_service_categories_color", sql`(color IS NULL) OR ((color)::text = ANY ((ARRAY['marigold'::character varying, 'pink'::character varying, 'green'::character varying, 'blue'::character varying, 'red'::character varying, 'cream'::character varying])::text[]))`),
]);

export const backupCodes = pgTable("backup_codes", {
	id: varchar({ length: 64 }).primaryKey().notNull(),
	userId: varchar("user_id", { length: 64 }).notNull(),
	codeHash: varchar("code_hash", { length: 128 }).notNull(),
	usedAt: timestamp("used_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	index("ix_backup_codes_user_id").using("btree", table.userId.asc().nullsLast()),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.userId],
			name: "fk_backup_codes_user_id_users"
		}).onDelete("cascade"),
]);

export const payments = pgTable("payments", {
	paymentId: varchar("payment_id", { length: 64 }).primaryKey().notNull(),
	applicationCode: varchar("application_code", { length: 64 }).notNull(),
	transactionId: varchar("transaction_id", { length: 64 }).notNull(),
	amountRwf: integer("amount_rwf").notNull(),
	governmentFeeRwf: integer("government_fee_rwf").notNull(),
	platformFeeRwf: integer("platform_fee_rwf").notNull(),
	vatRate: numeric("vat_rate", { precision: 4, scale:  3 }).notNull(),
	currency: varchar({ length: 8 }).notNull(),
	method: varchar({ length: 32 }).notNull(),
	providerTransactionId: varchar("provider_transaction_id", { length: 256 }),
	receiptNumber: varchar("receipt_number", { length: 64 }),
	status: varchar({ length: 32 }).notNull(),
	cardBrand: varchar("card_brand", { length: 16 }),
	maskedPhone: varchar("masked_phone", { length: 32 }),
	sessionToken: varchar("session_token", { length: 128 }),
	paidAt: timestamp("paid_at", { withTimezone: true, mode: 'string' }),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	clientId: varchar("client_id", { length: 64 }),
	planId: varchar("plan_id", { length: 64 }),
}, (table) => [
	index("ix_payments_application_code").using("btree", table.applicationCode.asc().nullsLast()),
	index("ix_payments_client_id").using("btree", table.clientId.asc().nullsLast()),
	index("ix_payments_plan_id").using("btree", table.planId.asc().nullsLast()),
	index("ix_payments_status").using("btree", table.status.asc().nullsLast()),
	unique("uq_payments_transaction_id").on(table.transactionId),
	unique("uq_payments_receipt_number").on(table.receiptNumber),
]);

export const servicePricingTiers = pgTable("service_pricing_tiers", {
	id: varchar({ length: 64 }).primaryKey().notNull(),
	serviceId: varchar("service_id", { length: 64 }).notNull(),
	tier: varchar({ length: 32 }).notNull(),
	displayName: varchar("display_name", { length: 128 }).notNull(),
	description: text(),
	platformFee: integer("platform_fee").notNull(),
	governmentFee: integer("government_fee").notNull(),
	etaBusinessDays: integer("eta_business_days").notNull(),
	features: jsonb().notNull(),
	isAvailable: boolean("is_available").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.serviceId],
			foreignColumns: [services.serviceId],
			name: "fk_service_pricing_tiers_service_id_services"
		}).onDelete("cascade"),
	unique("uq_service_pricing_tiers_service_tier").on(table.serviceId, table.tier),
]);

export const trustedDevices = pgTable("trusted_devices", {
	id: varchar({ length: 64 }).primaryKey().notNull(),
	userId: varchar("user_id", { length: 64 }).notNull(),
	fingerprintHash: varchar("fingerprint_hash", { length: 64 }).notNull(),
	trustedUntil: timestamp("trusted_until", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.userId],
			name: "fk_trusted_devices_user_id_users"
		}).onDelete("cascade"),
	unique("uq_trusted_devices_user_id_fingerprint_hash").on(table.userId, table.fingerprintHash),
]);

export const agentDocuments = pgTable("agent_documents", {
	documentId: varchar("document_id", { length: 64 }).primaryKey().notNull(),
	agentId: varchar("agent_id", { length: 64 }).notNull(),
	kind: varchar({ length: 32 }).notNull(),
	originalFilename: varchar("original_filename", { length: 512 }).notNull(),
	storagePath: varchar("storage_path", { length: 1024 }).notNull(),
	mimeType: varchar("mime_type", { length: 128 }).notNull(),
	fileSizeBytes: integer("file_size_bytes").notNull(),
	status: varchar({ length: 32 }).notNull(),
	reviewNote: text("review_note"),
	reviewedBy: varchar("reviewed_by", { length: 64 }),
	reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: 'string' }),
	isActive: boolean("is_active").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	index("ix_agent_documents_agent_id").using("btree", table.agentId.asc().nullsLast()),
	foreignKey({
			columns: [table.agentId],
			foreignColumns: [users.userId],
			name: "fk_agent_documents_agent_id_users"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.reviewedBy],
			foreignColumns: [users.userId],
			name: "fk_agent_documents_reviewed_by_users"
		}).onDelete("set null"),
	check("ck_agent_documents_kind", sql`(kind)::text = ANY ((ARRAY['cv'::character varying, 'contract'::character varying])::text[])`),
	check("ck_agent_documents_status", sql`(status)::text = ANY ((ARRAY['pending'::character varying, 'accepted'::character varying, 'rejected'::character varying])::text[])`),
]);

export const servicePriceBands = pgTable("service_price_bands", {
	id: varchar({ length: 64 }).primaryKey().notNull(),
	serviceId: varchar("service_id", { length: 64 }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	minAmountRwf: bigint("min_amount_rwf", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	maxAmountRwf: bigint("max_amount_rwf", { mode: "number" }),
	feeType: varchar("fee_type", { length: 16 }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	feeRwf: bigint("fee_rwf", { mode: "number" }),
	feePercent: numeric("fee_percent", { precision: 7, scale:  4 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	minFeeRwf: bigint("min_fee_rwf", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	maxFeeRwf: bigint("max_fee_rwf", { mode: "number" }),
	sortOrder: integer("sort_order").notNull(),
}, (table) => [
	index("ix_service_price_bands_service_id").using("btree", table.serviceId.asc().nullsLast()),
	foreignKey({
			columns: [table.serviceId],
			foreignColumns: [services.serviceId],
			name: "fk_service_price_bands_service_id_services"
		}).onDelete("cascade"),
]);

export const messageMentions = pgTable("message_mentions", {
	messageId: varchar("message_id", { length: 64 }).notNull(),
	subjectKey: varchar("subject_key", { length: 80 }).notNull(),
	userId: varchar("user_id", { length: 64 }),
	mentionRole: varchar("mention_role", { length: 32 }),
}, (table) => [
	foreignKey({
			columns: [table.messageId],
			foreignColumns: [applicationMessages.messageId],
			name: "fk_message_mentions_message_id"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.userId],
			name: "fk_message_mentions_user_id"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.messageId, table.subjectKey], name: "pk_message_mentions"}),
	check("ck_message_mentions_mention_subject", sql`((user_id IS NOT NULL) AND (mention_role IS NULL)) OR ((user_id IS NULL) AND ((mention_role)::text = 'admin'::text))`),
]);

export const messageReactions = pgTable("message_reactions", {
	messageId: varchar("message_id", { length: 64 }).notNull(),
	userId: varchar("user_id", { length: 64 }).notNull(),
	emoji: varchar({ length: 16 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	index("ix_message_reactions_message_id").using("btree", table.messageId.asc().nullsLast()),
	foreignKey({
			columns: [table.messageId],
			foreignColumns: [applicationMessages.messageId],
			name: "fk_message_reactions_message_id"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.userId],
			name: "fk_message_reactions_user_id"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.messageId, table.userId, table.emoji], name: "pk_message_reactions"}),
	check("ck_message_reactions_emoji", sql`(emoji)::text = ANY ((ARRAY['👍'::character varying, '✅'::character varying, '🙏'::character varying, '❤️'::character varying, '👀'::character varying])::text[])`),
]);

export const threadReads = pgTable("thread_reads", {
	applicationId: varchar("application_id", { length: 64 }).notNull(),
	userId: varchar("user_id", { length: 64 }).notNull(),
	lastReadAt: timestamp("last_read_at", { withTimezone: true, mode: 'string' }),
	lastNotifiedAt: timestamp("last_notified_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("ix_thread_reads_user_id").using("btree", table.userId.asc().nullsLast()),
	foreignKey({
			columns: [table.applicationId],
			foreignColumns: [applications.applicationId],
			name: "fk_thread_reads_application_id_applications"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.userId],
			name: "fk_thread_reads_user_id_users"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.applicationId, table.userId], name: "pk_thread_reads"}),
]);

export const conversationParticipants = pgTable("conversation_participants", {
	conversationId: varchar("conversation_id", { length: 64 }).notNull(),
	userId: varchar("user_id", { length: 64 }).notNull(),
	role: varchar({ length: 32 }).notNull(),
	joinedAt: timestamp("joined_at", { withTimezone: true, mode: 'string' }).notNull(),
	leftAt: timestamp("left_at", { withTimezone: true, mode: 'string' }),
	leftReason: varchar("left_reason", { length: 32 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastReadSeq: bigint("last_read_seq", { mode: "number" }).default(sql`'0'`).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastDeliveredSeq: bigint("last_delivered_seq", { mode: "number" }).default(sql`'0'`).notNull(),
	lastNotifiedAt: timestamp("last_notified_at", { withTimezone: true, mode: 'string' }),
	mutedUntil: timestamp("muted_until", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("ix_conversation_participants_conversation").using("btree", table.conversationId.asc().nullsLast()),
	index("ix_conversation_participants_user_left").using("btree", table.userId.asc().nullsLast(), table.leftAt.asc().nullsLast()),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversations.conversationId],
			name: "fk_conversation_participants_conversation_id"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.userId],
			name: "fk_conversation_participants_user_id"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.conversationId, table.userId], name: "pk_conversation_participants"}),
	check("ck_conversation_participants_left_reason", sql`(left_reason IS NULL) OR ((left_reason)::text = ANY ((ARRAY['unassigned'::character varying, 'reassigned'::character varying, 'closed'::character varying, 'left'::character varying])::text[]))`),
	check("ck_conversation_participants_role", sql`(role)::text = ANY ((ARRAY['client'::character varying, 'partner'::character varying, 'agent'::character varying, 'admin'::character varying])::text[])`),
]);
