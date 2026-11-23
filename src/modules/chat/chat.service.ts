// Port of .ref chat.service (hebuza chat: access rule, send/list, admin console) + the contract's extra chat routes.
// One access rule decides lanes for every path: client → client lane; the assigned agent → every lane; managers read
// every lane and write the client lane only after claiming/joining; DMs → participants only. What a caller cannot see
// does not exist (404, never 403). Messages are keyset-paged by `seq` (unique (conversation_id, seq) index; seq is
// allocated under the conversation row lock so it orders exactly like created_at). Every new message / edit / reaction /
// read receipt is pushed to the conversation's recipients with RealtimeService.emit after the tx commits.
import { createTicket } from "../applications/support.service";
import { holdsRole } from "@/db/holds-role";
import { normalizeRoles } from "@/domain/auth/roles";
import { settingOf } from "../../core/db/system-records";
import { FIRST_RESPONSE_MIN, addBusinessMinutes, businessHours, clientLaneReadOnly, parseCard, CARD_ACTIONS } from "@/domain/chat/rules";
import { Injectable } from "@nestjs/common";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  lt,
  ne,
  sql,
} from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  agentProfiles,
  applicationMessages,
  applications,
  chatTemplates,
  conversationParticipants,
  conversations,
  messageAttachments,
  messageEdits,
  messageMentions,
  messageReactions,
  messageReferences,
  opsRecords,
  users,
} from "@/db/schema";
import type { Tx } from "../../core/db/db";
import { TxService } from "../../core/db/tx";
import { OutboxService } from "../../core/db/outbox";
import { FINALIZE_DELAY_MS } from "../documents/documents.service";
import { AuditService } from "../../core/db/audit";
import { AppError, notFound } from "../../core/http/errors";
import type { SessionUser } from "../../core/http/context";
import { StorageService } from "../../core/storage/storage.service";
import { NotificationsService } from "../notifications/notifications.service";
import { RealtimeService } from "../realtime/realtime.service";
import { generateId as id, iso } from "../../core/db/ids";

type Conv = typeof conversations.$inferSelect;
type Msg = typeof applicationMessages.$inferSelect;
type App = typeof applications.$inferSelect;
type Att = typeof messageAttachments.$inferSelect;
type Lane = "client" | "team" | "internal";
export type Access = {
  lanes: string[];
  write: string[];
  role: "client" | "agent" | "admin" | "staff";
  participant: boolean;
  admin: boolean;
  app: App | null;
};
type Push = { to: string[]; type: string; payload: Record<string, unknown> };

const CASE = "case",
  DM = "direct_staff";
const MAX_MENTIONS = 10;
const EDIT_WINDOW_MS = 15 * 60_000; // PLACEHOLDER(chat-edit-window-min)
const DISPUTE_RESPONSE_MIN = 120; // ops RESPONSE_MIN.high
const gone = () => new AppError(404, "not_found", "Conversation not found.");
const isManager = (s: SessionUser) =>
  s.roles.some(
    (r) =>
      r === "staff:service_manager" ||
      r === "staff:executive" ||
      r === "staff:sysadmin",
  );
const isStaff = (s: SessionUser) =>
  s.roles.some((r) => r.startsWith("staff:") || r === "ext:agent");
const caseLanes = (app: App) =>
  app.assignedPartnerId
    ? ["client", "team", "internal"]
    : ["client", "internal"];
const partRole = (a: Access) => (a.role === "staff" ? "agent" : a.role);

const attachmentView = (x: Att) => ({
  id: x.id,
  filename: x.filename,
  mime: x.mime,
  size: x.size,
  lane: x.lane,
  has_thumbnail: !!x.thumbnailPath,
  scan_status: x.scanStatus,
  created_at: x.createdAt,
});

