// PRT institutional partners: registry, contacts, agreements, actions, meetings, correspondence, referrals,
// commissions (computed from paid referred cases, approved by finance), scorecard, history, reminders.
import { Injectable, Logger } from "@nestjs/common";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import {
  applications,
  partnerActions,
  partnerAgreements,
  partnerCommissions,
  partnerContacts,
  partnerCorrespondence,
  partnerMeetings,
  partnerReferrals,
  partners,
  users,
  partnerObjectives,
  partnerOpportunities,
  partnerObligations,
  partnerAgreementFiles,
  deadlineNotifications,
} from "@/db/schema";
import {
  agreementState,
  commissionOf,
  partnerHealth,
  renewalDue,
} from "@/domain/partners/partners";
import type { SessionUser } from "../../core/http/context";
import { AppError, notFound } from "../../core/http/errors";
import type { Tx } from "../../core/db/db";
import { TxService } from "../../core/db/tx";
import { AuditService } from "../../core/db/audit";
import { generateId } from "../../core/db/ids";
import { Cron } from "../../core/queue/queues";
import { NotificationsService } from "../notifications/notifications.service";
import { money, paidRows } from "../applications/applications.service";
import { upsertPayable } from "../finance/finance.cases";
import { textPdf } from "../chat/chat.service";
import { StorageService } from "../../core/storage/storage.service";
import { OutboxService } from "../../core/db/outbox";

/** Child record kinds served by the generic CRUD routes (`/staff/partners/:id/:kind`). */
export const CHILDREN = {
  contacts: partnerContacts,
  agreements: partnerAgreements,
  actions: partnerActions,
  meetings: partnerMeetings,
  correspondence: partnerCorrespondence,
  referrals: partnerReferrals,
  objectives: partnerObjectives,
  opportunities: partnerOpportunities,
  obligations: partnerObligations,
} as const;
export type ChildKind = keyof typeof CHILDREN;
type Cols = { id: never; partnerId: never; createdAt: never };
const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);
const CONFIDENTIAL_OK = (s: SessionUser) =>
  s.roles.some((r) => r === "staff:partner_manager" || r === "staff:executive");

@Injectable()
export class PartnersService {
  private readonly log = new Logger(PartnersService.name);
  constructor(
    private readonly txs: TxService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly storage: StorageService,
    private readonly outbox: OutboxService,
  ) {}

  private async partnerOr404(tx: Tx, id: string) {
    const [p] = await tx.select().from(partners).where(eq(partners.id, id));
    if (!p) throw notFound("Partner");
    return p;
  }

  private async scorecard(tx: Tx, ids: string[]) {
    if (!ids.length)
      return new Map<
        string,
        {
          health: "green" | "amber" | "red";
          overdue: number;
          actionsOnTimePct: number | null;
          referrals: number;
          revenue: number;
          expiring: number;
        }
      >();
    const [acts, agrs, refs, coms] = await Promise.all([
      tx
        .select({
          p: partnerActions.partnerId,
          dueOn: partnerActions.dueOn,
          status: partnerActions.status,
          doneAt: partnerActions.doneAt,
        })
        .from(partnerActions)
        .where(inArray(partnerActions.partnerId, ids)),
      tx
        .select({
          p: partnerAgreements.partnerId,
          status: partnerAgreements.status,
          endOn: partnerAgreements.endOn,
        })
        .from(partnerAgreements)
        .where(inArray(partnerAgreements.partnerId, ids)),
      tx
        .select({
          p: partnerReferrals.partnerId,
          n: sql<number>`count(*)::int`,
        })
        .from(partnerReferrals)
        .where(inArray(partnerReferrals.partnerId, ids))
        .groupBy(partnerReferrals.partnerId),
      tx
        .select({
          p: partnerCommissions.partnerId,
          v: sql<number>`coalesce(sum(${partnerCommissions.baseAmount}),0)::bigint`,
        })
        .from(partnerCommissions)
        .where(
          and(
            inArray(partnerCommissions.partnerId, ids),
            inArray(partnerCommissions.status, ["approved", "paid"]),
          ),
        )
        .groupBy(partnerCommissions.partnerId),
    ]);
    const ps = await tx
      .select({
        id: partners.id,
        lastContactAt: partners.lastContactAt,
        createdAt: partners.createdAt,
      })
      .from(partners)
      .where(inArray(partners.id, ids));
    const t = today();
    return new Map(
      ps.map((p) => {
        const a = acts.filter((x) => x.p === p.id),
          g = agrs.filter((x) => x.p === p.id);
        const done = a.filter((x) => x.status === "done" && x.dueOn);
        return [
          p.id,
          {
            health: partnerHealth(p, a, g, t),
            overdue: a.filter(
              (x) =>
                x.dueOn &&
                x.dueOn < t &&
                x.status !== "done" &&
                x.status !== "cancelled",
            ).length,
            actionsOnTimePct: done.length
              ? Math.round(
                  (done.filter((x) => x.doneAt!.slice(0, 10) <= x.dueOn!)
                    .length /
                    done.length) *
                    100,
                )
              : null,
            referrals: refs.find((x) => x.p === p.id)?.n ?? 0,
            revenue: Number(coms.find((x) => x.p === p.id)?.v ?? 0),
            expiring: g.filter((x) => agreementState(x, t) === "expiring")
              .length,
          },
        ];
      }),
    );
  }

