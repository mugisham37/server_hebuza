// Reference work.jobs: monthly licence invoices + overdue marking, daily credential expiry sweep. One short system tx per
// work_ext row, so one bad row can't roll back the rest.
import { dueOffset, expiryTitle } from "@/domain/expiry";
import { claimReminder } from "../../core/db/reminder-claim";
import { usersWithRole } from "../../core/db/system-records";
import { Injectable, Logger } from "@nestjs/common";
import { TxService } from "../../core/db/tx";
import { Cron } from "../../core/queue/queues";
import type { Exec } from "../ops/lib/ctx";
import { recGet, recIds } from "../ops/lib/store";
import { notify } from "../ops/lib/ctx";
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
        const days = dueOffset(d.end, new Date().toISOString()); // F-CAL-11 shared expiry rule + claim
        if (days === null || !(await claimReminder(tx, "work_doc_expiry", `${owner}:${d.id}`, days))) continue;
        const title = expiryTitle(d.title, days);
        await notify(tx, { userId: owner, kind: "contract", title, href: "/work/contract" });
        for (const id of await usersWithRole(tx, ["staff:service_manager"])) await notify(tx, { userId: id, kind: "contract", title: `${title} (${owner})`, href: `/ops/workforce/${owner}` });
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
