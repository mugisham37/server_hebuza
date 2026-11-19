// F-WRK-16 public team profile: a worker opts in with a short bio, marketing approves, the public /about/team reads only
// approved, opted-in profiles. Stored on agent_profiles.ws.publicProfile (no new table).
import { Body, Controller, Get, Injectable, Param, Post, Put } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { agentProfiles, users } from "@/db/schema";
import type { Tx } from "../../core/db/db";
import { TxService } from "../../core/db/tx";
import { AuditService } from "../../core/db/audit";
import { AppError } from "../../core/http/errors";
import { CurrentUser } from "../../core/auth/decorators";
import type { SessionUser } from "../../core/http/context";
import { Route } from "../../core/http/route";
import { dto } from "../../core/http/dto";

export type PublicProfile = { optIn: boolean; title: string; bio: string; status: "pending" | "approved" | "rejected"; note?: string; at: string };
const pp = (ws: unknown) => ((ws as { publicProfile?: PublicProfile } | null)?.publicProfile ?? null);

class TeamProfileDto extends dto(z.object({ optIn: z.boolean(), title: z.string().trim().max(80), bio: z.string().trim().max(600) })) {}
class TeamDecisionDto extends dto(z.object({ approve: z.boolean(), note: z.string().trim().max(500).optional() })) {}
export const TeamList = z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), title: z.string(), bio: z.string() })) }).meta({ id: "PublicTeamList" });
const MineOut = z.object({ optIn: z.boolean(), title: z.string(), bio: z.string(), status: z.string().nullable(), note: z.string().nullable() }).meta({ id: "MyTeamProfile" });
const Queue = z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), title: z.string(), bio: z.string(), status: z.string(), at: z.string() })) }).meta({ id: "TeamProfileQueue" });

const AGENTS = ["staff:agent", "ext:agent"] as const;
const MKT = ["staff:marketing"] as const;

@Injectable()
export class TeamService {
  constructor(private readonly tx: TxService, private readonly audit: AuditService) {}
  private async row(t: Tx, id: string) {
    const [r] = await t.select({ ws: agentProfiles.ws, name: users.name }).from(agentProfiles).innerJoin(users, eq(users.userId, agentProfiles.userId)).where(eq(agentProfiles.userId, id));
    if (!r) throw new AppError(404, "not_found", "No worker profile.");
    return r;
  }
  private save(t: Tx, id: string, p: PublicProfile) {
    return t.update(agentProfiles).set({ ws: sql`jsonb_set(coalesce(${agentProfiles.ws}, '{}'::jsonb), '{publicProfile}', ${JSON.stringify(p)}::jsonb)` }).where(eq(agentProfiles.userId, id));
  }
  mine(me: SessionUser) {
    return this.tx.run(async (t) => {
      const p = pp((await this.row(t, me.id)).ws);
      return { optIn: p?.optIn ?? false, title: p?.title ?? "", bio: p?.bio ?? "", status: p?.status ?? null, note: p?.note ?? null };
    });
  }
  setMine(me: SessionUser, b: { optIn: boolean; title: string; bio: string }) {
    if (b.optIn && (!b.title || !b.bio)) throw new AppError(422, "validation", "Add a title and a short bio to appear on the team page.");
    return this.tx.run(async (t) => {
      await this.row(t, me.id);
      // Any change goes back to marketing for approval; opting out removes the profile at once.
      await this.save(t, me.id, { ...b, status: "pending", at: new Date().toISOString() });
      await this.audit.record(t, { action: "workforce.team_profile_changed", entity: "worker", entityId: me.id, after: { optIn: b.optIn } });
      return this.mineIn(t, me.id);
    });
  }
  private async mineIn(t: Tx, id: string) {
    const p = pp((await this.row(t, id)).ws)!;
    return { optIn: p.optIn, title: p.title, bio: p.bio, status: p.status, note: p.note ?? null };
  }
  queue() {
    return this.tx.run(async (t) => {
      const rows = await t.select({ id: users.userId, name: users.name, ws: agentProfiles.ws }).from(agentProfiles).innerJoin(users, eq(users.userId, agentProfiles.userId))
        .where(sql`${agentProfiles.ws} -> 'publicProfile' ->> 'optIn' = 'true'`);
      return { items: rows.map((r) => ({ id: r.id, name: r.name, ...pp(r.ws)! })).map(({ id, name, title, bio, status, at }) => ({ id, name, title, bio, status, at })) };
    });
  }
  decide(me: SessionUser, id: string, b: { approve: boolean; note?: string }) {
    return this.tx.run(async (t) => {
      const p = pp((await this.row(t, id)).ws);
      if (!p?.optIn) throw new AppError(409, "conflict", "This worker has not opted in.");
      await this.save(t, id, { ...p, status: b.approve ? "approved" : "rejected", note: b.note, at: new Date().toISOString() });
      await this.audit.record(t, { action: b.approve ? "workforce.team_profile_approved" : "workforce.team_profile_rejected", entity: "worker", entityId: id, reason: b.note, after: { by: me.id } });
      return { id, status: b.approve ? "approved" : "rejected" };
    });
  }
  publicTeam() {
    return this.tx.run(async (t) => {
      const rows = await t.select({ id: users.userId, name: users.name, ws: agentProfiles.ws, active: users.isActive }).from(agentProfiles).innerJoin(users, eq(users.userId, agentProfiles.userId))
        .where(sql`${agentProfiles.ws} -> 'publicProfile' ->> 'status' = 'approved' and ${agentProfiles.ws} -> 'publicProfile' ->> 'optIn' = 'true'`);
      return { items: rows.filter((r) => r.active).map((r) => ({ id: r.id, name: r.name, title: pp(r.ws)!.title, bio: pp(r.ws)!.bio })) };
    });
  }
}

@Controller()
export class TeamController {
  constructor(private readonly svc: TeamService) {}
  @Get("me/team-profile") @Route({ auth: [...AGENTS], out: MineOut })
  mine(@CurrentUser() me: SessionUser) { return this.svc.mine(me); }
  @Put("me/team-profile") @Route({ auth: [...AGENTS], limit: "write", out: MineOut })
  set(@Body() b: TeamProfileDto, @CurrentUser() me: SessionUser) { return this.svc.setMine(me, b); }
  @Get("marketing/team-profiles") @Route({ auth: [...MKT], out: Queue })
  queue() { return this.svc.queue(); }
  @Post("marketing/team-profiles/:id/decision") @Route({ auth: [...MKT], limit: "write" })
  decide(@Param("id") id: string, @Body() b: TeamDecisionDto, @CurrentUser() me: SessionUser) { return this.svc.decide(me, id, b); }
  @Get("public/team") @Route({ auth: "public", limit: "read", out: TeamList })
  team() { return this.svc.publicTeam(); }
}
