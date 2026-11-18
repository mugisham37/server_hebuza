// Dev/staging chat seed: the global reply templates from .ref ops.seed (personal agent templates and case threads are
// created on use: a case conversation is made the first time `cv-<CODE>` is opened). Idempotent; run after seedAuth.
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type * as schema from "../schema";
import { chatTemplates } from "../schema";

type Db = PgDatabase<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;

// [id, title, en, fr, rw]
const G: [string, string, string, string, string][] = [
  [
    "tpl-docs",
    "Documents needed",
    "Hello {client_name},\nWe are following up on your case {case_ref}. Please provide the requested documents by {due_date}.",
    "Bonjour {client_name},\nNous faisons le suivi de votre dossier {case_ref}. Merci de fournir les documents demandés avant le {due_date}.",
    "Muraho {client_name},\nTurakurikirana dosiye yawe {case_ref}. Turabasaba kohereza inyandiko zasabwe bitarenze {due_date}.",
  ],
  [
    "tpl-pay",
    "Payment reminder",
    "Hello {client_name}, a payment for {case_ref} is still pending. Pay any time from your account.",
    "Bonjour {client_name}, un paiement pour {case_ref} est en attente. Payez depuis votre compte.",
    "Muraho {client_name}, kwishyura kuri {case_ref} ntikurarangira. Mushobora kwishyura muri konti yanyu.",
  ],
  [
    "tpl-delay",
    "Delay apology",
    "Hello {client_name}, we are sorry {case_ref} is taking longer than planned. New date: {due_date}.",
    "Bonjour {client_name}, désolés pour le retard de {case_ref}. Nouvelle date : {due_date}.",
    "Muraho {client_name}, tubabajwe n'uko {case_ref} yatinze. Itariki nshya: {due_date}.",
  ],
  [
    "tpl-done",
    "Completed",
    "Hello {client_name}, {case_ref} is complete. Your documents are in your account.",
    "Bonjour {client_name}, {case_ref} est terminé. Vos documents sont dans votre compte.",
    "Muraho {client_name}, {case_ref} yarangiye. Inyandiko zanyu ziri muri konti yanyu.",
  ],
];

export async function seedChat(db: Db) {
  await db
    .insert(chatTemplates)
    .values(G.map(([templateId, title, bodyEn, bodyFr, bodyRw]) => ({ templateId, title, bodyEn, bodyFr, bodyRw, scope: "all", createdBy: "mock-sm", isActive: true })))
    .onConflictDoNothing();
}
