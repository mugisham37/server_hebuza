// Finance ↔ real cases (G0): priced lines from the catalogue (F-FIN-03), the case invoice created when an application
// becomes payable and settled from gateway payments, scheduled payment reminders (F-FIN-16) and the allocation trigger
// (F-REV-03). Everything here runs as the system actor from FinanceJobs; request handlers reuse casePriceLines.
import { and, eq, gt, or } from "drizzle-orm";
import type { RefundReason } from "@/domain/finance/types";
import { requestRefund, saveRefund, type R } from "./finance.refunds";
import type { Tx as Exec } from "../../core/db/db";
import { applications, clientSubscriptions, procurementRecords, servicePricingTiers, services } from "@/db/schema";
import { priceLines } from "@/domain/finance/price";
import { splitVat } from "@/domain/money";
import type { DocLine } from "@/domain/finance/types";
import { allocationDue } from "@/domain/finance/states";
import { addDays, all, DAY, need, nowIso, one, put, rid, today, where, type Fin } from "./finance.store";
import { docTotals } from "@/domain/finance/money";
import { dueForRenewal } from "../subscriptions/subscriptions.service";
import {
  addClientCredit,
  createInvoice,
  invOr404,
  issueInvoice,
  newInvoice,
  issueCaseInvoice,
  issuePlanInvoice,
  keyOf,
  remind,
  saveInv,
  type Inv,
} from "./finance.billing";
import { allocateCase, saveAlloc, type Alloc, type RuleRec } from "./finance.revenue";
import { allocate } from "@/domain/finance/money";
import { resolveRule } from "@/domain/finance/rules";

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
  // F-RFD-07: money landing on a case that is already cancelled/rejected is owed back.
  if (app && ["cancelled", "rejected"].includes(app.status))
    await openCaseRefund(f, {
      applicationId: d.applicationCode,
      reason: "cancelled_before_work",
      note: `Payment ${d.paymentId} arrived after the case was ${app.status}.`,
      auto: "cancelled",
    });
  else await allocateIfDue(f, d.applicationCode);
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
      amountGross: p.amountRwf, dueAt: period, planMonths: p.interval === "year" ? 12 : 1,
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

// ---------------------------------------------------------------- F-BKG-06 paid consultation → FIN invoice
/** A settled booking payment becomes an issued, paid finance invoice (VAT-inclusive fee). Idempotent per payment id. */
export async function bookingSettled(f: Fin, d: { clientId?: string | null; guest?: { name: string; phone?: string; email?: string }; reference: string; paymentId: string; amount: number; label: string }) {
  if ((await all<Inv>(f.db, "invoice")).some((i) => (i.gatewayPaymentIds ?? []).includes(d.paymentId))) return;
  const { net } = splitVat(d.amount, f.S.vat_bps);
  const lines: DocLine[] = [{ kind: "service_fee", label: { en: d.label, fr: d.label, rw: d.label }, qty: 1, unit: net, taxable: true }];
  let key: string;
  if (d.clientId) key = (await createInvoice(f, { clientId: d.clientId, lines, dueAt: today() })).key;
  else {
    // Guest booking (no account): bill the name/phone/email given at booking, under a per-booking guest id.
    const inv = newInvoice(f, { clientId: `guest:${d.reference}`, series: "standard", lines, dueAt: today() });
    inv.billTo = { name: d.guest?.name || "Guest", ...(d.guest?.email && { email: d.guest.email }), ...(d.guest?.phone && { phone: d.guest.phone }) };
    await saveInv(f.db, inv);
    key = inv.id;
  }
  await issueInvoice(f, key, {});
  const inv = await invOr404(f.db, key);
  inv.gatewayPaymentIds = [d.paymentId];
  inv.amountPaid = d.amount;
  inv.balanceDue = 0;
  inv.status = "paid";
  inv.rev++;
  await saveInv(f.db, inv);
  f.rec("invoice.payment_applied", "invoice", keyOf(inv), null, { status: "paid", paymentId: d.paymentId, booking: d.reference });
}

// ---------------------------------------------------------------- refund hooks (REQ-11 early cancel, F-RFD-08 dispute)
export type CaseRefundRequest = {
  /** Application id or code. */
  applicationId: string;
  reason: RefundReason;
  note: string;
  auto: "cancelled" | "dispute";
};
/**
 * Other modules call this inside their own tx: the refund request exists iff that tx commits. FinanceJobs then
 * opens it against the case's paid invoice (normal SM → finance approval chain applies).
 */
export const createRefundRequest = (
  tx: Exec,
  outbox: { add: (tx: Exec, e: { type: string; payload: unknown }) => Promise<void> },
  r: CaseRefundRequest,
) => outbox.add(tx, { type: "finance.refund.case_requested", payload: r });

/** Worker side of createRefundRequest; idempotent (an open refund on the invoice is left alone). */
export async function openCaseRefund(f: Fin, r: CaseRefundRequest) {
  const [app] = await f.db
    .select({ code: applications.code })
    .from(applications)
    .where(or(eq(applications.applicationId, r.applicationId), eq(applications.code, r.applicationId)));
  if (!app) return null;
  const inv = (await caseInvoices(f, app.code)).find((i) => i.amountPaid > 0);
  if (!inv) return null;
  try {
    const row = await requestRefund(f, { invoiceNo: inv.no!, reason: r.reason, note: r.note });
    const saved = await one<R>(f.db, "refund", row.no, true);
    if (saved) await saveRefund(f.db, { ...saved, auto: r.auto });
    return row.no;
  } catch (e) {
    if ((e as { errorType?: string }).errorType === "refund_open") return null;
    throw e;
  }
}

