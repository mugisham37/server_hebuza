// Procurement lane C (contract: handlers-procurement-c.ts): purchase requests (raise, submit with quote rule and
// routing, finance/executive decisions with segregation and limits, budget commitment), purchase orders (issue within
// the R-3 tolerance of the approved PR, send, cancel/close releasing the commitment), goods receipts and reversals.
import { ownUpload } from "../account/account.service";
import {
  daysBetween,
  lineTolerance,
  quotesRequired,
  routeFor,
  totals,
  withCalc,
} from "@/domain/procurement/rules";
import type {
  Condition,
  PurchaseOrder,
  PurchaseRequest,
  Quote,
} from "@/domain/procurement/types";
import {
  budgetOf,
  isExec,
  isFin,
  isProc,
  nextNo,
  nowIso,
  poOf,
  prOf,
  procError,
  read,
  record,
  ref,
  today,
  uid,
  vendorName,
  vendorOf,
  write,
  type Actor,
  type Caller,
  type World,
} from "./procurement.world";

type LineIn = {
  id?: string;
  description: string;
  qty: number;
  unitPrice: number;
};
export type PrIn = {
  title?: string;
  lines?: LineIn[];
  budgetCategory?: string;
  neededBy?: string;
  justification?: string;
  vendorId?: string;
  vendorFreeText?: string;
  quotes?: Quote[];
  chosenQuoteId?: string;
  chosenReason?: string;
  waiveReason?: string;
  workspace?: string;
  draft?: boolean;
};
const mustPr = (w: World, no: string) => {
  const p = prOf(w, no);
  if (!p) throw procError(404, "not_found");
  return p;
};
const seesAll = (a: Actor) => isProc(a) || isFin(a) || isExec(a);

function validatePr(w: World, b: PrIn) {
  const errors: Record<string, string> = {};
  if (
    !b.lines?.length ||
    b.lines.some(
      (l) => !l.description?.trim() || !(l.qty > 0) || !(l.unitPrice > 0),
    )
  )
    errors.lines = "lines";
  if (!b.budgetCategory || !budgetOf(w, b.budgetCategory))
    errors.budgetCategory = "required";
  if (!b.neededBy || b.neededBy < today(w)) errors.neededBy = "date";
  if (
    (b.justification ?? "").trim().length < 10 ||
    (b.justification ?? "").length > 1000
  )
    errors.justification = "length";
  if (Object.keys(errors).length)
    throw procError(422, "validation", { errors });
}
function applyPr(p: PurchaseRequest, b: PrIn) {
  p.lines = b.lines!.map((l, i) =>
    withCalc({
      id: l.id ?? `l${i + 1}`,
      description: l.description.trim(),
      qty: l.qty,
      unitPrice: Math.round(l.unitPrice),
      vatable: false,
    }),
  );
  p.estimatedTotal = totals(p.lines).total;
  p.title = b.title?.trim() || p.lines[0]?.description || p.title;
  Object.assign(p, {
    budgetCategory: b.budgetCategory,
    neededBy: b.neededBy,
    justification: b.justification,
    vendorId: b.vendorId,
    vendorFreeText: b.vendorFreeText,
    quotes: b.quotes ?? p.quotes,
    chosenQuoteId: b.chosenQuoteId,
    chosenReason: b.chosenReason,
  });
}
/** Submit guard (draft → submitted): quotes rule R-2, route R-1/R-8. A waiver routes to the executive. */
function submitPr(
  w: World,
  p: PurchaseRequest,
  a: Actor,
  waiveReason?: string,
) {
  const need = quotesRequired(p.estimatedTotal, w.limits);
  if (p.quotes.length < need && !waiveReason?.trim())
    throw procError(422, "quotes_required", {
      required: need,
      have: p.quotes.length,
    });
  const r = routeFor(
    p.estimatedTotal,
    {
      budget: budgetOf(w, p.budgetCategory),
      quotesWaived: p.quotes.length < need,
    },
    w.limits,
  );
  p.route = r.route;
  p.routeReasons = r.reasons;
  p.status = "submitted";
  p.submittedAt = nowIso(w);
  p.decisions.push({
    step: "submit",
    by: ref(a),
    at: nowIso(w),
    outcome: "done",
    reason: waiveReason,
  });
}
const prDetail = (w: World, p: PurchaseRequest) => ({
  ...p,
  vendorName: vendorName(w, p.vendorId) || p.vendorFreeText,
  budget: budgetOf(w, p.budgetCategory),
  po: p.poNo ? poOf(w, p.poNo) : undefined,
  delivered: p.poNo
    ? ["received", "closed"].includes(poOf(w, p.poNo)?.status ?? "")
    : false,
});

