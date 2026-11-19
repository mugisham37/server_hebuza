// Finance ↔ real cases (G0): priced lines from the catalogue (F-FIN-03), the case invoice created when an application
// becomes payable and settled from gateway payments, scheduled payment reminders (F-FIN-16) and the allocation trigger
// (F-REV-03). Everything here runs as the system actor from FinanceJobs; request handlers reuse casePriceLines.
import { and, eq, gt } from "drizzle-orm";
import type { Tx as Exec } from "../../core/db/db";
import { applications, servicePricingTiers, services } from "@/db/schema";
import { priceLines } from "@/domain/finance/price";
import { splitVat } from "@/domain/money";
import type { DocLine } from "@/domain/finance/types";
import { allocationDue } from "@/domain/finance/states";
import { addDays, all, DAY, nowIso, today, type Fin } from "./finance.store";
import { dueForRenewal } from "../subscriptions/subscriptions.service";
import {
  addClientCredit,
  invOr404,
  issueCaseInvoice,
  issuePlanInvoice,
  keyOf,
  remind,
  saveInv,
  type Inv,
} from "./finance.billing";
import { allocateCase } from "./finance.revenue";

const appByCode = (db: Exec, code: string) =>
  db
    .select()
    .from(applications)
    .where(eq(applications.code, code))
    .then((r) => r[0]);

/** Calculator lines for a case: tier fee (or the agreed quote amount), urgent surcharge per service rule, government fee. */
export async function casePriceLines(
  db: Exec,
  code: string,
  vatBps: number,
): Promise<DocLine[] | null> {
  const app = await appByCode(db, code);
  if (!app) return null;
  const [[tier], [svc]] = await Promise.all([
    db
      .select()
      .from(servicePricingTiers)
      .where(
        and(
          eq(servicePricingTiers.serviceId, app.serviceId),
          eq(servicePricingTiers.tier, app.tier),
        ),
      ),
    db
      .select({
        kind: services.urgentSurchargeType,
        value: services.urgentSurchargeValue,
      })
      .from(services)
      .where(eq(services.serviceId, app.serviceId)),
  ]);
  const gov = tier?.governmentFee ?? 0;
  const feeGross =
    app.agreedAmountRwf ??
    tier?.platformFee ??
    Math.max(0, (app.paymentAmount ?? 0) - gov);
  return priceLines({
    label: app.serviceName,
    feeGross,
    urgent: app.isUrgent ? svc : null,
    governmentFee: gov,
    vatBps,
  });
}

/** Lines whose total is exactly what the client is asked to pay (gateway amounts are VAT-inclusive). */
function payableLines(
  label: string,
  gross: number,
  gov: number,
  vatBps: number,
): DocLine[] {
  const fee = splitVat(Math.max(0, gross - gov), vatBps).net;
  const lines: DocLine[] = [{ kind: "service_fee", label, qty: 1, unit: fee }];
  if (gov > 0)
    lines.push({
      kind: "government_fee",
      label: {
        en: "Government fee",
        fr: "Frais publics",
        rw: "Amafaranga ya Leta",
      },
      qty: 1,
      unit: gov,
    });
  return lines;
}

const caseInvoices = async (f: Fin, code: string) =>
  (await all<Inv>(f.db, "invoice")).filter(
    (i) => i.caseRef === code && i.status !== "void",
  );

/** Case became payable → one issued invoice for it (idempotent per case). */
export async function ensureCaseInvoice(f: Fin, code: string, paidSoFar = 0) {
  const have = await caseInvoices(f, code);
  if (have.length) return have[0];
  const app = await appByCode(f.db, code);
  if (!app?.clientId || !app.paymentAmount) return null;
  const [tier] = await f.db
    .select({ gov: servicePricingTiers.governmentFee })
    .from(servicePricingTiers)
    .where(
      and(
        eq(servicePricingTiers.serviceId, app.serviceId),
        eq(servicePricingTiers.tier, app.tier),
      ),
    );
  const gross = app.paymentAmount + paidSoFar;
  return issueCaseInvoice(f, {
    clientId: app.clientId,
    caseRef: code,
    lines: payableLines(
      app.serviceName,
      gross,
      Math.min(tier?.gov ?? 0, gross),
      f.S.vat_bps,
    ),
    dueAt: addDays(app.submittedAt, f.S.invoice_terms_days),
  });
}

/** Gateway payment landed on a case: mirror it on the case invoice; excess becomes client credit; then REV-03. */
export async function caseSettled(
  f: Fin,
  d: { applicationCode: string; paymentId: string; amount: number },
) {
  const inv = await ensureCaseInvoice(f, d.applicationCode, d.amount);
  if (!inv || (inv.gatewayPaymentIds ?? []).includes(d.paymentId)) return;
  const app = await appByCode(f.db, d.applicationCode);
  const applied = Math.min(d.amount, inv.balanceDue);
  inv.gatewayPaymentIds = [...(inv.gatewayPaymentIds ?? []), d.paymentId];
  inv.amountPaid += applied;
  // The application's payment status is authoritative (rounding of VAT-inclusive amounts never leaves 1 RWF open).
  inv.balanceDue =
    app?.paymentStatus === "paid" ? 0 : Math.max(0, inv.balanceDue - applied);
  inv.status = inv.balanceDue === 0 ? "paid" : "partially_paid";
  (inv.statement ??= []).push({
    at: nowIso(),
    label: `Payment ${d.paymentId}`,
    amount: -applied,
  });
  inv.rev++;
  await saveInv(f.db, inv);
  if (d.amount > applied)
    await addClientCredit(f.db, inv.clientId, d.amount - applied);
  f.rec("invoice.payment_applied", "invoice", keyOf(inv), null, {
    applied,
    credit: d.amount - applied,
    status: inv.status,
  });
  await allocateIfDue(f, d.applicationCode);
}

