// Dev/staging workforce seed (port of the .ref work.seed "workforce extras"): wf_worker facts and one review.
// Private fields (`privateEnc`) are encrypted with the runner's FIELD_KEY when `deps.encrypt` is given.
// Idempotent; run after seedOps (agent ids are the ops seed's).
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type * as schema from "../schema";
import { opsRecords } from "../schema";

type Db = PgDatabase<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;
const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString();

const W: [string, Record<string, unknown>][] = [
  ["mock-field", { field: true, districts: ["Gasabo", "Kicukiro"], contractEnd: day(300), certifications: [{ name: "Field safety", expiresOn: day(90) }] }],
  ["wk-new", { status: "invited", districts: ["Nyarugenge"] }],
  ["wk-old", { status: "suspended", districts: ["Huye"], contractEnd: day(30), sessionsRevoked: true }],
  [
    "mock-agent",
    {
      districts: ["Gasabo"],
      contractEnd: day(120),
      certifications: [{ name: "HEBUZA service standards", expiresOn: day(200) }],
      documents: [{ id: "wd-ag-eric", name: "Engagement contract.pdf" }],
    },
  ],
];

const PRIVATE: Record<string, { address: string; phone: string; nationalId: string }> = {
  "mock-field": { address: "KG 11 Ave, Gasabo", phone: "+250788000101", nationalId: "1199080000000101" },
  "mock-agent": { address: "KN 5 Rd, Kigali", phone: "+250788000102", nationalId: "1198870000000102" },
};

export async function seedWorkforce(db: Db, deps: { encrypt?: (plain: string) => string } = {}) {
  const priv = (id: string) => (deps.encrypt && PRIVATE[id] ? { privateEnc: deps.encrypt(JSON.stringify(PRIVATE[id])) } : {});
  await db
    .insert(opsRecords)
    .values([
      ...W.map(([id, data]) => ({ id: `wf:${id}`, kind: "wf_worker", ownerId: id, state: (data.status as string | undefined) ?? null, data: { ...data, ...priv(id) } })),
      {
        id: "rv-1",
        kind: "wf_review",
        ownerId: "ag-grace",
        ref: "2026-H1",
        state: "acknowledged",
        data: {
          id: "rv-1",
          workerId: "ag-grace",
          period: "2026-H1",
          kpis: { onTime: 96, rating: 4.8 },
          rating: 5,
          goals: "Mentor two new agents.",
          comments: "Consistently excellent.",
          ackRequired: true,
          status: "acknowledged",
          by: { id: "mock-sm", name: "Diane Mukamana" },
          at: day(-120),
        },
      },
    ])
    .onConflictDoNothing();
}