const outstanding = (po: PurchaseOrder, lineId: string) => {
  const l = po.lines.find((x) => x.id === lineId)!;
  return l.qty - l.received;
};
const poDetail = (w: World, po: PurchaseOrder) => {
  const v = vendorOf(w, po.vendorId),
    pr = prOf(w, po.prNo);
  return {
    ...po,
    vendorName: v?.legalName ?? po.vendorId,
    vendorEmail: v?.contacts.find((c) => c.email)?.email,
    vendorStatus: v?.status,
    grns: w.grns.filter((g) => g.poNo === po.no),
    bills: w.bills
      .filter((b) => b.poNo === po.no)
      .map((b) => ({ no: b.no, status: b.status, total: b.total })),
    pr: pr
      ? {
          no: po.prNo,
          title: pr.title,
          requester: pr.requester,
          total: pr.estimatedTotal,
        }
      : undefined,
    receivedPct: Math.round(
      (po.lines.reduce((s, l) => s + Math.min(l.received, l.qty), 0) * 100) /
        Math.max(
          1,
          po.lines.reduce((s, l) => s + l.qty, 0),
        ),
    ),
  };
};
const syncPoStatus = (po: PurchaseOrder) => {
  if (po.status === "closed" || po.status === "cancelled") return;
  const any = po.lines.some((l) => l.received > 0),
    all = po.lines.every((l) => l.received >= l.qty);
  po.status = all ? "received" : any ? "partially_received" : "issued";
};

// ---------------------------------------------------------------- purchase requests
export const listPrs = (c: Caller, q: { mine?: string; status?: string }) =>
  read(c, (w) => {
    const a = w.actor;
    const mine = q.mine === "1" || !seesAll(a);
    const items = w.prs
      .filter(
        (p) =>
          (!mine || p.requester.id === a.id) &&
          (!q.status || p.status === q.status) &&
          (mine || p.status !== "draft" || p.requester.id === a.id),
      )
      .map((p) => prDetail(w, p))
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    return { items };
  });

export const getPr = (c: Caller, no: string) =>
  read(c, (w) => {
    const p = mustPr(w, no);
    if (!seesAll(w.actor) && p.requester.id !== w.actor.id)
      throw procError(403, "forbidden");
    return prDetail(w, p);
  });

export const createPr = (c: Caller, b: PrIn) =>
  write(c, (w) => {
    const a = w.actor;
    if (isExec(a) && !isProc(a)) throw procError(403, "forbidden"); // D-14: executives approve, they don't raise
    validatePr(w, b);
    const p: PurchaseRequest = {
      id: uid("pr"),
      no: nextNo(w, "PR"),
      title: "",
      requester: ref(a),
      requesterWorkspace: b.workspace ?? "procurement",
      lines: [],
      estimatedTotal: 0,
      budgetCategory: b.budgetCategory!,
      neededBy: b.neededBy!,
      justification: b.justification!,
      quotes: [],
      status: "draft",
      route: "finance",
      routeReasons: [],
      decisions: [],
      createdAt: nowIso(w),
      version: 1,
    };
    applyPr(p, b);
    if (!b.draft) submitPr(w, p, a, b.waiveReason);
    w.prs.push(p);
    record(
      w,
      b.draft ? "sup.pr.created" : "sup.pr.submitted",
      "purchase_request",
      p.no,
      null,
      { total: p.estimatedTotal, route: p.route },
      b.waiveReason,
    );
    return prDetail(w, p);
  });

