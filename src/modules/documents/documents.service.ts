// Port of .ref documents.service (client document library, case uploads, deliverables). Files live in object storage:
// uploads are presigned PUTs (the API never sees bytes) finalized by the worker (documents.finalize: type sniff, scan,
// EXIF strip, activation); downloads are 5-minute presigned redirects after a per-document access check.
import { authorize, ownOr404 } from "../../core/auth/authorize";
import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { createTicket } from "../applications/support.service";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { auditHash, sha256, type SigningRecord } from "@/domain/documents/signature";
import { eSignProvider } from "../../core/esign/provider";
import { textPdf } from "../chat/chat.service";
import { stampPdf } from "../../core/pdf/pdf";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  max,
  sql,
} from "drizzle-orm";
import {
  applicationDocuments,
  applicationFeedback,
  npsResponses,
  applications,
  clientDocumentExpiry,
  clientDocuments,
  clientDocumentVersions,
  supportTickets,
  downloadTokens,
  documentRetentionFlags,
  deliverableSignatures,
  deliverables,
  documentRequests,
  messageAttachments,
  outbox,
  users,
} from "@/db/schema";
import { can } from "@/domain/auth/permissions";
import { normalizeStatus } from "@/domain/domain/case-status";
import type { Tx } from "../../core/db/db";
import { AuditService } from "../../core/db/audit";
import { OutboxService } from "../../core/db/outbox";
import { TxService } from "../../core/db/tx";
import type { SessionUser } from "../../core/http/context";
import { AppError, forbidden, notFound } from "../../core/http/errors";
import { StorageService } from "../../core/storage/storage.service";
import { NotificationsService } from "../notifications/notifications.service";
import {
  ApplicationsService,
  appByCode,
  assertCanRead,
  isTerminal,
  money,
  paidRows,
  recordFeedback,
  stepOf,
  STEPS,
} from "../applications/applications.service";
import { isPreviewable, sanitizeFilename } from "./documents.files";
import { generateId } from "../../core/db/ids";

/** The finalize job runs once the presigned PUT has expired (5 min), so the object is either there or never coming. */
export const FINALIZE_DELAY_MS = 330_000;
export type FinalizeJob = { kind: "case"; id: string; needId: string | null } | { kind: "library"; id: string; version: number } | { kind: "chat"; id: string };
type Upload = { filename: string; mime: string; size: number };

export const CLIENT_DOCUMENT_KINDS = [
  "national_id",
  "passport",
  "birth_certificate",
  "marriage_certificate",
  "tin_certificate",
  "rdb_certificate",
  "company_statutes",
  "proof_of_address",
  "bank_statement",
  "photo",
  "diploma",
  "driving_license",
  "other",
] as const;
/** UI groupings the library screen also sends (identity/company/tax…); accepted alongside the Python codes. */
const UI_KINDS = [
  "identity",
  "company",
  "tax",
  "finance",
  "property",
  "education",
  "personal",
];
export const MAX_LIBRARY_DOCUMENTS = 100;
export const ORPHAN_GRACE_DAYS = 30;
const OPEN_CASE = (s: string) =>
  !isTerminal(normalizeStatus(s)) &&
  normalizeStatus(s) !== "completed_delivered";

type Doc = typeof clientDocuments.$inferSelect;

export function cleanLabel(label: string | null | undefined, filename: string) {
  const l = (label ?? "").trim() || filename;
  if (l.length < 1 || l.length > 120)
    throw new AppError(422, "validation", "A label is 1 to 120 characters.");
  return l;
}
export function cleanKind(kind: string | null | undefined) {
  const k = (kind ?? "").trim();
  if (!k) return null;
  if (
    !(CLIENT_DOCUMENT_KINDS as readonly string[]).includes(k) &&
    !UI_KINDS.includes(k)
  )
    throw new AppError(422, "validation", "Unknown document type.");
  return k;
}

// ── projection ────────────────────────────────────────────────────────────────────────────────
async function project(db: Tx, docs: Doc[]) {
  const ids = docs.map((d) => d.documentId);
  if (!ids.length) return [];
  const [versions, uses, exp] = await Promise.all([
    db
      .select()
      .from(clientDocumentVersions)
      .where(inArray(clientDocumentVersions.documentId, ids))
      .orderBy(desc(clientDocumentVersions.version)),
    db
      .select({
        vault: applicationDocuments.vaultDocumentId,
        adId: applicationDocuments.documentId,
        key: applicationDocuments.requirementKey,
        version: applicationDocuments.vaultVersion,
        active: applicationDocuments.isActive,
        qc: applicationDocuments.qcStatus,
        code: applications.code,
        service: applications.serviceName,
        status: applications.status,
      })
      .from(applicationDocuments)
      .innerJoin(
        applications,
        eq(applications.applicationId, applicationDocuments.applicationId),
      )
      .where(
        and(
          inArray(applicationDocuments.vaultDocumentId, ids),
          isNull(applicationDocuments.removedAt),
        ),
      ),
    db
      .select()
      .from(clientDocumentExpiry)
      .where(inArray(clientDocumentExpiry.documentId, ids)),
  ]);
  return docs.map((d) => ({
    documentId: d.documentId,
    originalFilename: d.originalFilename,
    label: d.label,
    kind: d.kind,
    mimeType: d.mimeType,
    fileSizeBytes: d.fileSizeBytes,
    currentVersion: d.currentVersion,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    previewable: isPreviewable(d.mimeType),
    usedIn: uses
      .filter((u) => u.vault === d.documentId)
      .map((u) => ({
        code: u.code,
        serviceName: u.service,
        applicationDocumentId: u.adId,
        requirementKey: u.key,
        version: u.version ?? d.currentVersion,
        isCurrent: u.active,
        qcStatus: u.qc,
        status: normalizeStatus(u.status),
      })),
    versions: versions
      .filter((v) => v.documentId === d.documentId)
      .map((v) => ({
        version: v.version,
        originalFilename: v.originalFilename,
        mimeType: v.mimeType,
        fileSizeBytes: v.fileSizeBytes,
        uploadedAt: v.uploadedAt,
      })),
    expiresOn:
      exp.find((e) => e.documentId === d.documentId)?.expiresOn ?? null,
  }));
}