  list(q: { status?: string; type?: string }) {
    return this.txs.run(async (tx) => {
      const rows = await tx
        .select()
        .from(partners)
        .where(
          and(
            q.status
              ? eq(partners.status, q.status)
              : sql`${partners.status} <> 'archived'`,
            q.type ? eq(partners.type, q.type) : undefined,
          ),
        )
        .orderBy(asc(partners.name));
      const sc = await this.scorecard(
        tx,
        rows.map((r) => r.id),
      );
      const [m] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(partnerMeetings)
        .where(
          and(
            eq(partnerMeetings.status, "scheduled"),
            sql`${partnerMeetings.startsAt} between now() and now() + interval '7 days'`,
          ),
        );
      const items = rows.map((r) => ({ ...r, ...sc.get(r.id)! }));
      return {
        kpis: {
          active: rows.filter((r) => r.status === "active").length,
          expiring: items.reduce((x, r) => x + r.expiring, 0),
          overdue: items.reduce((x, r) => x + r.overdue, 0),
          meetingsThisWeek: m?.n ?? 0,
        },
        items,
      };
    });
  }

  create(me: SessionUser, b: Omit<typeof partners.$inferInsert, "id" | "createdAt" | "updatedAt">) {
    return this.txs.run(async (tx) => {
      const t = now();
      const [p] = await tx
        .insert(partners)
        .values({
          ...b,
          id: generateId("prt"),
          ownerUserId: b.ownerUserId ?? me.id,
          createdAt: t,
          updatedAt: t,
        })
        .returning();
      await this.audit.record(tx, {
        action: "partner.created",
        entity: "partner",
        entityId: p.id,
        after: { name: p.name },
      });
      return p;
    });
  }

  detail(me: SessionUser, id: string) {
    return this.txs.run(async (tx) => {
      const p = await this.partnerOr404(tx, id);
      const [
        contacts,
        agreements,
        actions,
        meetings,
        correspondence,
        referrals,
        commissions,
        sc,
      ] = await Promise.all([
        tx
          .select()
          .from(partnerContacts)
          .where(eq(partnerContacts.partnerId, id))
          .orderBy(desc(partnerContacts.isPrimary), asc(partnerContacts.name)),
        tx
          .select()
          .from(partnerAgreements)
          .where(eq(partnerAgreements.partnerId, id))
          .orderBy(desc(partnerAgreements.startOn)),
        tx
          .select()
          .from(partnerActions)
          .where(eq(partnerActions.partnerId, id))
          .orderBy(asc(partnerActions.dueOn)),
        tx
          .select()
          .from(partnerMeetings)
          .where(eq(partnerMeetings.partnerId, id))
          .orderBy(desc(partnerMeetings.startsAt)),
        tx
          .select()
          .from(partnerCorrespondence)
          .where(eq(partnerCorrespondence.partnerId, id))
          .orderBy(desc(partnerCorrespondence.date)),
        tx
          .select()
          .from(partnerReferrals)
          .where(eq(partnerReferrals.partnerId, id))
          .orderBy(desc(partnerReferrals.createdAt)),
        tx
          .select()
          .from(partnerCommissions)
          .where(eq(partnerCommissions.partnerId, id))
          .orderBy(desc(partnerCommissions.createdAt)),
        this.scorecard(tx, [id]),
      ]);
      const [objectives, opportunities, obligations, files] = await Promise.all([
        tx.select().from(partnerObjectives).where(eq(partnerObjectives.partnerId, id)).orderBy(desc(partnerObjectives.createdAt)),
        tx.select().from(partnerOpportunities).where(eq(partnerOpportunities.partnerId, id)).orderBy(desc(partnerOpportunities.createdAt)),
        tx.select().from(partnerObligations).where(eq(partnerObligations.partnerId, id)).orderBy(asc(partnerObligations.dueOn)),
        agreements.length ? tx.select().from(partnerAgreementFiles).where(inArray(partnerAgreementFiles.agreementId, agreements.map((a) => a.id))).orderBy(desc(partnerAgreementFiles.version)) : [],
      ]);
      const t = today();
      return {
        ...p,
        objectives,
        opportunities,
        obligations,
        scorecard: sc.get(id)!,
        contacts,
        actions,
        meetings,
        correspondence,
        referrals,
        commissions,
        // PRT §13: confidential agreements only for partner_manager / executive.
        agreements: agreements
          .filter((a) => !a.isConfidential || CONFIDENTIAL_OK(me))
          .map((a) => ({ ...a, state: agreementState(a, t), files: files.filter((f) => f.agreementId === a.id) })),
      };
    });
  }

