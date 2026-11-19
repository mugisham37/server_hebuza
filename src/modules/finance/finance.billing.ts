// Finance billing (U5–U7, U11, U15): quotations, invoices, client credit, EBM, reminders, receivables ageing, credit notes.
// Port of src/mocks/handlers-finance-b.ts + the receivables half of handlers-finance-d.ts onto finance_records.
import type { Tx as Exec } from "../../core/db/db";
import { applyPayment, depositSplit, docTotals, fx } from "@/domain/finance/money";
import { canMove, isOverdue } from "@/domain/finance/states";
import {
  BUCKETS,
  ageingBucket,
  ageingSummary,
  daysPastDue,
  type Bucket,
} from "@/domain/finance/ageing";
import type {
  CreditNote,
  DocLine,
  Invoice,
  Payment,
  Quote,
  RefundRequest,
  Series,
  UserRef,
} from "@/domain/finance/types";
import type {
  BillKind,
  CaseOption,
  InvoiceDetail,
  InvoiceRow,
  QuoteDetail,
  QuoteRec,
  BReminder,
} from "./lib/views";
import type {
  ArClient,
  ArClientDetail,
  ArNote,
  ArSummary,
  Channel,
  DReminder,
} from "./lib/views";
import type { Locale } from "@/domain/i18n/config";
import {
  addDays,
  all,
  byRef,
  checkRev,
  fail,
  need,
  nextNo,
  nowIso,
  one,
  put,
  refOf,
  rid,
  sum,
  today,
  where,
  type Fin,
  type Settings,
  tail4,
} from "./finance.store";
import { postCreditApplied, postCreditNote, postInvoice } from "../ledger/ledger.postings";
import { splitVat } from "@/domain/money";
import { casePriceLines } from "./finance.cases";
import { and, eq, sql as dsql } from "drizzle-orm";
import { financeRecords } from "@/db/schema";
import { textPdf } from "../chat/chat.service";

// ---------------------------------------------------------------- records
export type Q = Quote;
export type QMeta = {
  no: string;
  kind: BillKind;
  notes: Record<Locale, string>;
  terms: Record<Locale, string>;
  invoiceNos?: string[];
  changedBy?: UserRef;
  changedAt?: string;
  history: { v: number; status: string; at: string; note?: string }[];
};
export type Inv = Invoice & {
  /** Stable record id; the draft key until issue, then the number is `no`. */
  id: string;
  lang?: Locale;
  quoteNo?: string;
  changedBy?: UserRef;
  changedAt?: string;
  reminders?: BReminder[];
  arReminders?: DReminder[];
  statement?: { at: string; label: string; amount: number }[];
  /** Case invoice mirroring a gateway-collected amount: revenue is posted by the payment, never by the invoice. */
  cashBasis?: boolean;
  gatewayPaymentIds?: string[];
  /** Day offsets already reminded automatically (F-FIN-16). */
  autoReminders?: number[];
};
export const keyOf = (i: Inv) => i.no ?? i.id;
export const saveInv = (db: Exec, i: Inv) => put(db, "invoice", i.id, i, i.no);
export const saveQuote = (db: Exec, q: Q) =>
  put(db, "quote", `${q.no}#${q.version}`, q, q.no);
const saveMeta = (db: Exec, m: QMeta) => put(db, "quote_meta", m.no, m);

const NOTES = {
  en: "Thank you for your business.",
  rw: "Murakoze kutugirira icyizere.",
  fr: "Merci de votre confiance.",
};
const TERMS = {
  en: "Valid until the date shown. Government fees are passed through at cost.",
  rw: "Bifite agaciro kugeza ku itariki yerekanwe. Amafaranga ya Leta yishyurwa uko ari.",
  fr: "Valable jusqu'à la date indiquée. Les frais publics sont refacturés au coût réel.",
};
export const defaultMeta = (no: string, kind: BillKind): QMeta => ({
  no,
  kind,
  notes: { ...NOTES },
  terms: { ...TERMS },
  history: [],
});

/** Invoice by number or draft key. */
export async function invoiceByKey(db: Exec, key: string, lock = false) {
  return (
    (await one<Inv>(db, "invoice", key, lock)) ??
    (await byRef<Inv>(db, "invoice", key, lock))
  );
}
export async function invOr404(db: Exec, key: string, lock = true) {
  const i = await invoiceByKey(db, key, lock);
  if (!i) throw fail(404, "not_found");
  return i;
}

// ---------------------------------------------------------------- validation
function validateLines(lines: DocLine[], S: Settings) {
  need(lines.length, 422, "validation");
  for (const l of lines) {
    const label = typeof l.label === "string" ? l.label : (l.label.en ?? "");
    need(
      label.trim() &&
        Number.isInteger(l.qty) &&
        l.qty >= 1 &&
        Number.isInteger(l.unit) &&
        l.unit >= 0,
      422,
      "validation",
    );
  }
  need(docTotals(lines, S.vat_bps).total > 0, 422, "validation");
}

// ---------------------------------------------------------------- quotes
async function quoteVersions(db: Exec, no: string) {
  return (await where<Q>(db, "quote", { ref: no })).sort(
    (a, b) => b.version - a.version,
  );
}
async function quoteOr404(db: Exec, no: string) {
  const vs = await quoteVersions(db, no);
  if (!vs.length) throw fail(404, "not_found");
  return { q: vs[0], vs };
}
async function metaOf(db: Exec, no: string) {
  return (await one<QMeta>(db, "quote_meta", no)) ?? defaultMeta(no, "company");
}