async function ownDoc(db: Tx, s: SessionUser, id: string, forUpdate = false) {
  const q = db
    .select()
    .from(clientDocuments)
    .where(
      and(
        eq(clientDocuments.documentId, id),
        eq(clientDocuments.clientId, s.id),
        eq(clientDocuments.isActive, true),
      ),
    );
  const [d] = forUpdate ? await q.for("update") : await q;
  if (!d) throw new AppError(404, "not_found", "Not found.");
  return d;
}

const ownDocForUpdate = (db: Tx, s: SessionUser, id: string) => ownDoc(db, s, id, true);
export async function oneDoc(db: Tx, s: SessionUser, id: string) {
  return (await project(db, [await ownDoc(db, s, id)]))[0];
}

// ── library ───────────────────────────────────────────────────────────────────────────────────
export async function listLibrary(db: Tx, s: SessionUser) {
  const docs = await db
    .select()
    .from(clientDocuments)
    .where(
      and(
        eq(clientDocuments.clientId, s.id),
        eq(clientDocuments.isActive, true),
      ),
    )
    .orderBy(desc(clientDocuments.updatedAt));
  return { documents: await project(db, docs) };
}

export async function updateLibraryDoc(
  db: Tx,
  s: SessionUser,
  id: string,
  patch: { label?: string; kind?: string | null; expiresOn?: string | null },
) {
  const d = await ownDoc(db, s, id, true);
  const set: Partial<Doc> = { updatedAt: new Date().toISOString() };
  if (patch.label !== undefined)
    set.label = cleanLabel(patch.label, d.originalFilename);
  if (patch.kind !== undefined) set.kind = cleanKind(patch.kind);
  await db
    .update(clientDocuments)
    .set(set)
    .where(eq(clientDocuments.documentId, id));
  if (patch.expiresOn !== undefined) {
    if (patch.expiresOn)
      await db
        .insert(clientDocumentExpiry)
        .values({ documentId: id, expiresOn: patch.expiresOn })
        .onConflictDoUpdate({
          target: clientDocumentExpiry.documentId,
          set: { expiresOn: patch.expiresOn },
        });
    else
      await db
        .delete(clientDocumentExpiry)
        .where(eq(clientDocumentExpiry.documentId, id));
  }
  return oneDoc(db, s, id);
}

/** Soft delete; refused while an open request still uses the document (its objects are cleaned up later). */
export async function deleteLibraryDoc(db: Tx, s: SessionUser, id: string) {
  await ownDoc(db, s, id, true);
  const used = await db
    .select({ status: applications.status })
    .from(applicationDocuments)
    .innerJoin(
      applications,
      eq(applications.applicationId, applicationDocuments.applicationId),
    )
    .where(
      and(
        eq(applicationDocuments.vaultDocumentId, id),
        eq(applicationDocuments.isActive, true),
        isNull(applicationDocuments.removedAt),
      ),
    );
  if (used.some((u) => OPEN_CASE(u.status)))
    throw new AppError(409, "in_use", "Attached to an open request.");
  const ts = new Date().toISOString();
  await db
    .update(clientDocuments)
    .set({ isActive: false, deletedAt: ts, updatedAt: ts })
    .where(eq(clientDocuments.documentId, id));
  return { deleted: true };
}

/** Share a saved document into one of the client's open requests (Python reference_vault_document). */
export async function attachToCase(
  db: Tx,
  notify: NotificationsService,
  s: SessionUser,
  id: string,
  code: string,
  requirementKey?: string,
) {
  const d = await ownDoc(db, s, id);
  const a = await appByCode(db, code, { forUpdate: true });
  ownOr404(s, a, (x) => x.clientId, "Application");
  if (!OPEN_CASE(a.status))
    throw new AppError(422, "validation", "This application is closed.");
  const key = (requirementKey || d.kind || "other").slice(0, 128);
  const [{ v }] = await db
    .select({ v: max(applicationDocuments.version) })
    .from(applicationDocuments)
    .where(
      and(
        eq(applicationDocuments.applicationId, a.applicationId),
        eq(applicationDocuments.requirementKey, key),
      ),
    );
  const adId = generateId("doc");
  await db
    .update(applicationDocuments)
    .set({ isActive: false, replacedBy: null })
    .where(
      and(
        eq(applicationDocuments.applicationId, a.applicationId),
        eq(applicationDocuments.requirementKey, key),
        eq(applicationDocuments.isActive, true),
      ),
    );
  await db.insert(applicationDocuments).values({
    documentId: adId,
    applicationId: a.applicationId,
    requirementKey: key,
    originalFilename: d.originalFilename,
    storagePath: d.storagePath,
    mimeType: d.mimeType,
    fileSizeBytes: d.fileSizeBytes,
    uploadedBy: s.id,
    uploadedByRole: "client",
    version: (v ?? 0) + 1,
    qcStatus: "pending",
    isActive: true,
    createdAt: new Date().toISOString(),
    vaultDocumentId: d.documentId,
    vaultVersion: d.currentVersion,
  });
  if (a.assignedAgentId)
    await notify.notify(db, {
      userId: a.assignedAgentId,
      kind: "document",
      title: `Document shared on ${a.code}`,
      body: d.label ?? d.originalFilename,
      link: `/agent/case/${a.code}`,
    });
  return oneDoc(db, s, id);
}

type DlvFile = { id: string; title: string; mime: string; sizeBytes: number; version: number; issuedAt: string; issuer: string | null; signatureRequired: boolean; signedAt: string | null };
export type DlvGroup = {
  code: string; service: string; state: "in_progress" | "ready" | "locked"; step: number; totalSteps: number;
  expectedAt?: string | null; balance?: number; currency?: string; review?: "accepted" | "changes_requested" | null; rating?: number; files: DlvFile[];
};

