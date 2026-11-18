// Dev/staging agent-workspace seed: the records only the agent module owns (papers, settings); profiles, cases and
// offers come from seedOps / seedWork. Idempotent; run after seedOps.
import { eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type * as schema from "../schema";
import { agentProfiles, opsRecords } from "../schema";

type Db = PgDatabase<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;
const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString();

const PAPERS: { owner: string; id: string; kind: string; status: string; file: string; at: string }[] = [
  { owner: "mock-agent", id: "pp-ag-id", kind: "national_id", status: "approved", file: "national_id.pdf", at: day(-90) },
  { owner: "mock-agent", id: "pp-ag-cv", kind: "cv", status: "approved", file: "cv.pdf", at: day(-90) },
  { owner: "mock-ext", id: "pp-ext-id", kind: "national_id", status: "pending", file: "national_id.pdf", at: day(-3) },
];

export async function seedAgent(db: Db) {
  for (const p of PAPERS)
    await db
      .insert(opsRecords)
      .values({
        id: p.id,
        kind: "agent_paper",
        ownerId: p.owner,
        state: p.status,
        data: {
          documentId: p.id,
          kind: p.kind,
          status: p.status,
          originalFilename: p.file,
          uploadedAt: p.at,
          reviewNote: null,
          key: `u/${p.owner}/agent-paper/${p.id}`,
        },
        createdAt: p.at,
        updatedAt: p.at,
      })
      .onConflictDoNothing();
  await db
    .update(agentProfiles)
    .set({ ws: sql`jsonb_build_object('settings', jsonb_build_object('daily_case_cap', 4)) || ${agentProfiles.ws}` })
    .where(eq(agentProfiles.userId, "mock-agent"));
}
