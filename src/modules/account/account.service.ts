// Client self-service: consents, avatar, data export, deletion check, organisations, guest-application claim,
// generic uploads and file links. Small per-user documents live in system_records (kind "acct", id "<userId>:<doc>").
// Uploads go straight to object storage via presigned PUT; the API only stores the key.
import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  applicationClaimOtps,
  applicationDocuments,
  applications,
  notifications,
  systemRecords,
  users,
} from "@/db/schema";
import {
  CASE_STATUS_META,
  normalizeStatus,
} from "@/domain/domain/case-status";
import type { SessionUser } from "../../core/http/context";
import { AppError, forbidden, notFound } from "../../core/http/errors";
import type { Tx } from "../../core/db/db";
import { TxService } from "../../core/db/tx";
import { AuditService } from "../../core/db/audit";
import { OutboxService } from "../../core/db/outbox";
import { CryptoService } from "../../core/crypto/crypto.service";
import { checkOtp, newOtp } from "../../core/auth/otp";
import { assignCustomerNo } from "../../core/db/customer-no";
import { StorageService } from "../../core/storage/storage.service";
import { normalizePhone } from "../auth/auth.rules";

type Consents = { processing: boolean; marketing: boolean; analytics: boolean };
const NO_CONSENT: Consents = {
  processing: true,
  marketing: false,
  analytics: false,
};
type Export = {
  status: "none" | "pending" | "ready";
  requestedAt: string | null;
  key?: string | null;
};
type OrgRole = "owner" | "admin" | "member";
type Member = {
  id: string;
  name: string;
  contact: string;
  role: OrgRole;
  pending?: boolean;
};
type Org = { id: string; name: string; members: Member[] };
type Orgs = { activeOrgId: string | null; orgs: Org[] };
type Upload = {
  owner: string;
  key: string;
  name: string;
  mime: string;
  size: number;
  purpose: string;
  at: string;
};
/** An upload the caller made (POST /api/uploads), for DTOs that reference evidence by upload id. */
export async function ownUpload(db: Pick<Tx, "select">, ownerId: string, id: string) {
  const [r] = await db.select({ data: systemRecords.data }).from(systemRecords)
    .where(and(eq(systemRecords.kind, "upload"), eq(systemRecords.id, id)));
  const u = r?.data as Upload | undefined;
  if (!u || u.owner !== ownerId) throw new AppError(422, "validation", "Unknown upload.");
  return { id, name: u.name, href: `/api/files/${id}/${encodeURIComponent(u.name)}` };
}
const NO_ORGS: Orgs = { activeOrgId: null, orgs: [] };
const myRole = (o: Org, me: string): OrgRole =>
  o.members.find((m) => m.id === me)?.role ?? "member";
const AVATAR_MAX = 5 * 1024 * 1024;
const UPLOAD_MAX = 10 * 1024 * 1024;
const UPLOAD_MIME =
  /^(image\/(jpeg|png|webp)|application\/pdf|audio\/(webm|ogg|mp4|mpeg))$/;
const phoneKey = (p: string) => normalizePhone(p) ?? p.replace(/\D/g, "");
const sanitize = (n: string) =>
  n.replace(/[^\w.\- ]/g, "_").slice(0, 120) || "file";

@Injectable()
export class AccountService {
  constructor(
    private readonly txs: TxService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly crypto: CryptoService,
  ) {}

  private async getDoc<T>(
    tx: Tx,
    id: string,
    fallback: T,
    lock = false,
  ): Promise<T> {
    const q = tx
      .select({ data: systemRecords.data })
      .from(systemRecords)
      .where(and(eq(systemRecords.kind, "acct"), eq(systemRecords.id, id)));
    const [r] = lock ? await q.for("update") : await q;
    return (r?.data as T | undefined) ?? fallback;
  }
  private putDoc(tx: Tx, id: string, data: unknown) {
    return tx
      .insert(systemRecords)
      .values({ kind: "acct", id, pos: 0, data })
      .onConflictDoUpdate({
        target: [systemRecords.kind, systemRecords.id],
        set: { data, updatedAt: new Date().toISOString() },
      });
  }

  /** Open (non-terminal) case codes: consent lock + deletion blockers. Note: applications is RLS-forced (see report). */
  async openCaseRefs(tx: Tx, userId: string) {
    const rows = await tx
      .select({ code: applications.code, status: applications.status })
      .from(applications)
      .where(eq(applications.clientId, userId));
    return rows
      .filter((r) => !CASE_STATUS_META[normalizeStatus(r.status)].terminal)
      .map((r) => r.code);
  }
  deletionCheck(me: SessionUser) {
    return this.txs.run(async (tx) => {
      const refs = await this.openCaseRefs(tx, me.id);
      return { blocked: refs.length > 0, refs };
    });
  }