// ── deliverables ──────────────────────────────────────────────────────────────────────────────
const IN_FLIGHT = new Set([
  "in_progress",
  "awaiting_internal_review",
  "awaiting_external_institution",
  "completed_delivered",
]);

export async function myDeliverables(db: Tx, s: SessionUser) {
  const apps = await db
    .select()
    .from(applications)
    .where(eq(applications.clientId, s.id))
    .orderBy(desc(applications.submittedAt));
  if (!apps.length) return { requests: [] };
  const ids = apps.map((a) => a.applicationId);
  const [files, fb, paid] = await Promise.all([
    db
      .select()
      .from(deliverables)
      .where(
        and(
          inArray(deliverables.applicationId, ids),
          isNotNull(deliverables.releasedAt),
        ),
      )
      .orderBy(asc(deliverables.createdAt)),
    db
      .select()
      .from(applicationFeedback)
      .where(inArray(applicationFeedback.applicationId, ids)),
    paidRows(
      db,
      apps.map((a) => a.code),
    ),
  ]);
  // DLV-10: latest signature per file.
  const sigs = new Map(files.length ? (await db.select({ id: deliverableSignatures.deliverableId, at: deliverableSignatures.signedAt }).from(deliverableSignatures)
    .where(inArray(deliverableSignatures.deliverableId, files.map((f) => f.id)))).map((r) => [r.id, r.at]) : []);
  const requests = apps.flatMap((a): DlvGroup[] => {
    const st = normalizeStatus(a.status);
    const mine = files.filter((f) => f.applicationId === a.applicationId);
    if (!mine.length && !IN_FLIGHT.has(st)) return [];
    const { balance } = money(
      a,
      (paid.get(a.code) ?? []).reduce((x, r) => x + r.amount, 0),
    );
    const f = fb.find((x) => x.applicationId === a.applicationId);
    const base = {
      code: a.code,
      service: a.serviceName,
      step: Math.min(stepOf(st), STEPS.length),
      totalSteps: STEPS.length,
    };
    const out = mine.map((d) => ({
      id: d.id,
      title: d.title,
      mime: d.mimeType,
      sizeBytes: d.fileSizeBytes,
      version: d.version,
      issuedAt: d.releasedAt!,
      issuer: d.issuer,
      signatureRequired: d.signatureRequired,
      signedAt: sigs.get(d.id) ?? null,
    }));
    if (!mine.length)
      return [
        {
          ...base,
          state: "in_progress" as const,
          expectedAt: a.dueAt ?? a.slaDeadline,
          files: [],
        },
      ];
    if (balance > 0)
      return [
        {
          ...base,
          state: "locked" as const,
          balance,
          currency: "RWF",
          files: out,
        },
      ];
    return [
      {
        ...base,
        state: "ready" as const,
        review: (f?.review ?? null) as "accepted" | "changes_requested" | null,
        ...(f?.rating ? { rating: f.rating } : {}),
        files: out,
      },
    ];
  });
  // Ready to download first, then locked by a balance, then still in progress (stable: newest first within each).
  const rank = { ready: 0, locked: 1, in_progress: 2 } as const;
  return { requests: requests.sort((x, y) => rank[x.state] - rank[y.state]) };
}

/** A released deliverable the session may open; locked by an unpaid balance for downloads. */
export async function readableDeliverable(
  db: Tx,
  s: SessionUser,
  id: string,
  opts: { download: boolean },
) {
  const [d] = await db
    .select()
    .from(deliverables)
    .where(eq(deliverables.id, id));
  const a = d
    ? (
        await db
          .select()
          .from(applications)
          .where(eq(applications.applicationId, d.applicationId))
      )[0]
    : undefined;
  if (!d || !a) throw new AppError(404, "not_found", "Not found.");
  assertCanRead(s, a);
  const client = a.clientId === s.id;
  if (client && !d.releasedAt) throw new AppError(403, "forbidden", "Not released.");
  if (client && opts.download) {
    const [u] = await db.select({ v: users.isEmailVerified }).from(users).where(eq(users.userId, s.id));
    if (!u?.v)
      throw new AppError(403, "unverified", "Verify your account first.");
    const { balance } = money(
      a,
      ((await paidRows(db, [a.code])).get(a.code) ?? []).reduce(
        (x, r) => x + r.amount,
        0,
      ),
    );
    if (balance > 0) throw new AppError(403, "forbidden", "Not released.");
  }
  return { d, a };
}

/** Client accepts the files or asks for changes; the assignee hears about it. */
export async function deliverableReceipt(
  db: Tx,
  notify: NotificationsService,
  s: SessionUser,
  id: string,
  good: boolean,
  note?: string | null,
) {
  const { a } = await readableDeliverable(db, s, id, { download: false });
  ownOr404(s, a, (x) => x.clientId, "Deliverable");
  await recordFeedback(db, a.applicationId, {
    review: good ? "accepted" : "changes_requested",
    reviewNote: note ?? null,
    reviewedAt: new Date().toISOString(),
  });
  if (a.assignedAgentId)
    await notify.notify(db, {
      userId: a.assignedAgentId,
      kind: "document",
      title: good
        ? `${a.code}: client accepted the deliverables`
        : `${a.code}: client asked for changes`,
      body: note ?? null,
      link: `/agent/case/${a.code}`,
    });
  // DLV-08: a not-OK receipt opens a complaint (FBK) on the case, unless one is already open.
  if (!good) {
    const [open] = await db.select({ ref: supportTickets.ref }).from(supportTickets)
      .where(and(eq(supportTickets.userId, s.id), eq(supportTickets.caseRef, a.code), eq(supportTickets.type, "complaint"), sql`${supportTickets.status} <> 'resolved'`));
    if (open) return { recorded: true, ticketRef: open.ref };
    const t = await createTicket(db, s, `Changes requested on ${a.code}`, note?.trim() || "The delivered files need changes.", { type: "complaint", caseRef: a.code });
    return { recorded: true, ticketRef: t.ref };
  }
  return { recorded: true };
}

