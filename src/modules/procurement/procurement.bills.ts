// Procurement lane D (contract: handlers-procurement-d.ts): bills with duplicate-invoice detection (R-6), blocked
// vendor stop (R-16), three-way match / contract schedule / no-PO route (R-3), approve → authorise (four-eyes by user
// id, limits), dispute/resolve/void, exception requests, advance offsets, recurring contract drafts (R-14), vendor
// payments with the bank-change payment lock (R-7) and remittance advice.
import {
  addDays,
  applyAdvance,
  dueDate,
  guardApprove,
  guardAuthorise,
  guardPay,
  isDuplicate,
  lineTolerance,
  match,
  routeFor,
  totals,
  withCalc,
} from "@/domain/procurement/rules";
import type { Bill, Line, PayMethod } from "@/domain/procurement/types";
import {
  advanceOf,
  billOf,
  budgetOf,
  ACC,
  cashAcc,
  checkVersion,
  journal,
  contractOf,
  isExec,
  isLocked,
  liveStatus,
  nextNo,
  now,
  nowIso,
  poOf,
  procError,
  read,
  record,
  ref,
  today,
  uid,
  vendorName,
  vendorOf,
  write,
  type Caller,
  type World,
} from "./procurement.world";

export type BillInput = {
  vendorId: string;
  vendorInvoiceNo: string;
  invoiceDate: string;
  dueOn?: string;
  poNo?: string;
  contractRef?: string;
  noPoJustification?: string;
  vatMode: "excl" | "incl";
  lines: {
    id: string;
    description: string;
    qty: number;
    unitPrice: number;
    vatable: boolean;
  }[];
  file?: { id: string; name: string };
  submit?: boolean;
};
const view = (w: World, b: Bill) => {
  const v = vendorOf(w, b.vendorId);
  return {
    ...b,
    vendorName: v?.legalName ?? b.vendorId,
    vendorCode: v?.code ?? "",
    locked: v ? isLocked(w, v) : false,
    lockUntil: v?.lockUntil ?? null,
    vendorStatus: v?.status ?? "inactive",
  };
};
const calcLines = (
  i: Pick<BillInput, "lines" | "vatMode">,
  vatRegistered: boolean,
): Line[] =>
  i.lines.map((l) =>
    withCalc(
      {
        id: l.id,
        description: l.description,
        qty: l.qty,
        unitPrice: Math.round(l.unitPrice),
        vatable: vatRegistered && l.vatable,
      },
      i.vatMode,
    ),
  );
const validLines = (lines: BillInput["lines"] | undefined) =>
  !!lines?.length &&
  lines.every(
    (l) =>
      l.id &&
      l.description?.trim() &&
      l.qty > 0 &&
      Number.isFinite(l.unitPrice) &&
      l.unitPrice >= 0,
  );

/** Prepare (R-6 duplicate, R-16 blocked, R-3 match / contract schedule / no-PO route). */
function submit(w: World, b: Bill) {
  const v = vendorOf(w, b.vendorId)!;
  if (v.status === "blocked")
    throw procError(409, "vendor_blocked", { reason: v.blockReason });
  const dup = isDuplicate(
    w.bills.filter((x) => x.status !== "void"),
    b.vendorId,
    b.vendorInvoiceNo,
    b.no,
  );
  if (dup)
    throw procError(409, "duplicate_invoice", { existingBillNo: dup.no });
  const r = routeFor(
    b.total,
    { budget: budgetOf(w, b.budgetCategory), noPo: !b.poNo && !b.contractRef },
    { ...w.limits, financeMax: Number.MAX_SAFE_INTEGER },
  );
  b.route = r.route;
  b.routeReasons = r.reasons;
  b.preparedBy = ref(w.actor);
  b.preparedAt = nowIso(w);
  if (b.poNo) {
    const po = poOf(w, b.poNo);
    if (!po) throw procError(422, "validation");
    const m = match(po.lines, b.lines, w.limits);
    b.match = { result: m.result, lines: m.lines };
    b.status = m.result;
    w.grns.filter((g) => g.poNo === po.no).forEach((g) => (g.invoiced = true));
  } else if (b.contractRef) {
    const c = contractOf(w, b.contractRef);
    const okAmt =
      c && Math.abs(b.total - c.amount) <= lineTolerance(c.amount, w.limits);
    b.match = { result: okAmt ? "contract" : "no_po", lines: [] };
    if (!okAmt) {
      b.route = "executive";
      if (!b.routeReasons.includes("no_po")) b.routeReasons.push("no_po");
    }
    b.status = okAmt ? "matched" : "submitted";
  } else {
    if (!b.noPoJustification?.trim()) throw procError(422, "reason_required");
    b.match = { result: "no_po", lines: [] };
    b.status = "submitted";
  }
  b.version++;
  record(
    w,
    b.status === "match_exception"
      ? "sup.bill.match_exception"
      : "sup.bill.submitted",
    "bill",
    b.no,
    null,
    { status: b.status, total: b.total, route: b.route },
  );
}
const find = (w: World, no: string) => {
  const b = billOf(w, no);
  if (!b) throw procError(404, "not_found");
  return b;
};