function view(f: Fin, q: Q, m: QMeta): QuoteRec {
  const c = f.D.caseOf(q.caseRef);
  return {
    ...q,
    clientName: f.D.clientName(q.clientId),
    service: c ? f.D.serviceName(c.service) : "",
    kind: m.kind,
    notes: m.notes,
    terms: m.terms,
    deposit: depositSplit(q.totals.total, {
      bps: f.S.deposit_bps,
      threshold: f.S.deposit_threshold,
    }),
    invoiceNos: m.invoiceNos,
  };
}
async function quoteDetail(f: Fin, no: string): Promise<QuoteDetail> {
  const [vs, m] = await Promise.all([
    quoteVersions(f.db, no),
    metaOf(f.db, no),
  ]);
  return {
    versions: vs.map((q) => view(f, q, m)),
    history: [...m.history].reverse(),
    changedBy: m.changedBy,
    changedAt: m.changedAt,
    threshold: f.S.quote_approval_threshold,
    validityDays: f.S.quote_validity_days,
  };
}
const touchMeta = (f: Fin, m: QMeta) => {
  m.changedBy = refOf(f.me);
  m.changedAt = nowIso();
};
const hist = (m: QMeta, v: number, status: string, note?: string) =>
  m.history.push({ v, status, at: nowIso(), note });

export async function listQuotes(
  f: Fin,
  qs: { state?: string; q?: string; page?: number },
) {
  const [quotes, metas] = await Promise.all([
    all<Q>(f.db, "quote"),
    all<QMeta>(f.db, "quote_meta"),
  ]);
  const latest = new Map<string, Q>();
  for (const q of quotes)
    if ((latest.get(q.no)?.version ?? 0) < q.version) latest.set(q.no, q);
  const mm = new Map(metas.map((m) => [m.no, m]));
  const rows = [...latest.values()]
    .map((q) => view(f, q, mm.get(q.no) ?? defaultMeta(q.no, "company")))
    .sort((a, b) => b.no.localeCompare(a.no));
  const counts: Record<string, number> = { all: rows.length };
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const s = qs.q?.toLowerCase().trim();
  const items = rows.filter(
    (r) =>
      (!qs.state || r.status === qs.state) &&
      (!s ||
        [r.no, r.caseRef, r.clientName, r.service].some((v) =>
          v.toLowerCase().includes(s),
        )),
  );
  return { ...page(items, qs.page ?? 1), counts };
}
export const page = <T>(items: T[], p: number, size = 20) => ({
  items: items.slice((p - 1) * size, p * size),
  meta: {
    total: items.length,
    page: p,
    pages: Math.max(1, Math.ceil(items.length / size)),
  },
});

export function caseOptions(f: Fin): CaseOption[] {
  return f.D.cases
    .filter((c) => !["completed", "cancelled", "refunded"].includes(c.status))
    .map((c) => ({
      ref: c.ref,
      clientId: c.clientId,
      clientName: f.D.clientName(c.clientId),
      service: f.D.serviceName(c.service),
    }));
}
export async function getQuote(f: Fin, no: string) {
  await quoteOr404(f.db, no);
  return quoteDetail(f, no);
}

export async function createQuote(f: Fin, caseRef: string) {
  const c = f.D.caseOf(caseRef);
  need(c, 422, "validation");
  const no = await nextNo(f.db, "QUO");
  const lines = (await casePriceLines(f.db, c!.ref, f.S.vat_bps)) ?? [
    { kind: "service_fee", label: f.D.serviceName(c!.service), qty: 1, unit: c!.amount ?? 0 },
  ];
  const client = f.D.client(c!.clientId);
  const q: Q = {
    no,
    caseRef: c!.ref,
    clientId: c!.clientId,
    version: 1,
    status: "draft",
    lines,
    totals: docTotals(lines, f.S.vat_bps),
    // Deposit rule (D-08): large quotes ask for the configured share up front.
    depositPct: docTotals(lines, f.S.vat_bps).total >= f.S.deposit_threshold ? f.S.deposit_bps : null,
    validUntil: addDays(today(), f.S.quote_validity_days),
    lang: (client?.language ?? "en") as Locale,
    preparedBy: refOf(f.me),
    rev: 1,
  };
  await saveQuote(f.db, q);
  await saveMeta(
    f.db,
    defaultMeta(no, client?.type === "company" ? "company" : "individual"),
  );
  f.rec("quote.created", "quote", no, null, {
    version: 1,
    total: q.totals.total,
  });
  return { no };
}

export type QuotePatch = {
  rev?: number;
  lines?: DocLine[];
  lang?: Locale;
  validUntil?: string;
  kind?: BillKind;
  tin?: string;
  notes?: Record<Locale, string>;
  terms?: Record<Locale, string>;
};
export async function patchQuote(f: Fin, no: string, b: QuotePatch) {
  const { q } = await quoteOr404(f.db, no);
  need(q.status === "draft", 409, "conflict");
  checkRev(q.rev, b.rev);
  const m = await metaOf(f.db, no);
  if (b.lines) {
    q.lines = b.lines;
    q.totals = docTotals(b.lines, f.S.vat_bps);
  }
  if (b.lang) q.lang = b.lang;
  if (b.validUntil) q.validUntil = b.validUntil.slice(0, 10);
  if (b.tin !== undefined) q.orgTin = b.tin || undefined;
  if (b.kind) m.kind = b.kind;
  if (b.notes) m.notes = b.notes;
  if (b.terms) m.terms = b.terms;
  q.rev++;
  touchMeta(f, m);
  await Promise.all([saveQuote(f.db, q), saveMeta(f.db, m)]);
  return quoteDetail(f, no); // autosave is not audited per keystroke; send/approve/convert are
}