export async function rateCase(
  db: Tx,
  s: SessionUser,
  code: string,
  stars: number,
  extra: { tags?: string[]; comment?: string } = {},
) {
  const a = await appByCode(db, code);
  ownOr404(s, a, (x) => x.clientId, "Application");
  const [{ n }] = await db
    .select({ n: count() })
    .from(deliverables)
    .where(
      and(
        eq(deliverables.applicationId, a.applicationId),
        isNotNull(deliverables.releasedAt),
      ),
    );
  if (!n)
    throw new AppError(409, "conflict", "Nothing has been delivered yet.");
  // F-FBK-01: a rating can be changed for 7 days after it was first given.
  const [prev] = await db.select({ at: applicationFeedback.ratedAt, rating: applicationFeedback.rating })
    .from(applicationFeedback).where(eq(applicationFeedback.applicationId, a.applicationId));
  if (prev?.rating && prev.at && Date.now() - Date.parse(prev.at) > 7 * 86_400_000)
    throw new AppError(409, "rating_locked", "Ratings can be changed for 7 days only.");
  await recordFeedback(db, a.applicationId, {
    rating: stars,
    ratingTags: extra.tags ?? null,
    ratingComment: extra.comment || null,
    ratedAt: (prev?.rating && prev.at) || new Date().toISOString(), // the edit window runs from the first rating
  });
  return { recorded: true };
}


// ── F-FBK-02 NPS ──────────────────────────────────────────────────────────────────────────────────
const NPS_REPEAT_DAYS = 180;
/** Due after a 2nd delivered case or 90 days after the first, and not answered in the last 180 days. */
export async function npsDue(db: Tx, s: SessionUser) {
  const [d] = await db.execute<{ n: number; first: string | null }>(sql`
    select count(*)::int n, min(completed_at)::text first from applications
    where client_id = ${s.id} and status = 'completed_delivered'`);
  const [last] = await db.select({ at: npsResponses.createdAt }).from(npsResponses)
    .where(eq(npsResponses.clientId, s.id)).orderBy(desc(npsResponses.createdAt)).limit(1);
  const eligible = d.n >= 2 || (!!d.first && Date.now() - Date.parse(d.first) >= 90 * 86_400_000);
  const recent = !!last && Date.now() - Date.parse(last.at) < NPS_REPEAT_DAYS * 86_400_000;
  return { due: eligible && !recent };
}
export async function answerNps(db: Tx, s: SessionUser, score: number, comment?: string) {
  if (!(await npsDue(db, s)).due) throw new AppError(409, "conflict", "No survey is open right now.");
  await db.insert(npsResponses).values({ id: `nps_${randomUUID()}`, clientId: s.id, score, comment: comment?.trim() || null, createdAt: new Date().toISOString() });
  return { recorded: true };
}

// ── finalize (worker, runAsSystem) ────────────────────────────────────────────────────────────
/** The stored object of an upload, or null when the row is gone/already handled. */
export async function finalizeTarget(db: Tx, j: FinalizeJob) {
  if (j.kind === "chat") {
    const [x] = await db.select().from(messageAttachments).where(eq(messageAttachments.id, j.id));
    return x && x.scanStatus === "pending" ? { key: x.storagePath, mime: x.mime } : null;
  }
  if (j.kind === "case") {
    const [d] = await db.select().from(applicationDocuments).where(eq(applicationDocuments.documentId, j.id));
    return d && !d.isActive && !d.removedAt && !d.replacedBy ? { key: d.storagePath, mime: d.mimeType } : null;
  }
  const [v] = await db
    .select()
    .from(clientDocumentVersions)
    .where(and(eq(clientDocumentVersions.documentId, j.id), eq(clientDocumentVersions.version, j.version)));
  return v ? { key: v.storagePath, mime: v.mimeType } : null;
}

/** Upload never arrived or was not what it claimed: drop the row (the object is deleted by the caller). */
export async function rejectUpload(db: Tx, j: FinalizeJob) {
  const ts = new Date().toISOString();
  // A chat attachment has no "removed" state: `infected` is the status downloads already refuse.
  if (j.kind === "chat") await db.update(messageAttachments).set({ scanStatus: "infected" }).where(eq(messageAttachments.id, j.id));
  else if (j.kind === "case")
    await db.update(applicationDocuments).set({ removedAt: ts, qcStatus: "rejected" }).where(eq(applicationDocuments.documentId, j.id));
  else {
    // Only the bad version is rejected (downloads refuse `infected`); a first upload has nothing to fall back to.
    await db.update(clientDocumentVersions).set({ scanStatus: "infected" })
      .where(and(eq(clientDocumentVersions.documentId, j.id), eq(clientDocumentVersions.version, j.version)));
    if (j.version === 1)
      await db
        .update(clientDocuments)
        .set({ isActive: false, deletedAt: ts, updatedAt: ts })
        .where(and(eq(clientDocuments.documentId, j.id), eq(clientDocuments.currentVersion, 1)));
  }
}

/** A verified case upload becomes the active version of its requirement and fulfils the open request. */
export async function activateCaseUpload(db: Tx, notify: NotificationsService, j: Extract<FinalizeJob, { kind: "case" }>) {
  const [d] = await db.select().from(applicationDocuments).where(eq(applicationDocuments.documentId, j.id));
  const [a] = await db.select().from(applications).where(eq(applications.applicationId, d.applicationId)).for("update");
  await db
    .update(applicationDocuments)
    .set({ isActive: false, replacedBy: d.documentId })
    .where(
      and(
        eq(applicationDocuments.applicationId, d.applicationId),
        eq(applicationDocuments.requirementKey, d.requirementKey),
        eq(applicationDocuments.isActive, true),
      ),
    );
  await db.update(applicationDocuments).set({ isActive: true }).where(eq(applicationDocuments.documentId, d.documentId));
  if (j.needId)
    await db
      .update(documentRequests)
      .set({ fulfilledAt: d.createdAt, fulfilledByDocumentId: d.documentId })
      .where(and(eq(documentRequests.id, j.needId), eq(documentRequests.applicationId, d.applicationId), isNull(documentRequests.fulfilledAt)));
  if (d.uploadedByRole === "client" && a.assignedAgentId)
    await notify.notify(db, {
      userId: a.assignedAgentId,
      kind: "document",
      title: `New document on ${a.code}`,
      body: d.originalFilename,
      link: `/agent/case/${a.code}`,
    });
}

