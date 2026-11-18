// P12 assistant tables: settings + spend, sessions and their (PII-masked) messages, AI drafts, knowledge sources and
// their retrieval chunks, reindex jobs, eval runs and human handoffs.
// Retrieval: Postgres full-text search over ai_kb_chunks (GIN expression index, 'simple' config for en/fr/rw).
// Optional vector retrieval: ai_kb_embeddings (Voyage voyage-3.5, 1024 dims) exists only where pgvector is installed (migration 0012).
// A side table, not a column on ai_kb_chunks: Drizzle inserts name every column, which would fail on servers without the column.
import {
  pgTable,
  varchar,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
  customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { KbSource } from "@/domain/booking/types";

/** pgvector column; values travel as the '[a,b,…]' text literal. */
const vector = customType<{ data: number[]; driverData: string; config: { dimensions: number } }>({
  dataType: (c) => `vector(${c?.dimensions ?? 1024})`,
  toDriver: (v) => `[${v.join(",")}]`,
  fromDriver: (v) => JSON.parse(v) as number[],
});

const ts = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });
const now = (name: string) => ts(name).notNull().defaultNow();

/** Singleton id 'global'. Money is micro-USD integers (no floats). */
export const aiSettings = pgTable("ai_settings", {
  id: varchar({ length: 16 }).primaryKey().notNull(),
  enabled: boolean().notNull().default(true),
  budgetUsd: integer("budget_usd").notNull(),
  perIpDaily: integer("per_ip_daily").notNull(),
  retentionMonths: integer("retention_months").notNull(),
  officeHours: varchar("office_hours", { length: 64 }).notNull(),
  /** Extra PLACEHOLDER facts (handoff promise, WhatsApp number, prices per MTok, model). */
  value: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  version: integer().notNull().default(1),
  updatedAt: now("updated_at"),
});

export const aiSessions = pgTable(
  "ai_sessions",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    lang: varchar({ length: 4 }).notNull(),
    context: varchar({ length: 16 }).notNull(),
    ownerId: varchar("owner_id", { length: 64 }),
    ipHash: varchar("ip_hash", { length: 64 }),
    title: varchar({ length: 120 }).notNull().default("New chat"),
    turns: integer().notNull().default(0),
    lowConf: integer("low_conf").notNull().default(0),
    abuse: integer().notNull().default(0),
    blocked: boolean().notNull().default(false),
    handedOff: boolean("handed_off").notNull().default(false),
    outcome: varchar({ length: 24 }).notNull().default("abandoned"),
    rating: integer(),
    intake: jsonb().$type<{
      slug: string;
      step: number;
      answers: Record<string, string>;
      unsure: number;
    } | null>(),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    costMicroUsd: integer("cost_micro_usd").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    model: varchar({ length: 64 }),
    startedAt: now("started_at"),
    lastAt: now("last_at"),
  },
  (t) => [
    index("ix_ai_sessions_started").on(t.startedAt),
    index("ix_ai_sessions_owner").on(t.ownerId, t.startedAt),
  ],
);

export const aiMessages = pgTable(
  "ai_messages",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    sessionId: varchar("session_id", { length: 64 }).notNull(),
    role: varchar({ length: 12 }).notNull(),
    /** Always the masked text: raw PII never reaches the database. */
    text: text().notNull(),
    sources: jsonb().$type<string[]>().notNull().default([]),
    flags: jsonb().$type<string[]>().notNull().default([]),
    outcome: varchar({ length: 24 }),
    rating: integer(),
    comment: text(),
    createdAt: now("created_at"),
  },
  (t) => [
    index("ix_ai_messages_session").on(t.sessionId, t.createdAt),
    index("ix_ai_messages_outcome").on(t.outcome, t.createdAt),
  ],
);

export const aiDrafts = pgTable("ai_drafts", {
  id: varchar({ length: 64 }).primaryKey().notNull(),
  sessionId: varchar("session_id", { length: 64 }),
  ownerId: varchar("owner_id", { length: 64 }),
  serviceSlug: varchar("service_slug", { length: 128 }).notNull(),
  answers: jsonb().$type<Record<string, string>>().notNull().default({}),
  status: varchar({ length: 16 }).notNull(),
  structureVersion: integer("structure_version").notNull().default(1),
  expiresAt: ts("expires_at").notNull(),
  createdAt: now("created_at"),
});

