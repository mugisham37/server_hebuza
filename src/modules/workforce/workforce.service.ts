import { onExternalCreated, onExternalStatus } from "../work/work.service";
import { contractTemplate, loadExt, saveExt, type ContractDoc } from "../work/work.store";
// Port of .ref workforce.service: /ops/workforce directory of every worker (internal, external, field) with status
// lifecycle, audited private-field reveal, reviews, history, offboarding with case reassignment. Per-worker admin facts
// live in an ops_records "wf_worker" row (private fields encrypted with CryptoService); external-worker state is read from
// the work module's "work_ext" record.
import { Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, max, ne, notInArray, sql } from "drizzle-orm";
import {
  agentProfiles,
  applicationAssignmentHistory,
  applications,
  auditLog,
  authSessions,
  fieldAgents,
  opsRecords,
  users,
} from "@/db/schema";
import type { Tx } from "../../core/db/db";
import { TxService } from "../../core/db/tx";
import { AuditService } from "../../core/db/audit";
import { CryptoService } from "../../core/crypto/crypto.service";
import { AppError, notFound } from "../../core/http/errors";
import type { SessionUser } from "../../core/http/context";
import { AuthService } from "../auth/auth.service";
import { NotificationsService } from "../notifications/notifications.service";
import { generateId, iso } from "../../core/db/ids";

type Cv = { education: unknown[]; experience: unknown[]; expertise: string[]; years: string; languages: string[]; bio: string };
/** F-WRK-02: the CV the worker entered at onboarding (agent_profiles.ws.onboarding), normalised. */
const cvOf = (ws: unknown): Cv => {
  const ob = ((ws as { onboarding?: { cv?: Partial<Cv>; profile?: { languages?: string[]; bio?: string } } } | null)?.onboarding) ?? {};
  return {
    education: ob.cv?.education ?? [], experience: ob.cv?.experience ?? [], expertise: ob.cv?.expertise ?? [], years: ob.cv?.years ?? "",
    languages: ob.profile?.languages ?? [], bio: ob.profile?.bio ?? "",
  };
};
const cvText = (c: Cv) => [JSON.stringify(c.education), JSON.stringify(c.experience), ...c.expertise, c.bio].join(" ");

export type WorkerStatus =
  "invited" | "onboarding" | "cleared" | "suspended" | "terminated";
export const NEXT: Record<WorkerStatus, WorkerStatus[]> = {
  invited: ["suspended"],
  onboarding: ["suspended"],
  cleared: ["suspended", "terminated"],
  suspended: ["cleared", "onboarding", "terminated"],
  terminated: [],
};
const INVITE_TTL_S = 7 * 86_400; // PLACEHOLDER(invite-ttl-days)
const FIRST_RESPONSE_H = { field: 5, desk: 3 }; // PLACEHOLDER(kpi-first-response)
const CLOSED = ["completed_delivered", "rejected", "cancelled", "refunded"];

type WorkerEvent = {
  id: string;
  at: string;
  kind: string;
  text: string;
  actor?: string;
};
type Wf = {
  status?: WorkerStatus;
  field?: boolean;
  districts?: string[];
  contractEnd?: string;
  privateEnc?: string; // encrypted JSON {address, phone, nationalId}
  certifications?: { name: string; expiresOn?: string }[];
  documents?: { id: string; name: string }[];
  sessionsRevoked?: boolean;
  events?: WorkerEvent[];
};
/** The parts of the work module's external-worker record this directory reads. */
type Ext = {
  status?: string;
  contract?: {
    id: string;
    kind: string;
    title: string;
    version: number;
    end?: string;
    signedAt?: string | null;
  }[];
  credentials?: { title: string; status: string; expiresOn?: string | null }[];
};
export type Review = {
  id: string;
  workerId: string;
  period: string;
  kpis: { onTime: number; rating: number };
  rating: number;
  goals: string;
  comments: string;
  ackRequired: boolean;
  status: string;
  by: { id: string; name: string };
  at: string;
};

const fail = (status: number, type: string, msg: string) =>
  new AppError(status, type, msg);
