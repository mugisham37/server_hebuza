// DOC-09 retention policy per document class (spec documents §4): years after the anchor date (case closed, or upload).
export const RETENTION_YEARS = {
  id_document: 2, // client ID docs: 2 years after the client's last case closed
  case_document: 5, // case working documents: 5 years after the case closed
  deliverable: 10, // deliverables follow finance records (tax law)
  chat_attachment: 7,
} as const;
export type RetentionClass = keyof typeof RETENTION_YEARS;
const ID_KINDS = new Set(["national_id", "passport", "id_card", "residence_permit"]);

export const classOf = (source: "case" | "deliverable" | "chat", kind?: string | null): RetentionClass =>
  source === "deliverable" ? "deliverable" : source === "chat" ? "chat_attachment" : kind && ID_KINDS.has(kind) ? "id_document" : "case_document";

/** True once `anchor` + the class's years is in the past. */
export function expired(cls: RetentionClass, anchor: string, now = new Date()): boolean {
  const d = new Date(anchor);
  d.setUTCFullYear(d.getUTCFullYear() + RETENTION_YEARS[cls]);
  return d.getTime() <= now.getTime();
}