export async function sendQuote(
  f: Fin,
  no: string,
  b: { rev?: number; channels?: string[]; message?: string },
) {
  const { q, vs } = await quoteOr404(f.db, no);
  checkRev(q.rev, b.rev);
  need(!vs.some((v) => v !== q && v.status === "accepted"), 409, "conflict");
  need(canMove("quote", q.status, "sent"), 409, "conflict");
  validateLines(q.lines, f.S);
  need(q.validUntil >= today(), 409, "quote_expired");
  need(
    b.channels?.length && (b.message ?? "").length <= 200,
    422,
    "validation",
  );
  const m = await metaOf(f.db, no);
  const before = { status: q.status };
  for (const v of vs)
    if (
      v !== q &&
      ["sent", "changes_requested", "expired", "declined"].includes(v.status)
    ) {
      v.status = "superseded";
      await saveQuote(f.db, v);
    }
  // D-18: an SM quote above the threshold goes to finance approval instead of out (the preparer is not finance).
  if (
    q.totals.total > f.S.quote_approval_threshold &&
    !f.me.roles.includes("staff:finance")
  ) {
    q.status = "pending_approval";
  } else {
    if (q.totals.total > f.S.quote_approval_threshold)
      q.approvedBy = refOf(f.me);
    q.status = "sent";
    q.sentAt = nowIso();
    hist(m, q.version, "sent");
  }
  q.rev++;
  touchMeta(f, m);
  await Promise.all([saveQuote(f.db, q), saveMeta(f.db, m)]);
  f.rec("quote.sent", "quote", q.no, before, {
    status: q.status,
    version: q.version,
    channels: b.channels,
    total: q.totals.total,
  });
  return quoteDetail(f, no);
}

export async function approveQuote(f: Fin, no: string, b: { rev?: number }) {
  const { q } = await quoteOr404(f.db, no);
  checkRev(q.rev, b.rev);
  need(q.status === "pending_approval", 409, "conflict");
  if (q.preparedBy.id === f.me.id) throw fail(403, "same_approver");
  need(q.validUntil >= today(), 409, "quote_expired");
  const m = await metaOf(f.db, no);
  q.approvedBy = refOf(f.me);
  q.status = "sent";
  q.sentAt = nowIso();
  q.rev++;
  touchMeta(f, m);
  hist(m, q.version, "sent");
  await Promise.all([saveQuote(f.db, q), saveMeta(f.db, m)]);
  f.rec(
    "quote.approved",
    "quote",
    q.no,
    { status: "pending_approval" },
    { status: "sent", approvedBy: q.approvedBy.name },
  );
  return quoteDetail(f, no);
}

export async function withdrawQuote(
  f: Fin,
  no: string,
  b: { rev?: number; reason?: string },
) {
  const { q } = await quoteOr404(f.db, no);
  checkRev(q.rev, b.rev);
  need(b.reason?.trim(), 422, "reason_required");
  need(canMove("quote", q.status, "withdrawn"), 409, "conflict");
  const m = await metaOf(f.db, no);
  const before = { status: q.status };
  q.status = "withdrawn";
  q.rev++;
  touchMeta(f, m);
  hist(m, q.version, "withdrawn", b.reason);
  await Promise.all([saveQuote(f.db, q), saveMeta(f.db, m)]);
  f.rec(
    "quote.withdrawn",
    "quote",
    q.no,
    before,
    { status: "withdrawn" },
    b.reason,
  );
  return quoteDetail(f, no);
}

export async function reviseQuote(f: Fin, no: string) {
  const { q, vs } = await quoteOr404(f.db, no);
  need(
    ["sent", "changes_requested", "expired", "declined", "withdrawn"].includes(
      q.status,
    ),
    409,
    "conflict",
  );
  need(!vs.some((v) => v.status === "accepted"), 409, "conflict");
  const m = await metaOf(f.db, no);
  const n: Q = {
    ...q,
    version: q.version + 1,
    status: "draft",
    lines: q.lines.map((l) => ({ ...l })),
    totals: docTotals(q.lines, f.S.vat_bps),
    validUntil: addDays(today(), f.S.quote_validity_days),
    preparedBy: refOf(f.me),
    approvedBy: undefined,
    sentAt: undefined,
    respondedAt: undefined,
    responseNote: undefined,
    rev: 1,
  };
  touchMeta(f, m);
  hist(m, n.version, "draft");
  await Promise.all([saveQuote(f.db, n), saveMeta(f.db, m)]);
  f.rec(
    "quote.revised",
    "quote",
    q.no,
    { version: q.version },
    { version: n.version },
  );
  return quoteDetail(f, no);
}