  consents(me: SessionUser) {
    return this.txs.run(async (tx) => ({
      ...(await this.getDoc(tx, `${me.id}:consents`, NO_CONSENT)),
      processingLocked: (await this.openCaseRefs(tx, me.id)).length > 0,
    }));
  }
  setConsents(me: SessionUser, b: Partial<Consents>) {
    return this.txs.run(async (tx) => {
      const id = `${me.id}:consents`;
      const cur = await this.getDoc(tx, id, NO_CONSENT, true);
      const locked = (await this.openCaseRefs(tx, me.id)).length > 0;
      if (locked && b.processing === false)
        throw new AppError(
          409,
          "consent_locked",
          "Required while requests are open.",
        );
      const next = { ...cur, ...b };
      await this.putDoc(tx, id, next);
      await this.audit.record(tx, {
        action: "privacy.consents.updated",
        entity: "user",
        entityId: me.id,
        before: cur,
        after: next,
      });
      return { ...next, processingLocked: locked };
    });
  }

  // ── avatar ──
  async avatar(me: SessionUser) {
    const d = await this.txs.run((tx) =>
      this.getDoc<{ key: string | null }>(tx, `${me.id}:avatar`, { key: null }),
    );
    return {
      url:
        d.key && (await this.storage.head(d.key))
          ? await this.storage.presignGet(d.key)
          : null,
    };
  }
  /** Returns a presigned PUT; the client uploads the bytes, then GET /api/me/avatar serves it once present. */
  setAvatar(me: SessionUser, b: { contentType: string; size: number }) {
    if (!/^image\/(jpeg|png|webp)$/.test(b.contentType))
      throw new AppError(400, "validation_error", "Invalid image.");
    if (b.size > AVATAR_MAX)
      throw new AppError(413, "too_large", "Image too large.");
    return this.txs.run(async (tx) => {
      const key = StorageService.key(me.id, "avatar");
      const upload = await this.storage.presignPut({
        key,
        contentType: b.contentType,
        size: b.size,
        purpose: "avatar",
      });
      await this.putDoc(tx, `${me.id}:avatar`, { key });
      await this.audit.record(tx, {
        action: "profile.avatar.updated",
        entity: "user",
        entityId: me.id,
      });
      return { url: null, upload };
    });
  }
  clearAvatar(me: SessionUser) {
    return this.txs.run(async (tx) => {
      // shortcut: old objects stay in the bucket; add a lifecycle rule on u/*/avatar when storage cost matters.
      await this.putDoc(tx, `${me.id}:avatar`, { key: null });
      await this.audit.record(tx, {
        action: "profile.avatar.removed",
        entity: "user",
        entityId: me.id,
      });
      return { url: null };
    });
  }