export const listBills = (c: Caller) =>
  read(c, (w) => ({ items: w.bills.map((b) => view(w, b)), today: today(w) }));

export const billFormOptions = (c: Caller) =>
  read(c, (w) => ({
    vendors: w.vendors
      .filter((v) => v.status !== "inactive")
      .map((v) => ({
        id: v.id,
        name: v.legalName,
        code: v.code,
        status: v.status,
        blockReason: v.blockReason,
        terms: v.paymentTermsDays,
        vatRegistered: v.vatRegistered,
      })),
    pos: w.pos
      .filter(
        (p) => p.status === "received" || p.status === "partially_received",
      )
      .map((p) => ({
        no: p.no,
        vendorId: p.vendorId,
        lines: p.lines,
        total: p.total,
      })),
    contracts: w.contracts
      .filter((c) => ["active", "expiring"].includes(liveStatus(w, c)))
      .map((c) => ({
        ref: c.ref,
        vendorId: c.vendorId,
        title: c.title,
        amount: c.amount,
        dueDay: c.dueDay,
        budgetCategory: c.budgetCategory,
      })),
  }));

export const checkBillDuplicate = (
  c: Caller,
  q: { vendorId?: string; invoiceNo?: string },
) =>
  read(c, (w) => {
    const d = isDuplicate(
      w.bills.filter((x) => x.status !== "void"),
      q.vendorId ?? "",
      q.invoiceNo ?? "",
    );
    return {
      duplicate: !!d,
      billNo: d?.no,
      vendorName: d ? vendorName(w, d.vendorId) : undefined,
    };
  });

export const getBill = (c: Caller, no: string) =>
  read(c, (w) => {
    const b = find(w, no);
    const v = vendorOf(w, b.vendorId)!;
    return {
      bill: view(w, b),
      vendor: v,
      po: b.poNo ? (poOf(w, b.poNo) ?? null) : null,
      grns: b.poNo ? w.grns.filter((x) => x.poNo === b.poNo) : [],
      contract: b.contractRef ? (contractOf(w, b.contractRef) ?? null) : null,
      payments: w.payments.filter((p) =>
        p.allocations.some((x) => x.billNo === b.no),
      ),
      advances: w.advances.filter(
        (x) =>
          x.vendorId === b.vendorId &&
          (x.kind === "advance" || x.kind === "prepayment") &&
          x.remaining > 0,
      ),
      bankChange:
        w.bankChanges.filter((x) => x.vendorId === v.id).at(-1) ?? null,
      limits: w.limits,
    };
  });

export const createBill = (c: Caller, i: BillInput) =>
  write(c, (w) => {
    const v = vendorOf(w, i.vendorId);
    if (
      !v ||
      !i.vendorInvoiceNo?.trim() ||
      !i.invoiceDate ||
      !validLines(i.lines)
    )
      throw procError(422, "validation");
    if (!i.file) throw procError(422, "validation");
    const lines = calcLines(i, v.vatRegistered);
    const b: Bill = {
      id: uid("bl"),
      no: nextNo(w, "BL"),
      vendorId: v.id,
      vendorInvoiceNo: i.vendorInvoiceNo.trim(),
      invoiceDate: i.invoiceDate,
      dueOn: i.dueOn || dueDate(i.invoiceDate, v.paymentTermsDays),
      poNo: i.poNo || undefined,
      contractRef: i.contractRef || undefined,
      noPoJustification: i.noPoJustification,
      vatMode: i.vatMode,
      lines,
      ...totals(lines),
      appliedAdvances: [],
      payable: 0,
      amountPaid: 0,
      status: "draft",
      route: "finance",
      routeReasons: [],
      file: i.file,
      createdAt: nowIso(w),
      version: 1,
      budgetCategory:
        (i.contractRef && contractOf(w, i.contractRef)?.budgetCategory) ||
        v.categories[0] ||
        "OFFICE",
    };
    b.payable = b.total;
    const dup = isDuplicate(
      w.bills.filter((x) => x.status !== "void"),
      b.vendorId,
      b.vendorInvoiceNo,
    );
    if (dup)
      throw procError(409, "duplicate_invoice", { existingBillNo: dup.no });
    w.bills.unshift(b);
    record(w, "sup.bill.created", "bill", b.no, null, { total: b.total });
    if (i.submit) submit(w, b);
    return view(w, b);
  });

