// Help desk (port of .ref applications.support): the client's support tickets. Staff answer from the ops workspace,
// which calls SupportService.reply (side="support" messages + client notification).
import { openTicket } from "../ops/ops.manage";
import { OutboxService } from "../../core/db/outbox";
import { createRefundRequest } from "../finance/finance.cases";
import { Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { supportTicketMessages, supportTickets } from "@/db/schema";
import type { Tx } from "../../core/db/db";
import { AuditService } from "../../core/db/audit";
import { TxService } from "../../core/db/tx";
import type { SessionUser } from "../../core/http/context";
import { AppError } from "../../core/http/errors";
import { NotificationsService } from "../notifications/notifications.service";
import { generateId } from "../../core/db/ids";

const err = { notFound: (m: string) => new AppError(404, "not_found", m) };

type T = typeof supportTickets.$inferSelect;
type M = typeof supportTicketMessages.$inferSelect;

const project = (t: T, ms: M[]) => ({
  ref: t.ref,
  subject: t.subject,
  status: t.status as "open" | "waiting" | "resolved",
  type: t.type,
  contact: t.contact,
  caseRef: t.caseRef,
  createdAt: t.createdAt,
  messages: ms
    .filter((m) => m.ticketId === t.id)
    .map((m) => ({
      id: m.id,
      from: m.side as "me" | "support",
      body: m.body,
      at: m.createdAt,
    })),
  rating: t.ratingScore
    ? { score: t.ratingScore, comment: t.ratingComment ?? "" }
    : null,
});

const messagesOf = (db: Tx, ids: string[]) =>
  ids.length
    ? db
        .select()
        .from(supportTicketMessages)
        .where(inArray(supportTicketMessages.ticketId, ids))
        .orderBy(asc(supportTicketMessages.createdAt))
    : Promise.resolve([]);

async function own(db: Tx, s: SessionUser, ref: string, lock = false) {
  const q = db
    .select()
    .from(supportTickets)
    .where(and(eq(supportTickets.ref, ref), eq(supportTickets.userId, s.id)));
  const [t] = lock ? await q.for("update") : await q;
  if (!t) throw err.notFound("Ticket not found.");
  return t;
}

export async function listTickets(db: Tx, s: SessionUser) {
  const ts = await db
    .select()
    .from(supportTickets)
    .where(eq(supportTickets.userId, s.id))
    .orderBy(desc(supportTickets.createdAt))
    .limit(200);
  const ms = await messagesOf(
    db,
    ts.map((t) => t.id),
  );
  return { tickets: ts.map((t) => project(t, ms)) };
}

export async function getTicket(db: Tx, s: SessionUser, ref: string) {
  const t = await own(db, s, ref);
  return project(t, await messagesOf(db, [t.id]));
}

export async function createTicket(
  db: Tx,
  s: SessionUser,
  subject: string,
  message: string,
  extra: { type?: string; contact?: string; caseRef?: string } = {},
) {
  const [{ n }] = await db.execute<{ n: string }>(
    sql`select nextval('support_ticket_ref_seq') as n`,
  );
  const now = new Date().toISOString();
  const ref = `TKT-${now.slice(0, 4)}-${String(n).padStart(5, "0")}`;
  const id = generateId("tkt");
  await db
    .insert(supportTickets)
    .values({
      id,
      ref,
      userId: s.id,
      subject,
      ...extra,
      status: "open",
      createdAt: now,
      updatedAt: now,
    });
  await db
    .insert(supportTicketMessages)
    .values({
      id: generateId("tkm"),
      ticketId: id,
      authorId: s.id,
      side: "me",
      body: message,
      createdAt: now,
    });
  // CLP-11 / FBK: a complaint about a case also lands in the ops ticket register (response clock, owner, resolution).
  if (extra.type === "complaint" && extra.caseRef)
    await openTicket(db, { ...s, role: "client" }, { kind: "complaint", category: "quality", caseRef: extra.caseRef, note: `${subject}\n\n${message}\n\n(Client ticket ${ref})`, byClient: true })
      .catch((e: unknown) => { if ((e as { status?: number }).status !== 404) throw e; }); // unknown case ref: the client ticket alone stands
  return { ref };
}

export async function addMessage(
  db: Tx,
  s: SessionUser,
  ref: string,
  body: string,
) {
  const t = await own(db, s, ref, true);
  if (t.status === "resolved")
    throw new AppError(409, "ticket_closed", "Ticket is resolved.");
  const now = new Date().toISOString();
  await db
    .insert(supportTicketMessages)
    .values({
      id: generateId("tkm"),
      ticketId: t.id,
      authorId: s.id,
      side: "me",
      body,
      createdAt: now,
    });
  await db
    .update(supportTickets)
    .set({ status: "open", updatedAt: now })
    .where(eq(supportTickets.id, t.id));
  return getTicket(db, s, ref);
}

export async function rateTicket(
  db: Tx,
  s: SessionUser,
  ref: string,
  score: number,
  comment: string,
) {
  const t = await own(db, s, ref, true);
  if (t.status !== "resolved")
    throw new AppError(400, "validation_error", "Invalid rating.");
  await db
    .update(supportTickets)
    .set({
      ratingScore: score,
      ratingComment: comment.slice(0, 1000),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(supportTickets.id, t.id));
  return getTicket(db, s, ref);
}

/** Staff side (wired by the ops workspace in P5): reply and set the status; the client is notified. */
export async function replyAsSupport(
  db: Tx,
  notify: NotificationsService,
  staffId: string,
  ref: string,
  body: string,
  status: "waiting" | "resolved" = "waiting",
  /** F-RFD-08: resolving a case dispute with outcome "refund" opens a finance refund request in this tx. */
  outcome?: { kind: "refund"; outbox: OutboxService },
) {
  const [t] = await db
    .select()
    .from(supportTickets)
    .where(eq(supportTickets.ref, ref))
    .for("update");
  if (!t) throw err.notFound("Ticket not found.");
  const now = new Date().toISOString();
  await db
    .insert(supportTicketMessages)
    .values({
      id: generateId("tkm"),
      ticketId: t.id,
      authorId: staffId,
      side: "support",
      body,
      createdAt: now,
    });
  await db
    .update(supportTickets)
    .set({ status, updatedAt: now })
    .where(eq(supportTickets.id, t.id));
  await notify.notify(db, {
    userId: t.userId,
    kind: "admin_reply",
    title: `Reply on ${t.ref}`,
    body: body.slice(0, 200),
    link: `/help/${t.ref}`,
  });
  if (status === "resolved" && outcome?.kind === "refund" && t.caseRef)
    await createRefundRequest(db, outcome.outbox, {
      applicationId: t.caseRef,
      reason: "quality_dispute",
      note: `Dispute ${t.ref} resolved with a refund.`,
      auto: "dispute",
    });
  return { ref: t.ref, status };
}


/** The help screens' contract uses 400 validation_error (handlers-c4), not the pipeline's 422. */
const bad = (msg: string) => new AppError(400, "validation_error", msg);
const text = (raw: unknown, max: number, msg: string) => {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!v || v.length > max) throw bad(msg);
  return v;
};
type Loose = Record<string, unknown>;

@Injectable()
export class SupportService {
  constructor(private readonly tx: TxService, private readonly audit: AuditService, private readonly notifications: NotificationsService, private readonly outbox: OutboxService) {}

  list(s: SessionUser) {
    return this.tx.run((db) => listTickets(db, s));
  }
  get(s: SessionUser, ref: string) {
    return this.tx.run((db) => getTicket(db, s, ref));
  }
  create(s: SessionUser, b: Loose) {
    const subject = text(b.subject, 200, "Subject is required.");
    const message = text(b.message, 5000, "Message is empty.");
    return this.tx.run(async (db) => {
      const opt = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
      const r = await createTicket(db, s, subject, message, { type: opt(b.type, 40), contact: opt(b.contact, 255), caseRef: opt(b.caseRef, 64) });
      await this.audit.record(db, { action: "support.ticket.created", entity: "support", entityId: r.ref });
      return r;
    });
  }
  message(s: SessionUser, ref: string, b: Loose) {
    const body = text(b.body, 5000, "Message is empty.");
    return this.tx.run((db) => addMessage(db, s, ref, body));
  }
  rate(s: SessionUser, ref: string, b: Loose) {
    const score = Number(b.score);
    if (!Number.isInteger(score) || score < 1 || score > 5) throw bad("Invalid rating.");
    return this.tx.run((db) => rateTicket(db, s, ref, score, String(b.comment ?? "")));
  }
  /** For the ops workspace: staff reply in the caller's tx. */
  reply(db: Tx, staffId: string, ref: string, body: string, status: "waiting" | "resolved" = "waiting", refund = false) {
    return replyAsSupport(db, this.notifications, staffId, ref, body, status, refund ? { kind: "refund", outbox: this.outbox } : undefined);
  }
}