const extStatus = (s?: string): WorkerStatus =>
  s === "cleared"
    ? "cleared"
    : s === "suspended"
      ? "suspended"
      : s === "terminated"
        ? "terminated"
        : "onboarding";

@Injectable()
export class WorkforceService {
  constructor(
    private readonly tx: TxService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly auth: AuthService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── records ─────────────────────────────────────────────────────────────────────────────────────────
  private async loadWf(tx: Tx, id: string, lock = false): Promise<Wf> {
    const q = tx
      .select()
      .from(opsRecords)
      .where(
        and(eq(opsRecords.kind, "wf_worker"), eq(opsRecords.id, `wf:${id}`)),
      );
    const [r] = lock ? await q.for("update") : await q;
    return (r?.data as Wf | undefined) ?? {};
  }
  private async saveWf(tx: Tx, id: string, w: Wf) {
    await tx
      .insert(opsRecords)
      .values({
        id: `wf:${id}`,
        kind: "wf_worker",
        ownerId: id,
        state: w.status ?? null,
        data: w,
      })
      .onConflictDoUpdate({
        target: opsRecords.id,
        set: {
          state: w.status ?? null,
          data: w,
          updatedAt: iso(),
          version: sql`${opsRecords.version} + 1`,
        },
      });
  }
  private async actorName(tx: Tx, s: SessionUser) {
    const [u] = await tx
      .select({ name: users.name })
      .from(users)
      .where(eq(users.userId, s.id));
    return u?.name ?? "Service manager";
  }
  private event(w: Wf, kind: string, text: string, actor: string) {
    w.events = [
      { id: generateId("wev"), at: iso(), kind, text, actor },
      ...(w.events ?? []),
    ].slice(0, 200);
  }

  // ── rows ────────────────────────────────────────────────────────────────────────────────────────────
  private async rows(tx: Tx, ids?: string[]) {
    const agents = await tx
      .select({ p: agentProfiles, u: users })
      .from(agentProfiles)
      .innerJoin(users, eq(users.userId, agentProfiles.userId))
      .where(
        ids
          ? inArray(agentProfiles.userId, ids.length ? ids : ["-"])
          : undefined,
      );
    if (!agents.length) return [];
    const aids = agents.map((a) => a.u.userId);
    const [recs, fields, logins, loads] = await Promise.all([
      tx
        .select()
        .from(opsRecords)
        .where(
          and(
            inArray(opsRecords.kind, ["wf_worker", "work_ext"]),
            inArray(opsRecords.ownerId, aids),
          ),
        ),
      tx.select().from(fieldAgents).where(inArray(fieldAgents.userId, aids)),
      tx
        .select({ id: authSessions.userId, at: max(authSessions.lastSeenAt) })
        .from(authSessions)
        .where(inArray(authSessions.userId, aids))
        .groupBy(authSessions.userId),
      tx
        .select({
          id: applications.assignedAgentId,
          n: sql<number>`count(*)::int`,
        })
        .from(applications)
        .where(
          and(
            inArray(applications.assignedAgentId, aids),
            notInArray(applications.status, CLOSED),
          ),
        )
        .groupBy(applications.assignedAgentId),
    ]);
    const W = new Map(
      recs
        .filter((r) => r.kind === "wf_worker")
        .map((r) => [r.ownerId, r.data as Wf]),
    );
    const X = new Map(
      recs
        .filter((r) => r.kind === "work_ext")
        .map((r) => [r.ownerId, r.data as Ext]),
    );
    const F = new Map(fields.map((f) => [f.userId, f]));
    const L = new Map(logins.map((l) => [l.id, l.at]));
    const N = new Map(loads.map((l) => [l.id, Number(l.n)]));
    const today = iso().slice(0, 10);
    return agents.map(({ p, u }) => {
      const w = W.get(u.userId) ?? {};
      const x = X.get(u.userId);
      const f = F.get(u.userId);
      const status: WorkerStatus =
        w.status === "invited" ||
        w.status === "suspended" ||
        w.status === "terminated"
          ? w.status
          : x
            ? extStatus(x.status)
            : p.clearance === "cleared"
              ? "cleared"
              : "onboarding";
      const sa = x?.contract?.find((d) => d.kind === "service_agreement");
      const row = {
        id: u.userId,
        name: u.name,
        role: f ? "Field agent" : p.title,
        type: p.external ? ("external" as const) : ("internal" as const),
        field: !!f || !!w.field,
        status,
        services: p.services as string[],
        expertise: p.skillsLabel as string[],
        languages: p.languages as string[],
        districts:
          w.districts ?? f?.districts ?? (p.location ? [p.location] : []),
        load: { open: N.get(u.userId) ?? 0, cap: p.cap },
        onTimePct: Math.round(p.onTimeBps / 100),
        rating: p.ratingX10 / 10,
        contractEnd: sa?.end ?? w.contractEnd,
        availableFrom:
          p.onLeaveUntil && p.onLeaveUntil >= today
            ? p.onLeaveUntil
            : undefined,
        lastLoginAt: L.get(u.userId) ?? undefined,
        email: u.email ?? "",
      };
      return { row, w, x, u, p, cv: cvOf(p.ws) };
    });
  }

  list(f: { service?: string; language?: string; district?: string; available?: "1"; minRating?: number; type?: "internal" | "external"; q?: string } = {}) {
    const q = f.q?.trim().toLowerCase();
    return this.tx.run(async (tx) => ({
      items: (await this.rows(tx))
        .map((r) => ({ ...r.row, _cv: cvText(r.cv) }))
        .filter((w) =>
          (!f.service || w.services.includes(f.service)) &&
          (!f.language || w.languages.includes(f.language)) &&
          (!f.district || w.districts.includes(f.district)) &&
          (!f.available || (!w.availableFrom && w.load.open < w.load.cap && w.status === "cleared")) &&
          (f.minRating == null || w.rating >= f.minRating) &&
          (!f.type || w.type === f.type) &&
          (!q || [w.name, w.email, w._cv, ...w.expertise, ...w.services].some((x) => x.toLowerCase().includes(q))),
        )
        .map(({ _cv, ...w }) => w),
    }));
  }
  private async one(tx: Tx, id: string) {
    const [r] = await this.rows(tx, [id]);
    if (!r) throw notFound("Worker");
    return r;
  }

  private async openCases(tx: Tx, id: string) {
    const apps = await tx
      .select({
        code: applications.code,
        title: applications.serviceName,
        clientId: applications.clientId,
        info: applications.personalInfo,
      })
      .from(applications)
      .where(
        and(
          eq(applications.assignedAgentId, id),
          notInArray(applications.status, CLOSED),
        ),
      )
      .limit(500);
    const cl = apps.length
      ? await tx
          .select({ id: users.userId, name: users.name })
          .from(users)
          .where(
            inArray(
              users.userId,
              apps.map((a) => a.clientId ?? "-"),
            ),
          )
      : [];
    const C = new Map(cl.map((c) => [c.id, c.name]));
    return apps.map((c) => ({
      ref: c.code,
      title: c.title,
      client:
        C.get(c.clientId ?? "") ??
        String((c.info as Record<string, unknown>).fullName ?? ""),
    }));
  }
  private async pendingOffers(tx: Tx, id: string) {
    const offers = await tx
      .select()
      .from(opsRecords)
      .where(and(eq(opsRecords.kind, "offer"), eq(opsRecords.ownerId, id)));
    return offers
      .filter((o) => {
        const d = o.data as { state?: string; expiresAt?: string };
        return (
          ["sent", "viewed"].includes(d.state ?? "") &&
          Date.parse(d.expiresAt ?? "") > Date.now()
        );
      })
      .map((o) => ({ ref: o.id, title: `${o.ref} — offer` }));
  }

  /** F-WRK-04: issue a new engagement contract version to an external worker; they sign it in /work/contract. */
  issueContract(me: SessionUser, id: string, b: { kind: ContractDoc["kind"]; start: string; end: string | null; noticeDays: number; terms?: string[] }) {
    return this.tx.run(async (tx) => {
      const r = await this.one(tx, id);
      if (r.row.type !== "external") throw fail(422, "validation", "Contracts here are for external agents; staff contracts are HR's.");
      const e = await loadExt(tx, id, true);
      const same = (e.contract ?? []).filter((d) => d.kind === b.kind);
      const base = contractTemplate(b.kind, b.start);
      const doc: ContractDoc = {
        ...base,
        id: `${base.id}-v${same.length + 1}`,
        version: Math.max(0, ...same.map((d) => d.version)) + 1,
        status: "pending_signature",
        start: b.start,
        end: b.end,
        noticeDays: b.noticeDays,
        terms: b.terms?.length ? b.terms : base.terms,
      };
      e.contract = [...(e.contract ?? []), doc];
      await saveExt(tx, id, e);
      await this.notifications.notify(tx, { userId: id, kind: "contract", title: `New ${doc.title} v${doc.version} to sign`, link: "/work/contract" });
      await this.audit.record(tx, { action: "workforce.contract_issued", entity: "worker", entityId: id, after: { kind: doc.kind, version: doc.version, by: me.id } });
      return doc;
    });
  }

  /** F-WRK-11: 90-day first-pass approval, reassignment rate and allocated revenue share. */
  private async outcomes(tx: Tx, id: string) {
    const [r] = await tx.execute<{ done: number; first_pass: number; reassigned: number; total: number }>(sql`
      select
        (select count(*)::int from applications where assigned_agent_id = ${id} and status = 'completed_delivered' and completed_at > now() - interval '90 days') done,
        (select count(*)::int from applications a join application_feedback f on f.application_id = a.application_id
           where a.assigned_agent_id = ${id} and f.review = 'accepted' and a.completed_at > now() - interval '90 days'
           and not exists (select 1 from ops_records r where r.kind = 'review' and r.ref = a.code and (r.data->>'version')::int > 1)) first_pass,
        (select count(distinct application_id)::int from application_assignment_history where previous_agent_id = ${id} and new_agent_id is not null and created_at > now() - interval '90 days') reassigned,
        (select count(distinct application_id)::int from application_assignment_history where (new_agent_id = ${id} or previous_agent_id = ${id}) and created_at > now() - interval '90 days') total`);
    const allocs = await tx.execute<{ amount: number }>(sql`
      select coalesce(sum((s->>'amount')::int), 0)::int amount from finance_records fr, jsonb_array_elements(fr.data->'shares') s
      where fr.kind = 'allocation' and fr.status <> 'voided' and s->>'workerId' = ${id} and (fr.data->>'frozenAt') > (now() - interval '90 days')::text`);
    const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : null);
    return {
      completed90d: r.done,
      firstPassPct: pct(r.first_pass, r.done),
      reassignmentPct: pct(r.reassigned, r.total),
      revenue90d: allocs[0]?.amount ?? 0,
    };
  }

