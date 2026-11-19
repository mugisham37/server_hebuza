// DLV-10: the signing record is sealed by a hash over its canonical form, so any later change is detectable.
import { createHash } from "node:crypto";

export type SigningRecord = { deliverableId: string; fileSha256: string; signerId: string; signerName: string; method: "typed" | "drawn"; imageSha256: string | null; signedAt: string };

export const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

/** Keys in fixed order → the same record always hashes the same. */
export const auditHash = (r: SigningRecord) =>
  sha256(JSON.stringify([r.deliverableId, r.fileSha256, r.signerId, r.signerName, r.method, r.imageSha256, r.signedAt]));

export const verifySignature = (r: SigningRecord, stored: string) => auditHash(r) === stored;
