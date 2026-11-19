// P5 tables (new): ops workspace, staff agent workspace, compliance calendar.
// Case-level ops/agent state that has no column on `applications` lives in ops_case_meta.data (typed in
// modules/ops.store.ts) under a version counter, so concurrent writers serialise on the row (SELECT … FOR UPDATE).
// shortcut: reviews, approvals, tickets, offers, views, leave, notes, templates and earnings rows share one typed
// record table (ops_records, discriminated by kind) instead of one table each; split a kind into its own table
// when it needs relational queries beyond (kind, owner, ref, state).
import {
  pgTable,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  date,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";

import { applications, users } from "./schema";

const ts = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });

export const opsCaseMeta = pgTable(
  "ops_case_meta",
  {
    applicationId: varchar("application_id", { length: 64 })
      .primaryKey()
      .notNull()
      .references(() => applications.applicationId, { onDelete: "cascade" }),
    code: varchar({ length: 32 }).notNull(),
    data: jsonb().notNull().default({}),
    version: integer().notNull().default(1),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_ops_case_meta_code").on(t.code)],
);

export const opsCaseEvents = pgTable(
  "ops_case_events",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    applicationId: varchar("application_id", { length: 64 })
      .notNull()
      .references(() => applications.applicationId, { onDelete: "cascade" }),
    /** status | assignment | document | message | payment | note | system | time */
    kind: varchar({ length: 16 }).notNull(),
    /** ops = manager timeline, agent = agent workbench feed */
    feed: varchar({ length: 8 }).notNull().default("ops"),
    actorId: varchar("actor_id", { length: 64 }),
    actorName: varchar("actor_name", { length: 255 }).notNull(),
    fromValue: varchar("from_value", { length: 255 }),
    toValue: varchar("to_value", { length: 255 }),
    text: text(),
    ip: varchar({ length: 64 }),
    internal: boolean().notNull().default(false),
    client: boolean().notNull().default(false),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [index("ix_ops_case_events_app_at").on(t.applicationId, t.at)],
);

export const opsRecords = pgTable(
  "ops_records",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    kind: varchar({ length: 24 }).notNull(),
    ownerId: varchar("owner_id", { length: 64 }),
    ref: varchar({ length: 64 }),
    state: varchar({ length: 24 }),
    data: jsonb().notNull().default({}),
    version: integer().notNull().default(1),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("ix_ops_records_kind_owner").on(t.kind, t.ownerId),
    index("ix_ops_records_kind_ref").on(t.kind, t.ref),
    index("ix_ops_records_kind_state").on(t.kind, t.state),
  ],
);

/** Ops view of an agent: capacity, skills and the agent's own workspace settings (duty, onboarding, availability…). */
export const agentProfiles = pgTable("agent_profiles", {
  userId: varchar("user_id", { length: 64 })
    .primaryKey()
    .notNull()
    .references(() => users.userId, { onDelete: "cascade" }),
  title: varchar({ length: 120 }).notNull().default("Agent"),
  external: boolean().notNull().default(false),
  location: varchar({ length: 120 }),
  costRwf: integer("cost_rwf"),
  cap: integer().notNull().default(8),
  shareBps: integer("share_bps").notNull().default(3000),
  managerId: varchar("manager_id", { length: 64 }).references(
    () => users.userId,
    { onDelete: "set null" },
  ),
  languages: jsonb().notNull().default(["rw"]),
  services: jsonb().notNull().default([]),
  skills: jsonb().notNull().default({}),
  skillsLabel: jsonb("skills_label").notNull().default([]),
  /** available | leave | parttime */
  status: varchar({ length: 16 }).notNull().default("available"),
  onLeaveUntil: date("on_leave_until"),
  onTimeBps: integer("on_time_bps").notNull().default(9000),
  ratingX10: integer("rating_x10").notNull().default(45),
  duty: varchar({ length: 8 }).notNull().default("on"),
  /** F-WRK-09: new assignments per day (null = no daily limit); `cap` is the max concurrent open cases. */
  dailyCap: integer("daily_cap"),
  // F-WRK-01 unified worker profile: work contacts (shown to staff/clients) are separate from private ones (encrypted in wf_worker).
  workEmail: varchar("work_email", { length: 255 }),
  workPhone: varchar("work_phone", { length: 32 }),
  socialLinks: jsonb("social_links").notNull().default({}),
  awayUntil: ts("away_until"),
  /** new | in_progress | submitted | changes_requested | cleared */
  clearance: varchar({ length: 24 }).notNull().default("new"),
  /** onboarding, availability, notificationMatrix, contract, icsToken, payoutMethod */
  ws: jsonb().notNull().default({}),
  version: integer().notNull().default(1),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Ops facts about a client account that the users table doesn't carry. */
export const opsClientProfiles = pgTable("ops_client_profiles", {
  userId: varchar("user_id", { length: 64 })
    .primaryKey()
    .notNull()
    .references(() => users.userId, { onDelete: "cascade" }),
  type: varchar({ length: 16 }).notNull().default("individual"),
  flags: jsonb().notNull().default([]),
  dedicatedAgentId: varchar("dedicated_agent_id", { length: 64 }).references(
    () => users.userId,
    { onDelete: "set null" },
  ),
  since: varchar({ length: 8 }),
});

export const complianceRules = pgTable(
  "compliance_rules",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    code: varchar({ length: 64 }).notNull(),
    authority: varchar({ length: 16 }).notNull(),
    label: jsonb().notNull(),
    recurrence: jsonb().notNull(),
    dueRule: varchar("due_rule", { length: 24 })
      .notNull()
      .default("next_business_day"),
    leadDays: integer("lead_days").notNull(),
    remindOffsets: jsonb("remind_offsets").notNull().default([]),
    serviceSlug: varchar("service_slug", { length: 128 }),
    active: boolean().notNull().default(true),
    verified: boolean().notNull().default(false),
    updatedBy: varchar("updated_by", { length: 64 }),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_compliance_rules_code").on(t.code)],
);

export const complianceHolidays = pgTable(
  "compliance_holidays",
  {
    day: date().notNull(),
    name: varchar({ length: 120 }).notNull(),
    country: varchar({ length: 2 }).notNull().default("RW"),
  },
  (t) => [primaryKey({ columns: [t.country, t.day] })],
);