  update(id: string, b: Partial<typeof partners.$inferInsert>) {
    return this.txs.run(async (tx) => {
      const before = await this.partnerOr404(tx, id);
      if (before.status === "archived" && b.status !== "active")
        throw new AppError(
          409,
          "archived",
          "Archived partners are read-only. Reactivate first.",
        );
      const [p] = await tx
        .update(partners)
        .set({ ...b, updatedAt: now() })
        .where(eq(partners.id, id))
        .returning();
      await this.audit.record(tx, {
        action: "partner.updated",
        entity: "partner",
        entityId: id,
        before: { status: before.status },
        after: b,
      });
      return p;
    });
  }

  // ── children (generic CRUD; deletes are archive-style where the spec says so) ──
  addChild(id: string, kind: ChildKind, b: Record<string, unknown>) {
    return this.txs.run(async (tx) => {
      await this.partnerOr404(tx, id);
      if (
        kind === "agreements" &&
        b.endOn &&
        b.startOn &&
        String(b.endOn) < String(b.startOn)
      )
        throw new AppError(
          422,
          "validation",
          "The end date must be on or after the start date.",
          { endOn: "End must be ≥ start." },
        );
      const table = CHILDREN[kind] as unknown as PgTable & Cols; // cast: one generic insert over the child tables
      const [row] = await tx
        .insert(table)
        .values({
          ...b,
          id: generateId(kind.slice(0, 3)),
          partnerId: id,
          createdAt: now(),
        } as never)
        .returning();
      if (kind === "correspondence" || kind === "meetings")
        await tx
          .update(partners)
          .set({ lastContactAt: now() })
          .where(eq(partners.id, id));
      await this.audit.record(tx, {
        action: `partner.${kind}.added`,
        entity: "partner",
        entityId: id,
      });
      return row;
    });
  }

  updateChild(
    id: string,
    kind: ChildKind,
    childId: string,
    b: Record<string, unknown>,
  ) {
    return this.txs.run(async (tx) => {
      const table = CHILDREN[kind] as unknown as PgTable & {
        id: typeof partnerContacts.id;
        partnerId: typeof partnerContacts.partnerId;
      }; // cast: shared id/partner_id columns
      const patch = {
        ...b,
        ...(kind === "actions" &&
          b.status === "done" && { doneAt: now(), progress: 100 }),
      };
      const [row] = await tx
        .update(table)
        .set(patch as never)
        .where(and(eq(table.id, childId), eq(table.partnerId, id)))
        .returning();
      if (!row) throw notFound("Record");
      if (kind === "meetings" && b.minutes)
        await tx
          .update(partners)
          .set({ lastContactAt: now() })
          .where(eq(partners.id, id));
      await this.audit.record(tx, {
        action: `partner.${kind}.updated`,
        entity: "partner",
        entityId: id,
        after: { childId },
      });
      return row;
    });
  }