  private privateOf(r: Awaited<ReturnType<WorkforceService["one"]>>) {
    let p = { address: "—", phone: r.u.phoneE164 ?? "—", nationalId: "—" };
    if (r.w.privateEnc) {
      try {
        p = {
          ...p,
          ...(JSON.parse(this.crypto.decrypt(r.w.privateEnc)) as typeof p),
        };
      } catch {
        /* unreadable → placeholders */
      }
    }
    return p;
  }

  private async detail(tx: Tx, id: string, reveal = false) {
    const r = await this.one(tx, id);
    const p = this.privateOf(r);
    return {
      ...r.row,
      privateFields: reveal
        ? p
        : {
            address: "••••",
            phone: `•••• ${p.phone.slice(-3)}`,
            nationalId: "•••• ••••",
          },
      kpis: [
        { key: "onTime", value: r.row.onTimePct, unit: "pct" },
        { key: "rating", value: r.row.rating, unit: "rating" },
        { key: "open", value: r.row.load.open, unit: "count" },
        {
          key: "firstResponse",
          value: r.row.field ? FIRST_RESPONSE_H.field : FIRST_RESPONSE_H.desk,
          unit: "hours",
        },
      ],
      certifications: [
        ...(r.w.certifications ?? []),
        ...(r.x?.credentials ?? [])
          .filter((c) => c.status === "verified")
          .map((c) => ({ name: c.title, expiresOn: c.expiresOn ?? undefined })),
      ],
      documents: [
        ...(r.w.documents ?? []),
        ...(r.x?.contract ?? [])
          .filter((c) => c.signedAt)
          .map((c) => ({ id: c.id, name: `${c.title} v${c.version}.pdf` })),
      ],
      // F-WRK-02 structured CV (from onboarding), F-WRK-11 outcome KPIs.
      cv: r.cv,
      contracts: ((r.x?.contract ?? []) as unknown as ContractDoc[]).map((d) => ({ id: d.id, kind: d.kind, title: d.title, version: d.version, status: d.status, start: d.start, end: d.end, signedAt: d.signedAt ?? null })),
      outcomes: await this.outcomes(tx, id),
      openCases: await this.openCases(tx, id),
      pendingOffers: await this.pendingOffers(tx, id),
      sessionsRevoked: !!r.w.sessionsRevoked,
    };
  }

