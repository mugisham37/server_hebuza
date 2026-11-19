// Worker side of booking: client messages (confirm/reschedule/cancel/reassign/manage link/next steps/reminder), the
// minute sweep (payments settle, auto no-show, lapsed holds → waitlist offers) and due reminders.
// Account holders get an in-app notification (+ their preferred channel) via NotificationsService; guests get email or
// SMS at the booking contact. The manage-link token only ever goes to guests (clients manage from the portal).
import { CalendarSync } from "./booking.calendar";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../../core/config/env";
import { formatSlot } from "@/domain/booking/rules";
import type { Locale } from "@/domain/i18n/config";
import { Cron, Job } from "../../core/queue/queues";
import { MailService } from "../../core/notify/mail.service";
import { SmsService } from "../../core/notify/sms.service";
import { TxService } from "../../core/db/tx";
import { CryptoService } from "../../core/crypto/crypto.service";
import { NotificationsService } from "../notifications/notifications.service";
import { BookingService } from "./booking.service";

const T: Record<string, Record<Locale, string>> = {
  confirmed: {
    en: "Your consultation {ref} is confirmed for {when} (Kigali time).",
    fr: "Votre consultation {ref} est confirmée pour le {when} (heure de Kigali).",
    rw: "Gahunda yawe {ref} yemejwe ku {when} (isaha y'i Kigali).",
  },
  rescheduled: {
    en: "Your consultation moved to {when} (new reference {ref}).",
    fr: "Votre consultation est déplacée au {when} (nouvelle référence {ref}).",
    rw: "Gahunda yawe yimuriwe ku {when} (nimero nshya {ref}).",
  },
  cancelled: { en: "Your consultation {ref} was cancelled.", fr: "Votre consultation {ref} a été annulée.", rw: "Gahunda yawe {ref} yahagaritswe." },
  reassigned: {
    en: "Your consultation {ref} on {when} is now with another adviser.",
    fr: "Votre consultation {ref} du {when} est désormais avec un autre conseiller.",
    rw: "Gahunda yawe {ref} yo ku {when} izakorwa n'undi mujyanama.",
  },
  manage_link: { en: "Manage your consultation {ref} ({when}).", fr: "Gérez votre consultation {ref} ({when}).", rw: "Cunga gahunda yawe {ref} ({when})." },
  next_steps: {
    en: "Your next steps after consultation {ref} are ready.",
    fr: "Vos prochaines étapes après la consultation {ref} sont prêtes.",
    rw: "Intambwe zikurikira nyuma ya gahunda {ref} zateguwe.",
  },
  reminder: {
    en: "Reminder: consultation {ref} at {when} (Kigali time).",
    fr: "Rappel : consultation {ref} le {when} (heure de Kigali).",
    rw: "Kwibutsa: gahunda {ref} ku {when} (isaha y'i Kigali).",
  },
};
const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? "");

@Injectable()
export class BookingJobs {
  private readonly log = new Logger(BookingJobs.name);
  private readonly base: string;
  constructor(
    private readonly svc: BookingService,
    private readonly mail: MailService,
    private readonly sms: SmsService,
    private readonly txs: TxService,
    private readonly crypto: CryptoService,
    private readonly notifications: NotificationsService,
    private readonly calendar: CalendarSync,
    config: ConfigService<Env, true>,
  ) {
    this.base = config.get("WEB_ORIGIN", { infer: true }).split(",")[0].trim().replace(/\/$/, "");
  }

  private async deliver(to: { email?: string; phone?: string }, subject: string, text: string) {
    if (to.email) await this.mail.send({ to: to.email, subject, text, html: `<p>${text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`).replace(/\n/g, "<br>")}</p>`, tags: { module: "booking" } });
    else if (to.phone) await this.sms.send({ to: to.phone, text });
  }

  @Job("booking.notify")
  async notify(sealed: { kind: string; bookingId: string; token?: string }) {
    const { kind, bookingId, token } = this.crypto.unseal(sealed, ["token"]);
    const m = await this.svc.forMessage(bookingId);
    if (!m || !m.row.reference) return;
    const r = m.row;
    const l = m.language;
    const tpl = T[kind] ?? T.confirmed;
    let text = fill(tpl[l] ?? tpl.en, { ref: r.reference, when: formatSlot(r.startsAt, l) });
    if (kind === "next_steps" && r.startLinks.length) text += "\n" + r.startLinks.map((x) => `${x.name}: ${this.base}/${l}${x.href}`).join("\n");
    const subject = `HEBUZA ${r.reference}`;
    // F-BKG-10: confirmed bookings land in the adviser's linked Google/Microsoft calendar (no-op without links).
    if (kind === "confirmed" && r.adviserId) await this.calendar.push(r.adviserId, { ref: r.reference, title: `${subject} · ${m.language}`, startsAt: r.startsAt, endsAt: r.endsAt, joinUrl: r.joinUrl });
    if (r.clientId) {
      const clientId = r.clientId;
      await this.txs.runAsSystem((tx) => this.notifications.notify(tx, {
        userId: clientId, kind: "booking", title: subject, body: text, link: `/${l}/bookings/${r.id}`,
        channels: [r.whatsapp ? "whatsapp" : m.phone && !m.email ? "sms" : "email"], data: { type: `booking.${kind}`, vars: { ref: r.reference } },
      }));
      return;
    }
    if (token) text += `\n${this.base}/${l}/book/manage/${token}`;
    await this.deliver({ email: m.email, phone: m.phone }, subject, text);
  }

  @Job("booking.waitlist.offer")
  async offer(d: { typeSlug: string; date: string }) {
    const o = await this.svc.offerWaitlist(d.typeSlug, d.date);
    if (!o?.contact) return;
    const text = `A time opened on ${d.date} for "${o.type.name.en}": ${this.base}/en/book/${d.typeSlug}?date=${d.date}`;
    await this.deliver(o.contact.includes("@") ? { email: o.contact } : { phone: o.contact }, "A consultation time opened", text);
  }

  @Cron("booking.sweep", "* * * * *")
  async sweep() {
    for (const p of await this.svc.openPayments()) await this.svc.settle(p.id);
    return this.svc.sweep();
  }

  @Cron("booking.reminders", "*/5 * * * *")
  reminders() {
    return this.svc.dueReminders();
  }
}
