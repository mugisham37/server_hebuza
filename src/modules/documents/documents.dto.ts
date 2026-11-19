// Zod schemas moved verbatim from the reference documents.routes.ts; upload bodies replace the multipart form.
import { z } from "zod";
import { dto } from "../../core/http/dto";
import { UploadIn, UploadOut } from "./documents.files";

const Version = z.object({ version: z.number().int(), originalFilename: z.string(), mimeType: z.string(), fileSizeBytes: z.number().int(), uploadedAt: z.string() });
const UsedIn = z.object({
  code: z.string(), serviceName: z.string(), applicationDocumentId: z.string(), requirementKey: z.string(), version: z.number().int(),
  isCurrent: z.boolean(), qcStatus: z.string(), status: z.string(),
});
export const LibDoc = z.object({
  documentId: z.string(), originalFilename: z.string(), label: z.string().nullable(), kind: z.string().nullable(), mimeType: z.string(),
  fileSizeBytes: z.number().int(), currentVersion: z.number().int(), createdAt: z.string(), updatedAt: z.string(), previewable: z.boolean(),
  usedIn: z.array(UsedIn), versions: z.array(Version), expiresOn: z.string().nullable(),
}).meta({ id: "ClientDocumentItemResponse" });
const DlvFile = z.object({ id: z.string(), title: z.string(), mime: z.string(), sizeBytes: z.number().int(), version: z.number().int(), issuedAt: z.string(), issuer: z.string().nullable() });
export const DlvGroup = z.object({
  code: z.string(), service: z.string(), state: z.enum(["in_progress", "ready", "locked"]), step: z.number().int(), totalSteps: z.number().int(),
  expectedAt: z.string().nullable().optional(), balance: z.number().int().optional(), currency: z.string().optional(),
  review: z.enum(["accepted", "changes_requested"]).nullable().optional(), rating: z.number().int().optional(), files: z.array(DlvFile),
});
export const Recorded = z.object({ recorded: z.boolean() });

export const LibListOut = z.object({ documents: z.array(LibDoc) });
export const LibUploadOut = LibDoc.extend({ upload: UploadOut });
export class LibUploadDto extends dto(UploadIn.extend({
  label: z.string().max(120).nullish(), kind: z.string().max(64).nullish(),
  /** Client-computed SHA-256 (hex) for duplicate detection; the server never sees the bytes. */
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullish(), allowDuplicate: z.boolean().optional(),
})) {}
export class LibPatchDto extends dto(z.object({ label: z.string().max(120).optional(), kind: z.string().max(64).nullish(), expiresOn: z.iso.date().nullish() })) {}
export class AttachDto extends dto(z.object({ code: z.string().min(1).max(32), requirementKey: z.string().max(128).optional() })) {}
export const Deleted = z.object({ deleted: z.boolean() });
export const DeliverablesOut = z.object({ requests: z.array(DlvGroup) });
export class ReceiptDto extends dto(z.object({ ok: z.boolean(), note: z.string().max(2000).nullish() })) {}
export class RatingDto extends dto(z.object({ stars: z.number().int().min(1, "Rating must be 1–5.").max(5, "Rating must be 1–5."), tags: z.array(z.string().trim().min(1).max(40)).max(10).optional(), comment: z.string().trim().max(1000).optional() })) {}
export class CaseUploadDto extends dto(UploadIn.extend({ need_id: z.string().max(64).nullish(), requirement_key: z.string().max(128).nullish() })) {}
export const CaseUploadOut = z.object({ id: z.string(), code: z.string(), uploaded: z.boolean(), status: z.string(), upload: UploadOut });
export class NpsDto extends dto(z.object({ score: z.number().int().min(0).max(10), comment: z.string().trim().max(1000).optional() })) {}
export const NpsDue = z.object({ due: z.boolean() }).meta({ id: "NpsDueResponse" });
