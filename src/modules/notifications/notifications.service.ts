// Port of .ref notifications.service: in-app rows, preferences, delivery (email/SMS/WhatsApp) and hourly digest.
// RLS lets only the owner read and only `system` write `notifications`, so notify() goes through the outbox and the
// worker job (NotificationsJobs.deliver) inserts the row and fans it out.
import { Injectable } from "@nestjs/common";
import { and, count, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { notificationPreferences, notifications } from "@/db/schema";
import type { Tx } from "../../core/db/db";
import { OutboxService } from "../../core/db/outbox";
import { TxService } from "../../core/db/tx";
import { MAX_LIMIT, type Prefs } from "./notifications.dto";

export const DEFAULT_LIMIT = 30;
export const DIGEST_WINDOW_S = 3600;
/** PLACEHOLDER(chat-digest-threshold): Python settings.chat_digest_threshold default. */
export const DIGEST_THRESHOLD = 3;

export type Channel = "email" | "sms" | "whatsapp";
export type NotifyInput = {
  userId: string;
  kind: string;
  title: string;
  body?: string | null;
  link?: string | null;
  /** Extra delivery channels; the in-app row is always written. */
  channels?: Channel[];
  conversationId?: string | null;
  data?: { type: string; vars?: Record<string, string> } | null;
};
type Row = typeof notifications.$inferSelect;
type Channels = { matrix?: Record<string, Record<string, boolean>>; quiet?: { on: boolean; from: string; to: string } };

export const project = (r: Row) => {
  const d = r.data as { type?: string; vars?: Record<string, string> } | null;
  return {
    id: r.id, channel: r.channel, kind: r.kind,
    ...(d?.type ? { type: d.type, vars: d.vars ?? {} } : {}),
    title: r.title, body: r.body ?? "", href: r.href ?? "", read_at: r.readAt, created_at: r.createdAt,
  };
};

@Injectable()
export class NotificationsService {
  constructor(private readonly tx: TxService, private readonly outbox: OutboxService) {}

  /** Call inside your business tx: the notification exists iff that tx commits. */
  notify(tx: Tx, n: NotifyInput) {
    return this.outbox.add(tx, { type: "notifications.deliver", payload: n });
  }

  /** Worker only (runAsSystem tx). */
  /** `id` = deterministic per delivery job, so a retried job finds its row instead of inserting a second one. */
  async insert(tx: Tx, n: NotifyInput, id = `ntf_${randomUUID()}`) {
    const [row] = await tx.insert(notifications).values({
      id, userId: n.userId, kind: n.kind,
      title: n.title.slice(0, 255), body: n.body?.slice(0, 1024) ?? null, href: n.link ?? null,
      conversationId: n.conversationId ?? null, channel: "in_app", data: n.data ?? null,
      createdAt: new Date().toISOString(),
    }).onConflictDoNothing().returning();
    return row ?? (await tx.select().from(notifications).where(eq(notifications.id, id)))[0];
  }

  private unread(tx: Tx, userId: string) {
    return tx.select({ n: count() }).from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt))).then((r) => r[0].n);
  }

  list(userId: string, o: { limit?: number; unread?: boolean }) {
    const limit = Math.max(1, Math.min(o.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
    return this.tx.run(async (tx) => {
      const rows = await tx.select().from(notifications)
        .where(and(eq(notifications.userId, userId), o.unread ? isNull(notifications.readAt) : undefined))
        .orderBy(desc(notifications.createdAt)).limit(limit);
      return { notifications: rows.map(project), unread_count: await this.unread(tx, userId) };
    });
  }

  /** ids null/undefined marks everything; other users' ids mark nothing. */
  markRead(userId: string, ids?: string[] | null) {
    return this.tx.run(async (tx) => {
      const res = await tx.update(notifications).set({ readAt: new Date().toISOString() })
        .where(and(eq(notifications.userId, userId), isNull(notifications.readAt),
          ids ? inArray(notifications.id, ids.length ? ids : [""]) : undefined))
        .returning({ id: notifications.id });
      return { updated: res.length, unread_count: await this.unread(tx, userId) };
    });
  }

  async prefsOf(tx: Tx, userId: string) {
    const [r] = await tx.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId));
    // shortcut: Python also defaults email off for agents whose legacy notification_client_reply is false; add with agent settings.
    return { email_enabled: r?.emailEnabled ?? true, digest_enabled: r?.digestEnabled ?? true, ...((r?.channels as Channels | null) ?? {}), lastDigestAt: r?.lastDigestAt ?? null };
  }

  preferences(userId: string) {
    return this.tx.run((tx) => this.prefsOf(tx, userId));
  }

  updatePreferences(userId: string, patch: Prefs) {
    return this.tx.run(async (tx) => {
      const cur = await this.prefsOf(tx, userId);
      const channels: Channels = { matrix: patch.matrix ?? cur.matrix, quiet: patch.quiet ?? cur.quiet };
      const next = { emailEnabled: patch.email_enabled ?? cur.email_enabled, digestEnabled: patch.digest_enabled ?? cur.digest_enabled, channels, updatedAt: new Date().toISOString() };
      await tx.insert(notificationPreferences).values({ userId, ...next })
        .onConflictDoUpdate({ target: notificationPreferences.userId, set: next });
      return { email_enabled: next.emailEnabled, digest_enabled: next.digestEnabled, ...channels };
    });
  }

  /** Users with more than DIGEST_THRESHOLD unread rows in the last window, plus their latest titles. */
  async digestCandidates(tx: Tx, now: Date) {
    const since = new Date(now.getTime() - DIGEST_WINDOW_S * 1000).toISOString();
    const recent = and(isNull(notifications.readAt), gte(notifications.createdAt, since));
    const cands = await tx.select({ userId: notifications.userId, n: count() }).from(notifications)
      .where(recent).groupBy(notifications.userId).having(sql`count(*) > ${DIGEST_THRESHOLD}`);
    return Promise.all(cands.map(async (c) => ({
      ...c,
      titles: (await tx.select({ t: notifications.title }).from(notifications)
        .where(and(eq(notifications.userId, c.userId), recent)).orderBy(desc(notifications.createdAt)).limit(10)).map((r) => r.t),
    })));
  }

  markDigested(tx: Tx, userId: string, at: string) {
    return tx.insert(notificationPreferences).values({ userId, emailEnabled: true, digestEnabled: true, lastDigestAt: at, updatedAt: at })
      .onConflictDoUpdate({ target: notificationPreferences.userId, set: { lastDigestAt: at } });
  }
}
