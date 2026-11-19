// Chat crons: support first-response SLA escalation (F-MSG-13) and retention archival with legal hold (F-MSG-15).
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { applicationMessages, conversations, users } from "@/db/schema";
import { CHAT_RETENTION_YEARS, ESCALATION_CHAIN, escalationDue } from "@/domain/chat/rules";
import { DB, type Db } from "../../core/db/db";
import { TxService } from "../../core/db/tx";
import { Cron } from "../../core/queue/queues";
import { NotificationsService } from "../notifications/notifications.service";

@Injectable()
export class ChatJobs {
  private readonly log = new Logger("chat.jobs");
  constructor(@Inject(DB) private readonly db: Db, private readonly tx: TxService, private readonly ntf: NotificationsService) {}

  @Cron("chat.support_sla", "*/5 * * * *")
  async sla(now = new Date()) {
    const open = await this.db.select().from(conversations).where(and(eq(conversations.kind, "support"), isNotNull(conversations.slaDueAt), isNull(conversations.firstResponseAt), isNull(conversations.closedAt)));
    for (const c of open) {
      const level = escalationDue(c.slaDueAt!, c.escalationLevel, now);
      if (!level) continue;
      const role = ESCALATION_CHAIN[level - 1];
      // shortcut: recipients by users.role (plus legacy staff:admin); extra console grants are not consulted, use the IAM role resolver when it is shared.
      const to = await this.db.select({ id: users.userId }).from(users).where(and(inArray(users.role, [role, "staff:admin"]), eq(users.isActive, true)));
      await this.tx.runAsSystem(async (tx) => {
        await tx.update(conversations).set({ escalationLevel: level }).where(and(eq(conversations.conversationId, c.conversationId), eq(conversations.escalationLevel, c.escalationLevel)));
        for (const u of to)
          await this.ntf.notify(tx, { userId: u.id, kind: "chat.support_sla_breached", title: `Support enquiry waiting for a reply (level ${level})`, body: c.title ?? null, link: `/ops/conversations?c=${c.conversationId}`, channels: ["email"] });
      });
      this.log.warn({ event: "chat.sla_escalated", conversation: c.conversationId, level });
    }
  }

  /** Closed conversations past retention and not on legal hold: message bodies and attachments refs are purged, the row is kept as archived. */
  @Cron("chat.retention", "40 2 * * *")
  async retention() {
    const cutoff = sql`now() - make_interval(years => ${CHAT_RETENTION_YEARS})`;
    const due = await this.db.select({ id: conversations.conversationId }).from(conversations)
      .where(and(isNotNull(conversations.closedAt), lt(conversations.closedAt, cutoff), eq(conversations.legalHold, false), isNull(conversations.archivedAt))).limit(500);
    for (const { id } of due)
      await this.tx.runAsSystem(async (tx) => {
        await tx.update(applicationMessages).set({ content: "[archived]", attachments: [], payload: null }).where(eq(applicationMessages.conversationId, id));
        await tx.update(conversations).set({ archivedAt: new Date().toISOString() }).where(eq(conversations.conversationId, id));
      });
    if (due.length) this.log.log({ event: "chat.retention_archived", n: due.length });
  }
}
