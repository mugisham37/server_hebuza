// Dev/staging seed (port of .ref applications.seed, part 2): deliverables, the client document library with versions
// and expiry, and case documents. Run after seedApplications. `put` (optional) writes placeholder PDFs to storage.
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type * as schema from "../schema";
import { applicationDocuments, clientDocuments, clientDocumentVersions } from "../schema/schema";
import { clientDocumentExpiry, deliverables } from "../schema/schema-documents";
import { SEED_AGENT, SEED_CLIENT, day } from "./applications";

type Db = PgDatabase<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
const id = (code: string) => `app_seed_${code.slice(4).toLowerCase()}`;

export async function seedDocuments(root: Db, deps: { put?: (key: string, body: Uint8Array, type: string) => Promise<void> } = {}) {
  if (process.env.NODE_ENV === "production") throw new Error("refusing to seed production");
  // FORCE RLS binds the table owner too: the seed acts as `system` inside its own transaction.
  await root.transaction(async (db) => {
  await db.execute(sql`select set_config('app.roles', 'system', true)`);
  const files = [
    {
      id: "dl-4",
      app: "HBZ-2RT8LM",
      title: "certificate.pdf",
      issuer: "RRA",
      at: -29,
    },
    {
      id: "dl-1",
      app: "HBZ-K2M9QA",
      title: "Certificate of incorporation.pdf",
      issuer: "RDB",
      at: -0.3,
    },
    {
      id: "dl-2",
      app: "HBZ-K2M9QA",
      title: "TIN certificate.pdf",
      issuer: "RDB",
      at: -0.3,
    },
    {
      id: "dl-3",
      app: "HBZ-ACTN01",
      title: "Trademark filing receipt.pdf",
      issuer: null,
      at: -2,
    },
  ];
  await db
    .insert(deliverables)
    .values(
      files.map((f) => ({
        id: f.id,
        applicationId: id(f.app),
        title: f.title,
        storagePath: `seed/deliverables/${f.id}.pdf`,
        mimeType: "application/pdf",
        fileSizeBytes: PDF.length,
        version: 1,
        issuer: f.issuer,
        releasedAt: day(f.at),
        createdBy: SEED_AGENT,
        createdAt: day(f.at - 0.1),
      })),
    )
    .onConflictDoNothing();

  // Library: newest first is the ID card (expiry set, unused), as in handlers-c3.
  const lib = [
    {
      id: "doc-id",
      label: "National ID card",
      kind: "national_id",
      at: -1,
      v: 1,
      exp: day(900).slice(0, 10),
    },
    {
      id: "doc-rdb",
      label: "Business registration certificate",
      kind: "rdb_certificate",
      at: -5,
      v: 2,
      exp: day(20).slice(0, 10),
    },
    {
      id: "doc-tax",
      label: "Tax clearance certificate",
      kind: "other",
      at: -60,
      v: 1,
      exp: day(-3).slice(0, 10),
    },
  ];
  await db
    .insert(clientDocuments)
    .values(
      lib.map((d) => ({
        documentId: d.id,
        clientId: SEED_CLIENT,
        originalFilename: `${d.id}.pdf`,
        storagePath: `seed/clients/vault/${d.id}-v${d.v}.pdf`,
        mimeType: "application/pdf",
        fileSizeBytes: PDF.length,
        label: d.label,
        kind: d.kind,
        isActive: true,
        createdAt: day(d.at - 3),
        updatedAt: day(d.at),
        currentVersion: d.v,
        contentSha256: `seed-${d.id}`,
      })),
    )
    .onConflictDoNothing();
  await db
    .insert(clientDocumentVersions)
    .values(
      lib.flatMap((d) =>
        Array.from({ length: d.v }, (_, i) => ({
          versionId: `cvd_seed_${d.id}_${i + 1}`,
          documentId: d.id,
          version: i + 1,
          storagePath: `seed/clients/vault/${d.id}-v${i + 1}.pdf`,
          originalFilename: `${d.id}.pdf`,
          mimeType: "application/pdf",
          fileSizeBytes: PDF.length,
          contentSha256: `seed-${d.id}-${i + 1}`,
          uploadedAt: day(d.at - (d.v - 1 - i) * 3),
        })),
      ),
    )
    .onConflictDoNothing();
  await db
    .insert(clientDocumentExpiry)
    .values(lib.map((d) => ({ documentId: d.id, expiresOn: d.exp })))
    .onConflictDoNothing();

  // After the library: one case document points at a saved library document.
  await db
    .insert(applicationDocuments)
    .values([
      {
        documentId: "doc_seed_actn01_id",
        applicationId: id("HBZ-ACTN01"),
        requirementKey: "national_id",
        originalFilename: "id.pdf",
        storagePath: "seed/applications/wmvx19/id.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: PDF.length,
        uploadedBy: SEED_CLIENT,
        uploadedByRole: "client",
        version: 1,
        qcStatus: "accepted",
        isActive: true,
        createdAt: day(-7),
      },
      {
        documentId: "doc_seed_wmvx19_id",
        applicationId: id("HBZ-WMVX19"),
        requirementKey: "national_id",
        originalFilename: "id.pdf",
        storagePath: "seed/applications/wmvx19/id.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: PDF.length,
        uploadedBy: SEED_CLIENT,
        uploadedByRole: "client",
        version: 1,
        qcStatus: "accepted",
        isActive: true,
        createdAt: day(-6),
      },
      {
        documentId: "doc_seed_wmvx19_rdb",
        applicationId: id("HBZ-WMVX19"),
        requirementKey: "rdb_certificate",
        originalFilename: "doc-rdb.pdf",
        storagePath: "seed/clients/vault/rdb-v2.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: PDF.length,
        uploadedBy: SEED_CLIENT,
        uploadedByRole: "client",
        version: 1,
        qcStatus: "pending",
        isActive: true,
        createdAt: day(-5),
        vaultDocumentId: "doc-rdb",
        vaultVersion: 2,
      },
    ])
    .onConflictDoNothing();
  for (const p of [
    ...files.map((f) => `seed/deliverables/${f.id}.pdf`),
    ...lib.flatMap((d) =>
      Array.from(
        { length: d.v },
        (_, i) => `seed/clients/vault/${d.id}-v${i + 1}.pdf`,
      ),
    ),
    "seed/applications/wmvx19/id.pdf",
  ])
    // storage down: rows still seed, downloads 404
    await deps.put?.(p, PDF, "application/pdf").catch(() => undefined);
  });
}