export async function convertQuote(f: Fin, no: string, b: { rev?: number }) {
  const { q } = await quoteOr404(f.db, no);
  checkRev(q.rev, b.rev);
  need(canMove("quote", q.status, "converted"), 409, "conflict");
  const split = depositSplit(q.totals.total, {
    bps: f.S.deposit_bps,
    threshold: f.S.deposit_threshold,
  });
  const due = addDays(today(), f.S.invoice_terms_days);
  const made: Inv[] = [];
  const mk = (series: Series, lines: DocLine[], dueAt: string) =>
    newInvoice(f, {
      clientId: q.clientId,
      caseRef: q.caseRef,
      series,
      lines,
      dueAt,
      lang: q.lang,
      quoteNo: q.no,
    });
  if (split) {
    // shortcut: deposit invoice carries one non-VAT "other" line (VAT sits inside the quoted total); the balance invoice keeps
    // the quoted lines less the deposit. Upgrade when the spec fixes deposit-invoice VAT treatment.
    made.push(
      mk(
        "deposit",
        [
          {
            kind: "other",
            label: `Deposit · ${q.no} v${q.version}`,
            qty: 1,
            unit: split.deposit,
            taxable: false,
          },
        ],
        addDays(today(), 2),
      ),
    );
    made.push(
      mk(
        "standard",
        [
          ...q.lines.map((l) => ({ ...l })),
          {
            kind: "other",
            label: `Less deposit · ${q.no}`,
            qty: 1,
            unit: -split.deposit,
            taxable: false,
          },
        ],
        due,
      ),
    );
  } else
    made.push(
      mk(
        "standard",
        q.lines.map((l) => ({ ...l })),
        due,
      ),
    );
  for (const inv of made) await issue(f, inv, false);
  const m = await metaOf(f.db, no);
  q.status = "converted";
  q.rev++;
  touchMeta(f, m);
  hist(m, q.version, "converted");
  m.invoiceNos = made.map((i) => i.no!);
  await Promise.all([saveQuote(f.db, q), saveMeta(f.db, m)]);
  f.rec(
    "quote.converted",
    "quote",
    q.no,
    { status: "accepted" },
    { status: "converted", invoices: m.invoiceNos },
  );
  return { invoiceNos: m.invoiceNos };
}

// ---------------------------------------------------------------- invoices
/** System-issued case invoice (finance.cases): issued at once, cash-basis (the gateway payment posts revenue). */
export async function issueCaseInvoice(
  f: Fin,
  o: { clientId: string; caseRef: string; lines: DocLine[]; dueAt: string },
) {
  const inv = newInvoice(f, { ...o, series: "standard" });
  inv.cashBasis = true;
  return issue(f, inv, false);
}
/** Plan renewal invoice (F-SUB-04): cash-basis like case invoices (subscription payments post revenue). */
export async function issuePlanInvoice(
  f: Fin,
  o: { clientId: string; subscriptionId: string; label: string; amountGross: number; dueAt: string },
) {
  const inv = newInvoice(f, {
    clientId: o.clientId,
    series: "plan",
    subscriptionId: o.subscriptionId,
    dueAt: o.dueAt,
    lines: [{ kind: "service_fee", label: o.label, qty: 1, unit: splitVat(o.amountGross, f.S.vat_bps).net }],
  });
  inv.cashBasis = true;
  return issue(f, inv, false);
}
function newInvoice(
  f: Fin,
  o: {
    clientId: string;
    caseRef?: string;
    series: Series;
    lines: DocLine[];
    dueAt: string;
    lang?: Locale;
    subscriptionId?: string;
    quoteNo?: string;
  },
): Inv {
  const c = f.D.client(o.clientId);
  const totals = docTotals(o.lines, f.S.vat_bps);
  return {
    id: rid("DRAFT"),
    no: null,
    series: o.series,
    caseRef: o.caseRef,
    subscriptionId: o.subscriptionId,
    clientId: o.clientId,
    billTo: { name: c?.name ?? o.clientId, email: c?.email },
    status: "draft",
    overdue: false,
    lines: o.lines,
    totals,
    amountPaid: 0,
    amountCredited: 0,
    balanceDue: totals.total,
    dueAt: o.dueAt,
    currency: "RWF",
    rev: 1,
    lang: o.lang ?? ((c?.language ?? "en") as Locale),
    quoteNo: o.quoteNo,
    reminders: [],
    statement: [],
  };
}
const invTouch = (f: Fin, i: Inv) => {
  i.changedBy = refOf(f.me);
  i.changedAt = nowIso();
  i.rev++;
};

/** Draft → issued: gapless number in this transaction, totals frozen, receivable posted to the ledger. */
async function issue(f: Fin, inv: Inv, rev = true) {
  need(canMove("invoice", inv.status, "issued"), 409, "conflict");
  validateLines(inv.lines, f.S);
  const before = { status: inv.status, no: inv.no };
  inv.no = await nextNo(f.db, "INV");
  inv.status = "issued";
  inv.issuedAt = nowIso();
  inv.totals = docTotals(inv.lines, f.S.vat_bps);
  inv.balanceDue = inv.totals.total - inv.amountPaid;
  if (rev) invTouch(f, inv);
  else {
    inv.changedBy = refOf(f.me);
    inv.changedAt = nowIso();
  }
  await saveInv(f.db, inv);
  if (!inv.cashBasis) await postInvoice(f.deps.ledger, f.db, inv.no, inv.totals, f.me.id);
  f.rec("invoice.issued", "invoice", inv.no, before, {
    status: inv.status,
    no: inv.no,
    total: inv.totals.total,
  });
  return inv;
}

const ebmRequired = (i: Invoice) =>
  i.status !== "draft" && i.status !== "void" && i.status !== "paid_by_plan";