/** Minimal one-font PDF (latin-1 text, 60 lines/page): transcripts don't need layout, and it keeps react out of the API. */
export function textPdf(title: string, lines: string[]) {
  const esc = (s: string) =>
    s.replace(/[\\()]/g, "\\$&").replace(/[^\x20-\xff]/g, "?");
  const wrapped = [title, "", ...lines].flatMap(
    (l) => l.match(/.{1,95}/g) ?? [""],
  );
  const pages: string[][] = [];
  for (let i = 0; i < wrapped.length; i += 60)
    pages.push(wrapped.slice(i, i + 60));
  const objs: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  const kids: number[] = [];
  for (const p of pages) {
    const body = `BT /F1 9 Tf 12 TL 40 800 Td ${p.map((l) => `(${esc(l)}) '`).join(" ")} ET`;
    objs.push(
      `<< /Length ${Buffer.byteLength(body, "latin1")} >>\nstream\n${body}\nendstream`,
    );
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objs.length} 0 R >>`,
    );
    kids.push(objs.length);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const x = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

@Injectable()
export class ChatService {
  constructor(
    private readonly tx: TxService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
    private readonly outbox: OutboxService,
  ) {}

  // ── plumbing ─────────────────────────────────────────────────────────────────────────────────────────
  /** Runs fn in one tx, then fans its realtime pushes out after commit (best effort: SSE clients refetch on reconnect). */
  private async run<T>(fn: (tx: Tx, push: (p: Push) => void) => Promise<T>) {
    const out: Push[] = [];
    const res = await this.tx.run((tx) => fn(tx, (p) => out.push(p)));
    await Promise.allSettled(
      out.flatMap((p) =>
        [...new Set(p.to)].map((u) => this.realtime.emit(u, p.type, p.payload)),
      ),
    );
    return res;
  }

  private async names(tx: Tx, ids: (string | null | undefined)[]) {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    if (!list.length) return new Map<string, string>();
    const rows = await tx
      .select({ id: users.userId, name: users.name })
      .from(users)
      .where(inArray(users.userId, list));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private async claimOf(tx: Tx, convId: string, lock = false) {
    const q = tx
      .select()
      .from(opsRecords)
      .where(
        and(
          eq(opsRecords.kind, "conv_claim"),
          eq(opsRecords.id, `cc:${convId}`),
        ),
      );
    const [r] = lock ? await q.for("update") : await q;
    return (r?.data as { userId: string; name: string } | undefined) ?? null;
  }

  async ensureCaseConversation(tx: Tx, applicationId: string): Promise<Conv> {
    const [made] = await tx
      .insert(conversations)
      .values({
        conversationId: id("cnv"),
        kind: CASE,
        applicationId,
        lastSeq: 0,
        createdAt: iso(),
      })
      .onConflictDoNothing()
      .returning();
    return (
      made ??
      (
        await tx
          .select()
          .from(conversations)
          .where(eq(conversations.applicationId, applicationId))
      )[0]
    );
  }

  /** "cv-<CODE>" (case alias the ops UI uses) or a real conversation id. */
  private async conv(tx: Tx, cid: string, lock = false): Promise<Conv> {
    if (cid.startsWith("cv-")) {
      const [app] = await tx
        .select({ id: applications.applicationId })
        .from(applications)
        .where(eq(applications.code, cid.slice(3).toUpperCase()));
      if (!app) throw gone();
      cid = (await this.ensureCaseConversation(tx, app.id)).conversationId;
    }
    const q = tx
      .select()
      .from(conversations)
      .where(eq(conversations.conversationId, cid));
    const [c] = lock ? await q.for("update") : await q;
    if (!c) throw gone();
    return c;
  }

  private async activeParts(tx: Tx, convId: string) {
    return tx
      .select()
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, convId),
          isNull(conversationParticipants.leftAt),
        ),
      );
  }

  async access(tx: Tx, c: Conv, s: SessionUser): Promise<Access> {
    const joined = (await this.activeParts(tx, c.conversationId)).some(
      (p) => p.userId === s.id,
    );
    if (c.kind === CASE) {
      const [app] = c.applicationId
        ? await tx
            .select()
            .from(applications)
            .where(eq(applications.applicationId, c.applicationId))
        : [];
      if (!app) throw gone();
      if (s.roles.includes("client") && app.clientId === s.id)
        return {
          lanes: ["client"],
          // F-MSG-18: read-only 30 days after close (or once archived); new questions go to a support enquiry.
          write: c.archivedAt || clientLaneReadOnly(c.closedAt ?? app.completedAt) ? [] : ["client"],
          role: "client",
          participant: true,
          admin: false,
          app,
        };
      if (app.assignedAgentId === s.id)
        return {
          lanes: caseLanes(app),
          write: caseLanes(app),
          role: "agent",
          participant: true,
          admin: false,
          app,
        };
      if (isManager(s)) {
        const claim = await this.claimOf(tx, c.conversationId);
        const mayClient = joined || claim?.userId === s.id;
        return {
          lanes: caseLanes(app),
          write: mayClient ? caseLanes(app) : ["internal"],
          role: "admin",
          participant: joined,
          admin: true,
          app,
        };
      }
      throw gone();
    }
    if (joined)
      return {
        lanes: ["internal"],
        write: ["internal"],
        role: "staff",
        participant: true,
        admin: false,
        app: null,
      };
    if (c.kind === "support" && isManager(s))
      return {
        lanes: ["internal"],
        write: [],
        role: "admin",
        participant: false,
        admin: true,
        app: null,
      };
    throw gone();
  }

  private async open(tx: Tx, s: SessionUser, cid: string, lock = false) {
    const c = await this.conv(tx, cid, lock);
    return { c, a: await this.access(tx, c, s) };
  }

  /** Who gets realtime frames for a lane: active participants + client (client lane only) + assigned agent. */
  private async recipients(tx: Tx, c: Conv, a: Access, lane: string) {
    // Definer read: under RLS a client sees only their own participant row, so staff would miss the frame.
    const ids = ((await tx.execute(sql`select conversation_member_ids(${c.conversationId}) id`)) as unknown as { id: string }[]).map((r) => r.id); // cast: execute() rows are untyped
    if (a.app?.assignedAgentId) ids.push(a.app.assignedAgentId);
    if (a.app?.clientId) {
      if (lane === "client") ids.push(a.app.clientId);
      else return ids.filter((u) => u !== a.app!.clientId);
    }
    return ids;
  }

  private msgOut(
    m: Msg,
    names: Map<string, string>,
    mentions: Map<string, string[]>,
    reactions: Map<string, { emoji: string; user_ids: string[] }[]>,
  ) {
    return {
      message_id: m.messageId,
      conversation_id: m.conversationId,
      seq: m.seq,
      client_msg_id: m.clientMsgId,
      sender_id: m.senderId,
      sender_name: m.senderId ? (names.get(m.senderId) ?? null) : null,
      sender_role: m.isSystem
        ? "system"
        : m.senderRole === "client"
          ? "client"
          : "staff",
      content: m.deletedAt ? "" : m.content,
      lane: m.lane,
      kind: m.kind,
      is_system: m.isSystem,
      mentions: mentions.get(m.messageId) ?? [],
      reactions: reactions.get(m.messageId) ?? [],
      created_at: m.createdAt,
      reply_to_id: m.replyToId,
      edited_at: m.editedAt,
      deleted_at: m.deletedAt,
      pinned_at: m.pinnedAt,
      attachments: m.deletedAt ? [] : m.attachments,
      payload: m.payload,
    };
  }

  private async decorate(tx: Tx, ms: Msg[]) {
    const ids = ms.map((m) => m.messageId);
    const [mentions, reacts, names] = await Promise.all([
      ids.length
        ? tx
            .select()
            .from(messageMentions)
            .where(inArray(messageMentions.messageId, ids))
        : [],
      ids.length
        ? tx
            .select()
            .from(messageReactions)
            .where(inArray(messageReactions.messageId, ids))
        : [],
      this.names(
        tx,
        ms.map((m) => m.senderId),
      ),
    ]);
    const byMsg = new Map<string, string[]>();
    for (const x of mentions)
      byMsg.set(x.messageId, [
        ...(byMsg.get(x.messageId) ?? []),
        x.userId ?? x.subjectKey,
      ]);
    const byR = new Map<string, { emoji: string; user_ids: string[] }[]>();
    for (const r of reacts) {
      const list = byR.get(r.messageId) ?? [];
      const e = list.find((x) => x.emoji === r.emoji);
      if (e) e.user_ids.push(r.userId);
      else list.push({ emoji: r.emoji, user_ids: [r.userId] });
      byR.set(r.messageId, list);
    }
    return ms.map((m) => this.msgOut(m, names, byMsg, byR));
  }
  private one = async (tx: Tx, m: Msg) => (await this.decorate(tx, [m]))[0];

  /** Message the caller can see (lane check), optionally locked. */
  private async message(tx: Tx, s: SessionUser, mid: string, lock = false) {
    const q = tx
      .select()
      .from(applicationMessages)
      .where(eq(applicationMessages.messageId, mid));
    const [m] = lock ? await q.for("update") : await q;
    if (!m) throw notFound("Message");
    const { c, a } = await this.open(tx, s, m.conversationId);
    if (!a.lanes.includes(m.lane)) throw notFound("Message");
    return { m, c, a };
  }

  // ── messages ─────────────────────────────────────────────────────────────────────────────────────────
  listMessages(
    s: SessionUser,
    cid: string,
    q: {
      before?: number;
      after?: number;
      before_seq?: number;
      after_seq?: number;
      limit?: number;
    },
  ) {
    const before = q.before ?? q.before_seq,
      after = q.after ?? q.after_seq;
    return this.tx.run(async (tx) => {
      const { c, a } = await this.open(tx, s, cid);
      const limit = Math.min(q.limit ?? 100, 200);
      const rows = await tx
        .select()
        .from(applicationMessages)
        .where(
          and(
            eq(applicationMessages.conversationId, c.conversationId),
            inArray(applicationMessages.lane, a.lanes),
            before ? lt(applicationMessages.seq, before) : undefined,
            after ? gt(applicationMessages.seq, after) : undefined,
          ),
        )
        .orderBy(
          after ? asc(applicationMessages.seq) : desc(applicationMessages.seq),
        )
        .limit(limit + 1);
      const more = rows.length > limit;
      const page = rows.slice(0, limit).sort((x, y) => x.seq - y.seq);
      const parts = await this.activeParts(tx, c.conversationId);
      const pn = await this.names(
        tx,
        parts.map((p) => p.userId),
      );
      return {
        conversation_id: c.conversationId,
        messages: await this.decorate(tx, page),
        has_more_before: !after && more,
        has_more_after: !!after && more,
        latest_seq: c.lastSeq,
        lanes: a.lanes,
        write_lanes: a.write,
        participants: parts.map((p) => ({
          user_id: p.userId,
          name: pn.get(p.userId) ?? p.userId,
          role: p.role,
          last_read_seq: p.lastReadSeq,
          last_delivered_seq: p.lastDeliveredSeq,
        })),
      };
    });
  }

  /** Appends a message under the conversation row lock (serialises seq). */
  private async append(
    tx: Tx,
    c: Conv,
    v: Omit<
      typeof applicationMessages.$inferInsert,
      "messageId" | "seq" | "conversationId" | "createdAt"
    >,
  ) {
    const [cur] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.conversationId, c.conversationId))
      .for("update");
    const seq = cur.lastSeq + 1,
      now = iso();
    const [m] = await tx
      .insert(applicationMessages)
      .values({
        ...v,
        messageId: id("msg"),
        applicationId: c.applicationId,
        conversationId: c.conversationId,
        seq,
        createdAt: now,
      })
      .returning();
    // F-MSG-13: a client message opens the first-response clock (if none is running); the first staff reply stops it.
    const sla =
      cur.kind !== "support" || v.senderRole === "system"
        ? {}
        : v.senderRole === "client"
          ? cur.slaDueAt && !cur.firstResponseAt ? {} : { slaDueAt: addBusinessMinutes(new Date(now), FIRST_RESPONSE_MIN, businessHours(await settingOf(tx, "sla.business_start_hour"), await settingOf(tx, "sla.business_end_hour"))).toISOString(), firstResponseAt: null, escalationLevel: 0 }
          : cur.slaDueAt && !cur.firstResponseAt ? { firstResponseAt: now } : {};
    await tx
      .update(conversations)
      .set({ lastSeq: seq, lastMessageAt: now, ...sla })
      .where(eq(conversations.conversationId, c.conversationId));
    return m;
  }

  postSystem(
    tx: Tx,
    c: Conv,
    kind: string,
    content: string,
    payload: Record<string, unknown> | null = null,
    lane = "client",
  ) {
    return this.append(tx, c, {
      senderId: null,
      senderRole: "system",
      content,
      isInternal: lane === "internal",
      isSystem: true,
      attachments: [],
      isReadByClient: false,
      lane,
      kind,
      payload,
    });
  }

  send(
    s: SessionUser,
    cid: string,
    b: {
      client_msg_id: string;
      content: string;
      lane: Lane;
      mentions?: string[];
      reply_to_id?: string | null;
      attachment_ids?: string[];
      references?: { type: string; ref: string }[];
    },
  ) {
    const content = b.content.trim();
    if (!content && !b.attachment_ids?.length)
      throw new AppError(422, "validation", "Write a message first.");
    if ((b.mentions ?? []).length > MAX_MENTIONS)
      throw new AppError(422, "validation", "Too many mentions.");
    return this.run(async (tx, push) => {
      const { c, a } = await this.open(tx, s, cid);
      if (!a.lanes.includes(b.lane)) throw gone();
      if (a.role === "client" && !a.write.includes(b.lane))
        throw new AppError(409, "lane_closed", "This case is closed. Start a support enquiry to ask something new.");
      if (!a.write.includes(b.lane))
        throw new AppError(
          403,
          "forbidden",
          a.admin && b.lane === "client"
            ? "Claim the conversation first."
            : "You can't write in this lane.",
        );
      const [dup] = await tx
        .select()
        .from(applicationMessages)
        .where(
          and(
            eq(applicationMessages.senderId, s.id),
            eq(applicationMessages.clientMsgId, b.client_msg_id),
          ),
        );
      if (dup) return this.one(tx, dup);
      const atts = b.attachment_ids?.length
        ? await tx
            .select()
            .from(messageAttachments)
            .where(
              and(
                inArray(messageAttachments.id, b.attachment_ids),
                eq(messageAttachments.conversationId, c.conversationId),
                eq(messageAttachments.uploadedBy, s.id),
                isNull(messageAttachments.messageId),
              ),
            )
        : [];
      const m = await this.append(tx, c, {
        senderId: s.id,
        senderRole: a.role === "client" ? "client" : s.roles[0],
        content,
        isInternal: b.lane === "internal",
        isSystem: false,
        attachments: atts.map(attachmentView),
        isReadByClient: false,
        lane: b.lane,
        clientMsgId: b.client_msg_id,
        kind: "text",
        replyToId: b.reply_to_id ?? null,
      });
      if (atts.length)
        await tx
          .update(messageAttachments)
          .set({ messageId: m.messageId, lane: b.lane })
          .where(
            inArray(
              messageAttachments.id,
              atts.map((x) => x.id),
            ),
          );
      if (b.references?.length)
        await tx
          .insert(messageReferences)
          .values(
            b.references.map((r) => ({
              id: id("mref"),
              messageId: m.messageId,
              refType: r.type,
              refId: r.ref,
              snapshot: {},
            })),
          );
      await tx
        .update(conversationParticipants)
        .set({ lastReadSeq: m.seq, lastDeliveredSeq: m.seq })
        .where(
          and(
            eq(conversationParticipants.conversationId, c.conversationId),
            eq(conversationParticipants.userId, s.id),
          ),
        );
      const href = a.app
        ? `/agent/cases/${a.app.code}?tab=messages`
        : "/ops/conversations";
      const mentions =
        a.role === "client"
          ? []
          : [...new Set(b.mentions ?? [])].filter((u) => u !== s.id);
      if (mentions.length) {
        const real = [...(await this.names(tx, mentions)).keys()];
        if (real.length)
          await tx
            .insert(messageMentions)
            .values(
              real.map((u) => ({
                messageId: m.messageId,
                subjectKey: u,
                userId: u,
              })),
            )
            .onConflictDoNothing();
        for (const u of real)
          await this.notifications.notify(tx, {
            userId: u,
            kind: "mention",
            title: "You were mentioned",
            body: content.slice(0, 200),
            conversationId: c.conversationId,
            link: href,
          });
      }
      // Tell the other side: staff wrote in the client lane → client; client wrote → assigned agent.
      if (
        a.app &&
        b.lane === "client" &&
        a.role !== "client" &&
        a.app.clientId &&
        (await this.realtime.focusOf(a.app.clientId)) !== c.conversationId
      )
        await this.notifications.notify(tx, {
          userId: a.app.clientId,
          kind: "message",
          title: `New message on ${a.app.code}`,
          body: content.slice(0, 200),
          conversationId: c.conversationId,
          link: `/requests/${a.app.code}`,
        });
      if (
        a.app &&
        a.role === "client" &&
        a.app.assignedAgentId &&
        (await this.realtime.focusOf(a.app.assignedAgentId)) !==
          c.conversationId
      )
        await this.notifications.notify(tx, {
          userId: a.app.assignedAgentId,
          kind: "message",
          title: `Client message on ${a.app.code}`,
          body: content.slice(0, 200),
          conversationId: c.conversationId,
          link: href,
        });
      const out = await this.one(tx, m);
      push({
        to: await this.recipients(tx, c, a, b.lane),
        type: "chat.message",
        payload: { conversation_id: c.conversationId, message: out },
      });
      return out;
    });
  }

  /** Presigned upload (JSON {filename,mime,size}) or a small multipart file the current web client posts. */
  attach(
    s: SessionUser,
    cid: string,
    f: { filename: string; mime: string; size: number; bytes?: Buffer },
  ) {
    return this.tx.run(async (tx) => {
      const { c, a } = await this.open(tx, s, cid);
      if (!a.write.length)
        throw new AppError(403, "forbidden", "You can't write here.");
      const key = `${StorageService.key(s.id, "chat")}/${f.filename.replace(/[^\w.-]/g, "_")}`;
      let upload: { url: string; key: string; expiresAt: string } | null = null;
      if (f.bytes) await this.storage.putObject(key, f.bytes, f.mime);
      else
        upload = await this.storage.presignPut({
          key,
          contentType: f.mime,
          size: f.size,
          purpose: "chat",
        });
      const [row] = await tx
        .insert(messageAttachments)
        .values({
          id: id("att"),
          applicationId: c.applicationId,
          uploadedBy: s.id,
          lane: a.write[0],
          storagePath: key,
          filename: f.filename,
          mime: f.mime,
          size: f.size,
          createdAt: iso(),
          conversationId: c.conversationId,
          sha256: f.bytes
            ? createHash("sha256").update(f.bytes).digest("hex")
            : null,
          scanStatus: "pending",
        })
        .returning();
      // Same finalize job as documents (type sniff, scan, EXIF strip); `POST /api/documents/:id/complete` runs it early.
      await this.outbox.add(tx, { type: "documents.finalize", payload: { kind: "chat", id: row.id }, runAt: f.bytes ? undefined : new Date(Date.now() + FINALIZE_DELAY_MS) });
      await this.audit.record(tx, {
        action: "chat.attachment.uploaded",
        entity: "chat",
        entityId: row.id,
        after: { conversationId: c.conversationId, size: f.size },
      });
      return { ...attachmentView(row), upload };
    });
  }

  attachmentUrl(s: SessionUser, attId: string) {
    return this.tx.run(async (tx) => {
      const [x] = await tx
        .select()
        .from(messageAttachments)
        .where(eq(messageAttachments.id, attId));
      if (!x?.conversationId) throw notFound("Attachment");
      const { a } = await this.open(tx, s, x.conversationId);
      if (!a.lanes.includes(x.lane)) throw notFound("Attachment");
      if (x.scanStatus === "infected")
        throw new AppError(410, "quarantined", "This file was quarantined.");
      if (x.scanStatus !== "clean") throw new AppError(409, "scanning", "This file is still being checked.");
      return this.storage.presignGet(x.storagePath, x.filename);
    });
  }

  /** Batched receipt: one conditional update per (conversation, user); only moves forward. */
  private receipt(
    s: SessionUser,
    cid: string,
    col: "lastReadSeq" | "lastDeliveredSeq",
    seq?: number,
  ) {
    return this.run(async (tx, push) => {
      const { c, a } = await this.open(tx, s, cid);
      const to = Math.min(seq ?? c.lastSeq, c.lastSeq);
      const set =
        col === "lastReadSeq"
          ? {
              lastReadSeq: to,
              lastDeliveredSeq: sql`greatest(${conversationParticipants.lastDeliveredSeq}, ${to})`,
            }
          : { lastDeliveredSeq: to };
      const where = and(
        eq(conversationParticipants.conversationId, c.conversationId),
        eq(conversationParticipants.userId, s.id),
        lt(
          col === "lastReadSeq"
            ? conversationParticipants.lastReadSeq
            : conversationParticipants.lastDeliveredSeq,
          to,
        ),
      );
      let n = (
        await tx
          .update(conversationParticipants)
          .set(set)
          .where(where)
          .returning({ u: conversationParticipants.userId })
      ).length;
      if (!n && to > 0) {
        const ins = await tx
          .insert(conversationParticipants)
          .values({
            conversationId: c.conversationId,
            userId: s.id,
            role: partRole(a),
            joinedAt: iso(),
            lastReadSeq: col === "lastReadSeq" ? to : 0,
            lastDeliveredSeq: to,
          })
          .onConflictDoNothing()
          .returning({ u: conversationParticipants.userId });
        n = ins.length;
      }
      if (n)
        push({
          to: (await this.recipients(tx, c, a, "client")).filter(
            (u) => u !== s.id,
          ),
          type: col === "lastReadSeq" ? "chat.read" : "chat.delivered",
          payload: {
            conversation_id: c.conversationId,
            user_id: s.id,
            seq: to,
          },
        });
      return {
        conversation_id: c.conversationId,
        [col === "lastReadSeq" ? "last_read_seq" : "last_delivered_seq"]: to,
        updated: n,
      };
    });
  }
  markRead = (s: SessionUser, cid: string, seq?: number) =>
    this.receipt(s, cid, "lastReadSeq", seq);
  markDelivered = (s: SessionUser, cid: string, seq?: number) =>
    this.receipt(s, cid, "lastDeliveredSeq", seq);

  search(s: SessionUser, cid: string, q: string) {
    return this.tx.run(async (tx) => {
      const { c, a } = await this.open(tx, s, cid);
      if (q.trim().length < 2) return { results: [] };
      const rows = await tx
        .select()
        .from(applicationMessages)
        .where(
          and(
            eq(applicationMessages.conversationId, c.conversationId),
            inArray(applicationMessages.lane, a.lanes),
            isNull(applicationMessages.deletedAt),
            // F-MSG-11: full-text (simple dictionary: rw/en/fr mixed) with a substring fallback for codes and partial words.
            sql`(to_tsvector('simple', ${applicationMessages.content}) @@ websearch_to_tsquery('simple', ${q.trim()}) or ${ilike(
              applicationMessages.content,
              `%${q.trim().replace(/[\\%_]/g, "\\$&")}%`,
            )})`,
          ),
        )
        .orderBy(sql`ts_rank(to_tsvector('simple', ${applicationMessages.content}), websearch_to_tsquery('simple', ${q.trim()})) desc`, desc(applicationMessages.seq))
        .limit(50);
      return { results: await this.decorate(tx, rows) };
    });
  }

  pinned(s: SessionUser, cid: string) {
    return this.tx.run(async (tx) => {
      const { c, a } = await this.open(tx, s, cid);
      const rows = await tx
        .select()
        .from(applicationMessages)
        .where(
          and(
            eq(applicationMessages.conversationId, c.conversationId),
            inArray(applicationMessages.lane, a.lanes),
            sql`${applicationMessages.pinnedAt} is not null`,
            isNull(applicationMessages.deletedAt),
          ),
        )
        .orderBy(desc(applicationMessages.pinnedAt))
        .limit(50);
      return this.decorate(tx, rows);
    });
  }

  typing(s: SessionUser, cid: string, lane?: string | null) {
    return this.run(async (tx, push) => {
      const { c, a } = await this.open(tx, s, cid);
      const l = lane && a.write.includes(lane) ? lane : a.write[0];
      if (l)
        push({
          to: (await this.recipients(tx, c, a, l)).filter((u) => u !== s.id),
          type: "chat.typing",
          payload: {
            conversation_id: c.conversationId,
            user_id: s.id,
            lane: l,
          },
        });
      return { ok: true };
    });
  }

  mute(
    s: SessionUser,
    cid: string,
    b: { until?: string | null; hours?: number | null; muted?: boolean },
  ) {
    return this.tx.run(async (tx) => {
      const { c, a } = await this.open(tx, s, cid);
      const until =
        b.muted === false || b.hours === 0
          ? null
          : (b.until ??
            new Date(
              Date.now() + (b.hours ?? 24 * 365 * 10) * 3_600_000,
            ).toISOString());
      await tx
        .insert(conversationParticipants)
        .values({
          conversationId: c.conversationId,
          userId: s.id,
          role: partRole(a),
          joinedAt: iso(),
          mutedUntil: until,
        })
        .onConflictDoUpdate({
          target: [
            conversationParticipants.conversationId,
            conversationParticipants.userId,
          ],
          set: { mutedUntil: until },
        });
      return {
        conversation_id: c.conversationId,
        muted: !!until,
        muted_until: until,
      };
    });
  }

  /** Managers join a case thread (may then write the client lane); staff leave DMs/case threads. */
  join(s: SessionUser, cid: string) {
    return this.tx.run(async (tx) => {
      const { c, a } = await this.open(tx, s, cid);
      if (!a.admin)
        throw new AppError(403, "forbidden", "Only managers can join.");
      await tx
        .insert(conversationParticipants)
        .values({
          conversationId: c.conversationId,
          userId: s.id,
          role: "admin",
          joinedAt: iso(),
          lastReadSeq: c.lastSeq,
          lastDeliveredSeq: c.lastSeq,
        })
        .onConflictDoUpdate({
          target: [
            conversationParticipants.conversationId,
            conversationParticipants.userId,
          ],
          set: { leftAt: null, leftReason: null },
        });
      await this.postSystem(
        tx,
        c,
        "joined",
        `${(await this.names(tx, [s.id])).get(s.id) ?? "A manager"} joined`,
        { user_id: s.id },
        "internal",
      );
      await this.audit.record(tx, {
        action: "chat.joined",
        entity: "chat",
        entityId: c.conversationId,
      });
      return { conversation_id: c.conversationId, joined: true };
    });
  }
  leave(s: SessionUser, cid: string) {
    return this.tx.run(async (tx) => {
      const { c, a } = await this.open(tx, s, cid);
      if (a.role === "client")
        throw new AppError(
          403,
          "forbidden",
          "Clients can't leave their case thread.",
        );
      await tx
        .update(conversationParticipants)
        .set({ leftAt: iso(), leftReason: "left" })
        .where(
          and(
            eq(conversationParticipants.conversationId, c.conversationId),
            eq(conversationParticipants.userId, s.id),
          ),
        );
      return { conversation_id: c.conversationId, joined: false };
    });
  }

  partnerLane(s: SessionUser, cid: string, open: boolean) {
    return this.tx.run(async (tx) => {
      const { c, a } = await this.open(tx, s, cid);
      if (!a.app || !(a.role === "agent" || a.admin))
        throw new AppError(
          403,
          "forbidden",
          "Only the case owner can change the partner lane.",
        );
      if (!a.app.assignedPartnerId)
        throw new AppError(409, "conflict", "No partner on this case.");
      await tx
        .update(applications)
        .set({ partnerClientLaneOpen: open, updatedAt: iso() })
        .where(eq(applications.applicationId, a.app.applicationId));
      await this.postSystem(
        tx,
        c,
        "partner_lane",
        open
          ? "Partner can now message the client"
          : "Partner client lane closed",
        { open },
        "internal",
      );
      await this.audit.record(tx, {
        action: "chat.partner_lane",
        entity: "chat",
        entityId: c.conversationId,
        after: { open },
      });
      return { conversation_id: c.conversationId, partner_lane: open };
    });
  }

  // ── edits, deletes, reactions, pins, cards ──────────────────────────────────────────────────────────
  edit(s: SessionUser, mid: string, content: string) {
    return this.run(async (tx, push) => {
      const { m, c, a } = await this.message(tx, s, mid, true);
      if (m.senderId !== s.id || m.isSystem || m.deletedAt)
        throw new AppError(
          403,
          "forbidden",
          "You can only edit your own messages.",
        );
      if (Date.now() - Date.parse(m.createdAt) > EDIT_WINDOW_MS)
        throw new AppError(
          409,
          "edit_window_closed",
          "This message can no longer be edited.",
        );
      if (content === m.content) return this.one(tx, m);
      await tx
        .insert(messageEdits)
        .values({
          id: id("med"),
          messageId: m.messageId,
          previousContent: m.content,
          editedAt: iso(),
          editedBy: s.id,
        });
      const [u] = await tx
        .update(applicationMessages)
        .set({ content, editedAt: iso() })
        .where(eq(applicationMessages.messageId, m.messageId))
        .returning();
      const out = await this.one(tx, u);
      push({
        to: await this.recipients(tx, c, a, m.lane),
        type: "chat.message_edited",
        payload: { conversation_id: c.conversationId, message: out },
      });
      return out;
    });
  }

  remove(s: SessionUser, mid: string) {
    return this.run(async (tx, push) => {
      const { m, c, a } = await this.message(tx, s, mid, true);
      if (m.isSystem || (m.senderId !== s.id && !a.admin))
        throw new AppError(403, "forbidden", "You can't delete this message.");
      if (!m.deletedAt) {
        await tx
          .insert(messageEdits)
          .values({
            id: id("med"),
            messageId: m.messageId,
            previousContent: m.content,
            editedAt: iso(),
            editedBy: s.id,
          });
        await tx
          .update(applicationMessages)
          .set({ deletedAt: iso(), deletedBy: s.id })
          .where(eq(applicationMessages.messageId, m.messageId));
        await this.audit.record(tx, {
          action: "chat.message_deleted",
          entity: "chat",
          entityId: m.messageId,
          before: { content: m.content },
        });
        push({
          to: await this.recipients(tx, c, a, m.lane),
          type: "chat.message_deleted",
          payload: {
            conversation_id: c.conversationId,
            message_id: m.messageId,
          },
        });
      }
      return { message_id: m.messageId, deleted: true };
    });
  }

  history(s: SessionUser, mid: string) {
    return this.tx.run(async (tx) => {
      const { m, a } = await this.message(tx, s, mid);
      if (a.role === "client" && m.senderId !== s.id) return [];
      const rows = await tx
        .select()
        .from(messageEdits)
        .where(eq(messageEdits.messageId, m.messageId))
        .orderBy(asc(messageEdits.editedAt));
      return rows.map((r) => ({
        content: r.previousContent,
        edited_at: r.editedAt,
        edited_by: r.editedBy,
      }));
    });
  }

  react(s: SessionUser, mid: string, emoji: string) {
    return this.run(async (tx, push) => {
      const { m, c, a } = await this.message(tx, s, mid);
      const del = await tx
        .delete(messageReactions)
        .where(
          and(
            eq(messageReactions.messageId, m.messageId),
            eq(messageReactions.userId, s.id),
            eq(messageReactions.emoji, emoji),
          ),
        )
        .returning();
      if (!del.length)
        await tx
          .insert(messageReactions)
          .values({
            messageId: m.messageId,
            userId: s.id,
            emoji,
            createdAt: iso(),
          })
          .onConflictDoNothing();
      const { reactions } = await this.one(tx, m);
      push({
        to: await this.recipients(tx, c, a, m.lane),
        type: "chat.reaction",
        payload: {
          conversation_id: c.conversationId,
          message_id: m.messageId,
          reactions,
        },
      });
      return reactions;
    });
  }

  pin(s: SessionUser, mid: string, on: boolean) {
    return this.run(async (tx, push) => {
      const { m, c, a } = await this.message(tx, s, mid);
      if (a.role === "client")
        throw new AppError(403, "forbidden", "Only staff can pin messages.");
      const [u] = await tx
        .update(applicationMessages)
        .set(
          on
            ? { pinnedAt: iso(), pinnedBy: s.id }
            : { pinnedAt: null, pinnedBy: null },
        )
        .where(eq(applicationMessages.messageId, m.messageId))
        .returning();
      const out = await this.one(tx, u);
      push({
        to: await this.recipients(tx, c, a, m.lane),
        type: "chat.message_pinned",
        payload: { conversation_id: c.conversationId, message: out },
      });
      return out;
    });
  }

  /** Structured card (appointment, payment request, document request…) in the client lane, by staff only. */
  card(
    s: SessionUser,
    cid: string,
    b: { kind: string; payload: Record<string, unknown> },
  ) {
    return this.run(async (tx, push) => {
      const { c, a } = await this.open(tx, s, cid);
      if (a.role === "client" || !a.write.includes("client"))
        throw new AppError(403, "forbidden", "You can't post cards here.");
      // F-MSG-05: typed kinds only, payload validated per kind.
      const card = parseCard(b.kind, b.payload);
      if ("error" in card) throw new AppError(422, "validation", card.error === "unknown_card" ? "Unknown card type." : "Card details are incomplete.");
      const m = await this.append(tx, c, {
        senderId: s.id,
        senderRole: s.roles[0],
        content: String(card.payload.title ?? card.kind),
        isInternal: false,
        isSystem: false,
        attachments: [],
        isReadByClient: false,
        lane: "client",
        kind: "card",
        // Same shape as agent-inbox cards: payload.card = { type, title, detail, data }.
        payload: { card: { type: card.kind, title: String(card.payload.title ?? card.kind), detail: String(card.payload.detail ?? ""), data: card.payload } },
      });
      const out = await this.one(tx, m);
      push({
        to: await this.recipients(tx, c, a, "client"),
        type: "chat.message",
        payload: { conversation_id: c.conversationId, message: out },
      });
      return out;
    });
  }

  /** F-MSG-05: the client answers an actionable card once (quotation accept/decline). */
  cardAction(s: SessionUser, mid: string, action: string) {
    return this.run(async (tx, push) => {
      const { m, c, a } = await this.message(tx, s, mid, true);
      const p = (m.payload ?? {}) as { card?: { type?: string; response?: unknown } & Record<string, unknown> };
      const kind = String(p.card?.type ?? "") as keyof typeof CARD_ACTIONS;
      if (m.kind !== "card" || a.role !== "client") throw notFound("Card");
      if (!CARD_ACTIONS[kind]?.includes(action)) throw new AppError(422, "validation", "This card has no such action.");
      if (p.card?.response) throw new AppError(409, "already_decided", "Already answered.");
      await tx.update(applicationMessages).set({ payload: { ...p, card: { ...p.card, response: { action, by: s.id, at: iso() } } } }).where(eq(applicationMessages.messageId, mid));
      const sys = await this.postSystem(tx, c, "card_response", `Quotation ${action === "accept" ? "accepted" : "declined"}`, { card_id: mid, action });
      const out = await this.one(tx, sys);
      push({ to: await this.recipients(tx, c, a, "client"), type: "chat.message", payload: { conversation_id: c.conversationId, message: out } });
      return { id: mid, action };
    });
  }

  /** F-MSG-14: staff flag a case conversation as a complaint → FBK ticket for the client (type complaint, case linked). */
  flagComplaint(s: SessionUser, cid: string, summary: string) {
    return this.tx.run(async (tx) => {
      const { c, a } = await this.open(tx, s, cid);
      if (a.role === "client" || !a.app) throw new AppError(403, "forbidden", "Staff only, on a case conversation.");
      const clientId = a.app.clientId;
      if (!clientId) throw new AppError(422, "validation", "Guest case: no client account to attach the complaint to.");
      const [u] = await tx.select({ role: users.role }).from(users).where(eq(users.userId, clientId));
      const client: SessionUser = { id: clientId, roles: normalizeRoles({ role: u?.role ?? "client" }), scopes: {}, sid: "" };
      const t = await createTicket(tx, client, `Complaint: ${summary.slice(0, 120)}`, summary, { type: "complaint", caseRef: a.app.code });
      await this.postSystem(tx, c, "complaint_flagged", `Complaint ${t.ref} opened by ${s.id === a.app.assignedAgentId ? "the agent" : "a manager"}`, { ticket: t.ref }, "internal");
      return { ticket: t.ref };
    });
  }

  /** F-MSG-15: legal hold blocks retention archival. Managers only. */
  setLegalHold(s: SessionUser, cid: string, on: boolean) {
    if (!isManager(s)) throw new AppError(403, "forbidden", "Managers only.");
    return this.tx.run(async (tx) => {
      const c = await this.conv(tx, cid, true);
      await tx.update(conversations).set({ legalHold: on }).where(eq(conversations.conversationId, c.conversationId));
      return { id: c.conversationId, legal_hold: on };
    });
  }

  ics(s: SessionUser, mid: string) {
    return this.tx.run(async (tx) => {
      const { m } = await this.message(tx, s, mid);
      const p = (m.payload ?? {}) as Record<string, unknown>;
      const start =
        typeof p.start === "string"
          ? p.start
          : typeof p.at === "string"
            ? p.at
            : null;
      if (m.kind !== "card" || !start) throw notFound("Event");
      const d = (v: string) =>
        new Date(v).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
      const end =
        typeof p.end === "string"
          ? p.end
          : new Date(Date.parse(start) + 3_600_000).toISOString();
      const t = (v: unknown) =>
        String(v ?? "")
          .replace(/[\\;,]/g, "\\$&")
          .replace(/\r?\n/g, "\\n");
      return [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//HEBUZA//chat//EN",
        "BEGIN:VEVENT",
        `UID:${m.messageId}@hebuza`,
        `DTSTAMP:${d(m.createdAt)}`,
        `DTSTART:${d(start)}`,
        `DTEND:${d(end)}`,
        `SUMMARY:${t(p.title ?? "HEBUZA appointment")}`,
        ...(p.location ? [`LOCATION:${t(p.location)}`] : []),
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n");
    });
  }

  // ── inbox ────────────────────────────────────────────────────────────────────────────────────────────
  myConversations(
    s: SessionUser,
    q: { kind?: string; q?: string; filter?: string },
  ) {
    const kind =
      q.kind === "staff_dm" ? DM : q.kind === "application" ? CASE : q.kind;
    return this.tx.run(async (tx) => {
      const parts = await tx
        .select()
        .from(conversationParticipants)
        .where(
          and(
            eq(conversationParticipants.userId, s.id),
            isNull(conversationParticipants.leftAt),
          ),
        );
      const caseConvIds = (
        await tx
          .select({ id: conversations.conversationId })
          .from(conversations)
          .innerJoin(
            applications,
            eq(applications.applicationId, conversations.applicationId),
          )
          .where(
            s.roles.includes("client")
              ? eq(applications.clientId, s.id)
              : eq(applications.assignedAgentId, s.id),
          )
      ).map((r) => r.id);
      const ids = [
        ...new Set([...parts.map((p) => p.conversationId), ...caseConvIds]),
      ];
      const convs = ids.length
        ? await tx
            .select()
            .from(conversations)
            .where(
              and(
                inArray(conversations.conversationId, ids),
                kind ? eq(conversations.kind, kind) : undefined,
              ),
            )
            .orderBy(sql`${conversations.lastMessageAt} desc nulls last`)
            .limit(200)
        : [];
      const P = new Map(parts.map((p) => [p.conversationId, p]));
      const rows = await this.rows(
        tx,
        convs,
        s,
        (cid) => P.get(cid)?.lastReadSeq ?? 0,
      );
      const list = rows.filter(
        (r) =>
          matches(r, q.q ?? "") &&
          (q.filter !== "unread" || r.unread_for_admin > 0),
      );
      const out = list.map((r) => ({
        ...strip(r),
        unread: r.unread_for_admin,
        muted:
          !!P.get(r.conversation_id)?.mutedUntil &&
          Date.parse(P.get(r.conversation_id)!.mutedUntil!) > Date.now(),
      }));
      return {
        conversations: out,
        unread_total: out.reduce((n, r) => n + (r.muted ? 0 : r.unread), 0),
        next_cursor: null,
      };
    });
  }

  byApplication(s: SessionUser, code: string) {
    return this.conversation(s, `cv-${code}`);
  }

  conversation(s: SessionUser, cid: string) {
    return this.tx.run(async (tx) => {
      const { c, a } = await this.open(tx, s, cid);
      const [me] = await tx
        .select()
        .from(conversationParticipants)
        .where(
          and(
            eq(conversationParticipants.conversationId, c.conversationId),
            eq(conversationParticipants.userId, s.id),
          ),
        );
      const [r] = await this.rows(tx, [c], s, () => me?.lastReadSeq ?? 0);
      return {
        ...strip(r),
        unread: r.unread_for_admin,
        lanes: a.lanes,
        write_lanes: a.write,
        latest_seq: c.lastSeq,
        last_read_seq: me?.lastReadSeq ?? 0,
        muted: !!me?.mutedUntil && Date.parse(me.mutedUntil) > Date.now(),
        partner_lane: a.app?.partnerClientLaneOpen ?? false,
        application_code: a.app?.code ?? null,
      };
    });
  }

  /** A staff DM between two staff members (created on first use). */
  staffDm(s: SessionUser, other: string) {
    if (!isStaff(s)) throw new AppError(403, "forbidden", "Forbidden");
    if (other === s.id)
      throw new AppError(422, "validation", "Pick someone else.");
    return this.tx.run(async (tx) => {
      const [u] = await tx
        .select({ role: users.role, active: users.isActive })
        .from(users)
        .where(eq(users.userId, other));
      if (
        !u?.active ||
        !(u.role.startsWith("staff:") || u.role === "ext:agent")
      )
        throw notFound("User");
      const rows = await tx.execute<{ id: string }>(sql`
        select p1.conversation_id id from conversation_participants p1 join conversation_participants p2 using (conversation_id)
        join conversations c on c.conversation_id = p1.conversation_id
        where c.kind = ${DM} and p1.user_id = ${s.id} and p2.user_id = ${other} limit 1`);
      if (rows[0]) return { conversation_id: rows[0].id, kind: "staff_dm" };
      const now = iso();
      const [c] = await tx
        .insert(conversations)
        .values({
          conversationId: id("cnv"),
          kind: DM,
          lastSeq: 0,
          createdAt: now,
        })
        .returning();
      await tx
        .insert(conversationParticipants)
        .values(
          [s.id, other].map((u) => ({
            conversationId: c.conversationId,
            userId: u,
            role: "agent",
            joinedAt: now,
          })),
        );
      return { conversation_id: c.conversationId, kind: "staff_dm" };
    });
  }

  // ── console rows ─────────────────────────────────────────────────────────────────────────────────────
  /** One batched pass per list (no per-row queries): last message, last client-lane message, notes count, claims, disputes. */
  private async rows(
    tx: Tx,
    convs: Conv[],
    s: SessionUser,
    lastRead?: (cid: string) => number,
  ) {
    if (!convs.length) return [];
    const ids = convs.map((c) => c.conversationId);
    const appIds = convs
      .map((c) => c.applicationId)
      .filter((x): x is string => !!x);
    const [lasts, lastClients, notes, apps, claims, dmParts, handoffs] =
      await Promise.all([
        tx.execute<{ cid: string; content: string; deleted: boolean }>(sql`
        select distinct on (conversation_id) conversation_id cid, content, deleted_at is not null deleted from application_messages
        where conversation_id in ${ids} order by conversation_id, seq desc`),
        tx.execute<{ cid: string; role: string | null; at: string }>(sql`
        select distinct on (conversation_id) conversation_id cid, sender_role role, created_at at from application_messages
        where conversation_id in ${ids} and lane = 'client' and is_system = false order by conversation_id, seq desc`),
        tx.execute<{ cid: string }>(
          sql`select distinct conversation_id cid from application_messages where conversation_id in ${ids} and lane = 'internal'`,
        ),
        appIds.length
          ? tx
              .select()
              .from(applications)
              .where(inArray(applications.applicationId, appIds))
          : [],
        tx
          .select()
          .from(opsRecords)
          .where(
            and(
              eq(opsRecords.kind, "conv_claim"),
              inArray(opsRecords.ref, ids),
            ),
          ),
        tx
          .select()
          .from(conversationParticipants)
          .where(
            and(
              inArray(conversationParticipants.conversationId, ids),
              ne(conversationParticipants.userId, s.id),
              isNull(conversationParticipants.leftAt),
            ),
          ),
        tx.execute<{ cid: string }>(
          sql`select distinct conversation_id cid from application_messages where conversation_id in ${ids} and kind = 'handoff'`,
        ),
      ]);
    const A = new Map(apps.map((a) => [a.applicationId, a]));
    const codes = apps.map((a) => a.code);
    const disputes = codes.length
      ? await tx
          .select({ ref: opsRecords.ref })
          .from(opsRecords)
          .where(
            and(
              eq(opsRecords.kind, "ticket"),
              inArray(opsRecords.ref, codes),
              sql`${opsRecords.data}->>'kind' = 'dispute'`,
              ne(opsRecords.state, "resolved"),
            ),
          )
      : [];
    const D = new Set(disputes.map((d) => d.ref));
    const L = new Map(lasts.map((r) => [r.cid, r]));
    const LC = new Map(lastClients.map((r) => [r.cid, r]));
    const N = new Set(notes.map((r) => r.cid));
    const H = new Set(handoffs.map((r) => r.cid));
    const C = new Map(
      claims.map((r) => [r.ref, r.data as { userId: string; name: string }]),
    );
    const other = new Map(dmParts.map((p) => [p.conversationId, p.userId]));
    const names = await this.names(tx, [
      ...apps.map((a) => a.clientId),
      ...dmParts.map((p) => p.userId),
    ]);
    return convs.map((c) => {
      const app = c.applicationId ? A.get(c.applicationId) : undefined;
      const last = L.get(c.conversationId),
        lc = LC.get(c.conversationId),
        claim = C.get(c.conversationId);
      const clientName = app
        ? (names.get(app.clientId ?? "") ??
          String(
            (app.personalInfo as Record<string, unknown>).fullName ?? "Client",
          ))
        : null;
      const waitingOn = lc ? (lc.role === "client" ? "us" : "client") : null;
      const dmName =
        c.kind === DM
          ? names.get(other.get(c.conversationId) ?? "")
          : undefined;
      return {
        conversation_id: c.conversationId,
        kind:
          c.kind === DM ? "staff_dm" : c.kind === CASE ? "application" : c.kind,
        code: app?.code ?? null,
        title: dmName ?? c.title ?? clientName,
        client_name: clientName,
        last_message_preview: last
          ? last.deleted
            ? ""
            : last.content.slice(0, 140)
          : null,
        last_message_at: c.lastMessageAt,
        waiting_since: waitingOn === "us" ? lc!.at : null,
        unread_for_admin: lastRead
          ? Math.max(0, c.lastSeq - lastRead(c.conversationId))
          : waitingOn === "us"
            ? 1
            : 0,
        has_dispute: !!app && D.has(app.code),
        has_internal_notes: N.has(c.conversationId),
        handoff: H.has(c.conversationId),
        claimed_by: claim?.userId ?? null,
        claimed_by_name: claim?.name ?? null,
        waiting_on: waitingOn,
      };
    });
  }

  private async consoleRows(tx: Tx, s: SessionUser) {
    // shortcut: newest 300 open case threads, filtered in memory; move filters into SQL when the console outgrows that.
    const convs = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.kind, CASE),
          isNull(conversations.closedAt),
          sql`${conversations.lastMessageAt} is not null`,
        ),
      )
      .orderBy(desc(conversations.lastMessageAt))
      .limit(300);
    return this.rows(tx, convs, s);
  }

  adminList(
    s: SessionUser,
    q: {
      handoff?: string;
      unassigned?: string;
      agent_id?: string;
      waiting_hours?: string;
      waiting_on?: string;
      disputes?: string;
      has_internal_notes?: string;
      q?: string;
    },
  ) {
    const on = (v?: string) => !!v && v !== "false";
    return this.tx.run(async (tx) => {
      const me = q.agent_id && q.agent_id !== "me" ? q.agent_id : s.id;
      const minWait = Number(q.waiting_hours) || 0;
      const list = (await this.consoleRows(tx, s))
        .filter(
          (r) =>
            (!on(q.handoff) || r.handoff) &&
            (!on(q.unassigned) || !r.claimed_by) &&
            (!q.agent_id || r.claimed_by === me) &&
            (!q.waiting_hours ||
              (r.waiting_since &&
                Date.now() - Date.parse(r.waiting_since) >=
                  minWait * 3_600_000)) &&
            (!q.waiting_on || r.waiting_on === q.waiting_on) &&
            (!on(q.disputes) || r.has_dispute) &&
            (!on(q.has_internal_notes) || r.has_internal_notes) &&
            matches(r, q.q ?? ""),
        )
        .map(strip);
      return { conversations: list, total: list.length, archived_hidden: 0 };
    });
  }

  adminCounts(s: SessionUser) {
    return this.tx.run(async (tx) => {
      const rows = await this.consoleRows(tx, s);
      const [dms] = await tx.execute<{ n: number }>(sql`
        select count(*)::int n from conversation_participants p join conversations c using (conversation_id)
        where p.user_id = ${s.id} and p.left_at is null and c.kind = ${DM} and c.last_seq > p.last_read_seq`);
      return {
        unassigned: rows.filter((r) => !r.claimed_by).length,
        mine: rows.filter((r) => r.claimed_by === s.id).length,
        waiting_us: rows.filter((r) => r.waiting_on === "us").length,
        waiting_client: rows.filter((r) => r.waiting_on === "client").length,
        handoff: rows.filter((r) => r.handoff).length,
        dms: Number(dms?.n ?? 0),
      };
    });
  }

  adminOne(s: SessionUser, cid: string) {
    return this.tx.run(async (tx) => {
      const { c } = await this.open(tx, s, cid);
      return strip((await this.rows(tx, [c], s))[0]);
    });
  }

  adminMetrics(s: SessionUser) {
    return this.tx.run(async (tx) => {
      const rows = await this.consoleRows(tx, s);
      const open = await tx
        .select({ data: opsRecords.data })
        .from(opsRecords)
        .where(
          and(
            eq(opsRecords.kind, "ticket"),
            sql`${opsRecords.data}->>'kind' = 'dispute'`,
            ne(opsRecords.state, "resolved"),
          ),
        );
      const perDay = await tx.execute<{ d: string; n: number }>(
        sql`select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') d, count(*)::int n from application_messages where created_at >= now() - interval '14 days' group by 1 order by 1`,
      );
      const perAgent = await tx.execute<{ id: string; n: number }>(
        sql`select sender_id id, count(*)::int n from application_messages where created_at >= now() - interval '30 days' and sender_role <> 'client' and sender_id is not null group by 1 order by 2 desc limit 20`,
      );
      const [frt] = await tx.execute<{ m: number | null }>(sql`
        select percentile_cont(0.5) within group (order by extract(epoch from (r.created_at - q.created_at)) / 60) m
        from application_messages q
        join lateral (select created_at from application_messages r where r.conversation_id = q.conversation_id and r.lane = 'client'
          and r.seq > q.seq and r.sender_role <> 'client' and r.is_system = false order by r.seq limit 1) r on true
        where q.lane = 'client' and q.sender_role = 'client' and q.created_at >= now() - interval '30 days'`);
      const names = await this.names(
        tx,
        perAgent.map((a) => a.id),
      );
      const due = (d: unknown) =>
        Date.parse(
          String((d as { responseDueAt?: string }).responseDueAt ?? ""),
        ) < Date.now();
      return {
        agents: perAgent.map((a) => ({
          agent_id: a.id,
          name: names.get(a.id) ?? a.id,
          messages: Number(a.n),
        })),
        messages_per_day: perDay.map((d) => ({
          date: d.d,
          count: Number(d.n),
        })),
        total_conversations: rows.length,
        open_disputes: open.length,
        breached_disputes: open.filter((t) => due(t.data)).length,
        waiting_for_reply: rows.filter((r) => r.waiting_on === "us").length,
        median_first_response_minutes:
          frt?.m == null ? null : Math.round(Number(frt.m)),
      };
    });
  }

  adminClaim(s: SessionUser, cid: string) {
    return this.tx.run(async (tx) => {
      const { c } = await this.open(tx, s, cid);
      const cur = await this.claimOf(tx, c.conversationId, true);
      if (cur && cur.userId !== s.id)
        throw new AppError(409, "conflict", `Already claimed by ${cur.name}`);
      const name = (await this.names(tx, [s.id])).get(s.id) ?? "Staff";
      await tx
        .insert(opsRecords)
        .values({
          id: `cc:${c.conversationId}`,
          kind: "conv_claim",
          ownerId: s.id,
          ref: c.conversationId,
          data: { userId: s.id, name },
        })
        .onConflictDoUpdate({
          target: opsRecords.id,
          set: {
            ownerId: s.id,
            data: { userId: s.id, name },
            updatedAt: iso(),
          },
        });
      await tx
        .insert(conversationParticipants)
        .values({
          conversationId: c.conversationId,
          userId: s.id,
          role: "admin",
          joinedAt: iso(),
          lastReadSeq: c.lastSeq,
          lastDeliveredSeq: c.lastSeq,
        })
        .onConflictDoUpdate({
          target: [
            conversationParticipants.conversationId,
            conversationParticipants.userId,
          ],
          set: { leftAt: null, leftReason: null },
        });
      await this.audit.record(tx, {
        action: "chat.claimed",
        entity: "chat",
        entityId: c.conversationId,
      });
      return {
        ...strip((await this.rows(tx, [c], s))[0]),
        claimed_by: s.id,
        claimed_by_name: name,
      };
    });
  }

  /** Link a support (non-case) conversation to an application. */
  adminLink(s: SessionUser, cid: string, code: string) {
    return this.tx.run(async (tx) => {
      const { c } = await this.open(tx, s, cid);
      if (c.kind === CASE)
        throw new AppError(
          409,
          "conflict",
          "Case conversations are already linked.",
        );
      const [app] = await tx
        .select()
        .from(applications)
        .where(eq(applications.code, code.toUpperCase()));
      if (!app) throw notFound("Application");
      const [taken] = await tx
        .select({ id: conversations.conversationId })
        .from(conversations)
        .where(eq(conversations.applicationId, app.applicationId));
      if (taken)
        throw new AppError(
          409,
          "conflict",
          `${app.code} already has a conversation.`,
        );
      const [u] = await tx
        .update(conversations)
        .set({ applicationId: app.applicationId })
        .where(eq(conversations.conversationId, c.conversationId))
        .returning();
      await this.audit.record(tx, {
        action: "chat.linked",
        entity: "chat",
        entityId: c.conversationId,
        after: { code: app.code },
      });
      return {
        ...strip((await this.rows(tx, [u], s))[0]),
        application_code: app.code,
      };
    });
  }

  /** Transcript lines; internal notes only when the caller passed step-up (checked by the controller). */
  transcript(s: SessionUser, cid: string, internal: boolean, format: string) {
    return this.tx.run(async (tx) => {
      const { c, a } = await this.open(tx, s, cid);
      const lanes = a.lanes.filter((l) => internal || l !== "internal");
      const ms = await tx
        .select()
        .from(applicationMessages)
        .where(
          and(
            eq(applicationMessages.conversationId, c.conversationId),
            inArray(applicationMessages.lane, lanes),
          ),
        )
        .orderBy(asc(applicationMessages.seq));
      const lines = (await this.decorate(tx, ms)).map((m) => ({
        at: m.created_at,
        lane: m.lane,
        sender: m.sender_name ?? "system",
        content: m.deleted_at ? "(deleted)" : m.content,
      }));
      await this.audit.record(tx, {
        action: "chat.transcript_exported",
        entity: "chat",
        entityId: c.conversationId,
        after: { internal, format },
      });
      return {
        name: `transcript-${a.app?.code ?? c.conversationId}`,
        title: `Conversation ${a.app?.code ?? ""}`,
        lines,
      };
    });
  }

  // ── mentions, references, templates ─────────────────────────────────────────────────────────────────
  mentionCandidates(s: SessionUser, cid: string) {
    return this.tx.run(async (tx) => {
      const { a } = await this.open(tx, s, cid);
      if (a.role === "client") return [];
      const rows = await tx
        .select({ id: users.userId, name: users.name })
        .from(users)
        .leftJoin(agentProfiles, eq(agentProfiles.userId, users.userId))
        .where(
          and(
            eq(users.isActive, true),
            ne(users.userId, s.id),
            sql`(${agentProfiles.userId} is not null or ${holdsRole("staff:service_manager")})`,
          ),
        )
        .orderBy(asc(users.name))
        .limit(200);
      return rows.map((x) => ({ user_id: x.id, name: x.name, role: "staff" }));
    });
  }

  referenceCandidates(
    s: SessionUser,
    cid: string,
    q: { q?: string; type?: string },
  ) {
    return this.tx.run(async (tx) => {
      const { a } = await this.open(tx, s, cid);
      if (q.type && q.type !== "application") return [];
      const term = (q.q ?? "").trim().replace(/[\\%_]/g, "\\$&");
      const scope =
        a.role === "client"
          ? eq(applications.clientId, s.id)
          : a.admin
            ? undefined
            : eq(applications.assignedAgentId, s.id);
      const rows = await tx
        .select({ code: applications.code, name: applications.serviceName })
        .from(applications)
        .where(
          and(
            scope,
            term
              ? sql`(${applications.code} ilike ${`%${term}%`} or ${applications.serviceName} ilike ${`%${term}%`})`
              : undefined,
          ),
        )
        .orderBy(desc(applications.createdAt))
        .limit(20);
      return rows.map((r) => ({
        type: "application",
        ref: r.code,
        label: `${r.code} — ${r.name}`,
      }));
    });
  }

  templates(s: SessionUser, q?: string) {
    return this.tx.run(async (tx) => {
      const term = (q ?? "").trim().replace(/[\\%_]/g, "\\$&");
      const rows = await tx
        .select()
        .from(chatTemplates)
        .where(
          and(
            eq(chatTemplates.isActive, true),
            sql`(${chatTemplates.scope} in ('all','global') or ${chatTemplates.createdBy} = ${s.id})`,
            term ? ilike(chatTemplates.title, `%${term}%`) : undefined,
          ),
        )
        .orderBy(asc(chatTemplates.title));
      return rows.map(tplOut);
    });
  }

  /** Managers (msg.templates.manage) write global templates; everyone else only their own personal ones. */
  private mayManage(
    s: SessionUser,
    t: { scope: string; createdBy: string | null },
  ) {
    return (
      s.roles.includes("staff:service_manager") ||
      (t.scope === "agent" && t.createdBy === s.id)
    );
  }

  createTemplate(
    s: SessionUser,
    b: {
      title: string;
      body_rw: string;
      body_en: string;
      body_fr: string;
      scope?: string;
      is_active?: boolean;
    },
  ) {
    const scope = s.roles.includes("staff:service_manager")
      ? (b.scope ?? "all")
      : "agent";
    return this.tx.run(async (tx) => {
      const [t] = await tx
        .insert(chatTemplates)
        .values({
          templateId: id("tpl"),
          title: b.title,
          bodyRw: b.body_rw,
          bodyEn: b.body_en,
          bodyFr: b.body_fr,
          scope,
          createdBy: s.id,
          isActive: b.is_active ?? true,
        })
        .returning();
      await this.audit.record(tx, {
        action: "chat.template.created",
        entity: "chat",
        entityId: t.templateId,
        after: tplOut(t),
      });
      return tplOut(t);
    });
  }

  updateTemplate(
    s: SessionUser,
    tid: string,
    b: Partial<{
      title: string;
      body_rw: string;
      body_en: string;
      body_fr: string;
      scope: string;
      is_active: boolean;
    }>,
  ) {
    return this.tx.run(async (tx) => {
      const [t] = await tx
        .select()
        .from(chatTemplates)
        .where(eq(chatTemplates.templateId, tid))
        .for("update");
      if (!t || !this.mayManage(s, t)) throw notFound("Template");
      const [u] = await tx
        .update(chatTemplates)
        .set({
          title: b.title,
          bodyRw: b.body_rw,
          bodyEn: b.body_en,
          bodyFr: b.body_fr,
          scope: s.roles.includes("staff:service_manager")
            ? b.scope
            : undefined,
          isActive: b.is_active,
          updatedAt: iso(),
        })
        .where(eq(chatTemplates.templateId, tid))
        .returning();
      await this.audit.record(tx, {
        action: "chat.template.updated",
        entity: "chat",
        entityId: tid,
        before: tplOut(t),
        after: tplOut(u),
      });
      return tplOut(u);
    });
  }

  deleteTemplate(s: SessionUser, tid: string) {
    return this.tx.run(async (tx) => {
      const [t] = await tx
        .select()
        .from(chatTemplates)
        .where(eq(chatTemplates.templateId, tid));
      if (!t || !this.mayManage(s, t)) throw notFound("Template");
      await tx.delete(chatTemplates).where(eq(chatTemplates.templateId, tid));
      await this.audit.record(tx, {
        action: "chat.template.deleted",
        entity: "chat",
        entityId: tid,
        before: tplOut(t),
      });
      return { template_id: tid, deleted: true };
    });
  }

  renderTemplate(s: SessionUser, tid: string, cid: string, locale?: string) {
    return this.tx.run(async (tx) => {
      const [t] = await tx
        .select()
        .from(chatTemplates)
        .where(eq(chatTemplates.templateId, tid));
      if (!t || !t.isActive) throw notFound("Template");
      const { a } = await this.open(tx, s, cid);
      const [client] = a.app?.clientId
        ? await tx.select().from(users).where(eq(users.userId, a.app.clientId))
        : [];
      const ok = (l?: string | null): l is "rw" | "en" | "fr" =>
        !!l && ["rw", "en", "fr"].includes(l);
      const loc = ok(locale)
        ? locale
        : ok(client?.language)
          ? client.language
          : "en";
      const due = a.app?.dueAt ?? a.app?.slaDeadline;
      const vars: Record<string, string> = {
        client_name:
          client?.name ??
          String(
            (a.app?.personalInfo as Record<string, unknown> | undefined)
              ?.fullName ?? "",
          ),
        case_ref: a.app?.code ?? "",
        due_date: due
          ? new Date(due).toLocaleDateString(loc === "rw" ? "en-GB" : loc, {
              day: "numeric",
              month: "short",
              year: "numeric",
              timeZone: "Africa/Kigali",
            })
          : "",
      };
      const body = { rw: t.bodyRw, en: t.bodyEn, fr: t.bodyFr }[loc].replace(
        /\{(\w+)\}/g,
        (_, k: string) => vars[k] ?? `{${k}}`,
      );
      return { template_id: t.templateId, title: t.title, locale: loc, body };
    });
  }

  // ── disputes (client opens from chat, ops resolves) ─────────────────────────────────────────────────
  // Stored as an ops "ticket" record (kind dispute, id tkt:<ref>) so the ops ticket desk sees the same row.
  private async openDisputeRow(tx: Tx, code: string) {
    const [r] = await tx
      .select()
      .from(opsRecords)
      .where(
        and(
          eq(opsRecords.kind, "ticket"),
          eq(opsRecords.ref, code),
          sql`${opsRecords.data}->>'kind' = 'dispute'`,
          ne(opsRecords.state, "resolved"),
        ),
      )
      .limit(1);
    return r ?? null;
  }

  disputeOf(s: SessionUser, cid: string) {
    return this.tx.run(async (tx) => {
      const { c, a } = await this.open(tx, s, cid);
      const r = a.app ? await this.openDisputeRow(tx, a.app.code) : null;
      return r ? disputeOut(r.data as Ticket, c.conversationId) : null;
    });
  }

  openDispute(
    s: SessionUser,
    cid: string,
    b: { category: string; note: string },
  ) {
    return this.run(async (tx, push) => {
      const { c, a } = await this.open(tx, s, cid);
      if (!a.app) throw gone();
      if (await this.openDisputeRow(tx, a.app.code))
        throw new AppError(
          409,
          "conflict",
          "A dispute is already open on this case.",
        );
      const [{ n }] = await tx.execute<{ n: number }>(
        sql`select nextval('support_ticket_ref_seq')::int n`,
      );
      const ref = `TKT-${new Date().getUTCFullYear()}-${String(n).padStart(5, "0")}`;
      const owner = a.app.assignedAgentId ?? s.id;
      const names = await this.names(tx, [owner, s.id, a.app.clientId]);
      const by =
        a.role === "client"
          ? (names.get(s.id) ?? "Client")
          : (names.get(s.id) ?? "Staff");
      const now = iso();
      const t: Ticket = {
        ref,
        kind: "dispute",
        category: b.category,
        client: names.get(a.app.clientId ?? "") ?? "Client",
        clientId: a.app.clientId,
        caseRef: a.app.code,
        service: a.app.serviceName,
        paid: a.app.paymentStatus === "paid" ? (a.app.paymentAmount ?? 0) : 0,
        priority: "high",
        status: "open",
        owner: { id: owner, name: names.get(owner) ?? "Staff" },
        responseDueAt: new Date(
          Date.now() + DISPUTE_RESPONSE_MIN * 60_000,
        ).toISOString(),
        responded: false,
        escalatedAt: null,
        disputeId: `dsp-${ref}`,
        conversationId: c.conversationId,
        satisfaction: null,
        messages: [
          {
            id: `${ref}-1`,
            author: by,
            role: a.role === "client" ? "client" : "staff",
            internal: false,
            kind: "text",
            body: b.note,
            at: now,
          },
        ],
        files: [],
        activity: [{ at: now, text: `Opened by ${by}` }],
        history: [],
        refundRequest: null,
        credits: 0,
        resolution: null,
      };
      await tx
        .insert(opsRecords)
        .values({
          id: `tkt:${ref}`,
          kind: "ticket",
          ownerId: a.app.clientId,
          ref: a.app.code,
          state: "open",
          data: t,
        });
      const m = await this.postSystem(tx, c, "dispute_opened", b.note, {
        dispute_id: t.disputeId,
        category: b.category,
      });
      if (owner !== s.id)
        await this.notifications.notify(tx, {
          userId: owner,
          kind: "ticket",
          title: `New dispute on ${a.app.code}`,
          link: `/ops/tickets/${ref}`,
        });
      await this.audit.record(tx, {
        action: "chat.dispute_opened",
        entity: "chat",
        entityId: t.disputeId!,
        after: { category: b.category },
      });
      push({
        to: await this.recipients(tx, c, a, "client"),
        type: "chat.message",
        payload: {
          conversation_id: c.conversationId,
          message: await this.one(tx, m),
        },
      });
      return disputeOut(t, c.conversationId);
    });
  }

  closeDispute(
    s: SessionUser,
    did: string,
    b: {
      resolution_kind: string;
      note?: string | null;
      reassign_agent_id?: string | null;
    },
  ) {
    return this.tx.run(async (tx) => {
      const [rec] = await tx
        .select()
        .from(opsRecords)
        .where(
          and(
            eq(opsRecords.kind, "ticket"),
            eq(opsRecords.id, `tkt:${did.replace(/^dsp-/, "")}`),
          ),
        )
        .for("update");
      if (!rec) throw notFound("Dispute");
      const t = rec.data as Ticket,
        now = iso();
      if (t.status === "resolved")
        throw new AppError(
          409,
          "conflict",
          "This dispute is already resolved.",
        );
      t.status = "resolved";
      t.resolution = {
        summary: b.note ?? b.resolution_kind,
        rootCause: b.resolution_kind,
        preventive: "",
      };
      t.activity.unshift({
        at: now,
        text: `Dispute resolved (${b.resolution_kind})`,
      });
      await tx
        .update(opsRecords)
        .set({
          state: "resolved",
          data: t,
          updatedAt: now,
          version: sql`${opsRecords.version} + 1`,
        })
        .where(eq(opsRecords.id, rec.id));
      if (t.conversationId) {
        const [c] = await tx
          .select()
          .from(conversations)
          .where(eq(conversations.conversationId, t.conversationId));
        if (c)
          await this.postSystem(
            tx,
            c,
            "dispute_resolved",
            b.note ?? b.resolution_kind,
            { dispute_id: did, resolution_kind: b.resolution_kind },
          );
      }
      if (t.clientId)
        await this.notifications.notify(tx, {
          userId: t.clientId,
          kind: "ticket",
          title: `Your dispute on ${t.caseRef} was resolved`,
          body: b.note ?? null,
          link: `/requests/${t.caseRef}`,
        });
      await this.audit.record(tx, {
        action: "chat.dispute_resolved",
        entity: "chat",
        entityId: did,
        after: b,
      });
      return {
        ...disputeOut(t, t.conversationId),
        resolved_at: now,
        resolution_kind: b.resolution_kind,
        resolution_note: b.note ?? null,
        breached: Date.parse(t.responseDueAt) < Date.now() && !t.responded,
      };
    });
  }
}

