// ORG (company profiles, spec 05-modules/company-profiles): companies, representatives, emailed/SMS invites (7 days),
// SM verification. Membership lives in organization_members; the acting company is acct `${uid}:orgs`.activeOrgId
// (auth.access reads it into scopes.orgId).
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
  applications,
  organizationInvites,
  organizationMembers,
  organizations,
  systemRecords,
  users,
} from "@/db/schema";
import {
  canManageMember,
  INVITE_TTL_MS,
  isTin,
  orgCan,
  type OrgAction,
  type OrgRole,
} from "@/domain/org/org";
import type { Env } from "../../core/config/env";
import type { SessionUser } from "../../core/http/context";
import { AppError, notFound } from "../../core/http/errors";
import type { Tx } from "../../core/db/db";
import { TxService } from "../../core/db/tx";
import { AuditService } from "../../core/db/audit";
import { OutboxService } from "../../core/db/outbox";
import { CryptoService } from "../../core/crypto/crypto.service";
import { generateId } from "../../core/db/ids";
import { nextCustomerNo } from "../../core/db/customer-no";
import { NotificationsService } from "../notifications/notifications.service";
import { normalizePhone } from "../auth/auth.rules";
import { orgSubscription } from "../subscriptions/subscriptions.service";

export type OrgProfile = {
  legalName: string;
  tradeName?: string | null;
  orgType: string;
  tin?: string | null;
  rdbNumber?: string | null;
  registeredOn?: string | null;
  sectorCode?: string | null;
  province?: string | null;
  district?: string | null;
  sector?: string | null;
  cell?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  sizeBand?: string | null;
};
type Org = typeof organizations.$inferSelect;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const now = () => new Date().toISOString();

@Injectable()
export class OrgService {
  constructor(
    private readonly txs: TxService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly crypto: CryptoService,
    private readonly notifications: NotificationsService,
    private readonly cfg: ConfigService<Env, true>,
  ) {}

  private get origin() {
    return this.cfg.get("WEB_ORIGIN", { infer: true }).split(",")[0].trim();
  }

