// Procurement worker: daily obligations sweep, monthly recurring contract bill drafts (R-14), PO PDF rendering.
import { Injectable, Logger } from "@nestjs/common";
import { Cron, Job } from "../../core/queue/queues";
import { ProcurementStore } from "./procurement.store";
import { dueReminders, nowIso, record, systemWrite } from "./procurement.world";
import { generateRecurringIn } from "./procurement.bills";

@Injectable()
export class ProcurementJobs {
  private readonly log = new Logger("procurement.jobs");
  constructor(private readonly store: ProcurementStore) {}

  /** 07:00 Kigali: lock expiry + deposit return_due (refresh runs on save) and contract reminders marked sent.
   *  Reminders surface in the procurement bell/alerts (in-app channel); nothing is emailed. */
  @Cron("procurement.daily", "0 5 * * *")
  daily() {
    return systemWrite(this.store.deps, (w) => {
      const due = dueReminders(w);
      for (const { c, key } of due) {
        const r = c.reminders.find((x) => x.key === key);
        if (!r) continue;
        r.sentAt = nowIso(w);
        record(w, "sup.contract.reminder_sent", "contract", c.id, null, { offset: r.offset, on: r.on });
      }
      this.log.log({ reminders: due.length }, "procurement.daily");
    });
  }

  /** 20th of the month: draft next month's bills for active monthly contracts (procurement reviews and submits them). */
  @Cron("procurement.recurring_bills", "0 4 20 * *")
  recurring() {
    return systemWrite(this.store.deps, (w) => {
      this.log.log({ created: generateRecurringIn(w).length }, "procurement.recurring_bills");
    });
  }

  @Job("procurement.po.pdf")
  poPdf(d: { no: string }) {
    return this.store.renderPo(d.no);
  }
}