export const PR_ACTIONS = [
  "approve",
  "reject",
  "request-info",
  "note",
  "withdraw",
  "submit",
] as const;
export const isDecision = (action: string) =>
  action === "approve" || action === "reject" || action === "request-info";

export const prAction = (
  c: Caller,
  no: string,
  action: string,
  b: PrIn & { reason?: string; note?: string },
) =>
  write(
    c,
    (w) => {
      const a = w.actor;
      const decide = isDecision(action);
      if (decide && !(isFin(a) || isExec(a))) throw procError(403, "forbidden");
      const p = mustPr(w, no);
      const before = { status: p.status };
      const mine = p.requester.id === a.id;
      const why = b.reason ?? b.note;
      if (decide) {
        if (p.status !== "submitted")
          throw procError(409, "already_decided", {
            status: p.status,
            by: p.decisions.at(-1)?.by.name,
            at: p.decisions.at(-1)?.at,
          });
        if (mine) throw procError(403, "segregation_violation");
        if (
          p.route === "executive"
            ? !isExec(a)
            : !(
                isExec(a) ||
                (isFin(a) && p.estimatedTotal <= w.limits.financeMax)
              )
        )
          throw procError(403, "limit_exceeded");
        if (action !== "approve" && !why?.trim())
          throw procError(422, "reason_required");
        if (action === "approve") {
          p.status = "approved";
          const bud = budgetOf(w, p.budgetCategory);
          if (bud) bud.committed += p.estimatedTotal; // R-8 commitment
        } else p.status = action === "reject" ? "rejected" : "info_requested";
        p.decisions.push({
          step: action === "request-info" ? "request_info" : "approve",
          by: ref(a),
          at: nowIso(w),
          outcome:
            action === "approve"
              ? "approved"
              : action === "reject"
                ? "rejected"
                : "info_requested",
          reason: why,
        });
        p.version++;
        record(
          w,
          `sup.pr.${action === "request-info" ? "info_requested" : action === "approve" ? "approved" : "rejected"}`,
          "purchase_request",
          p.no,
          before,
          { status: p.status },
          why,
        );
        return prDetail(w, p);
      }
      if (action === "note") {
        if (!b.note?.trim()) throw procError(422, "reason_required");
        p.decisions.push({
          step: "request_info",
          by: ref(a),
          at: nowIso(w),
          outcome: "done",
          reason: b.note,
        });
        record(w, "sup.pr.noted", "purchase_request", p.no, null, null, b.note);
        return prDetail(w, p);
      }
      if (!mine) throw procError(403, "forbidden");
      if (action === "withdraw") {
        if (!["draft", "submitted", "info_requested"].includes(p.status))
          throw procError(409, "already_decided", { status: p.status });
        p.status = "withdrawn";
        p.version++;
        record(
          w,
          "sup.pr.withdrawn",
          "purchase_request",
          p.no,
          before,
          { status: p.status },
          b.reason,
        );
        return prDetail(w, p);
      }
      if (action === "submit") {
        if (!["draft", "info_requested"].includes(p.status))
          throw procError(409, "already_decided", { status: p.status });
        if (b.lines) {
          validatePr(w, b);
          applyPr(p, b);
        }
        if (p.status === "info_requested" && b.note?.trim())
          p.decisions.push({
            step: "resubmit",
            by: ref(a),
            at: nowIso(w),
            outcome: "done",
            reason: b.note,
          });
        p.version++;
        submitPr(w, p, a, b.waiveReason);
        record(
          w,
          "sup.pr.submitted",
          "purchase_request",
          p.no,
          before,
          { status: p.status, route: p.route },
          b.note,
        );
        return prDetail(w, p);
      }
      throw procError(404, "not_found");
    },
    { stepUp: action === "approve" },
  );

