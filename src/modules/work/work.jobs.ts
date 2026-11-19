// Reference work.jobs: monthly licence invoices + overdue marking, daily credential expiry sweep. One short system tx per
// work_ext row, so one bad row can't roll back the rest.
import { Injectable, Logger } from "@nestjs/common";
import { TxService } from "../../core/db/tx";
import { Cron } from "../../core/queue/queues";
import type { Exec } from "../ops/lib/ctx";
import { recGet, recIds } from "../ops/lib/store";
import { generateId, notify } from "../ops/lib/ctx";
import { deadlineNotifications } from "@/db/schema";
import { sql } from "drizzle-orm";
import { credentialRow, licenceRow } from "./work.service";
import type { ExtState } from "./work.store";

@Injectable()
export class WorkJobs {
  private readonly log = new Logger("work.jobs");
  constructor(private readonly tx: TxService) {}

  private async each(job: string, fn: (tx: Exec, owner: string, e: ExtState, now: number) => Promise<number>) {
    const now = Date.now();
    let n = 0;
    const ids = await this.tx.runAsSystem(async (tx) => {
      const out: string[] = [];
      for await (const id of recIds(tx, "work_ext")) out.push(id);
      return out;
    });
    for (const id of ids)
      try {
        n += await this.tx.runAsSystem(async (tx) => {
          const r = await recGet<ExtState>(tx, "work_ext", id, true);
          return r?.ownerId ? fn(tx, r.ownerId, r.data, now) : 0;
        });
      } catch (e) {
        this.log.error(`${job}_row_failed ${id} ${String(e)}`);
      }
    this.log.log(`${job} ${n}`);
    return n;
  }

  /** 21st of each month, 06:00 Kigali (04:00 UTC): raise next month's licence fee and mark unpaid past-due ones overdue. */
  @Cron("work.licence.monthly", "0 4 21 * *")
  licence() {
    return this.each("work_licence", licenceRow);
  }
  /** F-WRK-03/05: worker contract documents (service agreement, SLA, NDA, licence) — reminders at 60/30/7/0 days to the
   * worker and service managers, once each (deadline_notifications claim). */
  @Cron("work.documents.expiry", "15 7 * * *")
  docExpiry() {
    return this.each("work_doc_expiry", async (tx, owner, e) => {
      let sent = 0;
      for (const d of e.contract ?? []) {
        if (!d.end || ["terminated", "renewed", "expired"].includes(d.status)) continue;
        const days = Math.ceil((Date.parse(d.end.slice(0, 10)) - Date.parse(new Date().toISOString().slice(0, 10))) / 86_400_000);
        if (![60, 30, 7, 0].includes(days)) continue;
        const [claimed] = await tx.insert(deadlineNotifications)
          .values({ id: generateId("dln"), targetType: "work_doc_expiry", targetId: `${owner}:${d.id}`, offsetDays: days, sentAt: new Date().toISOString() })
          .onConflictDoNothing().returning({ id: deadlineNotifications.id });
        if (!claimed) continue;
        const title = `${d.title} ${days ? `ends in ${days} days` : "ends today"}`;
        await notify(tx, { userId: owner, kind: "contract", title, href: "/work/contract" });
        const sms = await tx.execute<{ id: string }>(sql`select user_id id from users where role = 'staff:service_manager' and is_active`);
        for (const u of sms) await notify(tx, { userId: u.id, kind: "contract", title: `${title} (${owner})`, href: `/ops/workforce/${owner}` });
        sent++;
      }
      return sent;
    });
  }
  /** Daily 02:30 Kigali (00:30 UTC): expired credentials pull their services back to not_cleared. */
  @Cron("work.credentials.sweep", "30 0 * * *")
  credentials() {
    return this.each("work_credential", credentialRow);
  }
}