/** Daily: delete objects of versions whose document was deleted more than the grace period ago and nothing references. */
export async function orphanVersions(db: Tx, now = new Date()) {
  const older = new Date(now.getTime() - ORPHAN_GRACE_DAYS * 864e5).toISOString();
  return db
    .select({ id: clientDocumentVersions.versionId, path: clientDocumentVersions.storagePath })
    .from(clientDocumentVersions)
    .innerJoin(clientDocuments, eq(clientDocuments.documentId, clientDocumentVersions.documentId))
    .where(
      and(
        eq(clientDocuments.isActive, false),
        lt(clientDocuments.deletedAt, older),
        isNull(clientDocumentVersions.orphanedAt),
        // a case still pointing at the object keeps it
        sql`not exists (select 1 from ${applicationDocuments} ad where ad.storage_path = ${clientDocumentVersions.storagePath} and ad.removed_at is null)`,
      ),
    );
}
export const markOrphaned = (db: Tx, id: string, now = new Date()) =>
  db.update(clientDocumentVersions).set({ orphanedAt: now.toISOString() }).where(eq(clientDocumentVersions.versionId, id));

// ── service ───────────────────────────────────────────────────────────────────────────────────
@Injectable()
export class DocumentsService {
  constructor(
    private readonly tx: TxService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly storage: StorageService,
    private readonly notifications: NotificationsService,
    private readonly apps: ApplicationsService,
  ) {}

  private finalizeLater(db: Tx, j: FinalizeJob) {
    return this.outbox.add(db, { type: "documents.finalize", payload: j, runAt: new Date(Date.now() + FINALIZE_DELAY_MS) });
  }
  /**
   * Client confirms its presigned PUT: finalize now instead of after the PUT window. The delayed outbox row stays as the
   * fallback (finalize is idempotent: a handled case/chat upload reads as gone, a library re-run re-checks the same object).
   */
  complete(s: SessionUser, id: string) {
    return this.tx.run(async (db) => {
      const [own] = await Promise.all([
        db.select({ key: clientDocuments.storagePath }).from(clientDocuments).where(and(eq(clientDocuments.documentId, id), eq(clientDocuments.clientId, s.id))),
        db.select({ key: applicationDocuments.storagePath }).from(applicationDocuments).where(and(eq(applicationDocuments.documentId, id), eq(applicationDocuments.uploadedBy, s.id))),
        db.select({ key: messageAttachments.storagePath }).from(messageAttachments).where(and(eq(messageAttachments.id, id), eq(messageAttachments.uploadedBy, s.id))),
      ]).then((r) => r.flat());
      if (!own) throw notFound("Upload");
      const [job] = await db
        .select({ payload: outbox.payload })
        .from(outbox)
        .where(and(eq(outbox.type, "documents.finalize"), sql`${outbox.payload}->>'id' = ${id}`, isNull(outbox.sentAt)));
      if (!job) return { id, status: "done" as const }; // fallback already ran
      // Never finalize early on a missing object: that would reject an upload that is still in flight.
      if (!(await this.storage.head(own.key))) throw new AppError(409, "upload_missing", "The file has not finished uploading.");
      // Pull the pending delayed row forward instead of queueing a second finalize.
      await db.update(outbox).set({ runAt: sql`now()` })
        .where(and(eq(outbox.type, "documents.finalize"), sql`${outbox.payload}->>'id' = ${id}`, isNull(outbox.sentAt)));
      return { id, status: "finalizing" as const };
    });
  }
  private presign(userId: string, purpose: string, f: Upload) {
    return this.storage.presignPut({ key: StorageService.key(userId, purpose), contentType: f.mime, size: f.size, purpose });
  }

  // ---- library
  list(s: SessionUser) {
    return this.tx.run((db) => listLibrary(db, s));
  }

  upload(s: SessionUser, f: Upload & { label?: string | null; kind?: string | null; sha256?: string | null; allowDuplicate?: boolean; organizationId?: string | null }) {
    return this.tx.run(async (db) => {
      if (f.organizationId) {
        const [m] = (await db.execute(sql`select role from organization_members where organization_id = ${f.organizationId} and user_id = ${s.id} and status = 'active'`)) as unknown as { role: string }[]; // cast: execute() rows are untyped
        if (!m) throw new AppError(404, "not_found", "Not found.");
        if (m.role === "viewer") throw new AppError(403, "forbidden", "Your role in this company can't add documents.");
      }
      const [{ n }] = await db
        .select({ n: count() })
        .from(clientDocuments)
        .where(and(eq(clientDocuments.clientId, s.id), eq(clientDocuments.isActive, true)));
      if (n >= MAX_LIBRARY_DOCUMENTS)
        throw new AppError(422, "validation", `You have reached the limit of ${MAX_LIBRARY_DOCUMENTS} saved documents. Delete one you no longer need.`);
      const name = sanitizeFilename(f.filename);
      const label = cleanLabel(f.label, name);
      const kind = cleanKind(f.kind);
      // shortcut: the hash is client-declared (bytes never reach the API); recompute in documents.finalize if dedup must be trusted.
      const sha = f.sha256 ?? null;
      if (sha && !f.allowDuplicate) {
        const [dup] = await db
          .select({ id: clientDocuments.documentId })
          .from(clientDocuments)
          .where(and(eq(clientDocuments.clientId, s.id), eq(clientDocuments.isActive, true), eq(clientDocuments.contentSha256, sha)));
        if (dup)
          throw new AppError(409, "duplicate", "This file is already saved in your documents.", undefined, { existingDocumentId: dup.id });
      }
      const id = generateId("vdoc");
      const upload = await this.presign(s.id, "vault", f);
      const ts = new Date().toISOString();
      const file = { storagePath: upload.key, originalFilename: name, mimeType: f.mime, fileSizeBytes: f.size, contentSha256: sha };
      await db.insert(clientDocuments).values({ documentId: id, clientId: s.id, organizationId: f.organizationId ?? null, ...file, label, kind, isActive: true, createdAt: ts, updatedAt: ts, currentVersion: 1 });
      await db.insert(clientDocumentVersions).values({ versionId: generateId("cvd"), documentId: id, version: 1, ...file, contentSha256: sha ?? "", uploadedAt: ts }); // "" = not declared
      await this.finalizeLater(db, { kind: "library", id, version: 1 });
      await this.audit.record(db, { action: "document.vault_upload", entity: "document", entityId: id, after: { name, mime: f.mime, size: f.size } });
      return { ...(await oneDoc(db, s, id)), upload };
    });
  }