export const vendorOptions = (c: Caller) =>
  read(c, (w) => ({
    items: w.vendors.map((v) => ({
      id: v.id,
      code: v.code,
      name: v.legalName,
      status: v.status,
      blockReason: v.blockReason,
      vatRegistered: v.vatRegistered,
      paymentTermsDays: v.paymentTermsDays,
      email: v.contacts.find((x) => x.email)?.email,
    })),
  }));

/** Budgets + limits for the raise sheet (any staff; /settings is procurement/finance/exec only). */
export const prContext = (c: Caller) =>
  read(c, (w) => ({
    budgets: w.budgets,
    financeMax: w.limits.financeMax,
    quoteThreshold: w.limits.quoteThreshold,
    quotesRequired: w.limits.quotesRequired,
  }));

// ---------------------------------------------------------------- purchase orders
export const listPos = (c: Caller) =>
  read(c, (w) => ({
    items: w.pos
      .map((p) => poDetail(w, p))
      .sort((x, y) => y.issuedAt.localeCompare(x.issuedAt)),
  }));

export const getPo = (c: Caller, no: string) =>
  read(c, (w) => {
    const po = poOf(w, no);
    if (!po) throw procError(404, "not_found");
    return poDetail(w, po);
  });

const poMail = (w: World, po: PurchaseOrder, to: string) => ({
  to,
  subject: `Purchase order ${po.no}`,
  text: [
    `Purchase order ${po.no}`,
    `Deliver to: ${po.deliveryAddress}`,
    `Needed by: ${po.neededBy}`,
    `Payment terms: ${po.paymentTermsDays} days`,
    "",
    ...po.lines.map(
      (l) =>
        `${l.qty} × ${l.description} @ RWF ${l.unitPrice.toLocaleString("en-US")} = RWF ${l.total.toLocaleString("en-US")}`,
    ),
    "",
    `Subtotal RWF ${po.subtotal.toLocaleString("en-US")} · VAT RWF ${po.vat.toLocaleString("en-US")} · Total RWF ${po.total.toLocaleString("en-US")}`,
    `Please quote ${po.no} on your invoice. Issued by ${po.issuedBy.name} on ${nowIso(w).slice(0, 10)}.`,
  ].join("\n"),
});

/** Mails the PO and queues its PDF (worker renders + stores it; GET purchase-orders/:no/pdf serves it). */
function sendPo(w: World, po: PurchaseOrder, to: string) {
  w.mails.push(poMail(w, po, to));
  w.events.push({ type: "procurement.po.pdf", payload: { no: po.no } });
}

export type PoIn = {
  prNo: string;
  vendorId: string;
  lines: LineIn[];
  deliveryAddress: string;
  paymentTermsDays: number;
  neededBy: string;
  send?: boolean;
};
export const createPo = (c: Caller, b: PoIn) =>
  write(c, (w) => {
    const p = mustPr(w, b.prNo);
    if (p.status !== "approved")
      throw procError(409, "invalid_state", { status: p.status });
    const v = vendorOf(w, b.vendorId);
    if (!v)
      throw procError(422, "validation", { errors: { vendorId: "required" } });
    if (v.status !== "active")
      throw procError(409, "vendor_blocked", {
        reason: v.blockReason ?? v.status,
      });
    if (
      !b.lines?.length ||
      b.lines.some((l) => !(l.qty > 0) || !(l.unitPrice > 0))
    )
      throw procError(422, "validation", { errors: { lines: "lines" } });
    const lines = b.lines.map((l, i) => ({
      ...withCalc({
        id: l.id ?? `l${i + 1}`,
        description: l.description,
        qty: l.qty,
        unitPrice: Math.round(l.unitPrice),
        vatable: v.vatRegistered,
      }),
      received: 0,
    }));
    const t = totals(lines);
    // D-11 PLACEHOLDER(po-over-pr): PO net may exceed the approved PR total by at most the R-3 tolerance.
    if (
      t.subtotal >
      p.estimatedTotal + lineTolerance(p.estimatedTotal, w.limits)
    )
      throw procError(422, "needs_reapproval", { approved: p.estimatedTotal });
    const email = v.contacts.find((x) => x.email)?.email;
    const po: PurchaseOrder = {
      id: uid("po"),
      no: nextNo(w, "PO"),
      prNo: p.no,
      vendorId: v.id,
      lines,
      ...t,
      status: "issued",
      deliveryAddress: b.deliveryAddress,
      paymentTermsDays: b.paymentTermsDays,
      neededBy: b.neededBy,
      issuedBy: ref(w.actor),
      issuedAt: nowIso(w),
      sentAt: b.send && email ? nowIso(w) : undefined,
      sentTo: b.send && email ? email : undefined,
      version: 1,
    };
    w.pos.push(po);
    if (po.sentTo) sendPo(w, po, po.sentTo);
    p.status = "ordered";
    p.poNo = po.no;
    p.version++;
    record(w, "sup.po.issued", "purchase_order", po.no, null, {
      total: po.total,
      vendor: v.code,
      sentTo: po.sentTo,
    });
    return poDetail(w, po);
  });