export const correctBill = (
  c: Caller,
  no: string,
  i: Pick<BillInput, "lines" | "vatMode">,
) =>
  write(c, (w) => {
    const b = find(w, no);
    checkVersion(c.ifMatch, b);
    if (!["draft", "match_exception", "submitted"].includes(b.status))
      throw procError(409, "invalid_state");
    if (!validLines(i.lines)) throw procError(422, "validation");
    const before = { lines: b.lines, total: b.total };
    b.vatMode = i.vatMode ?? b.vatMode;
    b.lines = calcLines(
      { lines: i.lines, vatMode: b.vatMode },
      vendorOf(w, b.vendorId)!.vatRegistered,
    );
    Object.assign(b, totals(b.lines));
    b.payable = b.total - b.appliedAdvances.reduce((s, x) => s + x.amount, 0);
    record(w, "sup.bill.updated", "bill", b.no, before, {
      lines: b.lines,
      total: b.total,
    });
    submit(w, b);
    return view(w, b);
  });

export const submitBill = (c: Caller, no: string) =>
  write(c, (w) => {
    const b = find(w, no);
    checkVersion(c.ifMatch, b);
    if (b.status !== "draft") throw procError(409, "invalid_state");
    submit(w, b);
    return view(w, b);
  });

export const approveBill = (c: Caller, no: string, override?: string) =>
  write(
    c,
    (w) => {
      const a = w.actor;
      const b = find(w, no);
      checkVersion(c.ifMatch, b);
      const v = vendorOf(w, b.vendorId)!;
      if (v.status === "blocked") throw procError(409, "vendor_blocked");
      const gr = guardApprove(b, a);
      if (gr === "segregation_violation" && override?.trim() && isExec(a)) {
        b.override = { by: ref(a), reason: override };
        record(
          w,
          "sup.override.used",
          "bill",
          b.no,
          null,
          { step: "approve" },
          override,
        );
      } else if (
        gr === "invalid_state" &&
        ["approved", "authorised", "paid", "partially_paid"].includes(b.status)
      )
        throw procError(409, "already_decided", { by: b.approvedBy?.name });
      else if (gr) throw procError(gr === "invalid_state" ? 409 : 403, gr);
      const from = b.status;
      b.status = "approved";
      b.approvedBy = ref(a);
      b.approvedAt = nowIso(w);
      b.version++;
      const bud = budgetOf(w, b.budgetCategory);
      if (bud) bud.actual += b.total; // R-8 actual
      journal(w, `bill:${b.no}:approve`, `Bill ${b.no} approved`, ACC.expense, ACC.payable, b.total);
      record(
        w,
        "sup.bill.approved",
        "bill",
        b.no,
        { status: from },
        { status: b.status },
      );
      return view(w, b);
    },
    { stepUp: true },
  );

export const authoriseBill = (c: Caller, no: string) =>
  write(
    c,
    (w) => {
      const b = find(w, no);
      checkVersion(c.ifMatch, b);
      const gr = guardAuthorise(b, w.actor, w.limits);
      if (gr === "invalid_state" && b.authorisedBy)
        throw procError(409, "already_decided", { by: b.authorisedBy.name });
      if (gr) throw procError(gr === "invalid_state" ? 409 : 403, gr);
      b.status = "authorised";
      b.authorisedBy = ref(w.actor);
      b.authorisedAt = nowIso(w);
      b.version++;
      record(
        w,
        "supplier_payment.approved",
        "bill",
        b.no,
        { status: "approved" },
        { status: b.status },
      );
      return view(w, b);
    },
    { stepUp: true },
  );