  get(id: string) {
    return this.tx.run((tx) => this.detail(tx, id));
  }

  reveal(s: SessionUser, id: string, reason: string) {
    if (!s.roles.includes("staff:service_manager"))
      throw fail(403, "forbidden", "Service managers only.");
    if (!reason.trim()) throw fail(422, "reason_required", "Give a reason.");
    return this.tx.run(async (tx) => {
      const out = await this.detail(tx, id, true);
      const w = await this.loadWf(tx, id, true);
      this.event(
        w,
        "reveal",
        "Private fields revealed",
        await this.actorName(tx, s),
      );
      await this.saveWf(tx, id, w);
      await this.audit.record(tx, {
        action: "workforce.private_field.revealed",
        entity: "workforce.worker",
        entityId: id,
        after: { fields: ["address", "phone", "nationalId"] },
        reason: reason.trim(),
      });
      return out;
    });
  }

  // ── create (invite) ─────────────────────────────────────────────────────────────────────────────────
  create(
    s: SessionUser,
    b: {
      firstName: string;
      lastName: string;
      email: string;
      phone: string;
      type: "internal" | "external";
      field: boolean;
    },
  ) {
    if (!b.email.includes("@") || !b.firstName.trim() || !b.lastName.trim())
      throw fail(422, "validation", "Check the fields.");
    return this.tx.run(async (tx) => {
      const email = b.email.trim().toLowerCase();
      const role = b.type === "external" ? "ext:agent" : "staff:agent";
      const [dup] = await tx
        .select({ id: users.userId })
        .from(users)
        .where(
          and(sql`lower(${users.email}) = ${email}`, eq(users.role, role)),
        );
      if (dup) throw new AppError(409, "conflict", "Email already invited.");
      const id = generateId("usr"),
        now = iso();
      const name = `${b.firstName.trim()} ${b.lastName.trim()}`;
      const phone = b.phone.replace(/\s/g, "") || null;
      const [u] = await tx
        .insert(users)
        .values({
          userId: id,
          name,
          email,
          phoneE164: phone,
          passwordHash: "!invited",
          role,
          isActive: true,
          isEmailVerified: false,
          language: "en",
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await tx.insert(agentProfiles).values({
        userId: id,
        title: b.field ? "Field agent" : "Agent",
        external: b.type === "external",
        cap: 5,
        managerId: s.id,
        languages: ["rw"],
        services: [],
        clearance: "new",
      });
      const w: Wf = {
        status: "invited",
        field: b.field,
        districts: [],
        privateEnc: this.crypto.encrypt(
          JSON.stringify({
            address: "—",
            phone: phone ?? "—",
            nationalId: "—",
          }),
        ),
      };
      this.event(w, "created", "Invited", await this.actorName(tx, s));
      await this.saveWf(tx, id, w);
      if (b.type === "external") await onExternalCreated(tx, id, email);
      // Set-password link (staff → /team/set-password) mailed through the auth outbox.
      await this.auth.issueResetToken(tx, u, INVITE_TTL_S, "invite");
      await this.audit.record(tx, {
        action: "workforce.worker.created",
        entity: "workforce.worker",
        entityId: id,
        after: { status: "invited", type: b.type, field: b.field },
      });
      return { id };
    });
  }

  // ── status lifecycle ────────────────────────────────────────────────────────────────────────────────
  setStatus(
    s: SessionUser,
    id: string,
    b: {
      to: WorkerStatus;
      reason: string;
      reassignments?: { ref: string; to: string }[];
    },
  ) {
    if (!b.reason.trim()) throw fail(422, "reason_required", "Give a reason.");
    return this.tx.run(async (tx) => {
      const r = await this.one(tx, id);
      const from = r.row.status;
      if (!NEXT[from].includes(b.to))
        throw fail(409, "conflict", "Not allowed from this status.");
      const w = await this.loadWf(tx, id, true);
      const by = await this.actorName(tx, s);
      if (b.to === "terminated") {
        const map = new Map((b.reassignments ?? []).map((x) => [x.ref, x.to]));
        const open = (await this.openCases(tx, id)).filter(
          (c) => !map.has(c.ref),
        );
        if (open.length)
          throw fail(
            409,
            "cases_unresolved",
            `${open.length} open cases need a decision.`,
          );
        for (const [ref, to] of map) {
          if (to === "keep") continue;
          const [app] = await tx
            .select()
            .from(applications)
            .where(eq(applications.code, ref))
            .for("update");
          if (!app || app.assignedAgentId !== id) continue;
          const [target] = await tx
            .select({ id: agentProfiles.userId })
            .from(agentProfiles)
            .where(eq(agentProfiles.userId, to));
          if (!target)
            throw fail(422, "validation", `Unknown assignee for ${ref}.`);
          await tx.insert(applicationAssignmentHistory).values({
            id: generateId("aah"),
            applicationId: app.applicationId,
            previousAgentId: id,
            newAgentId: to,
            performedBy: s.id,
            performedByRole: s.roles[0],
            note: "offboarding reassignment",
            createdAt: iso(),
          });
          await tx
            .update(applications)
            .set({ assignedAgentId: to, assignedAt: iso(), updatedAt: iso() })
            .where(eq(applications.applicationId, app.applicationId));
          await this.notifications.notify(tx, {
            userId: to,
            kind: "assignment",
            title: `${ref} was reassigned to you`,
            link: `/agent/cases/${ref}`,
          });
        }
        // withdraw open offers
        await tx
          .update(opsRecords)
          .set({
            state: "withdrawn",
            data: sql`${opsRecords.data} || jsonb_build_object('state','withdrawn','endedAt',${iso()}::text)`,
            updatedAt: iso(),
          })
          .where(
            and(
              eq(opsRecords.kind, "offer"),
              eq(opsRecords.ownerId, id),
              sql`${opsRecords.data}->>'state' in ('sent','viewed')`,
            ),
          );
      }
      const revoke = b.to === "suspended" || b.to === "terminated";
      w.status = b.to === "cleared" || b.to === "onboarding" ? undefined : b.to;
      if (b.to === "onboarding" && r.row.type === "internal")
        await tx
          .update(agentProfiles)
          .set({ clearance: "in_progress" })
          .where(eq(agentProfiles.userId, id));
      w.sessionsRevoked = revoke;
      await tx
        .update(users)
        .set({ isActive: !revoke, updatedAt: iso() })
        .where(eq(users.userId, id));
      if (revoke) await this.auth.revokeAllSessions(tx, id);
      if (r.row.type === "external") await onExternalStatus(tx, id, b.to);
      this.event(w, "status", `Status → ${b.to}`, by);
      if (revoke) this.event(w, "access", "Sessions revoked", by);
      if (from === "suspended" && (b.to === "cleared" || b.to === "onboarding"))
        this.event(w, "access", "Access restored", by);
      await this.saveWf(tx, id, w);
      const out = await this.detail(tx, id);
      await this.audit.record(tx, {
        action: "workforce.worker.status.changed",
        entity: "workforce.worker",
        entityId: id,
        before: { status: from },
        after: { status: b.to },
        reason: b.reason.trim(),
      });
      return out;
    });
  }

  // ── reviews, history, assignees ─────────────────────────────────────────────────────────────────────
  reviews(id: string) {
    return this.tx.run(async (tx) => ({
      items: (
        await tx
          .select({ data: opsRecords.data })
          .from(opsRecords)
          .where(
            and(eq(opsRecords.kind, "wf_review"), eq(opsRecords.ownerId, id)),
          )
          .orderBy(desc(opsRecords.createdAt))
      ).map((r) => r.data as Review),
    }));
  }

  addReview(
    s: SessionUser,
    id: string,
    b: {
      period: string;
      rating: number;
      goals?: string;
      comments: string;
      ackRequired?: boolean;
    },
  ) {
    if (
      !b.period ||
      !Number.isInteger(b.rating) ||
      b.rating < 1 ||
      b.rating > 5 ||
      !b.comments.trim()
    )
      throw fail(422, "validation", "Check the fields.");
    return this.tx.run(async (tx) => {
      const r = await this.one(tx, id);
      const by = await this.actorName(tx, s);
      const rv: Review = {
        id: generateId("rv"),
        workerId: id,
        period: b.period,
        kpis: { onTime: r.row.onTimePct, rating: r.row.rating },
        rating: b.rating,
        goals: b.goals ?? "",
        comments: b.comments.trim(),
        ackRequired: !!b.ackRequired,
        status: "submitted",
        by: { id: s.id, name: by },
        at: iso(),
      };
      await tx
        .insert(opsRecords)
        .values({
          id: rv.id,
          kind: "wf_review",
          ownerId: id,
          ref: b.period,
          state: rv.status,
          data: rv,
        });
      const w = await this.loadWf(tx, id, true);
      this.event(w, "review", `Review ${b.period} submitted`, by);
      await this.saveWf(tx, id, w);
      if (rv.ackRequired)
        await this.notifications.notify(tx, {
          userId: id,
          kind: "workforce",
          title: `Your ${b.period} review is ready to acknowledge`,
          link: "/agent/profile",
        });
      await this.audit.record(tx, {
        action: "workforce.review.submitted",
        entity: "workforce.worker",
        entityId: id,
        after: { period: b.period, rating: b.rating },
      });
      return rv;
    });
  }

  history(id: string) {
    return this.tx.run(async (tx) => {
      const r = await this.one(tx, id);
      const login = r.row.lastLoginAt
        ? [
            {
              id: `ll-${id}`,
              at: r.row.lastLoginAt,
              kind: "login",
              text: "Signed in",
            },
          ]
        : [];
      const rows = await tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.resourceId, id),
            sql`${auditLog.resourceType} like 'workforce%'`,
          ),
        )
        .orderBy(desc(auditLog.createdAt))
        .limit(200);
      const names = new Map(
        (
          await tx
            .select({ id: users.userId, name: users.name })
            .from(users)
            .where(
              inArray(
                users.userId,
                rows.map((a) => a.actorId ?? "-").concat("-"),
              ),
            )
        ).map((u) => [u.id, u.name]),
      );
      return {
        items: [...(r.w.events ?? []), ...login],
        audit: rows.map((a) => {
          const d = (a.details ?? {}) as Record<string, unknown>;
          return {
            id: a.id,
            at: a.createdAt,
            actor: (a.actorId && names.get(a.actorId)) ?? "System",
            action: a.action,
            entity: { kind: "workforce", id },
            before: d.before,
            after: d.after,
            reason: d.reason,
          };
        }),
      };
    });
  }

  assignees(id: string) {
    return this.tx.run(async (tx) => {
      const live = await tx
        .select({ id: users.userId, name: users.name, cap: agentProfiles.cap })
        .from(agentProfiles)
        .innerJoin(users, eq(users.userId, agentProfiles.userId))
        .where(
          and(
            eq(users.isActive, true),
            ne(agentProfiles.userId, id),
            eq(agentProfiles.clearance, "cleared"),
          ),
        );
      const loads = live.length
        ? await tx
            .select({
              id: applications.assignedAgentId,
              n: sql<number>`count(*)::int`,
            })
            .from(applications)
            .where(
              and(
                inArray(
                  applications.assignedAgentId,
                  live.map((a) => a.id),
                ),
                notInArray(applications.status, CLOSED),
              ),
            )
            .groupBy(applications.assignedAgentId)
        : [];
      const N = new Map(loads.map((l) => [l.id, Number(l.n)]));
      return {
        items: live.map((a) => ({
          id: a.id,
          name: a.name,
          load: N.get(a.id) ?? 0,
          cap: a.cap,
        })),
      };
    });
  }
}