  removeChild(id: string, kind: ChildKind, childId: string) {
    if (kind !== "contacts" && kind !== "actions")
      throw new AppError(
        409,
        "archive_only",
        "This record is kept for history.",
      );
    return this.txs.run(async (tx) => {
      // Contacts are deactivated (history keeps them); actions are cancelled.
      if (kind === "contacts")
        await tx
          .update(partnerContacts)
          .set({ active: false })
          .where(
            and(
              eq(partnerContacts.id, childId),
              eq(partnerContacts.partnerId, id),
            ),
          );
      else
        await tx
          .update(partnerActions)
          .set({ status: "cancelled" })
          .where(
            and(
              eq(partnerActions.id, childId),
              eq(partnerActions.partnerId, id),
            ),
          );
      return { ok: true };
    });
  }

  /** Meeting decision → action item ("Convert to action"). */
  decisionToAction(
    id: string,
    meetingId: string,
    b: { index: number; ownerUserId?: string | null; dueOn?: string | null },
  ) {
    return this.txs.run(async (tx) => {
      const [m] = await tx
        .select()
        .from(partnerMeetings)
        .where(
          and(
            eq(partnerMeetings.id, meetingId),
            eq(partnerMeetings.partnerId, id),
          ),
        );
      const text = m?.decisions[b.index];
      if (!text) throw notFound("Decision");
      const [a] = await tx
        .insert(partnerActions)
        .values({
          id: generateId("act"),
          partnerId: id,
          meetingId,
          title: text.slice(0, 255),
          ownerUserId: b.ownerUserId ?? null,
          dueOn: b.dueOn ?? null,
          createdAt: now(),
        })
        .returning();
      return a;
    });
  }