  update(s: SessionUser, id: string, patch: { label?: string; kind?: string | null; expiresOn?: string | null }) {
    return this.tx.run(async (db) => {
      const r = await updateLibraryDoc(db, s, id, patch);
      await this.audit.record(db, { action: "document.vault_update", entity: "document", entityId: id, after: patch });
      return r;
    });
  }

  /** DLV-06: redeem a single-use link (the signed-in client it was sent to only); returns the file URL. */
  redeemToken(s: SessionUser, token: string) {
    return this.tx.run(async (db) => {
      const hash = createHash("sha256").update(token).digest("hex");
      const [t] = await db.update(downloadTokens).set({ usedAt: new Date().toISOString() })
        .where(and(eq(downloadTokens.tokenHash, hash), eq(downloadTokens.userId, s.id), isNull(downloadTokens.usedAt), sql`${downloadTokens.expiresAt} > now()`))
        .returning({ id: downloadTokens.deliverableId });
      if (!t) throw new AppError(410, "expired", "This link was already used or has expired. Open the request to download again.");
      const { d } = await readableDeliverable(db, s, t.id, { download: true });
      await this.audit.record(db, { action: "deliverable.downloaded", entity: "deliverable", entityId: t.id, after: { via: "link" } });
      return { url: await this.storage.presignGet(d.storagePath, d.title) };
    });
  }

  /** DOC-05: make an older version current again (a new version pointing at the same stored object). */
  restoreVersion(s: SessionUser, id: string, version: number) {
    return this.tx.run(async (db) => {
      const d = await ownDocForUpdate(db, s, id);
      const [v] = await db.select().from(clientDocumentVersions).where(and(eq(clientDocumentVersions.documentId, id), eq(clientDocumentVersions.version, version)));
      if (!v) throw new AppError(404, "not_found", "Not found.");
      if (v.scanStatus === "infected") throw new AppError(409, "infected", "That version failed the virus scan.");
      if (version === d.currentVersion) throw new AppError(409, "conflict", "That is already the current version.");
      const next = d.currentVersion + 1, ts = new Date().toISOString();
      await db.insert(clientDocumentVersions).values({ ...v, versionId: generateId("cvd"), version: next, uploadedAt: ts, orphanedAt: null });
      await db.update(clientDocuments).set({ currentVersion: next, storagePath: v.storagePath, originalFilename: v.originalFilename, mimeType: v.mimeType, fileSizeBytes: v.fileSizeBytes, contentSha256: v.contentSha256 || null, updatedAt: ts })
        .where(eq(clientDocuments.documentId, id));
      await this.audit.record(db, { action: "document.version_restored", entity: "document", entityId: id, before: { version: d.currentVersion }, after: { version: next, from: version } });
      return oneDoc(db, s, id);
    });
  }

  /** DLV-09: keep a released deliverable in the client's library (its own copy, so library deletes never touch the deliverable). */
  saveDeliverableToLibrary(s: SessionUser, id: string) {
    return this.tx.run(async (db) => {
      const { d, a } = await readableDeliverable(db, s, id, { download: true });
      ownOr404(s, a, (x) => x.clientId, "Deliverable");
      const docId = generateId("vdoc"), ts = new Date().toISOString();
      const key = `u/${s.id}/vault/${docId}-${d.title.replace(/[^\w.-]+/g, "_").slice(0, 80)}`;
      await this.storage.copy(d.storagePath, key);
      const file = { storagePath: key, originalFilename: d.title, mimeType: d.mimeType, fileSizeBytes: d.fileSizeBytes };
      await db.insert(clientDocuments).values({ documentId: docId, clientId: s.id, ...file, label: d.title.slice(0, 120), kind: "deliverable", isActive: true, createdAt: ts, updatedAt: ts, currentVersion: 1 });
      await db.insert(clientDocumentVersions).values({ versionId: generateId("cvd"), documentId: docId, version: 1, ...file, contentSha256: "", scanStatus: "clean", uploadedAt: ts }); // released deliverables were scanned at upload
      await this.audit.record(db, { action: "deliverable.saved_to_library", entity: "document", entityId: docId, after: { deliverableId: id } });
      return oneDoc(db, s, docId);
    });
  }

  delete(s: SessionUser, id: string) {
    return this.tx.run(async (db) => {
      const r = await deleteLibraryDoc(db, s, id);
      await this.audit.record(db, { action: "document.vault_delete", entity: "document", entityId: id });
      return r;
    });
  }

  attach(s: SessionUser, id: string, code: string, requirementKey?: string) {
    return this.tx.run(async (db) => {
      const r = await attachToCase(db, this.notifications, s, id, code, requirementKey);
      await this.audit.record(db, { action: "document.vault_share", entity: "document", entityId: id, after: { code } });
      return r;
    });
  }