export const rejectBill = (c: Caller, no: string, reason?: string) =>
  write(c, (w) => {
    const b = find(w, no);
    if (!reason?.trim()) throw procError(422, "reason_required");
    if (b.preparedBy?.id === w.actor.id)
      throw procError(403, "segregation_violation");
    if (["paid", "partially_paid", "void", "disputed"].includes(b.status))
      throw procError(409, "invalid_state");
    const before = b.status;
    if (before === "approved") {
      const bud = budgetOf(w, b.budgetCategory);
      if (bud) bud.actual -= b.total;
    }
    b.status = "disputed";
    b.disputedFrom = "draft";
    b.disputeReason = reason;
    b.version++;
    record(
      w,
      "sup.bill.disputed",
      "bill",
      b.no,
      { status: before },
      { status: b.status },
      reason,
    );
    return view(w, b);
  });

export const disputeBill = (c: Caller, no: string, reason?: string) =>
  write(c, (w) => {
    const b = find(w, no);
    if (!reason?.trim()) throw procError(422, "reason_required");
    if (
      ![
        "submitted",
        "matched",
        "match_exception",
        "approved",
        "authorised",
      ].includes(b.status)
    )
      throw procError(409, "invalid_state");
    b.disputedFrom = b.status;
    b.status = "disputed";
    b.disputeReason = reason;
    b.version++;
    record(
      w,
      "sup.bill.disputed",
      "bill",
      b.no,
      { status: b.disputedFrom },
      { status: "disputed" },
      reason,
    );
    return view(w, b);
  });

export const resolveBill = (c: Caller, no: string, reason?: string) =>
  write(c, (w) => {
    const b = find(w, no);
    if (b.status !== "disputed") throw procError(409, "invalid_state");
    if (!reason?.trim()) throw procError(422, "reason_required");
    b.status =
      b.disputedFrom && b.disputedFrom !== "draft" ? b.disputedFrom : "draft";
    delete b.disputedFrom;
    b.version++;
    record(
      w,
      "sup.bill.resolved",
      "bill",
      b.no,
      { status: "disputed" },
      { status: b.status },
      reason,
    );
    return view(w, b);
  });

export const voidBill = (c: Caller, no: string, reason?: string) =>
  write(c, (w) => {
    const b = find(w, no);
    if (!reason?.trim()) throw procError(422, "reason_required");
    if (
      b.amountPaid > 0 ||
      ["paid", "partially_paid", "authorised", "void"].includes(b.status)
    )
      throw procError(409, "invalid_state");
    const before = b.status;
    if (
      before === "approved" ||
      (before === "disputed" && b.disputedFrom === "approved")
    ) {
      const bud = budgetOf(w, b.budgetCategory);
      if (bud) bud.actual -= b.total;
      journal(w, `bill:${b.no}:void`, `Bill ${b.no} voided`, ACC.payable, ACC.expense, b.total);
    }
    b.appliedAdvances.forEach((x, i) =>
      journal(w, `bill:${b.no}:void-adv:${i}`, `Advance ${x.advanceNo} restored`, ACC.advances, ACC.payable, x.amount),
    );
    b.status = "void";
    b.voidReason = reason;
    b.version++;
    b.appliedAdvances.forEach((x) => {
      const ad = advanceOf(w, x.advanceNo);
      if (ad) {
        ad.remaining += x.amount;
        ad.status = "active";
      }
    });
    b.appliedAdvances = [];
    b.payable = b.total;
    record(
      w,
      "sup.bill.voided",
      "bill",
      b.no,
      { status: before },
      { status: "void" },
      reason,
    );
    return view(w, b);
  });

/** Procurement requests an exception approval; the executive decides (step-up). */
export const billException = (
  c: Caller,
  no: string,
  b0: { decision?: "approve" | "reject"; reason?: string },
) =>
  write(
    c,
    (w) => {
      const { decision, reason } = b0;
      if (decision && !isExec(w.actor)) throw procError(403, "forbidden");
      const b = find(w, no);
      if (!reason?.trim()) throw procError(422, "reason_required");
      if (b.status !== "match_exception" || !b.match)
        throw procError(409, "invalid_state");
      if (!decision) {
        b.match.exceptionRequested = true;
        record(
          w,
          "sup.bill.exception_requested",
          "bill",
          b.no,
          null,
          null,
          reason,
        );
      } else if (decision === "approve") {
        b.match.exceptionApproved = true;
        b.status = "matched";
        b.route = "executive";
        record(
          w,
          "sup.bill.exception_approved",
          "bill",
          b.no,
          { status: "match_exception" },
          { status: "matched" },
          reason,
        );
      } else {
        b.match.exceptionRequested = false;
        record(
          w,
          "sup.bill.exception_rejected",
          "bill",
          b.no,
          null,
          null,
          reason,
        );
      }
      b.version++;
      return view(w, b);
    },
    { stepUp: !!b0.decision },
  );