  /** ICS for a meeting (PRT-05 calendar invite). */
  ics(id: string, meetingId: string) {
    return this.txs.run(async (tx) => {
      const [m] = await tx
        .select()
        .from(partnerMeetings)
        .where(
          and(
            eq(partnerMeetings.id, meetingId),
            eq(partnerMeetings.partnerId, id),
          ),
        );
      if (!m) throw notFound("Meeting");
      const f = (s: string) => s.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
      const esc = (s: string) =>
        s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");
      const end =
        m.endsAt ?? new Date(Date.parse(m.startsAt) + 3_600_000).toISOString();
      return [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//HEBUZA//partners//EN",
        "BEGIN:VEVENT",
        `UID:${m.id}@hebuza`,
        `DTSTAMP:${f(now())}`,
        `DTSTART:${f(new Date(m.startsAt).toISOString())}`,
        `DTEND:${f(new Date(end).toISOString())}`,
        `SUMMARY:${esc(m.title)}`,
        ...(m.location ? [`LOCATION:${esc(m.location)}`] : []),
        ...(m.agenda ? [`DESCRIPTION:${esc(m.agenda)}`] : []),
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");
    });
  }

  /** PRT-12 unified timeline. */
  history(id: string) {
    return this.txs.run(async (tx) => {
      await this.partnerOr404(tx, id);
      const q = (kind: string, table: string, at: string, title: string) =>
        sql.raw(
          `select '${kind}' as kind, id, ${at}::text as at, ${title} as title from ${table} where partner_id = `,
        );
      const rows = await tx.execute<{
        kind: string;
        id: string;
        at: string;
        title: string;
      }>(sql`
        ${q("agreement", "partner_agreements", "coalesce(signed_on, start_on)", "title")}${id}
        union all ${q("meeting", "partner_meetings", "starts_at", "title")}${id}
        union all ${q("action", "partner_actions", "coalesce(done_at, created_at)", "title || ' (' || status || ')'")}${id}
        union all ${q("correspondence", "partner_correspondence", "date", "direction || ': ' || subject")}${id}
        union all ${q("referral", "partner_referrals", "created_at", "name || ' (' || status || ')'")}${id}
        union all ${q("commission", "partner_commissions", "created_at", "amount::text || ' RWF (' || status || ')'")}${id}
        union all ${q("opportunity", "partner_opportunities", "coalesce(closed_on::timestamptz, created_at)", "title || ' (' || stage || ')'")}${id}
        union all ${q("objective", "partner_objectives", "created_at", "title")}${id}
        order by at desc limit 500`);
      return { items: [...rows] };
    });
  }

  /** PRT-12: the history as a printable PDF. */
  async historyPdf(id: string) {
    const [p, h] = await Promise.all([this.txs.run((tx) => this.partnerOr404(tx, id)), this.history(id)]);
    return textPdf(`Partner history: ${p.name}`, [`Generated ${now().slice(0, 16).replace("T", " ")} UTC`, "", ...h.items.map((x) => `${String(x.at).slice(0, 10)}  [${x.kind}]  ${x.title}`)]);
  }

  /** PRT-03: a new agreement file version (presigned PUT; bytes go straight to storage, scanned like other uploads). */
  addAgreementFile(me: SessionUser, id: string, agreementId: string, b: { filename: string; contentType: string; size: number }) {
    return this.txs.run(async (tx) => {
      const [a] = await tx.select({ id: partnerAgreements.id }).from(partnerAgreements).where(and(eq(partnerAgreements.id, agreementId), eq(partnerAgreements.partnerId, id))).for("update");
      if (!a) throw notFound("Agreement");
      const [{ v }] = await tx.select({ v: sql<number>`coalesce(max(${partnerAgreementFiles.version}), 0)::int` }).from(partnerAgreementFiles).where(eq(partnerAgreementFiles.agreementId, agreementId));
      const key = `partners/${id}/agreements/${agreementId}/v${v + 1}-${b.filename.replace(/[^\w.-]+/g, "_")}`;
      const [f] = await tx.insert(partnerAgreementFiles).values({ id: generateId("paf"), agreementId, version: v + 1, fileKey: key, filename: b.filename.slice(0, 255), uploadedBy: me.id, uploadedAt: now() }).returning();
      await tx.update(partnerAgreements).set({ fileKey: key }).where(eq(partnerAgreements.id, agreementId));
      await this.outbox.add(tx, { type: "storage.scan", payload: { key, kind: "partner" } });
      await this.audit.record(tx, { action: "partner.agreement.file_added", entity: "partner", entityId: id, after: { agreementId, version: f.version } });
      return { ...f, upload: await this.storage.presignPut({ key, contentType: b.contentType, size: b.size, purpose: "partner_agreement", filename: b.filename }) };
    });
  }

  agreementFileUrl(me: SessionUser, id: string, agreementId: string, fileId: string) {
    return this.txs.run(async (tx) => {
      const [r] = await tx.select({ f: partnerAgreementFiles, conf: partnerAgreements.isConfidential }).from(partnerAgreementFiles)
        .innerJoin(partnerAgreements, eq(partnerAgreements.id, partnerAgreementFiles.agreementId))
        .where(and(eq(partnerAgreementFiles.id, fileId), eq(partnerAgreements.id, agreementId), eq(partnerAgreements.partnerId, id)));
      if (!r || (r.conf && !CONFIDENTIAL_OK(me))) throw notFound("File");
      return { url: await this.storage.presignGet(r.f.fileKey, r.f.filename) };
    });
  }

  /** PRT-10: 1-hour meeting reminder (claimed once per meeting in deadline_notifications). */
  @Cron("partners.meeting_soon", "*/10 * * * *")
  async meetingSoon() {
    return this.txs.runAsSystem(async (tx) => {
      const soon = await tx.select({ m: partnerMeetings, owner: partners.ownerUserId, p: partners.name }).from(partnerMeetings).innerJoin(partners, eq(partners.id, partnerMeetings.partnerId))
        .where(and(eq(partnerMeetings.status, "scheduled"), sql`${partnerMeetings.startsAt} between now() and now() + interval '60 minutes'`));
      let n = 0;
      for (const { m, owner, p } of soon) {
        if (!owner) continue;
        const [c] = await tx.insert(deadlineNotifications).values({ id: generateId("dln"), targetType: "prt_meeting", targetId: m.id, offsetDays: 0, sentAt: now() }).onConflictDoNothing().returning({ id: deadlineNotifications.id });
        if (!c) continue;
        await this.notifications.notify(tx, { userId: owner, kind: "prt.meeting.reminder", title: `In 1 hour: ${m.title} with ${p}`, link: `/partners/${m.partnerId}?tab=meetings` });
        n++;
      }
      return { sent: n };
    });
  }

  // ── commissions (PRT-09) ──
  /** Referred, paid cases without a commission get one at the active agreement's rate. Idempotent per application. */
  async computeCommissions(tx: Tx) {
    const refs = await tx
      .select({ r: partnerReferrals, a: applications })
      .from(partnerReferrals)
      .innerJoin(
        applications,
        eq(applications.applicationId, partnerReferrals.applicationId),
      )
      .where(
        and(
          eq(partnerReferrals.direction, "in"),
          sql`not exists (select 1 from partner_commissions c where c.application_id = ${partnerReferrals.applicationId})`,
        ),
      );
    if (!refs.length) return 0;
    const paid = await paidRows(
      tx,
      refs.map((x) => x.a.code),
    );
    let n = 0;
    for (const { r, a } of refs) {
      const base = money(
        a,
        (paid.get(a.code) ?? []).reduce((x, p) => x + p.amount, 0),
      ).paid;
      if (base <= 0) continue;
      const [ag] = await tx
        .select()
        .from(partnerAgreements)
        .where(
          and(
            eq(partnerAgreements.partnerId, r.partnerId),
            inArray(partnerAgreements.status, ["active", "renewed"]),
            sql`${partnerAgreements.commissionBps} is not null`,
            sql`${partnerAgreements.startOn} <= current_date and (${partnerAgreements.endOn} is null or ${partnerAgreements.endOn} >= current_date)`,
          ),
        )
        .orderBy(desc(partnerAgreements.startOn))
        .limit(1);
      if (!ag?.commissionBps) continue;
      await tx
        .insert(partnerCommissions)
        .values({
          id: generateId("com"),
          partnerId: r.partnerId,
          agreementId: ag.id,
          referralId: r.id,
          applicationId: a.applicationId,
          baseAmount: base,
          rateBps: ag.commissionBps,
          amount: commissionOf(base, ag.commissionBps),
          createdAt: now(),
        });
      await tx
        .update(partnerReferrals)
        .set({ status: "converted" })
        .where(eq(partnerReferrals.id, r.id));
      n++;
    }
    if (n)
      for (const f of await tx
        .select({ id: users.userId })
        .from(users)
        .where(and(eq(users.role, "staff:finance"), eq(users.isActive, true))))
        await this.notifications.notify(tx, {
          userId: f.id,
          kind: "prt.commission.pending",
          title: `${n} partner commission(s) to approve`,
          link: "/partners/commissions",
        });
    return n;
  }

  commissions(status?: string) {
    return this.txs.run(async (tx) => {
      await this.computeCommissions(tx);
      const rows = await tx
        .select({
          c: partnerCommissions,
          partner: partners.name,
          code: applications.code,
        })
        .from(partnerCommissions)
        .innerJoin(partners, eq(partners.id, partnerCommissions.partnerId))
        .leftJoin(
          applications,
          eq(applications.applicationId, partnerCommissions.applicationId),
        )
        .where(status ? eq(partnerCommissions.status, status) : undefined)
        .orderBy(desc(partnerCommissions.createdAt));
      return {
        items: rows.map((r) => ({
          ...r.c,
          partner: r.partner,
          caseCode: r.code,
        })),
      };
    });
  }

  /** Finance decision: approve → finance payable (finance/x/payables-due); paid → payable closed. */
  decideCommission(
    me: SessionUser,
    id: string,
    b: { decision: "approved" | "rejected" | "paid"; note?: string },
  ) {
    return this.txs.run(async (tx) => {
      const from = b.decision === "paid" ? "approved" : "computed";
      const [c] = await tx
        .update(partnerCommissions)
        .set({
          status: b.decision,
          decidedBy: me.id,
          decidedAt: now(),
          note: b.note ?? null,
        })
        .where(
          and(
            eq(partnerCommissions.id, id),
            eq(partnerCommissions.status, from),
          ),
        )
        .returning();
      if (!c)
        throw new AppError(
          409,
          "conflict",
          "This commission is not waiting for that decision.",
        );
      // PRT-09: an approved commission becomes a finance payable; paid closes it.
      if (b.decision !== "rejected") {
        const [p] = await tx.select({ name: partners.name }).from(partners).where(eq(partners.id, c.partnerId));
        await upsertPayable(tx, {
          id: `prtcom_${c.id}`, source: "partner_commission", payee: p?.name ?? c.partnerId, amount: Number(c.amount),
          memo: `Partner commission ${c.rateBps / 100}% on ${Number(c.baseAmount)} RWF`, status: b.decision === "paid" ? "paid" : "due",
          at: c.createdAt, ...(b.decision === "paid" && { paidAt: now() }),
        });
      }
      await this.audit.record(tx, {
        action: `partner.commission.${b.decision}`,
        entity: "partner_commission",
        entityId: id,
        reason: b.note,
      });
      return c;
    });
  }

  /** PRT-13: logos for the public partners strip. */
  publicList() {
    return this.txs.runAsSystem(async (tx) => ({
      items: await tx
        .select({
          id: partners.id,
          name: partners.name,
          logoUrl: partners.logoUrl,
          website: partners.website,
        })
        .from(partners)
        .where(
          and(eq(partners.shownOnWebsite, true), eq(partners.status, "active")),
        )
        .orderBy(asc(partners.name)),
    }));
  }

  // ── reminders (PRT-10) + dormancy ──
  @Cron("partners.daily", "0 6 * * *")
  async daily() {
    return this.txs.runAsSystem(async (tx) => {
      const t = today();
      let sent = 0;
      const agrs = await tx
        .select({ a: partnerAgreements, p: partners })
        .from(partnerAgreements)
        .innerJoin(partners, eq(partners.id, partnerAgreements.partnerId))
        .where(
          and(
            inArray(partnerAgreements.status, ["active", "renewed"]),
            sql`${partnerAgreements.endOn} is not null`,
          ),
        );
      const pms = (
        await tx
          .select({ id: users.userId })
          .from(users)
          .where(
            and(
              eq(users.role, "staff:partner_manager"),
              eq(users.isActive, true),
            ),
          )
      ).map((u) => u.id);
      for (const { a, p } of agrs) {
        const d = renewalDue(a.endOn!, t);
        if (d !== null)
          for (const userId of new Set(
            [p.ownerUserId, ...pms].filter((x): x is string => !!x),
          )) {
            await this.notifications.notify(tx, {
              userId,
              kind: "prt.agreement.expiring",
              title: `${p.name}: "${a.title}" ends in ${d} days`,
              link: `/partners/${p.id}`,
            });
            sent++;
          }
        if (a.endOn! < t)
          await tx
            .update(partnerAgreements)
            .set({ status: "expired" })
            .where(eq(partnerAgreements.id, a.id));
      }
      // Overdue actions: owner on day 1, partner managers after 7 days.
      const late = await tx
        .select({ a: partnerActions, p: partners.name })
        .from(partnerActions)
        .innerJoin(partners, eq(partners.id, partnerActions.partnerId))
        .where(
          and(
            inArray(partnerActions.status, ["open", "in_progress"]),
            sql`${partnerActions.dueOn} in (current_date - 1, current_date - 8)`,
          ),
        );
      for (const { a, p } of late)
        for (const userId of (a.dueOn! ===
        new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
          ? [a.ownerUserId]
          : pms
        ).filter((x): x is string => !!x)) {
          await this.notifications.notify(tx, {
            userId,
            kind: "prt.action.overdue",
            title: `${p}: "${a.title}" is overdue`,
            link: `/partners/${a.partnerId}`,
          });
          sent++;
        }
      // Meetings tomorrow (24 h reminder; the 1 h reminder needs a finer cron).
      const meets = await tx
        .select({
          m: partnerMeetings,
          owner: partners.ownerUserId,
          p: partners.name,
        })
        .from(partnerMeetings)
        .innerJoin(partners, eq(partners.id, partnerMeetings.partnerId))
        .where(
          and(
            eq(partnerMeetings.status, "scheduled"),
            sql`${partnerMeetings.startsAt}::date = current_date + 1`,
          ),
        );
      for (const { m, owner, p } of meets)
        if (owner) {
          await this.notifications.notify(tx, {
            userId: owner,
            kind: "prt.meeting.reminder",
            title: `Tomorrow: ${m.title} with ${p}`,
            link: `/partners/${m.partnerId}`,
          });
          sent++;
        }
      // Obligations due today → owner (prt.obligation.due).
      const obl = await tx.select({ o: partnerObligations, p: partners.name }).from(partnerObligations).innerJoin(partners, eq(partners.id, partnerObligations.partnerId))
        .where(and(eq(partnerObligations.status, "open"), sql`${partnerObligations.dueOn} = current_date`));
      for (const { o, p } of obl) if (o.ownerUserId) { await this.notifications.notify(tx, { userId: o.ownerUserId, kind: "prt.obligation.due", title: `${p}: obligation due today`, body: o.description, link: `/partners/${o.partnerId}?tab=agreements` }); sent++; }
      // Dormant after 180 days without contact.
      await tx
        .update(partners)
        .set({ status: "dormant", updatedAt: now() })
        .where(
          and(
            eq(partners.status, "active"),
            sql`coalesce(${partners.lastContactAt}, ${partners.createdAt}) < now() - interval '180 days'`,
          ),
        );
      const commissions = await this.computeCommissions(tx);
      this.log.log(
        `partners.daily reminders=${sent} commissions=${commissions}`,
      );
      return { sent, commissions };
    });
  }
}