/** Same document shape as the ops ticket desk (ops.manage Ticket). */
export type Ticket = {
  ref: string;
  kind: "complaint" | "dispute" | "enquiry";
  category: string;
  client: string;
  clientId: string | null;
  caseRef: string;
  service: string;
  paid: number;
  priority: "high" | "medium" | "low";
  status: string;
  owner: { id: string; name: string };
  responseDueAt: string;
  responded: boolean;
  escalatedAt: string | null;
  disputeId: string | null;
  conversationId: string | null;
  satisfaction: number | null;
  messages: {
    id: string;
    author: string;
    role: "client" | "staff";
    internal: boolean;
    kind: "text" | "call";
    body: string;
    at: string;
  }[];
  files: { name: string; size: string }[];
  activity: { at: string; text: string }[];
  history: { ref: string; category: string; status: string }[];
  refundRequest: { amount: number; reason: string; status: string } | null;
  credits: number;
  resolution: { summary: string; rootCause: string; preventive: string } | null;
};
const disputeOut = (t: Ticket, cid: string | null) => ({
  dispute_id: t.disputeId,
  conversation_id: cid,
  kind: "dispute",
  category: t.category,
  note: t.messages[0]?.body ?? "",
  reason: t.messages[0]?.body ?? "",
  status: t.status === "resolved" ? "resolved" : "open",
  breached: Date.parse(t.responseDueAt) < Date.now() && !t.responded,
  resolution: t.resolution?.summary ?? null,
  created_at: t.messages[0]?.at ?? null,
});

const tplOut = (t: typeof chatTemplates.$inferSelect) => ({
  template_id: t.templateId,
  title: t.title,
  body_rw: t.bodyRw,
  body_en: t.bodyEn,
  body_fr: t.bodyFr,
  scope: t.scope,
  is_active: t.isActive,
  updated_at: t.updatedAt,
  created_by: t.createdBy,
});

type Row = {
  title: string | null;
  code: string | null;
  last_message_preview: string | null;
  waiting_on: string | null;
};
const matches = (r: Row, q: string) =>
  !q ||
  [r.title, r.code, r.last_message_preview].some((x) =>
    x?.toLowerCase().includes(q.toLowerCase()),
  );
const strip = <R extends Row>({ waiting_on, ...r }: R) => (void waiting_on, r);