export type PoActionIn = {
  reason?: string;
  lines?: {
    lineId: string;
    qty: number;
    condition: Condition;
    note?: string;
  }[];
  receivedById?: string;
  receivedAt?: string;
  evidence?: { name: string; uploadId?: string };
  notes?: string;
  service?: boolean;
  reverses?: string;
};
export const poAction = async (
  c: Caller,
  no: string,
  action: string,
  b: PoActionIn,
) => {
  const up = b.evidence?.uploadId && c.session ? await ownUpload(c.db, c.session.id, b.evidence.uploadId) : undefined;
  return write(c, (w) => {
    const a = w.actor;
    if (action !== "receive" && !isProc(a)) throw procError(403, "forbidden");
    const po = poOf(w, no);
    if (!po) throw procError(404, "not_found");
    const before = { status: po.status };
    if (action === "send") {
      const email = vendorOf(w, po.vendorId)?.contacts.find(
        (x) => x.email,
      )?.email;
      if (!email) throw procError(422, "no_email");
      po.sentAt = nowIso(w);
      po.sentTo = email;
      sendPo(w, po, email);
      record(w, "sup.po.sent", "purchase_order", po.no, null, { to: email });
      return poDetail(w, po);
    }
    if (action === "cancel" || action === "close") {
      if (!b.reason?.trim()) throw procError(422, "reason_required");
      if (
        action === "cancel" &&
        (po.status !== "issued" || w.grns.some((x) => x.poNo === po.no))
      )
        throw procError(409, "invalid_state", { status: po.status });
      if (
        action === "close" &&
        !["partially_received", "received"].includes(po.status)
      )
        throw procError(409, "invalid_state", { status: po.status });
      // Release the unreceived share of the PR commitment from the budget (short-close).
      const pr = prOf(w, po.prNo),
        bud = pr && budgetOf(w, pr.budgetCategory);
      const unreceived = po.lines.reduce(
        (s, l) => s + Math.max(0, l.qty - l.received) * l.unitPrice,
        0,
      );
      if (bud) bud.committed = Math.max(0, bud.committed - unreceived);
      po.status = action === "cancel" ? "cancelled" : "closed";
      po.closeReason = b.reason;
      po.version++;
      record(
        w,
        `sup.po.${action === "cancel" ? "cancelled" : "closed"}`,
        "purchase_order",
        po.no,
        before,
        { status: po.status, released: unreceived },
        b.reason,
      );
      return poDetail(w, po);
    }
    if (action === "receive") {
      const pr = prOf(w, po.prNo);
      // Service managers/agents may record a GRN only on POs from their own PR (module §2).
      if (!isProc(a) && pr?.requester.id !== a.id)
        throw procError(403, "forbidden");
      if (!["issued", "partially_received", "received"].includes(po.status))
        throw procError(409, "invalid_state", { status: po.status });
      const reversing = !!b.reverses;
      const lines = (b.lines ?? []).filter((l) => l.qty !== 0);
      if (!lines.length)
        throw procError(422, "validation", { errors: { lines: "qty" } });
      for (const l of lines) {
        const pl = po.lines.find((x) => x.id === l.lineId);
        if (!pl || !Number.isInteger(l.qty))
          throw procError(422, "validation", { errors: { lines: "line" } });
        if (
          reversing
            ? l.qty > 0 || pl.received + l.qty < 0
            : l.qty < 0 || l.qty > outstanding(po, l.lineId)
        )
          throw procError(422, "qty_exceeds_outstanding", {
            lineId: l.lineId,
            outstanding: outstanding(po, l.lineId),
          });
      }
      // R-18 PLACEHOLDER(grn-photo-services): photo required for goods, optional for services and corrections.
      if (!b.service && !reversing && !b.evidence?.name)
        throw procError(422, "evidence_required");
      for (const l of lines)
        po.lines.find((x) => x.id === l.lineId)!.received += l.qty;
      syncPoStatus(po);
      const who =
        pr && b.receivedById === pr.requester.id ? pr.requester : ref(a);
      const grn = {
        id: uid("grn"),
        no: nextNo(w, "GRN"),
        poNo: po.no,
        lines,
        receivedBy: who,
        receivedAt: b.receivedAt ?? nowIso(w),
        evidence: b.evidence
          ? up ?? { id: uid("ev"), name: b.evidence.name }
          : undefined,
        notes: b.notes,
        reverses: b.reverses,
        service: !!b.service,
        invoiced: false,
      };
      w.grns.push(grn);
      po.version++;
      record(
        w,
        reversing ? "sup.grn.reversed" : "sup.grn.recorded",
        "goods_receipt",
        grn.no,
        before,
        { po: po.no, status: po.status, lines },
        b.notes,
      );
      return { grn, po: poDetail(w, po) };
    }
    throw procError(404, "not_found");
  });
};