export function invRow(f: Fin, i: Inv): InvoiceRow {
  const {
    id: _id,
    lang: _l,
    quoteNo: _q,
    changedBy: _c,
    changedAt: _a,
    reminders: _r,
    arReminders: _ar,
    statement: _s,
    ...rest
  } = i;
  return {
    ...rest,
    key: keyOf(i),
    clientName: f.D.clientName(i.clientId),
    overdue: isOverdue(i, today()),
    ebmRequired: ebmRequired(i),
  };
}
export const plainInvoice = (i: Inv): Invoice => {
  const {
    id: _id,
    lang: _l,
    quoteNo: _q,
    changedBy: _c,
    changedAt: _a,
    reminders: _r,
    arReminders: _ar,
    statement: _s,
    ...rest
  } = i;
  return { ...rest, overdue: isOverdue(i, today()) };
};
export async function clientCredit(db: Exec, clientId: string) {
  return (
    (await one<{ id: string; amount: number }>(db, "client_credit", clientId))
      ?.amount ?? 0
  );
}
export async function addClientCredit(
  db: Exec,
  clientId: string,
  delta: number,
) {
  const cur = await one<{ id: string; amount: number }>(
    db,
    "client_credit",
    clientId,
    true,
  );
  await put(db, "client_credit", clientId, {
    id: clientId,
    amount: (cur?.amount ?? 0) + delta,
  });
}

async function invDetail(f: Fin, i: Inv): Promise<InvoiceDetail> {
  const [payments, cns, credit] = await Promise.all([
    i.no ? where<Payment>(f.db, "payment", { ref: i.no }) : Promise.resolve([]),
    i.no
      ? where<CreditNote>(f.db, "credit_note", { ref: i.no })
      : Promise.resolve([]),
    clientCredit(f.db, i.clientId),
  ]);
  return {
    invoice: invRow(f, i),
    payments,
    creditNotes: cns,
    credit,
    reminders: [...(i.reminders ?? [])].reverse(),
    lang: i.lang ?? "en",
    quoteNo: i.quoteNo,
    changedBy: i.changedBy,
    changedAt: i.changedAt,
    statement: i.statement ?? [],
    confirmedPayments: payments.some((p) =>
      ["confirmed", "confirmed_late"].includes(p.state),
    ),
  };
}

export async function listInvoices(
  f: Fin,
  q: {
    state?: string;
    series?: string;
    client?: string;
    due?: string;
    ebm?: string;
    overdue?: string;
    q?: string;
    page?: number;
  },
) {
  const invs = await all<Inv>(f.db, "invoice");
  const t = today();
  const dueBy =
    q.due === "week"
      ? addDays(t, 7)
      : q.due === "month"
        ? addDays(t, 30)
        : null;
  const s = q.q?.toLowerCase().trim();
  const rows = invs
    .map((i) => invRow(f, i))
    .filter(
      (r) =>
        (!q.state || r.status === q.state) &&
        (!q.series || r.series === q.series) &&
        (!q.client || r.clientId === q.client) &&
        (!dueBy ||
          (!!r.dueAt &&
            r.dueAt.slice(0, 10) >= t &&
            r.dueAt.slice(0, 10) <= dueBy &&
            r.balanceDue > 0)) &&
        (!q.ebm ||
          (q.ebm === "missing"
            ? r.ebmRequired && !r.ebmReceiptNo
            : !!r.ebmReceiptNo)) &&
        (q.overdue !== "1" || r.overdue) &&
        (!s ||
          [r.no ?? "", r.caseRef ?? "", r.clientName].some((v) =>
            v.toLowerCase().includes(s),
          )),
    )
    .sort((a, b) => (b.issuedAt ?? "9").localeCompare(a.issuedAt ?? "9"));
  // Totals for the whole filter, not the page (U7).
  const live = rows.filter((r) => r.status !== "void");
  const totals = {
    total: sum(live, (r) => r.totals.total),
    paid: sum(live, (r) => r.amountPaid),
    balance: sum(live, (r) => r.balanceDue),
  };
  const clients = [...new Set(invs.map((i) => i.clientId))].map((id) => ({
    id,
    name: f.D.clientName(id),
  }));
  const pg = page(rows, q.page ?? 1);
  return { items: pg.items, meta: { ...pg.meta, totals, clients } };
}
export function invoiceForm(f: Fin) {
  return {
    clients: f.D.clients.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type as BillKind,
    })),
    cases: caseOptions(f),
    termsDays: f.S.invoice_terms_days,
    today: today(),
  };
}
export async function getInvoice(f: Fin, key: string) {
  return invDetail(f, await invOr404(f.db, key, false));
}