/** REV-03 for plans: each paid plan invoice allocates its eligible fee to the subscription's dedicated agent (once). */
export async function planAllocations(f: Fin) {
  const [invs, allocs, rules, subs] = await Promise.all([
    all<Inv>(f.db, "invoice"),
    all<Alloc>(f.db, "allocation"),
    all<RuleRec>(f.db, "rule"),
    f.db.select({ id: clientSubscriptions.subscriptionId, agent: clientSubscriptions.dedicatedAgentId }).from(clientSubscriptions),
  ]);
  const agentOf = new Map(subs.map((s) => [s.id, s.agent]));
  let made = 0;
  for (const i of invs.filter((x) => x.series === "plan" && x.status === "paid" && x.no && x.subscriptionId)) {
    const ref = `PLAN:${i.no}`;
    const agent = agentOf.get(i.subscriptionId!.split("@")[0]);
    if (!agent || allocs.some((a) => a.caseRef === ref && a.status !== "voided")) continue;
    const rule = resolveRule(rules, { agentId: agent, date: i.issuedAt ?? today() });
    const { netBase, pool, hebuza } = allocate(i.totals.eligible, [], rule.agentPct);
    const a: Alloc = {
      id: `al-${Date.now().toString(36)}${made}`,
      caseRef: ref, invoiceNos: [i.no!], eligible: i.totals.eligible, deductions: [], netBase,
      ruleId: rule.id, agentPct: rule.agentPct, pool, hebuza,
      shares: [{ workerId: agent, kind: f.D.workerKind(agent), pct: 10_000, amount: pool }],
      status: "pending_review", frozenAt: nowIso(), rev: 1,
    };
    await saveAlloc(f.db, a);
    f.rec("allocation.created", "allocation", a.id, null, { pool, rule: rule.id, plan: i.subscriptionId });
    made++;
  }
  return made;
}

// ---------------------------------------------------------------- F-SUP-17 case disbursements
export type Disbursement = {
  id: string; caseRef: string; vendorId: string; vendorName: string; label: string; amount: number;
  billNo?: string; invoiceKey: string; at: string; by: { id: string; name: string };
};
/** A third-party cost paid for a client case: vendor + case + a pass-through line on a draft invoice to rebill it. */
export async function addDisbursement(f: Fin, caseRef: string, b: { vendorId: string; label: string; amount: number; billNo?: string }) {
  const c = f.D.caseOf(caseRef);
  need(c, 404, "not_found");
  need(Number.isInteger(b.amount) && b.amount > 0 && b.label.trim(), 422, "validation");
  const [v] = await f.db
    .select({ data: procurementRecords.data })
    .from(procurementRecords)
    .where(and(eq(procurementRecords.kind, "vendor"), eq(procurementRecords.id, b.vendorId)));
  need(v, 422, "validation");
  const vendorName = (v.data as { legalName: string }).legalName;
  const line: DocLine = { kind: "third_party_cost", label: `${vendorName}: ${b.label.trim()}`, qty: 1, unit: b.amount };
  // Rebill on the case's open draft, else a new draft for finance to review and issue.
  const draft = (await caseInvoicesAll(f, caseRef)).find((i) => i.status === "draft");
  let key: string;
  if (draft) {
    draft.lines.push(line);
    draft.totals = docTotals(draft.lines, f.S.vat_bps);
    draft.balanceDue = draft.totals.total - draft.amountPaid;
    draft.rev++;
    await saveInv(f.db, draft);
    key = keyOf(draft);
  } else key = (await createInvoice(f, { clientId: c!.clientId, caseRef, lines: [line], dueAt: addDays(today(), f.S.invoice_terms_days) })).key;
  const d: Disbursement = {
    id: rid("DSB"), caseRef, vendorId: b.vendorId, vendorName, label: b.label.trim(), amount: b.amount,
    billNo: b.billNo?.trim() || undefined, invoiceKey: key, at: nowIso(), by: { id: f.me.id, name: f.me.name },
  };
  await put(f.db, "disbursement", d.id, d, caseRef);
  f.rec("disbursement.recorded", "disbursement", d.id, null, { caseRef, vendorId: b.vendorId, amount: b.amount, invoice: key });
  return d;
}
export const caseDisbursements = (f: Fin, caseRef: string) => where<Disbursement>(f.db, "disbursement", { ref: caseRef });
const caseInvoicesAll = async (f: Fin, code: string) => (await all<Inv>(f.db, "invoice")).filter((i) => i.caseRef === code);

// ---------------------------------------------------------------- payables from other modules (PRT-09 partner commissions)
export type Payable = { id: string; source: "partner_commission"; payee: string; amount: number; memo: string; status: "due" | "paid" | "cancelled"; at: string; paidAt?: string };
/** Other modules call this inside their own tx once their approval is done; idempotent per id. */
export async function upsertPayable(db: Exec, p: Payable) {
  await put(db, "payable", p.id, p, p.payee);
}