  /** Owner only (inactive/deleted documents read as 404). */
  libraryUrl(s: SessionUser, id: string) {
    return this.tx.run(async (db) => {
      const d = await ownDoc(db, s, id);
      const [v] = await db.select({ scan: clientDocumentVersions.scanStatus }).from(clientDocumentVersions)
        .where(and(eq(clientDocumentVersions.documentId, id), eq(clientDocumentVersions.storagePath, d.storagePath)));
      if (v?.scan === "infected") throw new AppError(410, "quarantined", "This file was quarantined.");
      if (v?.scan !== "clean") throw new AppError(409, "scanning", "This file is still being checked.");
      return this.storage.presignGet(d.storagePath, d.originalFilename);
    });
  }

  // ---- case uploads (POST /api/applications/:code/documents)
  uploadCase(s: SessionUser, code: string, f: Upload & { need_id?: string | null; requirement_key?: string | null }) {
    return this.tx.run(async (db) => {
      const a = await this.apps.getForActor(db, s, code, { forUpdate: true });
      authorize(s, "doc.case.upload", { ownerId: a.clientId, assigneeIds: [a.assignedAgentId ?? ""] }, "Application");
      if (isTerminal(normalizeStatus(a.status))) throw new AppError(422, "validation", "This application is closed.");
      // REQ-18: no client uploads while held, nor 30 days after delivery (the case is closed for new material).
      if (a.clientId === s.id && normalizeStatus(a.status) === "on_hold")
        throw new AppError(409, "on_hold", "This request is on hold. Your agent will tell you when to send documents.");
      if (a.clientId === s.id && a.completedAt && Date.now() - Date.parse(a.completedAt) > 30 * 864e5)
        throw new AppError(409, "closed", "This request was completed more than 30 days ago. Start a new request instead.");
      const [need] = f.need_id
        ? await db
            .select()
            .from(documentRequests)
            .where(and(eq(documentRequests.id, f.need_id), eq(documentRequests.applicationId, a.applicationId)))
        : [];
      const reqKey = (f.requirement_key || need?.requirementKey || "other").slice(0, 128);
      const [{ v }] = await db
        .select({ v: max(applicationDocuments.version) })
        .from(applicationDocuments)
        .where(and(eq(applicationDocuments.applicationId, a.applicationId), eq(applicationDocuments.requirementKey, reqKey)));
      const id = generateId("doc");
      const upload = await this.presign(s.id, "case", f);
      const client = s.id === a.clientId;
      // Inactive until documents.finalize has checked the stored object; then it replaces the previous version.
      await db.insert(applicationDocuments).values({
        documentId: id,
        applicationId: a.applicationId,
        requirementKey: reqKey,
        originalFilename: sanitizeFilename(f.filename),
        storagePath: upload.key,
        mimeType: f.mime,
        fileSizeBytes: f.size,
        uploadedBy: s.id,
        uploadedByRole: client ? "client" : (s.roles[0] ?? "client"),
        version: (v ?? 0) + 1,
        qcStatus: "pending",
        isActive: false,
        createdAt: new Date().toISOString(),
      });
      await this.finalizeLater(db, { kind: "case", id, needId: need && !need.fulfilledAt ? need.id : null });
      await this.audit.record(db, { action: "application.document.uploaded", entity: "application", entityId: id, after: { code: a.code } });
      return { id, code: a.code, uploaded: false, status: "uploading", upload };
    });
  }

  // ---- deliverables
  deliverables(s: SessionUser) {
    return this.tx.run((db) => myDeliverables(db, s));
  }

  /** Access check on every open; downloads (not previews) are locked by an unpaid balance and audited. */
  deliverableUrl(s: SessionUser, id: string, download: boolean) {
    return this.tx.run(async (db) => {
      const { d } = await readableDeliverable(db, s, id, { download });
      if (download) await this.audit.record(db, { action: "deliverable.downloaded", entity: "deliverable", entityId: id });
      return this.storage.presignGet(d.storagePath, download ? d.title : undefined);
    });
  }

  /** DLV-10: staff (case readers, assignee or SM) ask the client to sign a deliverable. */
  requireSignature(s: SessionUser, id: string, on: boolean) {
    return this.tx.run(async (db) => {
      const { a } = await readableDeliverable(db, s, id, { download: false });
      if (a.clientId === s.id) throw forbidden();
      await db.update(deliverables).set({ signatureRequired: on }).where(eq(deliverables.id, id));
      if (on && a.clientId)
        await this.notifications.notify(db, { userId: a.clientId, kind: "deliverable", title: `${a.code}: a document needs your signature`, link: "/documents?tab=deliverables", channels: ["email"] });
      await this.audit.record(db, { action: on ? "deliverable.signature_requested" : "deliverable.signature_cancelled", entity: "deliverable", entityId: id });
      return { signatureRequired: on };
    });
  }

  /**
   * DLV-10 built-in signing: hashes the exact stored bytes, seals the record (domain/documents/signature) and keeps
   * IP + user agent. A configured external provider (core/esign) also receives it; none is configured today.
   */
  sign(s: SessionUser, id: string, b: { method: "typed" | "drawn"; name: string; image?: string | null; agree: true }, meta: { ip: string | null; ua: string | null }) {
    return this.tx.run(async (db) => {
      const { d, a } = await readableDeliverable(db, s, id, { download: true });
      if (a.clientId !== s.id) throw forbidden();
      if (!d.signatureRequired) throw new AppError(409, "not_requested", "This file does not need a signature.");
      if (b.method === "drawn" && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(b.image ?? "")) throw new AppError(422, "validation", "Draw your signature.", { image: "Draw your signature." });
      const fileSha256 = sha256(Buffer.concat(await (await this.storage.getStream(d.storagePath)).toArray()));
      const rec: SigningRecord = { deliverableId: id, fileSha256, signerId: s.id, signerName: b.name.trim(), method: b.method, imageSha256: b.image ? sha256(b.image) : null, signedAt: new Date().toISOString() };
      const hash = auditHash(rec);
      const provider = eSignProvider();
      const ext = provider ? await provider.send({ deliverableId: id, signerName: rec.signerName, signerEmail: null, fileUrl: await this.storage.presignGet(d.storagePath) }) : null;
      await db.insert(deliverableSignatures).values({ id: generateId("sig"), deliverableId: id, userId: s.id, method: b.method, signerName: rec.signerName, imagePng: b.image ?? null,
        fileSha256, auditHash: hash, ip: meta.ip, userAgent: meta.ua?.slice(0, 255) ?? null, provider: provider?.name ?? null, providerRef: ext?.ref ?? null, signedAt: rec.signedAt });
      if (a.assignedAgentId) await this.notifications.notify(db, { userId: a.assignedAgentId, kind: "document", title: `${a.code}: client signed ${d.title}`, link: `/agent/case/${a.code}` });
      await this.audit.record(db, { action: "deliverable.signed", entity: "deliverable", entityId: id, after: { method: b.method, fileSha256, auditHash: hash } });
      return { signedAt: rec.signedAt, auditHash: hash, fileSha256 };
    });
  }