export async function allocateIfDue(f: Fin, code: string) {
  const c = f.D.caseOf(code);
  if (!c) return null;
  const invs = await caseInvoices(f, code);
  return allocationDue(c, invs) ? allocateCase(f, code) : null;
}

/** Sweep: payable cases without an invoice get one; delivered + paid cases get their allocation. */
export async function syncCases(f: Fin) {
  const payable = await f.db
    .select({ code: applications.code })
    .from(applications)
    .where(
      and(
        eq(applications.paymentStatus, "pending"),
        gt(applications.paymentAmount, 0),
      ),
    );
  let made = 0,
    allocated = 0;
  for (const a of payable) {
    const before = (await caseInvoices(f, a.code)).length;
    if (!before && (await ensureCaseInvoice(f, a.code))) made++;
  }
  for (const c of f.D.cases.filter((x) => x.status === "completed_delivered"))
    if (await allocateIfDue(f, c.ref)) allocated++;
  return { made, allocated };
}

/** F-FIN-16: email reminder at each configured offset from the due date (−3/0/+3/+7/+14), once per offset; stops when paid. */
export async function scheduledReminders(f: Fin, now = Date.now()) {
  const t = today(now);
  let sent = 0;
  for (const inv of await all<Inv>(f.db, "invoice")) {
    if (
      !inv.no ||
      !inv.dueAt ||
      inv.balanceDue <= 0 ||
      ["void", "draft", "paid", "paid_by_plan", "credited"].includes(inv.status)
    )
      continue;
    const off = Math.round(
      (Date.parse(t) - Date.parse(inv.dueAt.slice(0, 10))) / DAY,
    );
    if (
      !f.S.reminderOffsets.includes(off) ||
      (inv.autoReminders ?? []).includes(off)
    )
      continue;
    const client = f.D.client(inv.clientId);
    if (client?.email) await remind(f, keyOf(inv), { channel: "email" });
    const fresh = await invOr404(f.db, keyOf(inv)); // remind() saved its own copy
    fresh.autoReminders = [...(fresh.autoReminders ?? []), off];
    await saveInv(f.db, fresh);
    await f.deps.outbox(f.db, "notifications.deliver", {
      userId: inv.clientId,
      kind: "invoice_reminder",
      title:
        off < 0
          ? `Invoice ${inv.no} is due in ${-off} days`
          : off === 0
            ? `Invoice ${inv.no} is due today`
            : `Invoice ${inv.no} is ${off} days overdue`,
      body: `${inv.balanceDue} RWF outstanding.`,
      link: "/billing",
      data: {
        type: "invoice_reminder",
        vars: { no: inv.no, amount: String(inv.balanceDue), days: String(off) },
      },
    });
    sent++;
  }
  return sent;
}

/** F-SUB-04: plan invoice once per period, issued `lead` days before period end (subscriptions owns the state). */
export async function renewalInvoices(f: Fin) {
  const due = await dueForRenewal(f.db);
  const invs = await all<Inv>(f.db, "invoice");
  let made = 0;
  for (const { s, p } of due) {
    const period = s.currentPeriodEnd.slice(0, 10);
    const subId = `${s.subscriptionId}@${period}`;
    if (invs.some((i) => i.subscriptionId === subId && i.status !== "void")) continue;
    await issuePlanInvoice(f, {
      clientId: s.clientId, subscriptionId: subId, label: `${p.name} · renewal from ${period}`,
      amountGross: p.amountRwf, dueAt: period,
    });
    made++;
  }
  return made;
}

/** A plan payment settles the client's open plan invoice (oldest first). */
export async function planSettled(f: Fin, d: { clientId: string; paymentId: string; amount: number }) {
  const open = (await all<Inv>(f.db, "invoice"))
    .filter((i) => i.clientId === d.clientId && i.series === "plan" && i.no && i.balanceDue > 0 && i.status !== "void")
    .sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""))[0];
  if (!open || (open.gatewayPaymentIds ?? []).includes(d.paymentId)) return;
  open.gatewayPaymentIds = [...(open.gatewayPaymentIds ?? []), d.paymentId];
  open.amountPaid += Math.min(d.amount, open.balanceDue);
  open.balanceDue = 0; // VAT-inclusive plan price: the plan payment is the whole invoice
  open.status = "paid";
  open.rev++;
  await saveInv(f.db, open);
  f.rec("invoice.payment_applied", "invoice", keyOf(open), null, { status: "paid", paymentId: d.paymentId });
}