  /** The caller's active role in the org, or null (non-members get 404, never 403: ownership checks). */
  async roleOf(tx: Tx, orgId: string, userId: string): Promise<OrgRole | null> {
    const [m] = await tx
      .select({ role: organizationMembers.role })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, orgId),
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.status, "active"),
        ),
      );
    return (m?.role as OrgRole) ?? null;
  }
  /** For other modules (submit on behalf, invoices): throws 404 unless `userId` may do `action` for the org. */
  async assertCan(tx: Tx, orgId: string, userId: string, action: OrgAction) {
    const role = await this.roleOf(tx, orgId, userId);
    if (!role) throw notFound("Organisation");
    if (!orgCan(role, action))
      throw new AppError(
        403,
        "forbidden",
        "Your role in this company does not allow that.",
      );
    return role;
  }

  private async activeOrgId(tx: Tx, uid: string) {
    const [r] = await tx
      .select({ d: systemRecords.data })
      .from(systemRecords)
      .where(
        and(
          eq(systemRecords.kind, "acct"),
          eq(systemRecords.id, `${uid}:orgs`),
        ),
      );
    return (
      (r?.d as { activeOrgId?: string | null } | undefined)?.activeOrgId ?? null
    );
  }

  private async members(tx: Tx, orgIds: string[]) {
    if (!orgIds.length)
      return new Map<
        string,
        {
          id: string;
          name: string;
          contact: string;
          role: OrgRole;
          title: string | null;
          pending: boolean;
        }[]
      >();
    const [ms, inv] = await Promise.all([
      tx
        .select({
          org: organizationMembers.organizationId,
          id: users.userId,
          name: users.name,
          email: users.email,
          phone: users.phoneE164,
          role: organizationMembers.role,
          title: organizationMembers.title,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(users.userId, organizationMembers.userId))
        .where(
          and(
            inArray(organizationMembers.organizationId, orgIds),
            eq(organizationMembers.status, "active"),
          ),
        ),
      tx
        .select()
        .from(organizationInvites)
        .where(
          and(
            inArray(organizationInvites.organizationId, orgIds),
            sql`${organizationInvites.acceptedAt} is null and ${organizationInvites.expiresAt} > now()`,
          ),
        ),
    ]);
    const out = new Map<
      string,
      {
        id: string;
        name: string;
        contact: string;
        role: OrgRole;
        title: string | null;
        pending: boolean;
      }[]
    >();
    for (const m of ms)
      (out.get(m.org) ?? out.set(m.org, []).get(m.org)!).push({
        id: m.id,
        name: m.name,
        contact: m.email ?? m.phone ?? "",
        role: m.role as OrgRole,
        title: m.title,
        pending: false,
      });
    for (const i of inv)
      (
        out.get(i.organizationId) ??
        out.set(i.organizationId, []).get(i.organizationId)!
      ).push({
        id: i.id,
        name: i.contact,
        contact: i.contact,
        role: i.role as OrgRole,
        title: null,
        pending: true,
      });
    return out;
  }

  private view(o: Org) {
    return {
      id: o.id,
      name: o.tradeName || o.legalName,
      legalName: o.legalName,
      tradeName: o.tradeName,
      orgType: o.orgType,
      tin: o.tin,
      rdbNumber: o.rdbNumber,
      registeredOn: o.registeredOn,
      sectorCode: o.sectorCode,
      province: o.province,
      district: o.district,
      sector: o.sector,
      cell: o.cell,
      phone: o.phone,
      email: o.email,
      website: o.website,
      sizeBand: o.sizeBand,
      customerNo: o.customerNo,
      verificationStatus: o.verificationStatus,
      verificationNote: o.verificationNote,
      verifiedAt: o.verifiedAt,
      archived: !!o.archivedAt,
      createdAt: o.createdAt,
    };
  }

  // ── client ──
  mine(me: SessionUser) {
    return this.txs.run(async (tx) => {
      const rows = await tx
        .select({ o: organizations, role: organizationMembers.role })
        .from(organizationMembers)
        .innerJoin(
          organizations,
          eq(organizations.id, organizationMembers.organizationId),
        )
        .where(
          and(
            eq(organizationMembers.userId, me.id),
            eq(organizationMembers.status, "active"),
          ),
        )
        .orderBy(organizations.legalName);
      const ms = await this.members(
        tx,
        rows.map((r) => r.o.id),
      );
      const active = await this.activeOrgId(tx, me.id);
      return {
        activeOrgId: rows.some((r) => r.o.id === active) ? active : null,
        orgs: rows.map((r) => ({
          ...this.view(r.o),
          myRole: r.role as OrgRole,
          members: ms.get(r.o.id) ?? [],
        })),
      };
    });
  }

  setActive(me: SessionUser, orgId: string | null) {
    return this.txs.run(async (tx) => {
      if (orgId && !(await this.roleOf(tx, orgId, me.id)))
        throw notFound("Organisation");
      await tx.execute(sql`insert into system_records (kind, id, pos, data) values ('acct', ${`${me.id}:orgs`}, 0, ${JSON.stringify({ activeOrgId: orgId })}::jsonb)
        on conflict (kind, id) do update set data = system_records.data || ${JSON.stringify({ activeOrgId: orgId })}::jsonb, updated_at = now()`);
      return { activeOrgId: orgId };
    });
  }

  create(me: SessionUser, b: OrgProfile) {
    if (b.tin && !isTin(b.tin))
      throw new AppError(422, "validation", "TIN must be 9 digits.", {
        tin: "TIN must be 9 digits.",
      });
    return this.txs.run(async (tx) => {
      const id = generateId("org");
      const t = now();
      const [o] = await tx
        .insert(organizations)
        .values({
          ...b,
          id,
          customerNo: await nextCustomerNo(tx),
          createdBy: me.id,
          createdAt: t,
          updatedAt: t,
        })
        .returning();
      await tx
        .insert(organizationMembers)
        .values({
          organizationId: id,
          userId: me.id,
          role: "owner",
          status: "active",
          acceptedAt: t,
        });
      await this.audit.record(tx, {
        action: "org.created",
        entity: "organization",
        entityId: id,
        after: { legalName: b.legalName },
      });
      return { ...this.view(o), myRole: "owner" as const, members: [] };
    });
  }

  detail(me: SessionUser, id: string) {
    return this.txs.run(async (tx) => {
      const role = await this.assertCan(tx, id, me.id, "view");
      return this.full(tx, id, role);
    });
  }

  private async full(tx: Tx, id: string, myRole: OrgRole | null) {
    const [o] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, id));
    if (!o) throw notFound("Organisation");
    const [ms, cases] = await Promise.all([
      this.members(tx, [id]),
      tx
        .select({
          code: applications.code,
          service: applications.serviceName,
          status: applications.status,
          submittedAt: applications.submittedAt,
          amount: applications.paymentAmount,
          paymentStatus: applications.paymentStatus,
        })
        .from(applications)
        .where(eq(applications.organizationId, id))
        .orderBy(desc(applications.submittedAt))
        .limit(200),
    ]);
    return {
      ...this.view(o),
      myRole,
      members: ms.get(id) ?? [],
      requests: cases,
    };
  }

  update(me: SessionUser, id: string, b: Partial<OrgProfile>) {
    if (b.tin && !isTin(b.tin))
      throw new AppError(422, "validation", "TIN must be 9 digits.", {
        tin: "TIN must be 9 digits.",
      });
    return this.txs.run(async (tx) => {
      const role = await this.assertCan(tx, id, me.id, "edit");
      const [before] = await tx
        .select()
        .from(organizations)
        .where(eq(organizations.id, id))
        .for("update");
      // Changing the legal identity of a verified company sends it back to verification.
      const reverify =
        before.verificationStatus === "verified" &&
        ((b.tin !== undefined && b.tin !== before.tin) ||
          (b.rdbNumber !== undefined && b.rdbNumber !== before.rdbNumber) ||
          (b.legalName !== undefined && b.legalName !== before.legalName));
      await tx
        .update(organizations)
        .set({
          ...b,
          ...(reverify && {
            verificationStatus: "pending_verification",
            verifiedAt: null,
            verifiedBy: null,
          }),
          updatedAt: now(),
        })
        .where(eq(organizations.id, id));
      await this.audit.record(tx, {
        action: "org.updated",
        entity: "organization",
        entityId: id,
        before: { tin: before.tin, legalName: before.legalName },
        after: b,
      });
      return this.full(tx, id, role);
    });
  }

  /** ORG-04: the client asks for verification once the RDB certificate is in the company's documents. */
  requestVerification(me: SessionUser, id: string) {
    return this.txs.run(async (tx) => {
      await this.assertCan(tx, id, me.id, "edit");
      const [o] = await tx
        .update(organizations)
        .set({ verificationStatus: "pending_verification", updatedAt: now() })
        .where(
          and(
            eq(organizations.id, id),
            inArray(organizations.verificationStatus, [
              "unverified",
              "rejected",
            ]),
          ),
        )
        .returning({ id: organizations.id });
      if (!o)
        throw new AppError(
          409,
          "conflict",
          "Verification is already pending or done.",
        );
      return { verificationStatus: "pending_verification" as const };
    });
  }

  invite(
    me: SessionUser,
    id: string,
    b: { contact: string; role?: "admin" | "viewer" },
  ) {
    const role = b.role === "admin" ? "admin" : "viewer";
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.contact)
      ? b.contact.toLowerCase()
      : null;
    const phone = email ? null : normalizePhone(b.contact);
    if (!email && !phone)
      throw new AppError(
        422,
        "validation",
        "Enter a valid email or phone number.",
        { contact: "Enter a valid email or phone number." },
      );
    return this.txs.run(async (tx) => {
      const mine = await this.assertCan(tx, id, me.id, "invite");
      if (role === "admin" && mine !== "owner")
        throw new AppError(
          403,
          "forbidden",
          "Only the owner can invite admins.",
        );
      const [o] = await tx
        .select()
        .from(organizations)
        .where(eq(organizations.id, id));
      const token = randomBytes(24).toString("base64url");
      const contact = (email ?? phone)!;
      await tx
        .insert(organizationInvites)
        .values({
          id: generateId("oinv"),
          tokenHash: sha(token),
          organizationId: id,
          contact,
          role,
          invitedBy: me.id,
          expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
          createdAt: now(),
        });
      const link = `${this.origin}/org-invite/${token}`;
      const text = `You have been invited to act for ${o.tradeName || o.legalName} on Hebuza. Accept within 7 days: ${link}`;
      await this.outbox.add(
        tx,
        email
          ? {
              type: "auth.mail",
              queue: "critical",
              payload: this.crypto.seal(
                {
                  to: email,
                  subject: `Invitation: ${o.tradeName || o.legalName}`,
                  text,
                },
                ["text"],
              ),
            }
          : {
              type: "auth.sms",
              queue: "critical",
              payload: this.crypto.seal({ to: phone!, text }, ["text"]),
            },
      );
      // In-app too when the contact already has a client account.
      const [u] = await tx
        .select({ id: users.userId })
        .from(users)
        .where(
          and(
            eq(users.role, "client"),
            email ? eq(users.email, email) : eq(users.phoneE164, phone!),
          ),
        );
      if (u)
        await this.notifications.notify(tx, {
          userId: u.id,
          kind: "org.invite",
          title: `Invitation to ${o.tradeName || o.legalName}`,
          link: `/org-invite/${token}`,
        });
      await this.audit.record(tx, {
        action: "org.member.invited",
        entity: "organization",
        entityId: id,
        after: { role },
      });
      return { invited: true };
    });
  }

  /** Invite preview for the accept page (no membership needed; the token is the secret). */
  invitePreview(token: string) {
    return this.txs.runAsSystem(async (tx) => {
      const [i] = await tx
        .select({
          i: organizationInvites,
          name: organizations.legalName,
          trade: organizations.tradeName,
        })
        .from(organizationInvites)
        .innerJoin(
          organizations,
          eq(organizations.id, organizationInvites.organizationId),
        )
        .where(eq(organizationInvites.tokenHash, sha(token)));
      if (!i) throw notFound("Invitation");
      const state = i.i.acceptedAt
        ? "accepted"
        : Date.parse(i.i.expiresAt) < Date.now()
          ? "expired"
          : "open";
      return {
        organization: i.trade || i.name,
        role: i.i.role as OrgRole,
        state,
        expiresAt: i.i.expiresAt,
      };
    });
  }

  accept(me: SessionUser, token: string) {
    return this.txs.runAsSystem(async (tx) => {
      const [i] = await tx
        .select()
        .from(organizationInvites)
        .where(eq(organizationInvites.tokenHash, sha(token)))
        .for("update");
      if (!i) throw notFound("Invitation");
      if (i.acceptedAt)
        throw new AppError(
          409,
          "conflict",
          "This invitation was already used.",
        );
      if (Date.parse(i.expiresAt) < Date.now())
        throw new AppError(
          410,
          "expired",
          "This invitation has expired. Ask for a new one.",
        );
      const t = now();
      await tx
        .insert(organizationMembers)
        .values({
          organizationId: i.organizationId,
          userId: me.id,
          role: i.role,
          status: "active",
          invitedBy: i.invitedBy,
          invitedAt: i.createdAt,
          acceptedAt: t,
        })
        .onConflictDoUpdate({
          target: [
            organizationMembers.organizationId,
            organizationMembers.userId,
          ],
          set: {
            role: sql`case when ${organizationMembers.role} = 'owner' then 'owner' else excluded.role end`,
            status: "active",
            acceptedAt: t,
          },
        });
      await tx
        .update(organizationInvites)
        .set({ acceptedAt: t })
        .where(eq(organizationInvites.id, i.id));
      await this.audit.record(tx, {
        action: "org.member.joined",
        entity: "organization",
        entityId: i.organizationId,
        after: { userId: me.id, role: i.role },
      });
      return { organizationId: i.organizationId };
    });
  }

  setMember(
    me: SessionUser,
    id: string,
    memberId: string,
    b: { role?: "admin" | "viewer"; title?: string | null },
  ) {
    return this.txs.run(async (tx) => {
      const mine = await this.roleOf(tx, id, me.id);
      const target = await this.roleOf(tx, id, memberId);
      if (!mine || !target) throw notFound("Member");
      if (
        !canManageMember(mine, target) ||
        (b.role === "admin" && mine !== "owner")
      )
        throw new AppError(
          403,
          "forbidden",
          "Your role in this company does not allow that.",
        );
      await tx
        .update(organizationMembers)
        .set({
          ...(b.role && { role: b.role }),
          ...(b.title !== undefined && { title: b.title }),
        })
        .where(
          and(
            eq(organizationMembers.organizationId, id),
            eq(organizationMembers.userId, memberId),
          ),
        );
      await this.audit.record(tx, {
        action: "org.member.updated",
        entity: "organization",
        entityId: id,
        after: { memberId, ...b },
      });
      return this.full(tx, id, mine);
    });
  }

  removeMember(me: SessionUser, id: string, memberId: string) {
    return this.txs.run(async (tx) => {
      const mine = await this.roleOf(tx, id, me.id);
      if (!mine) throw notFound("Organisation");
      // A pending invite is removed by its id.
      const gone = await tx
        .delete(organizationInvites)
        .where(
          and(
            eq(organizationInvites.id, memberId),
            eq(organizationInvites.organizationId, id),
          ),
        )
        .returning({ id: organizationInvites.id });
      if (gone.length) {
        if (!orgCan(mine, "invite"))
          throw new AppError(
            403,
            "forbidden",
            "Your role in this company does not allow that.",
          );
        return { removed: true };
      }
      const target = await this.roleOf(tx, id, memberId);
      if (!target) throw notFound("Member");
      if (memberId !== me.id && !canManageMember(mine, target))
        throw new AppError(
          403,
          "forbidden",
          "Your role in this company does not allow that.",
        );
      if (target === "owner")
        throw new AppError(
          409,
          "owner",
          "The owner can't leave or be removed.",
        );
      await tx
        .update(organizationMembers)
        .set({ status: "removed" })
        .where(
          and(
            eq(organizationMembers.organizationId, id),
            eq(organizationMembers.userId, memberId),
          ),
        );
      await this.notifications.notify(tx, {
        userId: memberId,
        kind: "org.member_removed",
        title: "You were removed from a company",
        link: "/orgs",
      });
      await this.audit.record(tx, {
        action: "org.member.removed",
        entity: "organization",
        entityId: id,
        after: { memberId },
      });
      return { removed: true };
    });
  }

  // ── staff ──
  adminList(q: { q?: string; status?: string }) {
    return this.txs.run(async (tx) => {
      const where = and(
        q.status ? eq(organizations.verificationStatus, q.status) : undefined,
        q.q
          ? or(
              ilike(organizations.legalName, `%${q.q}%`),
              ilike(organizations.tradeName, `%${q.q}%`),
              eq(organizations.tin, q.q),
              eq(organizations.customerNo, q.q),
            )
          : undefined,
      );
      const rows = await tx
        .select({
          o: organizations,
          members: sql<number>`(select count(*)::int from organization_members m where m.organization_id = ${organizations.id} and m.status = 'active')`,
          dupTin: sql<boolean>`exists (select 1 from organizations x where x.tin = ${organizations.tin} and x.id <> ${organizations.id})`,
        })
        .from(organizations)
        .where(where)
        .orderBy(desc(organizations.createdAt))
        .limit(500);
      return {
        rows: rows.map((r) => ({
          ...this.view(r.o),
          members: r.members,
          duplicateTin: !!r.o.tin && r.dupTin,
        })),
      };
    });
  }

  adminDetail(id: string) {
    return this.txs.run((tx) => this.full(tx, id, null));
  }

  verify(
    me: SessionUser,
    id: string,
    b: { decision: "verified" | "rejected"; note?: string },
  ) {
    return this.txs.run(async (tx) => {
      const [o] = await tx
        .select()
        .from(organizations)
        .where(eq(organizations.id, id))
        .for("update");
      if (!o) throw notFound("Organisation");
      if (b.decision === "rejected" && !b.note?.trim())
        throw new AppError(
          422,
          "reason_required",
          "Say what needs correcting.",
        );
      if (b.decision === "verified" && !o.tin)
        throw new AppError(
          422,
          "validation",
          "A verified company needs a TIN.",
        );
      await tx
        .update(organizations)
        .set({
          verificationStatus: b.decision,
          verificationNote: b.note ?? null,
          verifiedBy: me.id,
          verifiedAt: b.decision === "verified" ? now() : null,
          updatedAt: now(),
        })
        .where(eq(organizations.id, id))
        .catch((e: unknown) => {
          throw /uq_organizations_verified_tin/.test(String(e))
            ? new AppError(
                409,
                "duplicate_tin",
                "Another verified company has this TIN.",
              )
            : e;
        });
      const owners = await tx
        .select({ id: organizationMembers.userId })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, id),
            eq(organizationMembers.role, "owner"),
            eq(organizationMembers.status, "active"),
          ),
        );
      for (const w of owners)
        await this.notifications.notify(tx, {
          userId: w.id,
          kind: b.decision === "verified" ? "org.verified" : "org.rejected",
          title: `${o.tradeName || o.legalName}: ${b.decision === "verified" ? "verified" : "needs correction"}`,
          body: b.note ?? null,
          link: "/orgs",
        });
      await this.audit.record(tx, {
        action: `org.${b.decision}`,
        entity: "organization",
        entityId: id,
        reason: b.note,
      });
      return this.full(tx, id, null);
    });
  }
}
