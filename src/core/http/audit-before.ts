// F-AUD-03/06: snapshot of the record a @Route-audited mutation is about to change, keyed by the audit code's prefix
// and the route's :code / :id param. Handlers can still override with auditBefore(x) (route.ts).
import { eq } from "drizzle-orm";
import { applications, cmsEntries, opsRecords, serviceCategories, serviceSubcategories, services } from "@/db/schema";
import type { Tx } from "../db/db";

type Loader = (tx: Tx, p: Record<string, string>) => Promise<unknown>;
const first = <T>(rows: T[]) => rows[0] ?? undefined;
const caseLoader: Loader = (tx, p) =>
  // Workflow fields only: the case row also carries personal data, which must not be copied into the append-only log.
  p.code
    ? tx.select({ status: applications.status, assignedAgentId: applications.assignedAgentId, paymentStatus: applications.paymentStatus, isUrgent: applications.isUrgent, completedAt: applications.completedAt })
        .from(applications).where(eq(applications.code, p.code)).then(first)
    : Promise.resolve(undefined);
/** ops-style documents (leads, offers, contracts, segments, campaigns, firms…) live in ops_records keyed by id. */
const recLoader: Loader = (tx, p) =>
  p.id ? tx.select({ kind: opsRecords.kind, data: opsRecords.data }).from(opsRecords).where(eq(opsRecords.id, p.id)).limit(1).then(first) : Promise.resolve(undefined);

export const AUDIT_BEFORE: Record<string, Loader> = {
  case: caseLoader,
  application: caseLoader,
  cms: (tx, p) => (p.id ? tx.select({ version: cmsEntries.version, archived: cmsEntries.archived, doc: cmsEntries.doc }).from(cmsEntries).where(eq(cmsEntries.id, p.id)).then(first) : Promise.resolve(undefined)),
  service: (tx, p) => (p.id ? tx.select().from(services).where(eq(services.serviceId, p.id)).then(first) : Promise.resolve(undefined)),
  service_category: (tx, p) => (p.id ? tx.select().from(serviceCategories).where(eq(serviceCategories.id, p.id)).then(first) : Promise.resolve(undefined)),
  service_subcategory: (tx, p) => (p.id ? tx.select().from(serviceSubcategories).where(eq(serviceSubcategories.id, p.id)).then(first) : Promise.resolve(undefined)),
  lead: recLoader, offer: recLoader, contract: recLoader, segment: recLoader, campaign: recLoader, firm: recLoader, worker: recLoader, rate: recLoader, review: recLoader, ticket: recLoader,
};