export const applyAdvanceToBill = (
  c: Caller,
  no: string,
  i: { advanceNo: string; amount: number },
) =>
  write(c, (w) => {
    const b = find(w, no);
    const ad = advanceOf(w, i.advanceNo);
    if (!ad || ad.vendorId !== b.vendorId || ad.remaining <= 0)
      throw procError(422, "validation");
    if (["paid", "void", "draft"].includes(b.status))
      throw procError(409, "invalid_state");
    const r = applyAdvance(
      b.payable - b.amountPaid,
      ad.remaining,
      Math.round(i.amount),
    );
    if (!r.applied) throw procError(422, "amount_invalid");
    b.appliedAdvances.push({ advanceNo: ad.no, amount: r.applied });
    journal(w, `bill:${b.no}:adv:${b.appliedAdvances.length}`, `Advance ${ad.no} applied to ${b.no}`, ACC.payable, ACC.advances, r.applied);
    b.payable -= r.applied;
    ad.remaining = r.remaining;
    if (ad.remaining === 0) ad.status = "offset";
    if (
      b.payable - b.amountPaid <= 0 &&
      ["authorised", "partially_paid"].includes(b.status)
    )
      b.status = "paid";
    b.version++;
    record(w, "sup.advance.applied", "bill", b.no, null, {
      advanceNo: ad.no,
      applied: r.applied,
      payable: b.payable,
    });
    return { bill: view(w, b), applied: r.applied };
  });

/** Monthly contracts whose next-period bill isn't drafted yet (R-14; escalation applies from renewal only). */
function recurringDue(w: World) {
  const x = new Date(`${today(w)}T00:00:00Z`);
  const next = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 1))
    .toISOString()
    .slice(0, 10);
  return w.contracts
    .filter(
      (c) =>
        c.frequency === "monthly" &&
        ["active", "expiring"].includes(liveStatus(w, c)) &&
        next <= c.endOn,
    )
    .filter(
      (c) =>
        !w.bills.some(
          (b) =>
            b.contractRef === c.ref &&
            b.status !== "void" &&
            b.invoiceDate.slice(0, 7) === next.slice(0, 7),
        ),
    )
    .map((c) => ({ c, invoiceDate: addDays(next, 0) }));
}

export const recurringPreview = (c: Caller) =>
  read(c, (w) => ({
    items: recurringDue(w).map((x) => ({
      ref: x.c.ref,
      title: x.c.title,
      vendorName: vendorName(w, x.c.vendorId),
      amount: x.c.amount,
      invoiceDate: x.invoiceDate,
    })),
  }));

/** Drafts next month's contract bills; also run by the monthly cron (procurement.jobs.ts). */
export function generateRecurringIn(w: World) {
  return recurringDue(w).map(({ c, invoiceDate }) => {
    const v = vendorOf(w, c.vendorId)!;
    const lines = [
      withCalc({
        id: "l1",
        description: `${c.title}, ${invoiceDate.slice(0, 7)}`,
        qty: 1,
        unitPrice: c.amount,
        vatable: false,
      }),
    ];
    const b: Bill = {
      id: uid("bl"),
      no: nextNo(w, "BL"),
      vendorId: v.id,
      vendorInvoiceNo: `${c.ref}-${invoiceDate.slice(0, 7)}`,
      invoiceDate,
      dueOn: dueDate(invoiceDate, v.paymentTermsDays, c.dueDay),
      contractRef: c.ref,
      vatMode: "excl",
      lines,
      ...totals(lines),
      appliedAdvances: [],
      payable: c.amount,
      amountPaid: 0,
      status: "draft",
      route: "finance",
      routeReasons: [],
      createdAt: nowIso(w),
      version: 1,
      budgetCategory: c.budgetCategory,
      file: { id: uid("f"), name: `${c.ref}-schedule.pdf` },
    };
    w.bills.unshift(b);
    record(w, "sup.bill.created", "bill", b.no, null, {
      recurring: c.ref,
      total: b.total,
    });
    return b.no;
  });
}
export const generateRecurring = (c: Caller) =>
  write(c, (w) => ({ created: generateRecurringIn(w) }));