export async function createInvoice(
  f: Fin,
  b: {
    clientId: string;
    caseRef?: string;
    series?: Series;
    lines: DocLine[];
    dueAt: string;
    lang?: Locale;
    fx?: { currency: string; rate: number };
  },
) {
  need(f.D.client(b.clientId), 422, "validation");
  if (b.caseRef)
    need(f.D.caseOf(b.caseRef)?.clientId === b.clientId, 422, "validation");
  need(b.dueAt.slice(0, 10) >= today(), 422, "validation");
  validateLines(b.lines, f.S);
  const inv = newInvoice(f, {
    clientId: b.clientId,
    caseRef: b.caseRef || undefined,
    series: b.series === "plan" ? "plan" : "standard",
    lines: b.lines,
    dueAt: b.dueAt.slice(0, 10),
    lang: b.lang,
  });
  if (b.fx) inv.fx = { ...b.fx, at: nowIso() };
  await saveInv(f.db, inv);
  f.rec("invoice.draft.created", "invoice", inv.id, null, {
    total: inv.totals.total,
  });
  return { key: inv.id };
}
export async function patchInvoice(
  f: Fin,
  key: string,
  b: { rev?: number; lines?: DocLine[]; dueAt?: string; lang?: Locale },
) {
  const inv = await invOr404(f.db, key);
  need(inv.status === "draft", 409, "conflict"); // invoices are immutable after issue
  checkRev(inv.rev, b.rev);
  if (b.lines) {
    inv.lines = b.lines;
    inv.totals = docTotals(b.lines, f.S.vat_bps);
    inv.balanceDue = inv.totals.total;
  }
  if (b.dueAt) inv.dueAt = b.dueAt.slice(0, 10);
  if (b.lang) inv.lang = b.lang;
  invTouch(f, inv);
  await saveInv(f.db, inv);
  return invDetail(f, inv);
}
export async function issueInvoice(f: Fin, key: string, b: { rev?: number }) {
  const inv = await invOr404(f.db, key);
  checkRev(inv.rev, b.rev);
  await issue(f, inv);
  return invDetail(f, inv);
}
export async function voidInvoice(
  f: Fin,
  key: string,
  b: { rev?: number; reason?: string; note?: string },
) {
  const inv = await invOr404(f.db, key);
  checkRev(inv.rev, b.rev);
  need(b.reason && b.note?.trim(), 422, "reason_required");
  const pays = inv.no
    ? await where<Payment>(f.db, "payment", { ref: inv.no })
    : [];
  if (
    inv.amountPaid > 0 ||
    pays.some((p) => ["confirmed", "confirmed_late"].includes(p.state))
  )
    throw fail(409, "invoice_settled");
  need(canMove("invoice", inv.status, "void"), 409, "conflict");
  const before = { status: inv.status };
  inv.status = "void";
  inv.voidReason = `${b.reason}: ${b.note}`;
  inv.balanceDue = 0;
  invTouch(f, inv);
  await saveInv(f.db, inv);
  // A void keeps its number (A-4) and mirrors the receivable out of the ledger.
  if (inv.no && !inv.cashBasis) {
    await postCreditNote(
      f.deps.ledger,
      f.db,
      `VOID-${inv.no}`,
      {
        subtotal: -inv.totals.subtotal,
        vat: -inv.totals.vat,
        passThrough: -inv.totals.passThrough,
        total: -inv.totals.total,
        eligible: -inv.totals.eligible,
      },
      f.me.id,
    );
  }
  f.rec(
    "invoice.voided",
    "invoice",
    keyOf(inv),
    before,
    { status: "void", no: inv.no },
    inv.voidReason,
  );
  return invDetail(f, inv);
}
export async function applyCredit(
  f: Fin,
  key: string,
  b: { rev?: number; amount?: number },
) {
  const inv = await invOr404(f.db, key);
  checkRev(inv.rev, b.rev);
  const credit =
    (
      await one<{ id: string; amount: number }>(
        f.db,
        "client_credit",
        inv.clientId,
        true,
      )
    )?.amount ?? 0;
  const amount = b.amount ?? 0;
  if (!["issued", "partially_paid"].includes(inv.status) || inv.balanceDue <= 0)
    throw fail(409, "invoice_settled");
  need(Number.isInteger(amount) && amount > 0, 422, "validation");
  need(amount <= credit, 422, "exceeds_credit");
  need(amount <= inv.balanceDue, 422, "exceeds_invoice");
  const r = applyPayment(inv, amount);
  const before = {
    amountPaid: inv.amountPaid,
    balanceDue: inv.balanceDue,
    status: inv.status,
    credit,
  };
  inv.amountPaid += r.applied;
  inv.balanceDue -= r.applied;
  inv.status = r.status === "issued" ? inv.status : r.status;
  (inv.statement ??= []).push({
    at: nowIso(),
    label: "credit_applied",
    amount: r.applied,
  });
  invTouch(f, inv);
  await put(f.db, "client_credit", inv.clientId, {
    id: inv.clientId,
    amount: credit - r.applied,
  });
  await saveInv(f.db, inv);
  await postCreditApplied(f.deps.ledger,f.db, `${keyOf(inv)}:${inv.rev}`, r.applied, f.me.id);
  f.rec("invoice.credit_applied", "invoice", keyOf(inv), before, {
    amountPaid: inv.amountPaid,
    balanceDue: inv.balanceDue,
    status: inv.status,
    credit: credit - r.applied,
  });
  return invDetail(f, inv);
}
export async function recordEbm(
  f: Fin,
  key: string,
  b: { rev?: number; no?: string },
) {
  const inv = await invOr404(f.db, key);
  checkRev(inv.rev, b.rev);
  const no = (b.no ?? "").trim().toUpperCase();
  need(/^[A-Z0-9-]{4,30}$/.test(no), 422, "validation");
  need(inv.status !== "draft" && inv.status !== "void", 409, "conflict");
  const before = { ebmReceiptNo: inv.ebmReceiptNo ?? null };
  inv.ebmReceiptNo = no;
  invTouch(f, inv);
  await saveInv(f.db, inv);
  f.rec("invoice.ebm.recorded", "invoice", keyOf(inv), before, {
    ebmReceiptNo: no,
  });
  return invDetail(f, inv);
}