export const aiKbSources = pgTable("ai_kb_sources", {
  id: varchar({ length: 64 }).primaryKey().notNull(),
  title: varchar({ length: 255 }).notNull(),
  kind: varchar({ length: 24 }).$type<KbSource["kind"]>().notNull(),
  locale: varchar({ length: 4 }).notNull(),
  status: varchar({ length: 24 }).$type<KbSource["status"]>().notNull(),
  owner: varchar({ length: 255 }).notNull(),
  factsBy: varchar("facts_by", { length: 255 }),
  toneBy: varchar("tone_by", { length: 255 }),
  reviewBy: varchar("review_by", { length: 10 }).notNull(),
  lastIndexedAt: ts("last_indexed_at"),
  body: text().notNull(),
  previous: text(),
  flags: jsonb().$type<KbSource["flags"]>().notNull().default([]),
  comment: text(),
  version: integer().notNull().default(1),
  updatedAt: now("updated_at"),
});

export const aiKbChunks = pgTable(
  "ai_kb_chunks",
  {
    id: varchar({ length: 80 }).primaryKey().notNull(),
    sourceId: varchar("source_id", { length: 96 }).notNull(),
    ord: integer().notNull(),
    title: varchar({ length: 255 }).notNull(),
    url: varchar({ length: 255 }).notNull(),
    locale: varchar({ length: 4 }).notNull(),
    content: text().notNull(),
    sourceVersion: integer("source_version").notNull(),
    updatedAt: now("updated_at"),
  },
  (t) => [
    index("ix_ai_kb_chunks_source").on(t.sourceId),
    index("ix_ai_kb_chunks_fts").using(
      "gin",
      sql`to_tsvector('simple', ${t.title} || ' ' || ${t.content})`,
    ),
  ],
);

/** Created by migration 0012 only when pgvector exists; touch it only after `to_regclass('ai_kb_embeddings')` is non-null. */
export const aiKbEmbeddings = pgTable(
  "ai_kb_embeddings",
  {
    chunkId: varchar("chunk_id", { length: 80 })
      .primaryKey()
      .notNull()
      .references(() => aiKbChunks.id, { onDelete: "cascade" }),
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
  },
  (t) => [index("ix_ai_kb_embeddings_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops"))],
);

export const aiReindexJobs = pgTable("ai_reindex_jobs", {
  id: varchar({ length: 64 }).primaryKey().notNull(),
  ids: jsonb().$type<string[]>().notNull(),
  done: integer().notNull().default(0),
  startedBy: varchar("started_by", { length: 64 }),
  startedAt: now("started_at"),
  finishedAt: ts("finished_at"),
});

export const aiEvals = pgTable("ai_evals", {
  id: varchar({ length: 32 }).primaryKey().notNull(),
  at: now("at"),
  trigger: varchar({ length: 255 }).notNull(),
  passed: integer().notNull(),
  total: integer().notNull(),
  prohibited: integer().notNull().default(0),
  deployBlocked: boolean("deploy_blocked").notNull().default(false),
  results: jsonb()
    .$type<{ id: string; ok: boolean; why?: string }[]>()
    .notNull()
    .default([]),
});

export const aiHandoffs = pgTable(
  "ai_handoffs",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    sessionId: varchar("session_id", { length: 64 }).notNull(),
    conversationId: varchar("conversation_id", { length: 64 }).notNull(),
    ticketRef: varchar("ticket_ref", { length: 32 }).notNull(),
    reason: varchar({ length: 32 }).notNull(),
    lang: varchar({ length: 4 }).notNull(),
    summary: text().notNull(),
    who: varchar({ length: 255 }).notNull(),
    claimedBy: varchar("claimed_by", { length: 255 }),
    claimedById: varchar("claimed_by_id", { length: 64 }),
    at: now("at"),
  },
  (t) => [index("ix_ai_handoffs_at").on(t.at)],
);

/** One row per model call (assistant turns per round-trip batch, copilot rewrites). The monthly USD cap sums usd_micros. */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    sessionId: varchar("session_id", { length: 64 }),
    userId: varchar("user_id", { length: 64 }),
    model: varchar({ length: 64 }).notNull(),
    kind: varchar({ length: 16 }).notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    usdMicros: integer("usd_micros").notNull().default(0),
    at: now("at"),
  },
  (t) => [index("ix_ai_usage_at").on(t.at)],
);