  // ── data export ──
  async dataExport(me: SessionUser) {
    const d = await this.txs.run((tx) =>
      this.getDoc<Export>(tx, `${me.id}:export`, {
        status: "none",
        requestedAt: null,
      }),
    );
    return {
      status: d.status,
      requestedAt: d.requestedAt,
      url: d.key
        ? await this.storage.presignGet(d.key, "hebuza-data-export.json")
        : null,
    };
  }
  /** Builds the bundle inline: one user's rows are small. shortcut: synchronous build, move to a job when bundles include files. */
  requestExport(me: SessionUser) {
    return this.txs.run(async (tx) => {
      const [u] = await tx
        .select({
          name: users.name,
          email: users.email,
          phone: users.phoneE164,
          language: users.language,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(eq(users.userId, me.id));
      const apps = await tx
        .select({
          code: applications.code,
          service: applications.serviceName,
          status: applications.status,
          submittedAt: applications.submittedAt,
          personalInfo: applications.personalInfo,
          serviceData: applications.serviceData,
        })
        .from(applications)
        .where(eq(applications.clientId, me.id));
      const ntf = await tx
        .select({
          title: notifications.title,
          body: notifications.body,
          createdAt: notifications.createdAt,
        })
        .from(notifications)
        .where(eq(notifications.userId, me.id));
      const requestedAt = new Date().toISOString();
      const key = StorageService.key(me.id, "export");
      await this.storage.putObject(
        key,
        JSON.stringify(
          {
            generatedAt: requestedAt,
            profile: u ?? null,
            consents: await this.getDoc(tx, `${me.id}:consents`, NO_CONSENT),
            applications: apps,
            notifications: ntf,
          },
          null,
          2,
        ),
        "application/json",
      );
      await this.putDoc(tx, `${me.id}:export`, {
        status: "ready",
        requestedAt,
        key,
      });
      await this.audit.record(tx, {
        action: "privacy.export.requested",
        entity: "user",
        entityId: me.id,
      });
      return {
        status: "ready" as const,
        requestedAt,
        url: await this.storage.presignGet(key, "hebuza-data-export.json"),
      };
    });
  }

  // ── organisations ──
  orgs(me: SessionUser) {
    return this.txs.run(async (tx) => {
      const d = await this.getDoc<Orgs>(tx, `${me.id}:orgs`, NO_ORGS);
      return {
        activeOrgId: d.activeOrgId,
        orgs: d.orgs.map((o) => ({ ...o, myRole: myRole(o, me.id) })),
      };
    });
  }
  setActiveOrg(me: SessionUser, orgId: string | null) {
    return this.txs.run(async (tx) => {
      const d = await this.getDoc<Orgs>(tx, `${me.id}:orgs`, NO_ORGS, true);
      if (orgId && !d.orgs.some((o) => o.id === orgId))
        throw notFound("Organisation");
      await this.putDoc(tx, `${me.id}:orgs`, { ...d, activeOrgId: orgId });
      return { activeOrgId: orgId };
    });
  }
  private editOrg(me: SessionUser, orgId: string, fn: (o: Org) => void) {
    return this.txs.run(async (tx) => {
      const d = await this.getDoc<Orgs>(tx, `${me.id}:orgs`, NO_ORGS, true);
      const o = d.orgs.find((x) => x.id === orgId);
      if (!o) throw notFound("Organisation");
      if (myRole(o, me.id) === "member") throw forbidden();
      fn(o);
      await this.putDoc(tx, `${me.id}:orgs`, d);
    });
  }
  async invite(
    me: SessionUser,
    orgId: string,
    b: { contact: string; role?: "admin" | "member" },
  ) {
    // shortcut: invitee recorded as pending, not emailed; add an outbox mail when org accounts ship.
    await this.editOrg(me, orgId, (o) =>
      o.members.push({
        id: `mem_${randomUUID()}`,
        name: b.contact,
        contact: b.contact,
        role: b.role === "admin" ? "admin" : "member",
        pending: true,
      }),
    );
    return { invited: true };
  }
  async removeMember(me: SessionUser, orgId: string, memberId: string) {
    await this.editOrg(me, orgId, (o) => {
      o.members = o.members.filter(
        (m) => m.id !== memberId || m.role === "owner",
      );
    });
    return { removed: true };
  }

  // ── guest application claim ──
  /** REQ-10: step 1 (no otp) texts a code to the case's phone; step 2 (otp) verifies it, then links the case. */
  claim(me: SessionUser, b: { code: string; phone: string; otp?: string }) {
    const code = b.code.trim().toUpperCase();
    return this.txs.run(async (tx) => {
      // RLS hides unowned rows; the SECURITY DEFINER functions (migration 0005) expose only `client_id is null` rows by code.
      const [a] = (await tx.execute(sql`select application_id as id, personal_info as info from guest_application(${code})`)) as unknown as { id: string; info: unknown }[]; // cast: execute() rows are untyped
      const phone = (a?.info as { phone?: unknown } | null)?.phone;
      if (!a || typeof phone !== "string" || phoneKey(phone) !== phoneKey(b.phone))
        throw new AppError(404, "not_found", "Application not found for that phone number.");
      if (!b.otp) {
        const [prev] = await tx.select().from(applicationClaimOtps).where(eq(applicationClaimOtps.applicationId, a.id));
        if (prev && Date.now() - Date.parse(prev.sentAt) < 60_000)
          throw new AppError(429, "rate_limited", "Wait before sending another code.", undefined, { retryAfterSeconds: 60 });
        const o = newOtp();
        const row = { applicationId: a.id, userId: me.id, codeHash: o.hash, attempts: 0, expiresAt: o.expiresAt.toISOString(), sentAt: new Date().toISOString() };
        await tx.insert(applicationClaimOtps).values(row).onConflictDoUpdate({ target: applicationClaimOtps.applicationId, set: row });
        await this.outbox.add(tx, {
          type: "auth.sms",
          queue: "critical",
          payload: this.crypto.seal({ to: phone, text: `HEBUZA code to claim ${code}: ${o.code}. Valid 10 minutes.` }, ["text"]),
        });
        return { claimed: false, otpSent: true };
      }
      const [own] = await tx.select({ u: applicationClaimOtps.userId }).from(applicationClaimOtps).where(eq(applicationClaimOtps.applicationId, a.id));
      const res = own?.u === me.id ? await checkOtp(tx, applicationClaimOtps, applicationClaimOtps.applicationId, a.id, b.otp) : "dead";
      if (res !== "ok") throw new AppError(422, "otp_invalid", res === "dead" ? "The code expired. Request a new one." : "Wrong code.");
      await tx.delete(applicationClaimOtps).where(eq(applicationClaimOtps.applicationId, a.id));
      const [c] = (await tx.execute(sql`select claim_application(${a.id}) as ok`)) as unknown as { ok: boolean }[]; // cast: execute() rows are untyped
      if (!c?.ok) throw new AppError(409, "conflict", "This application was already claimed.");
      await assignCustomerNo(tx, me.id);
      await this.audit.record(tx, {
        action: "application.claimed",
        entity: "application",
        entityId: code,
      });
      return { claimed: true, otpSent: false };
    });
  }

  // ── generic uploads ──
  /** Anonymous uploads only for the public /join application (qualification files). Returns a presigned PUT + a stable href. */
  upload(
    me: SessionUser | null,
    ip: string,
    b: { purpose?: string; name: string; contentType: string; size: number },
  ) {
    const purpose =
      (b.purpose ?? "file").replace(/[^a-z_-]/gi, "").slice(0, 32) || "file";
    if (!me && purpose !== "qualification")
      throw new AppError(401, "unauthenticated", "Not signed in");
    if (!UPLOAD_MIME.test(b.contentType))
      throw new AppError(
        415,
        "unsupported_media_type",
        "File type not allowed.",
      );
    if (b.size <= 0 || b.size > UPLOAD_MAX)
      throw new AppError(413, "too_large", "File too large.");
    const owner = me?.id ?? `anon:${ip}`;
    const name = sanitize(b.name);
    return this.txs.run(async (tx) => {
      const id = `up_${randomUUID()}`;
      const key = StorageService.key(owner.replace(/[^\w.-]/g, "_"), purpose);
      const upload = await this.storage.presignPut({
        key,
        contentType: b.contentType,
        size: b.size,
        purpose,
      });
      const rec: Upload = {
        owner,
        key,
        name,
        mime: b.contentType,
        size: b.size,
        purpose,
        at: new Date().toISOString(),
      };
      await tx
        .insert(systemRecords)
        .values({ kind: "upload", id, pos: 0, data: rec });
      await this.audit.record(tx, {
        action: "file.uploaded",
        entity: "file",
        entityId: id,
      });
      return {
        id,
        href: `/api/files/${id}/${encodeURIComponent(name)}`,
        name,
        mime: b.contentType,
        size: b.size,
        upload,
      };
    });
  }

  /** Owner, or any staff/agent role. Clients never see each other's files. */
  async fileUrl(me: SessionUser, id: string) {
    const [r] = await this.txs.run((tx) =>
      tx
        .select({ data: systemRecords.data })
        .from(systemRecords)
        .where(and(eq(systemRecords.kind, "upload"), eq(systemRecords.id, id))),
    );
    const u = r?.data as Upload | undefined;
    if (
      !u ||
      (u.owner !== me.id &&
        !me.roles.some((x) => x.startsWith("staff:") || x === "ext:agent"))
    )
      throw notFound("File");
    return this.storage.presignGet(u.key, u.name);
  }

  /** SM/exec/sysadmin any case; internal agents only their assigned cases. */
  caseDocUrl(me: SessionUser, code: string, docId: string) {
    return this.txs.run(async (tx) => {
      const [a] = await tx
        .select({
          id: applications.applicationId,
          agent: applications.assignedAgentId,
        })
        .from(applications)
        .where(eq(applications.code, code));
      if (!a) throw notFound("Application");
      const wide = me.roles.some(
        (r) =>
          r === "staff:service_manager" ||
          r === "staff:executive" ||
          r === "staff:sysadmin",
      );
      if (!wide && a.agent !== me.id) throw notFound("Application");
      const [d] = await tx
        .select({
          path: applicationDocuments.storagePath,
          name: applicationDocuments.originalFilename,
        })
        .from(applicationDocuments)
        .where(
          and(
            eq(applicationDocuments.applicationId, a.id),
            eq(applicationDocuments.documentId, docId),
          ),
        );
      if (!d) throw notFound("Document");
      await this.audit.record(tx, {
        action: "document_access.document.viewed",
        entity: "application",
        entityId: code,
        after: { doc: docId },
      });
      return this.storage.presignGet(d.path, d.name);
    });
  }
}