// ---------------------------------------------------------------- receivables (U11)
const consentOf = (c?: {
  consent?: Partial<Record<Channel, boolean>>;
}): Record<Channel, boolean> => ({
  email: true,
  whatsapp: true,
  sms: true,
  ...c?.consent,
});
/** Kigali quiet hours 21:00–07:00 (SET F-SET-09): messages queue for 07:00. */
function quietUntil(now = new Date()) {
  const h = (now.getUTCHours() + 2) % 24;
  if (h >= 7 && h < 21) return undefined;
  const d = new Date(
    now.getTime() + (h >= 21 ? 24 - h + 7 : 7 - h) * 3_600_000,
  );
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

/**
 * Payment reminder (U11). Validates consent and length, records the reminder and queues the message for the
 * client's channel (quiet hours respected). shortcut: only email is delivered (queueMail no-ops without RESEND key);
 * WhatsApp/SMS are recorded for the outbox until a provider is wired.
 */
export async function remind(
  f: Fin,
  key: string,
  b: { channel: Channel; lang?: Locale; text?: string },
) {
  const inv = await invOr404(f.db, key);
  if (inv.balanceDue <= 0 || inv.status === "void" || inv.status === "draft")
    throw fail(409, "invoice_settled");
  need(["email", "whatsapp", "sms"].includes(b.channel), 422, "validation");
  const client = f.D.client(inv.clientId);
  need(consentOf(client)[b.channel], 422, "no_consent");
  const text =
    b.text?.trim() ||
    `Reminder: invoice ${inv.no} has ${inv.balanceDue} RWF outstanding, due ${inv.dueAt?.slice(0, 10)}.`;
  need(b.channel !== "sms" || text.length <= 320, 422, "validation");
  const lang = b.lang ?? inv.lang ?? "en";
  const rem: DReminder = {
    at: nowIso(),
    channel: b.channel,
    lang,
    by: f.me.name,
    scheduledFor: quietUntil(),
  };
  inv.arReminders = [rem, ...(inv.arReminders ?? [])];
  (inv.reminders ??= []).push({
    at: rem.at,
    channel: b.channel,
    by: f.me.name,
  });
  await saveInv(f.db, inv);
  if (b.channel === "email" && client?.email) {
    await f.deps.mail(
      f.db,
      { to: client.email, subject: `Invoice ${inv.no}`, text },
      rem.scheduledFor ? new Date(rem.scheduledFor) : undefined,
    );
  }
  f.rec(
    "invoice.reminder_sent",
    "invoice",
    keyOf(inv),
    null,
    { channel: rem.channel, lang: rem.lang, scheduledFor: rem.scheduledFor },
    undefined,
    "communication",
  );
  return rem;
}

const openInvoices = (invs: Inv[]) =>
  invs.filter(
    (i) =>
      i.no &&
      i.balanceDue > 0 &&
      i.dueAt &&
      !["void", "draft", "paid_by_plan"].includes(i.status),
  );
const lastOf = (xs: DReminder[]) =>
  xs.reduce<DReminder | undefined>(
    (m, x) => (!m || x.at > m.at ? x : m),
    undefined,
  );
function clientRow(
  f: Fin,
  clientId: string,
  invs: Inv[],
  refunds: RefundRequest[],
  notes: ArNote[],
): ArClient {
  const mine = openInvoices(invs).filter((i) => i.clientId === clientId);
  const t = today();
  const buckets = ageingSummary(mine, t);
  const oldestDays = Math.max(0, ...mine.map((i) => daysPastDue(i.dueAt!, t)));
  const credit = sum(
    refunds.filter(
      (r) =>
        r.status === "completed_as_credit" &&
        invs.find((i) => i.no === r.invoiceNo)?.clientId === clientId,
    ),
    (r) => r.approved ?? r.recommended ?? r.requested,
  );
  const promise = notes.find((n) => n.promiseAt);
  const c = f.D.client(clientId);
  return {
    clientId,
    name: c?.name ?? clientId,
    language: (c?.language ?? "en") as Locale,
    outstanding: BUCKETS.reduce((s, b) => s + buckets[b], 0),
    buckets,
    oldestDays,
    bucket:
      [...BUCKETS].reverse().find((b) => buckets[b] > 0) ??
      ("not_due" as Bucket),
    credit,
    invoices: mine.length,
    lastReminder: lastOf(mine.flatMap((i) => i.arReminders ?? [])),
    promise: promise && { at: promise.promiseAt!, note: promise.text },
  };
}
type NoteRec = ArNote & { clientId: string };
export async function receivablesAgeing(f: Fin): Promise<ArSummary> {
  const [invs, refunds, notes] = await Promise.all([
    all<Inv>(f.db, "invoice"),
    all<RefundRequest>(f.db, "refund"),
    all<NoteRec>(f.db, "ar_note"),
  ]);
  const open = openInvoices(invs);
  const b = ageingSummary(open, today());
  const notesOf = (id: string) =>
    notes
      .filter((n) => n.clientId === id)
      .sort((x, y) => y.at.localeCompare(x.at));
  const clients = [...new Set(open.map((i) => i.clientId))]
    .map((id) => clientRow(f, id, invs, refunds, notesOf(id)))
    .sort((x, y) => y.outstanding - x.outstanding);
  return {
    asOf: nowIso(),
    total: BUCKETS.reduce((s, k) => s + b[k], 0),
    overdue31: b["31_60"] + b["61_90"] + b["90_plus"],
    due0_30: b["0_30"],
    over90: b["90_plus"],
    buckets: b,
    clients,
  };
}
export async function receivableClient(
  f: Fin,
  id: string,
): Promise<ArClientDetail> {
  const c = f.D.client(id);
  if (!c) throw fail(404, "not_found", "No such client.");
  const [invsAll, refunds, notesAll, payments, cns] = await Promise.all([
    all<Inv>(f.db, "invoice"),
    all<RefundRequest>(f.db, "refund"),
    where<NoteRec>(f.db, "ar_note", { ref: id }),
    all<Payment>(f.db, "payment"),
    all<CreditNote>(f.db, "credit_note"),
  ]);
  const notes = notesAll
    .sort((x, y) => y.at.localeCompare(x.at))
    .map(({ clientId: _c, ...n }) => n);
  const invs = invsAll.filter(
    (i) => i.clientId === id && i.no && i.status !== "draft",
  );
  const t = today();
  return {
    client: {
      id,
      name: c.name,
      type: c.type,
      phone: tail4(c.phone),
      email: c.email.replace(/^(.).*@/, "$1•••@"),
      language: c.language as Locale,
      consent: consentOf(c),
    },
    summary: clientRow(f, id, invsAll, refunds, notes),
    invoices: invs.map((i) => ({
      ...plainInvoice(i),
      bucket: i.dueAt ? ageingBucket(i.dueAt, t) : "not_due",
      days: i.dueAt ? daysPastDue(i.dueAt, t) : 0,
      reminders: i.arReminders ?? [],
    })),
    payments: payments.filter((p) => p.clientId === id).map(stripPayment),
    credits: cns.filter((n) => invs.some((i) => i.no === n.invoiceNo)),
    notes,
  };
}
/** Payment as the shared Payment type (drops server-side bookkeeping fields). */
export const stripPayment = (p: Payment): Payment => {
  const {
    journalId: _j,
    lockAt: _l,
    evidence: _e,
    applied: _a,
    credit: _c,
    ...rest
  } = p as Payment & { journalId?: string; lockAt?: number; evidence?: string; applied?: number; credit?: number };
  return rest;
};
export async function addArNote(
  f: Fin,
  clientId: string,
  b: { text?: string; promiseAt?: string },
) {
  need(f.D.client(clientId), 404, "not_found");
  need(b.text?.trim(), 422, "reason_required");
  need(!b.promiseAt || b.promiseAt >= today(), 422, "retroactive");
  const n: NoteRec = {
    id: rid("n"),
    clientId,
    at: nowIso(),
    by: f.me.name,
    text: b.text!.trim(),
    promiseAt: b.promiseAt || undefined,
  };
  await put(f.db, "ar_note", n.id, n, clientId);
  f.rec(
    "receivable.note_added",
    "client",
    clientId,
    null,
    { promiseAt: n.promiseAt },
    n.text,
  );
  const { clientId: _c, ...out } = n;
  return out;
}

// ---------------------------------------------------------------- client side + PDFs (F-FIN-02/04, RFD-05)
export const labelOf = (l: unknown): string =>
  typeof l === "string" ? l : ((l as Partial<Record<Locale, string>> | undefined)?.en ?? "");
/** The client's issued invoices (drafts never leave finance). */
export async function clientInvoices(db: Exec, clientId: string) {
  const rows = await db
    .select({ data: financeRecords.data })
    .from(financeRecords)
    .where(and(eq(financeRecords.kind, "invoice"), dsql`${financeRecords.data}->>'clientId' = ${clientId}`));
  return rows.map((r) => r.data as Inv).filter((i) => i.no && i.status !== "draft");
}
/** Dependency-free text PDF of a priced document (invoice, quote, credit note). */
export function invoiceDocPdf(
  title: string,
  no: string,
  d: { lines: DocLine[]; totals: { subtotal: number; vat: number; passThrough: number; total: number }; billTo?: { name: string }; dueAt?: string; validUntil?: string; caseRef?: string; balanceDue?: number; fx?: { currency: string; rate: number; at: string } },
) {
  const rwf = (n: number) => `${n.toLocaleString("en-US")} RWF`;
  return textPdf(`${title} ${no}`, [
    ...(d.billTo ? [`Bill to: ${d.billTo.name}`] : []),
    ...(d.caseRef ? [`Case: ${d.caseRef}`] : []),
    ...(d.dueAt ? [`Due: ${d.dueAt.slice(0, 10)}`] : []),
    ...(d.validUntil ? [`Valid until: ${d.validUntil.slice(0, 10)}`] : []),
    "",
    ...d.lines.map((l) => `${labelOf(l.label)}  ${l.qty} x ${rwf(l.unit)}${l.kind === "discount" ? " (discount)" : ""}`),
    "",
    `Subtotal (taxable): ${rwf(d.totals.subtotal)}`,
    `VAT: ${rwf(d.totals.vat)}`,
    `Pass-through (government / third party): ${rwf(d.totals.passThrough)}`,
    `Total: ${rwf(d.totals.total)}`,
    ...(d.balanceDue != null ? [`Balance due: ${rwf(d.balanceDue)}`] : []),
    ...(d.fx ? [`Indicative: ${fx(d.totals.total, 1 / d.fx.rate).rwf.toLocaleString("en-US")} ${d.fx.currency} at ${d.fx.rate} RWF/${d.fx.currency} (${d.fx.at.slice(0, 10)}); RWF is the amount due.`] : []),
  ]);
}
export async function quotePdf(f: Fin, no: string) {
  const { q } = await quoteOr404(f.db, no);
  const c = f.D.client(q.clientId);
  return invoiceDocPdf(`Quotation v${q.version}`, q.no, { ...q, billTo: c ? { name: c.name } : undefined });
}