// ---------------------------------------------------------------- payments
export const listPayments = (c: Caller) =>
  read(c, (w) => ({
    payments: w.payments.map((p) => ({
      ...p,
      vendorName: vendorName(w, p.vendorId),
    })),
    waiting: w.bills
      .filter((b) => b.status === "authorised" || b.status === "partially_paid")
      .map((b) => view(w, b)),
  }));

export type PaymentIn = {
  allocations: { billNo: string; amount: number }[];
  method: PayMethod;
  reference: string;
  proof?: { id: string; name: string };
};
export const recordPayment = (c: Caller, i: PaymentIn) =>
  write(
    c,
    (w) => {
      const a = w.actor;
      if (!i.reference?.trim() || !i.proof || !i.allocations?.length)
        throw procError(422, "validation");
      if (
        new Set(i.allocations.map((x) => x.billNo)).size !==
        i.allocations.length
      )
        throw procError(422, "validation");
      const bills = i.allocations.map((x) => ({ x, b: find(w, x.billNo) }));
      const vendorId = bills[0].b.vendorId;
      for (const { x, b } of bills) {
        if (b.vendorId !== vendorId) throw procError(422, "validation");
        const gr = guardPay(b, a, vendorOf(w, b.vendorId)!, now(w));
        if (gr)
          throw procError(
            gr === "payment_locked" ||
              gr === "vendor_blocked" ||
              gr === "invalid_state"
              ? 409
              : 403,
            gr,
          );
        if (!Number.isInteger(x.amount) || x.amount <= 0)
          throw procError(422, "amount_invalid");
        if (x.amount > b.payable - b.amountPaid)
          throw procError(422, "over_payable");
      }
      const v = vendorOf(w, vendorId)!;
      const pay = {
        id: uid("vp"),
        no: nextNo(w, "VP"),
        vendorId,
        allocations: i.allocations,
        amount: i.allocations.reduce((s, x) => s + x.amount, 0),
        method: i.method,
        reference: i.reference.trim(),
        proof: i.proof,
        paidBy: ref(a),
        paidAt: nowIso(w),
        remittance: {
          no: nextNo(w, "RA"),
          status: "draft" as const,
          to: v.contacts.find((x) => x.email)?.email,
        },
      };
      for (const { x, b } of bills) {
        b.amountPaid += x.amount;
        b.status = b.amountPaid >= b.payable ? "paid" : "partially_paid";
        b.version++;
        record(w, "sup.payment.recorded", "bill", b.no, null, {
          payment: pay.no,
          amount: x.amount,
          status: b.status,
        });
      }
      w.payments.unshift(pay);
      journal(w, `pay:${pay.no}`, `Supplier payment ${pay.no}`, ACC.payable, { code: cashAcc(pay.method) }, pay.amount);
      return pay;
    },
    { stepUp: true },
  );

export const sendRemittance = (c: Caller, no: string) =>
  write(c, (w) => {
    const p = w.payments.find((x) => x.no === no);
    if (!p) throw procError(404, "not_found");
    if (!p.remittance.to) throw procError(422, "no_email");
    const v = vendorOf(w, p.vendorId);
    w.mails.push({
      to: p.remittance.to,
      subject: `Remittance advice ${p.remittance.no}`,
      text: [
        `Remittance advice ${p.remittance.no} for ${v?.legalName ?? p.vendorId}`,
        `Payment ${p.no} · ${p.method} · reference ${p.reference} · ${p.paidAt.slice(0, 10)}`,
        "",
        ...p.allocations.map((x) => {
          const b = billOf(w, x.billNo);
          return `${x.billNo}${b ? ` (your invoice ${b.vendorInvoiceNo})` : ""}: RWF ${x.amount.toLocaleString("en-US")}`;
        }),
        "",
        `Total paid: RWF ${p.amount.toLocaleString("en-US")}`,
      ].join("\n"),
    });
    p.remittance = { ...p.remittance, status: "sent", sentAt: nowIso(w) };
    record(w, "sup.remittance.sent", "payment", p.no, null, {
      remittance: p.remittance.no,
      to: p.remittance.to,
    });
    return p;
  });