// ---------------------------------------------------------------- receipts
export const listReceipts = (c: Caller, q: { notInvoiced?: string }) =>
  read(c, (w) => {
    const notInvoiced = q.notInvoiced === "1";
    const reversed = new Set(w.grns.map((x) => x.reverses).filter(Boolean));
    const items = w.grns
      .filter(
        (x) =>
          !notInvoiced || (!x.invoiced && !x.reverses && !reversed.has(x.no)),
      )
      .flatMap((x) => {
        const po = poOf(w, x.poNo);
        if (!po) return [];
        const value = x.lines.reduce(
          (s, l) =>
            s +
            l.qty * (po.lines.find((p) => p.id === l.lineId)?.unitPrice ?? 0),
          0,
        );
        return [
          {
            ...x,
            vendorId: po.vendorId,
            vendorName: vendorName(w, po.vendorId),
            vendorEmail: vendorOf(w, po.vendorId)?.contacts.find((c) => c.email)
              ?.email,
            value,
            ageDays: daysBetween(x.receivedAt, today(w)),
            poStatus: po.status,
            reversed: reversed.has(x.no),
            lineText: x.lines
              .map(
                (l) =>
                  `${l.qty} × ${po.lines.find((p) => p.id === l.lineId)?.description ?? l.lineId}`,
              )
              .join(", "),
          },
        ];
      })
      .sort((x, y) => y.receivedAt.localeCompare(x.receivedAt));
    return { items };
  });

/** "Chase" a delivery: emails the supplier the receipt's text (queued through the world's outbound mail). */
export const chaseReceipt = (c: Caller, no: string, b: { text: string }) =>
  write(c, (w) => {
    const g = w.grns.find((x) => x.no === no);
    const po = g && poOf(w, g.poNo);
    if (!g || !po) throw procError(404, "not_found");
    const to = vendorOf(w, po.vendorId)?.contacts.find((x) => x.email)?.email;
    if (!to) throw procError(422, "no_email");
    w.mails.push({ to, subject: `Delivery follow-up · ${po.no}`, text: b.text });
    record(w, "receipt_chased", "grn", g.no, null, { sentTo: to });
    return { sentTo: to };
  });