  /** DOC-09: the SM queue of documents past retention. */
  retentionQueue(state: "open" | "decided") {
    return this.tx.run(async (db) => ({
      items: await db.select().from(documentRetentionFlags)
        .where(state === "open" ? isNull(documentRetentionFlags.decision) : isNotNull(documentRetentionFlags.decision))
        .orderBy(asc(documentRetentionFlags.flaggedAt)).limit(500),
    }));
  }

  /** DOC-09: SM decision. Shred = delete the stored object, tombstone the metadata (path → shredded/<id>), audited. */
  async retentionDecision(s: SessionUser, id: string, b: { decision: "shred" | "keep"; reason?: string }) {
    const flag = await this.tx.run(async (db) => {
      const [f] = await db.update(documentRetentionFlags).set({ decision: b.decision, decidedBy: s.id, decidedAt: new Date().toISOString(), reason: b.reason ?? null })
        .where(and(eq(documentRetentionFlags.id, id), isNull(documentRetentionFlags.decision))).returning();
      if (!f) throw new AppError(409, "conflict", "Already decided.");
      await this.audit.record(db, { action: `document.retention_${b.decision}`, entity: "document", entityId: f.sourceId, reason: b.reason, after: { class: f.retentionClass, case: f.caseCode } });
      return f;
    });
    if (b.decision === "keep") return flag;
    await this.storage.delete(flag.storagePath);
    return this.tx.run(async (db) => {
      const tomb = `shredded/${flag.id}`, ts = new Date().toISOString();
      if (flag.source === "case") await db.update(applicationDocuments).set({ storagePath: tomb, removedAt: ts }).where(eq(applicationDocuments.documentId, flag.sourceId));
      else await db.update(deliverables).set({ storagePath: tomb }).where(eq(deliverables.id, flag.sourceId));
      const [f] = await db.update(documentRetentionFlags).set({ shreddedAt: ts, storagePath: tomb }).where(eq(documentRetentionFlags.id, id)).returning();
      return f;
    });
  }

  /**
   * DLV-05: while the client still owes money, the preview is a stamped low-resolution copy, never the file itself.
   * Images: 800 px + "PREVIEW — HEBUZA — {code}" overlay. PDFs: the first 3 pages stamped (pdf-lib); other types a notice page.
   */
  deliverablePreview(s: SessionUser, id: string): Promise<{ url: string } | { body: Buffer; type: string }> {
    return this.tx.run(async (db) => {
      const { d, a } = await readableDeliverable(db, s, id, { download: false });
      const owes = a.clientId === s.id && money(a, ((await paidRows(db, [a.code])).get(a.code) ?? []).reduce((x, r) => x + r.amount, 0)).balance > 0;
      if (!owes) return { url: await this.storage.presignGet(d.storagePath) };
      const stamp = `PREVIEW — HEBUZA — ${a.code}`;
      if (d.mimeType.startsWith("image/")) {
        const bytes = Buffer.concat(await (await this.storage.getStream(d.storagePath)).toArray());
        const img = sharp(bytes).rotate().resize(800, 800, { fit: "inside", withoutEnlargement: true });
        const { width = 800, height = 800 } = await img.clone().metadata();
        const w = Math.min(width, 800), h = Math.min(height, 800);
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><g transform="rotate(-30 ${w / 2} ${h / 2})" font-family="sans-serif" font-size="${Math.max(14, Math.round(w / 18))}" fill="rgba(200,0,0,0.35)" text-anchor="middle">${[0.3, 0.5, 0.7].map((y) => `<text x="${w / 2}" y="${Math.round(h * y)}">${stamp.replace(/&/g, "&amp;")}</text>`).join("")}</g></svg>`;
        return { body: await img.composite([{ input: Buffer.from(svg), gravity: "center" }]).jpeg({ quality: 60 }).toBuffer(), type: "image/jpeg" };
      }
      if (d.mimeType === "application/pdf") {
        const bytes = Buffer.concat(await (await this.storage.getStream(d.storagePath)).toArray());
        // First 3 pages, stamped; an encrypted/broken PDF falls back to the notice page.
        const out = await stampPdf(bytes, stamp, { maxPages: 3, opacity: 0.3 }).catch(() => null);
        if (out) return { body: Buffer.from(out), type: "application/pdf" };
      }
      return { body: Buffer.from(textPdf(stamp, [d.title, "", "This is a preview. The full file unlocks once the balance is paid."])), type: "application/pdf" };
    });
  }

  receipt(s: SessionUser, id: string, ok: boolean, note?: string | null) {
    return this.tx.run(async (db) => {
      const r = await deliverableReceipt(db, this.notifications, s, id, ok, note);
      await this.audit.record(db, { action: "deliverable.receipt", entity: "deliverable", entityId: id, after: { ok } });
      return r;
    });
  }

  rate(s: SessionUser, code: string, stars: number, extra?: { tags?: string[]; comment?: string }) {
    return this.tx.run((db) => rateCase(db, s, code, stars, extra));
  }
  npsDue(s: SessionUser) {
    return this.tx.run((db) => npsDue(db, s));
  }
  answerNps(s: SessionUser, score: number, comment?: string) {
    return this.tx.run((db) => answerNps(db, s, score, comment));
  }
}
