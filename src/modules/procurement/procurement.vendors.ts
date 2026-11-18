// Procurement lane B + E (contract: handlers-procurement-b.ts, handlers-procurement-e.ts): vendors with KYC and
// duplicate checks, bank-change request → four-eyes callback verification → payment lock, masked-field reveal,
// supplier statements, contracts (renewal, termination, snooze), deposits & advances (return, forfeit, offset).
// Clear TINs and bank numbers are Fernet-encrypted secrets; lists only ever carry masked values.
import {
  addDays,
  applyAdvance,
  depositReturnDue,
  escalate,
  maskTin,
  normaliseInvoiceNo,
  paymentLockUntil,
  reminderDates,
  validTin,
} from "@/domain/procurement/rules";
import type {
  Advance,
  AdvanceKind,
  BankKind,
  CallbackLog,
  Contact,
  Contract,
  ContractKind,
  Frequency,
  Vendor,
  VendorType,
} from "@/domain/procurement/types";
import {
  advanceOf,
  billOf,
  budgetOf,
  ACC,
  cashAcc,
  checkVersion,
  journal,
  contractOf,
  getSecret,
  blind,
  isLocked,
  liveStatus,
  nextNo,
  noticeDeadline,
  nowIso,
  prOf,
  procError,
  read,
  record,
  ref,
  secretHash,
  setSecret,
  today,
  uid,
  vendorName,
  vendorOf,
  write,
  type Caller,
  type World,
} from "./procurement.world";

const norm = (s: string) =>
  normaliseInvoiceNo(s).replace(/(LTD|LIMITED|SARL|CO\.?)$/g, "");
export function duplicates(
  w: World,
  tin?: string,
  name?: string,
  except?: string,
) {
  const t = tin?.replace(/\s/g, "");
  const th = t ? blind(w, t) : undefined;
  return w.vendors
    .filter((v) => v.id !== except)
    .flatMap(
      (
        v,
      ): { id: string; code: string; name: string; why: "tin" | "name" }[] => {
        if (
          t &&
          t.length >= 4 &&
          (secretHash(w, `tin:${v.id}`) === th ||
            v.tinMasked.endsWith(t.slice(-4)))
        )
          return [{ id: v.id, code: v.code, name: v.legalName, why: "tin" }];
        if (
          name &&
          name.length > 3 &&
          (norm(v.legalName).includes(norm(name)) ||
            norm(name).includes(norm(v.legalName)))
        )
          return [{ id: v.id, code: v.code, name: v.legalName, why: "name" }];
        return [];
      },
    );
}
export type VendorInput = {
  legalName: string;
  tradingName?: string;
  type: VendorType;
  tin: string;
  rdbNumber?: string;
  categories?: string[];
  contacts?: Contact[];
  address?: string;
  paymentTermsDays?: number;
  vatRegistered?: boolean;
  rating?: number;
  bank?: { kind: BankKind; label: string; number: string };
};
function validate(b: VendorInput) {
  const f: Record<string, string> = {};
  if (!b.legalName?.trim()) f.legalName = "required";
  if (!b.type) f.type = "required";
  if (!validTin(b.tin ?? "")) f.tin = "tin_format";
  if (Object.keys(f).length) throw procError(422, "validation", f);
}
const maskNo = (n: string) => `•••• ${n.replace(/\s/g, "").slice(-4)}`;
const vendorView = (w: World, v: Vendor) => ({ ...v, locked: isLocked(w, v) });
const mustVendor = (w: World, id: string) => {
  const v = vendorOf(w, id);
  if (!v) throw procError(404, "not_found");
  return v;
};

function contractRow(w: World, c: Contract) {
  const t = today(w);
  const next = c.reminders.find((r) => r.on >= t);
  const mine = c.snoozedUntil?.[w.actor.id];
  return {
    ...c,
    status: liveStatus(w, c),
    vendorName: vendorOf(w, c.vendorId)?.legalName ?? "",
    noticeOn: noticeDeadline(c),
    nextReminder: next?.on,
    snoozed: !!mine && mine > t,
  };
}
function statement(w: World, vendorId: string, from: string, to: string) {
  const bills = w.bills.filter(
    (b) => b.vendorId === vendorId && !["draft", "void"].includes(b.status),
  );
  const pays = w.payments.filter((p) => p.vendorId === vendorId);
  const credits = w.advances.filter(
    (a) =>
      a.vendorId === vendorId &&
      (a.kind === "credit_note" || a.kind === "refund"),
  );
  const before = (d: string) => d.slice(0, 10) < from;
  const inP = (d: string) => d.slice(0, 10) >= from && d.slice(0, 10) <= to;
  const opening =
    bills
      .filter((b) => before(b.invoiceDate))
      .reduce((s, b) => s + b.total, 0) -
    pays.filter((p) => before(p.paidAt)).reduce((s, p) => s + p.amount, 0);
  const rows = [
    ...bills
      .filter((b) => inP(b.invoiceDate))
      .map((b) => ({
        date: b.invoiceDate,
        ref: b.no,
        text: `Bill ${b.vendorInvoiceNo}`,
        debit: b.total,
        credit: 0,
      })),
    ...pays
      .filter((p) => inP(p.paidAt))
      .map((p) => ({
        date: p.paidAt.slice(0, 10),
        ref: p.no,
        text: `Payment ${p.reference}`,
        debit: 0,
        credit: p.amount,
      })),
    ...credits
      .filter((c) => c.paidOn && inP(c.paidOn))
      .map((c) => ({
        date: c.paidOn!,
        ref: c.no,
        text: c.note ?? c.kind,
        debit: 0,
        credit: c.amount,
      })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const billed = rows.reduce((s, r) => s + r.debit, 0),
    paid = rows.reduce((s, r) => s + r.credit, 0);
  return {
    from,
    to,
    opening,
    rows,
    billed,
    paid,
    closing: opening + billed - paid,
  };
}

// ---------------------------------------------------------------- vendors
export type VendorQuery = {
  q?: string;
  type?: string;
  status?: string;
  category?: string;
  bank?: string;
};
export const listVendors = (c: Caller, q: VendorQuery) =>
  read(c, (w) => {
    const s = (q.q ?? "").toLowerCase();
    const items = w.vendors.filter(
      (v) =>
        (!s ||
          [v.legalName, v.code, v.tradingName ?? ""].some((x) =>
            x.toLowerCase().includes(s),
          )) &&
        (!q.type || v.type === q.type) &&
        (!q.status || v.status === q.status) &&
        (!q.category || v.categories.includes(q.category)) &&
        (!q.bank || v.bankStatus === q.bank),
    );
    return {
      items: items.map((v) => vendorView(w, v)),
      total: w.vendors.length,
    };
  });

export const checkVendorDuplicate = (
  c: Caller,
  q: { tin?: string; name?: string; except?: string },
) => read(c, (w) => ({ matches: duplicates(w, q.tin, q.name, q.except) }));

export const createVendor = (c: Caller, b: VendorInput) =>
  write(c, (w) => {
    validate(b);
    const id = uid("v");
    const tin = b.tin.replace(/\s/g, "");
    const v: Vendor = {
      id,
      code: nextNo(w, "V"),
      type: b.type,
      legalName: b.legalName.trim().slice(0, 120),
      tradingName: b.tradingName,
      tinMasked: maskTin(tin),
      rdbNumber: b.rdbNumber,
      categories: b.categories ?? [],
      contacts: (b.contacts ?? []).filter((x) => x.name?.trim()),
      address: b.address,
      paymentTermsDays: b.paymentTermsDays || 30,
      bank: b.bank?.number
        ? {
            kind: b.bank.kind,
            label: b.bank.label,
            masked: maskNo(b.bank.number),
          }
        : undefined,
      bankStatus: b.bank?.number ? "unverified" : "verified",
      status: "active",
      rating: b.rating,
      balance: 0,
      openBills: 0,
      documents: [],
      vatRegistered: !!b.vatRegistered,
      version: 1,
    };
    const dups = duplicates(w, tin, b.legalName);
    setSecret(w, `tin:${id}`, tin);
    if (b.bank?.number)
      setSecret(w, `bank:${id}`, b.bank.number.replace(/\s/g, ""));
    w.vendors.unshift(v);
    record(w, "sup.vendor.created", "vendor", v.id, null, {
      code: v.code,
      legalName: v.legalName,
      bank: v.bank?.masked,
    });
    return { vendor: v, duplicates: dups };
  });

export const getVendor = (c: Caller, id: string) =>
  read(c, (w) => {
    const v = mustVendor(w, id);
    return {
      vendor: vendorView(w, v),
      contracts: w.contracts
        .filter((x) => x.vendorId === v.id)
        .map((x) => contractRow(w, x)),
      bills: w.bills
        .filter((b) => b.vendorId === v.id)
        .map((b) => ({
          no: b.no,
          vendorInvoiceNo: b.vendorInvoiceNo,
          dueOn: b.dueOn,
          total: b.total,
          open: b.payable - b.amountPaid,
          status: b.status,
        })),
      payments: w.payments.filter((p) => p.vendorId === v.id),
      advances: w.advances.filter((a) => a.vendorId === v.id),
      bankChange:
        w.bankChanges.filter((x) => x.vendorId === v.id).at(-1) ?? null,
    };
  });

export const updateVendor = (c: Caller, id: string, b: Partial<VendorInput>) =>
  write(c, (w) => {
    const v = mustVendor(w, id);
    checkVersion(c.ifMatch, v);
    const before = {
      legalName: v.legalName,
      categories: v.categories,
      paymentTermsDays: v.paymentTermsDays,
      contacts: v.contacts,
      rating: v.rating,
    };
    if (b.tin !== undefined) {
      if (!validTin(b.tin))
        throw procError(422, "validation", { tin: "tin_format" });
      const tin = b.tin.replace(/\s/g, "");
      v.tinMasked = maskTin(tin);
      setSecret(w, `tin:${v.id}`, tin);
    }
    Object.assign(v, {
      ...(b.legalName && { legalName: b.legalName.trim().slice(0, 120) }),
      ...(b.tradingName !== undefined && { tradingName: b.tradingName }),
      ...(b.type && { type: b.type }),
      ...(b.categories && { categories: b.categories }),
      ...(b.contacts && { contacts: b.contacts.filter((x) => x.name?.trim()) }),
      ...(b.address !== undefined && { address: b.address }),
      ...(b.paymentTermsDays && { paymentTermsDays: b.paymentTermsDays }),
      ...(b.rating !== undefined && { rating: b.rating }),
      ...(b.vatRegistered !== undefined && { vatRegistered: b.vatRegistered }),
      ...(b.rdbNumber !== undefined && { rdbNumber: b.rdbNumber }),
    });
    v.version++;
    record(w, "sup.vendor.updated", "vendor", v.id, before, {
      legalName: v.legalName,
      categories: v.categories,
      paymentTermsDays: v.paymentTermsDays,
      contacts: v.contacts,
      rating: v.rating,
    });
    return v;
  });

export const setVendorStatus = (
  c: Caller,
  id: string,
  b: { to: Vendor["status"]; reason?: string },
) =>
  write(c, (w) => {
    const v = mustVendor(w, id);
    if (b.to !== "active" && !b.reason?.trim())
      throw procError(422, "reason_required");
    const before = { status: v.status, blockReason: v.blockReason };
    v.status = b.to;
    if (b.to === "blocked") v.blockReason = b.reason;
    else delete v.blockReason;
    v.version++;
    record(
      w,
      "sup.vendor.status_changed",
      "vendor",
      v.id,
      before,
      { status: v.status },
      b.reason,
    );
    return v;
  });

/** R-7: a bank change takes effect only after a different finance user verifies it by callback; payments are locked meanwhile. */
export const requestBankChange = (
  c: Caller,
  id: string,
  b: {
    kind: BankKind;
    label: string;
    number?: string;
    reason?: string;
    doc?: string;
  },
) =>
  write(
    c,
    (w) => {
      const v = mustVendor(w, id);
      if (!b.number?.trim() || !b.reason?.trim())
        throw procError(422, "validation", {
          number: b.number ? "" : "required",
          reason: b.reason ? "" : "required",
        });
      if (
        w.bankChanges.some(
          (x) => x.vendorId === v.id && x.status === "requested",
        )
      )
        throw procError(409, "already_pending");
      const bc = {
        id: uid("bc"),
        vendorId: v.id,
        requestedBy: ref(w.actor),
        requestedAt: nowIso(w),
        newKind: b.kind,
        newLabel: b.label,
        newMasked: maskNo(b.number),
        oldMasked: v.bank?.masked,
        callbackNumber: v.contacts.find((x) => x.phone)?.phone,
        reason: b.reason,
        status: "requested" as const,
        doc: b.doc ? { id: uid("doc"), name: b.doc } : undefined,
      };
      setSecret(w, `bankreq:${bc.id}`, b.number.replace(/\s/g, ""));
      w.bankChanges.push(bc);
      v.bankStatus = "unverified";
      delete v.lockUntil;
      v.version++;
      record(
        w,
        "sup.vendor.bank_change_requested",
        "vendor",
        v.id,
        { bank: v.bank?.masked },
        { bank: bc.newMasked },
        b.reason,
      );
      return bc;
    },
    { stepUp: true },
  );

export const listBankChanges = (c: Caller) =>
  read(c, (w) => ({
    items: w.bankChanges.map((x) => ({
      ...x,
      vendorName: vendorName(w, x.vendorId),
      vendorCode: vendorOf(w, x.vendorId)?.code,
    })),
  }));

export const verifyBankChange = (
  c: Caller,
  id: string,
  b: { decision: "verify" | "reject"; callback?: CallbackLog; reason?: string },
) =>
  write(
    c,
    (w) => {
      const bc = w.bankChanges.find((x) => x.id === id);
      if (!bc) throw procError(404, "not_found");
      if (bc.status !== "requested") throw procError(409, "already_decided");
      if (bc.requestedBy.id === w.actor.id)
        throw procError(403, "segregation_violation");
      if (
        b.decision === "verify" &&
        !(
          b.callback?.holderConfirmed &&
          b.callback.last4Confirmed &&
          b.callback.answeredBy?.trim()
        )
      )
        throw procError(422, "validation");
      if (b.decision === "reject" && !b.reason?.trim())
        throw procError(422, "reason_required");
      const v = mustVendor(w, bc.vendorId);
      bc.status = b.decision === "verify" ? "verified" : "rejected";
      bc.verifiedBy = ref(w.actor);
      bc.verifiedAt = nowIso(w);
      bc.callback = b.callback;
      if (bc.status === "verified") {
        v.bank = { kind: bc.newKind, label: bc.newLabel, masked: bc.newMasked };
        const clear = getSecret(w, `bankreq:${bc.id}`);
        if (clear) setSecret(w, `bank:${v.id}`, clear);
      }
      w.secrets.delete(`bankreq:${bc.id}`);
      v.bankStatus = "verified";
      const lock = paymentLockUntil(bc, w.limits);
      if (lock) v.lockUntil = lock;
      else delete v.lockUntil;
      v.version++;
      record(
        w,
        bc.status === "verified"
          ? "sup.vendor.bank_change_verified"
          : "sup.vendor.bank_change_rejected",
        "vendor",
        v.id,
        { bank: bc.oldMasked },
        { bank: v.bank?.masked, lockUntil: v.lockUntil },
        b.reason,
      );
      return { ...bc, lockUntil: v.lockUntil };
    },
    { stepUp: true },
  );

/** Audited reveal of a masked field (sensitive read). */
export const reveal = (
  c: Caller,
  id: string,
  b: { field: "bank" | "tin"; reason?: string },
) =>
  write(c, (w) => {
    const v = mustVendor(w, id);
    if (!b.reason?.trim()) throw procError(422, "reason_required");
    record(
      w,
      b.field === "tin" ? "sup.tin.revealed" : "sup.bank.revealed",
      "vendor",
      v.id,
      null,
      null,
      b.reason,
    );
    const value = getSecret(w, `${b.field}:${v.id}`);
    if (!value) throw procError(404, "not_found");
    return { value };
  });

export const addVendorDocument = (
  c: Caller,
  id: string,
  b: { name?: string; expiresOn?: string },
  upload?: { key: string; expiresAt: string | Date },
) =>
  write(c, (w) => {
    const v = vendorOf(w, id);
    if (!v || !b.name?.trim()) throw procError(404, "not_found");
    const d = {
      id: uid("doc"),
      name: b.name.trim(),
      ...(b.expiresOn ? { expiresOn: b.expiresOn } : {}),
      ...(upload ? { key: upload.key } : {}),
    };
    v.documents.push(d);
    // Scan once the presigned PUT window has passed (infected → quarantined by storage.scan).
    if (upload)
      w.events.push({
        type: "storage.scan",
        payload: { key: upload.key },
        runAt: new Date(Date.now() + 330_000),
      });
    record(w, "sup.document.uploaded", "vendor", v.id, null, d);
    return d;
  });

export const vendorStatement = (
  c: Caller,
  id: string,
  q: { from?: string; to?: string },
) =>
  read(c, (w) => {
    const v = mustVendor(w, id);
    return {
      vendor: {
        id: v.id,
        code: v.code,
        legalName: v.legalName,
        email: v.contacts.find((x) => x.email)?.email ?? null,
      },
      ...statement(w, v.id, q.from || addDays(today(w), -90), q.to || today(w)),
    };
  });

const rwf = (n: number) => `RWF ${n.toLocaleString("en-US")}`;
export const sendStatement = (
  c: Caller,
  id: string,
  b: { from: string; to: string },
) =>
  write(c, (w) => {
    const v = mustVendor(w, id);
    const to = v.contacts.find((x) => x.email)?.email;
    if (!to) throw procError(422, "no_email");
    const s = statement(w, v.id, b.from, b.to);
    w.mails.push({
      to,
      subject: `Statement of account ${b.from} to ${b.to}`,
      text: [
        `Statement for ${v.legalName} (${v.code}), ${b.from} to ${b.to}.`,
        `Opening balance: ${rwf(s.opening)}`,
        ...s.rows.map(
          (r) =>
            `${r.date}  ${r.ref}  ${r.text}  ${r.debit ? rwf(r.debit) : ""}${r.credit ? `-${rwf(r.credit)}` : ""}`,
        ),
        `Closing balance: ${rwf(s.closing)}`,
      ].join("\n"),
    });
    record(w, "data_export", "vendor", v.id, null, {
      statement: `${b.from}..${b.to}`,
      sentTo: to,
    });
    return { sentTo: to, at: nowIso(w) };
  });

// ---------------------------------------------------------------- contracts
export const listContracts = (
  c: Caller,
  q: { q?: string; status?: string; vendor?: string },
) =>
  read(c, (w) => {
    const s = (q.q ?? "").toLowerCase();
    return {
      items: w.contracts
        .map((x) => contractRow(w, x))
        .filter(
          (x) =>
            (!s ||
              [x.ref, x.title, x.vendorName].some((y) =>
                y.toLowerCase().includes(s),
              )) &&
            (!q.status || x.status === q.status) &&
            (!q.vendor || x.vendorId === q.vendor),
        ),
    };
  });

export type ContractIn = Partial<
  Pick<
    Contract,
    | "vendorId"
    | "kind"
    | "title"
    | "startOn"
    | "endOn"
    | "frequency"
    | "dueDay"
    | "autoRenew"
    | "budgetCategory"
  >
> & {
  amount?: number;
  escalationPercent?: number;
  noticeDays?: number;
  depositAmount?: number;
};
export const createContract = (c: Caller, b: ContractIn) =>
  write(c, (w) => {
    const f: Record<string, string> = {};
    for (const k of [
      "vendorId",
      "title",
      "startOn",
      "endOn",
      "budgetCategory",
    ] as const)
      if (!b[k]) f[k] = "required";
    if (!(Number(b.amount) > 0)) f.amount = "required";
    if (b.startOn && b.endOn && b.endOn <= b.startOn) f.endOn = "after_start";
    if (Object.keys(f).length) throw procError(422, "validation", f);
    const v = mustVendor(w, b.vendorId!);
    if (v.status === "blocked") throw procError(409, "vendor_blocked");
    const ct: Contract = {
      id: uid("ct"),
      ref:
        b.kind === "lease"
          ? `CT-LEASE-${String(w.contracts.filter((x) => x.kind === "lease" && !x.versionOf).length + 1).padStart(3, "0")}`
          : nextNo(w, "CT"),
      vendorId: v.id,
      kind: (b.kind ?? "service") as ContractKind,
      title: b.title!,
      startOn: b.startOn!,
      endOn: b.endOn!,
      amount: Math.round(Number(b.amount)),
      frequency: (b.frequency ?? "monthly") as Frequency,
      dueDay: b.dueDay,
      escalationPercent: Number(b.escalationPercent) || 0,
      noticeDays: Number(b.noticeDays) || 30,
      autoRenew: !!b.autoRenew,
      depositAmount: b.depositAmount
        ? Math.round(Number(b.depositAmount))
        : undefined,
      budgetCategory: b.budgetCategory!,
      status: "active",
      ownerId: w.actor.id,
      reminders: reminderDates(b.endOn!, w.limits.reminderOffsets).map((r) => ({
        ...r,
        channel: "in_app" as const,
      })),
      documents: [],
      version: 1,
    };
    if (ct.depositAmount) {
      const no = nextNo(w, "DP", 3);
      ct.depositNo = no;
      w.advances.push({
        id: uid("dp"),
        no,
        vendorId: v.id,
        kind: "deposit",
        amount: ct.depositAmount,
        remaining: ct.depositAmount,
        contractRef: ct.ref,
        returnDueOn: depositReturnDue(ct.endOn, w.limits),
        status: "pending_payment",
      });
    }
    w.contracts.push(ct);
    record(w, "sup.contract.created", "contract", ct.id, null, {
      ref: ct.ref,
      amount: ct.amount,
      endOn: ct.endOn,
    });
    return ct;
  });

export const getContract = (c: Caller, id: string) =>
  read(c, (w) => {
    const ct = contractOf(w, id);
    if (!ct) throw procError(404, "not_found");
    return {
      contract: contractRow(w, ct),
      vendor: vendorOf(w, ct.vendorId) ?? null,
      deposit: ct.depositNo ? (advanceOf(w, ct.depositNo) ?? null) : null,
      bills: w.bills
        .filter((b) => b.contractRef === ct.ref)
        .map((b) => ({
          no: b.no,
          invoiceDate: b.invoiceDate,
          total: b.total,
          status: b.status,
        })),
      versions: w.contracts
        .filter(
          (x) =>
            x.id === ct.versionOf ||
            x.versionOf === ct.id ||
            (ct.versionOf && x.versionOf === ct.versionOf && x.id !== ct.id),
        )
        .map((x) => ({
          id: x.id,
          ref: x.ref,
          startOn: x.startOn,
          endOn: x.endOn,
          amount: x.amount,
          status: liveStatus(w, x),
        })),
      escalated: escalate(ct.amount, ct.escalationPercent),
    };
  });

export const updateContract = (c: Caller, id: string, b: ContractIn) =>
  write(c, (w) => {
    const ct = contractOf(w, id);
    if (!ct) throw procError(404, "not_found");
    checkVersion(c.ifMatch, ct);
    const before = {
      title: ct.title,
      amount: ct.amount,
      endOn: ct.endOn,
      noticeDays: ct.noticeDays,
      escalationPercent: ct.escalationPercent,
      autoRenew: ct.autoRenew,
    };
    if (b.title !== undefined) ct.title = b.title;
    if (b.dueDay !== undefined) ct.dueDay = b.dueDay;
    if (b.autoRenew !== undefined) ct.autoRenew = b.autoRenew;
    if (b.budgetCategory !== undefined) ct.budgetCategory = b.budgetCategory;
    if (b.amount) ct.amount = Math.round(Number(b.amount));
    if (b.noticeDays) ct.noticeDays = Number(b.noticeDays);
    if (b.escalationPercent !== undefined)
      ct.escalationPercent = Number(b.escalationPercent);
    if (b.endOn && b.endOn !== ct.endOn) {
      ct.endOn = b.endOn;
      ct.reminders = reminderDates(ct.endOn, w.limits.reminderOffsets).map(
        (r) => ({ ...r, channel: "in_app" as const }),
      );
    }
    ct.version++;
    record(w, "sup.contract.updated", "contract", ct.id, before, {
      title: ct.title,
      amount: ct.amount,
      endOn: ct.endOn,
      noticeDays: ct.noticeDays,
      escalationPercent: ct.escalationPercent,
      autoRenew: ct.autoRenew,
    });
    return ct;
  });

export const requestRenewal = (
  c: Caller,
  id: string,
  b: { amount: number; endOn: string; noticeDays?: number; reason?: string },
) =>
  write(c, (w) => {
    const ct = contractOf(w, id);
    if (!ct) throw procError(404, "not_found");
    if (ct.renewal?.status === "requested")
      throw procError(409, "already_pending");
    if (!(b.amount > 0) || !b.endOn || b.endOn <= ct.endOn)
      throw procError(422, "validation", { endOn: "after_end" });
    const esc = escalate(ct.amount, ct.escalationPercent);
    if (Math.round(b.amount) !== esc && !b.reason?.trim())
      throw procError(422, "reason_required");
    ct.renewal = {
      amount: Math.round(b.amount),
      endOn: b.endOn,
      noticeDays: b.noticeDays || ct.noticeDays,
      reason: b.reason ?? "",
      status: "requested",
      by: w.actor.name,
      at: nowIso(w),
    };
    ct.version++;
    record(
      w,
      "sup.contract.renewal_requested",
      "contract",
      ct.id,
      { amount: ct.amount, endOn: ct.endOn },
      { amount: ct.renewal.amount, endOn: ct.renewal.endOn },
      b.reason,
    );
    return ct.renewal;
  });

/** D-12 PLACEHOLDER(renewal-approver): the executive approves every renewal → new version active, old renewed, deposit carried over. */
export const decideRenewal = (
  c: Caller,
  id: string,
  b: { decision: "approve" | "reject"; reason?: string },
) =>
  write(
    c,
    (w) => {
      const ct = contractOf(w, id);
      if (!ct?.renewal) throw procError(404, "not_found");
      if (ct.renewal.status !== "requested")
        throw procError(409, "already_decided");
      if (b.decision === "reject" && !b.reason?.trim())
        throw procError(422, "reason_required");
      ct.renewal.status = b.decision === "approve" ? "approved" : "rejected";
      ct.renewal.decidedBy = w.actor.name;
      let next: Contract | undefined;
      if (b.decision === "approve") {
        const root = ct.versionOf ?? ct.id;
        next = {
          ...ct,
          id: uid("ct"),
          ref: `${ct.ref.replace(/-R\d+$/, "")}-R${w.contracts.filter((x) => x.versionOf === root).length + 1}`,
          startOn: addDays(ct.endOn, 1),
          endOn: ct.renewal.endOn,
          amount: ct.renewal.amount,
          noticeDays: ct.renewal.noticeDays,
          status: "active",
          versionOf: root,
          renewal: undefined,
          snoozedUntil: undefined,
          version: 1,
          reminders: reminderDates(
            ct.renewal.endOn,
            w.limits.reminderOffsets,
          ).map((r) => ({ ...r, channel: "in_app" as const })),
          documents: [],
        };
        w.contracts.push(next);
        ct.status = "renewed";
        if (ct.depositNo) {
          const d = advanceOf(w, ct.depositNo);
          if (d) {
            d.contractRef = next.ref;
            d.returnDueOn = depositReturnDue(next.endOn, w.limits);
          }
          next.depositNo = ct.depositNo;
        }
      }
      ct.version++;
      record(
        w,
        b.decision === "approve"
          ? "sup.contract.renewed"
          : "sup.contract.renewal_rejected",
        "contract",
        ct.id,
        null,
        { next: next?.ref, amount: ct.renewal.amount },
        b.reason,
      );
      return { contract: ct, next };
    },
    { stepUp: true },
  );

export const terminateContract = (
  c: Caller,
  id: string,
  b: { effectiveOn?: string; checklist?: string[]; reason?: string },
) =>
  write(c, (w) => {
    const ct = contractOf(w, id);
    if (!ct) throw procError(404, "not_found");
    if (!b.effectiveOn || !b.reason?.trim())
      throw procError(422, "validation", {
        effectiveOn: b.effectiveOn ? "" : "required",
        reason: b.reason ? "" : "required",
      });
    const before = { status: ct.status, endOn: ct.endOn };
    ct.termination = {
      effectiveOn: b.effectiveOn,
      checklist: b.checklist ?? [],
      at: nowIso(w),
    };
    ct.status = "terminated";
    ct.endOn = b.effectiveOn;
    if (ct.depositNo) {
      const d = advanceOf(w, ct.depositNo);
      if (d && ["held", "paid_out"].includes(d.status)) {
        d.returnDueOn = depositReturnDue(b.effectiveOn, w.limits);
        d.status = "return_due";
      }
    }
    ct.version++;
    record(
      w,
      "sup.contract.terminated",
      "contract",
      ct.id,
      before,
      { status: ct.status, endOn: ct.endOn, deposit: ct.depositNo },
      b.reason,
    );
    return ct;
  });

export const snoozeContract = (c: Caller, id: string) =>
  write(c, (w) => {
    const ct = contractOf(w, id);
    if (!ct) throw procError(404, "not_found");
    ct.snoozedUntil = {
      ...ct.snoozedUntil,
      [w.actor.id]: addDays(today(w), 7),
    };
    record(w, "sup.contract.snoozed", "contract", ct.id, null, {
      until: ct.snoozedUntil[w.actor.id],
    });
    return { until: ct.snoozedUntil[w.actor.id] };
  });

/** Executive drawer read (lane E). */
export const contractForExec = (c: Caller, refOrId: string) =>
  read(c, (w) => {
    const ct = contractOf(w, refOrId);
    if (!ct) throw procError(404, "not_found");
    return { contract: ct, vendorName: vendorName(w, ct.vendorId) };
  });

// ---------------------------------------------------------------- deposits & advances
const HELD = ["held", "return_due", "partially_returned"];
export const listDeposits = (c: Caller) =>
  read(c, (w) => {
    const t = today(w);
    return {
      items: w.advances.map((x) => ({
        ...x,
        vendorName: vendorOf(w, x.vendorId)?.legalName ?? "",
        overdueDays:
          x.returnDueOn && HELD.includes(x.status) && x.returnDueOn < t
            ? Math.round((Date.parse(t) - Date.parse(x.returnDueOn)) / 864e5)
            : 0,
      })),
      openBills: w.bills
        .filter(
          (b) =>
            [
              "submitted",
              "matched",
              "approved",
              "authorised",
              "partially_paid",
            ].includes(b.status) && b.payable > 0,
        )
        .map((b) => ({
          no: b.no,
          vendorId: b.vendorId,
          total: b.total,
          payable: b.payable,
          vendorInvoiceNo: b.vendorInvoiceNo,
        })),
    };
  });

export const createAdvance = (
  c: Caller,
  b: {
    kind: AdvanceKind;
    vendorId: string;
    amount: number;
    contractRef?: string;
    note?: string;
    returnDueOn?: string;
  },
) =>
  write(c, (w) => {
    if (!vendorOf(w, b.vendorId) || !(b.amount > 0))
      throw procError(422, "validation", {
        vendorId: vendorOf(w, b.vendorId) ? "" : "required",
        amount: b.amount > 0 ? "" : "required",
      });
    const ct = b.contractRef ? contractOf(w, b.contractRef) : undefined;
    const x: Advance = {
      id: uid("adv"),
      no: nextNo(w, b.kind === "deposit" ? "DP" : "ADV", 3),
      vendorId: vendorOf(w, b.vendorId)!.id,
      kind: b.kind,
      amount: Math.round(b.amount),
      remaining: Math.round(b.amount),
      contractRef: ct?.ref,
      note: b.note,
      returnDueOn:
        b.kind === "deposit"
          ? b.returnDueOn ||
            (ct ? depositReturnDue(ct.endOn, w.limits) : undefined)
          : undefined,
      // Credits/refunds are money owed to the firm; deposits/advances wait for finance's payment record.
      status:
        b.kind === "refund" || b.kind === "credit_note"
          ? "active"
          : "pending_payment",
      paidOn: today(w),
    };
    w.advances.push(x);
    // Money we place with the supplier: claim (1300) against what we owe them (2150).
    // shortcut: no payout event yet, so the cash leg (Dr 2150 / Cr cash) is not posted; add it when a payout route lands.
    if (x.status === "pending_payment")
      journal(w, `adv:${x.no}:open`, `${x.kind === "deposit" ? "Deposit" : "Advance"} ${x.no} placed`, ACC.advances, ACC.payable, x.amount);
    record(w, "sup.advance.created", "advance", x.no, null, {
      kind: x.kind,
      amount: x.amount,
      vendor: x.vendorId,
    });
    return x;
  });

export const returnDeposit = (
  c: Caller,
  id: string,
  b: {
    received: number;
    bankRef?: string;
    date?: string;
    deductions?: { reason: string; amount: number }[];
    proof?: string;
  },
) =>
  write(c, (w) => {
    const x = advanceOf(w, id);
    if (!x) throw procError(404, "not_found");
    const ded = (b.deductions ?? [])
      .filter((d) => d.amount > 0)
      .map((d) => ({ reason: d.reason, amount: Math.round(d.amount) }));
    if (ded.some((d) => !d.reason?.trim()))
      throw procError(422, "validation", { deductions: "reason_required" });
    const dedSum = ded.reduce((s, d) => s + d.amount, 0);
    const received = Math.round(b.received);
    if (
      !(received >= 0) ||
      !b.bankRef?.trim() ||
      received + dedSum > x.remaining
    )
      throw procError(422, "validation", { received: "too_much" });
    const before = { remaining: x.remaining, status: x.status };
    x.remaining -= received + dedSum;
    x.returned = (x.returned ?? 0) + received;
    x.deductions = [...(x.deductions ?? []), ...ded];
    journal(w, `adv:${x.no}:ret:${x.returned}`, `Deposit ${x.no} returned (${b.bankRef})`, { code: cashAcc("bank") }, ACC.advances, received);
    journal(w, `adv:${x.no}:ded:${x.deductions.length}`, `Deposit ${x.no} deductions`, ACC.depositLoss, ACC.advances, dedSum);
    x.status =
      x.remaining === 0
        ? x.kind === "deposit"
          ? "returned"
          : "received"
        : "partially_returned";
    record(w, "sup.deposit.returned", "advance", x.no, before, {
      remaining: x.remaining,
      status: x.status,
      received,
      deductions: ded,
      ref: b.bankRef,
    });
    return x;
  });

export const requestForfeit = (c: Caller, id: string, b: { reason?: string }) =>
  write(c, (w) => {
    const x = advanceOf(w, id);
    if (!x) throw procError(404, "not_found");
    if (!b.reason?.trim()) throw procError(422, "reason_required");
    if (x.forfeit?.status === "requested")
      throw procError(409, "already_pending");
    x.forfeit = { reason: b.reason, status: "requested", by: w.actor.name };
    record(
      w,
      "sup.deposit.forfeit_requested",
      "advance",
      x.no,
      null,
      { amount: x.remaining },
      b.reason,
    );
    return x;
  });

export const decideForfeit = (
  c: Caller,
  id: string,
  b: { decision: "approve" | "reject"; reason?: string },
) =>
  write(
    c,
    (w) => {
      const x = advanceOf(w, id);
      if (!x?.forfeit) throw procError(404, "not_found");
      if (x.forfeit.status !== "requested")
        throw procError(409, "already_decided");
      x.forfeit.status = b.decision === "approve" ? "approved" : "rejected";
      const before = { status: x.status, remaining: x.remaining };
      if (b.decision === "approve") {
        x.status = "forfeited";
        journal(w, `adv:${x.no}:forfeit`, `Deposit ${x.no} forfeited`, ACC.depositLoss, ACC.advances, x.remaining);
        x.deductions = [
          ...(x.deductions ?? []),
          { reason: x.forfeit.reason, amount: x.remaining },
        ];
        x.remaining = 0;
      }
      record(
        w,
        "sup.deposit.forfeited",
        "advance",
        x.no,
        before,
        { status: x.status, decision: b.decision },
        b.reason,
      );
      return x;
    },
    { stepUp: true },
  );

export const offsetAdvance = (
  c: Caller,
  id: string,
  b: { billNo: string; amount: number },
) =>
  write(c, (w) => {
    const x = advanceOf(w, id);
    const bill = billOf(w, b.billNo);
    if (!x || !bill) throw procError(404, "not_found");
    if (
      x.vendorId !== bill.vendorId ||
      !["advance", "prepayment", "credit_note", "refund"].includes(x.kind)
    )
      throw procError(422, "validation", { billNo: "other_vendor" });
    if (bill.amountPaid > 0 || ["paid", "void", "draft"].includes(bill.status))
      throw procError(409, "invalid_state");
    const r = applyAdvance(bill.payable, x.remaining, Math.round(b.amount));
    if (r.applied <= 0) throw procError(422, "validation", { amount: "zero" });
    const before = { payable: bill.payable, remaining: x.remaining };
    bill.appliedAdvances.push({ advanceNo: x.no, amount: r.applied });
    journal(w, `bill:${bill.no}:adv:${bill.appliedAdvances.length}`, `Advance ${x.no} applied to ${bill.no}`, ACC.payable, ACC.advances, r.applied);
    bill.payable = r.payable;
    bill.version++;
    x.remaining = r.remaining;
    if (x.remaining === 0) x.status = "offset";
    record(w, "sup.advance.applied", "bill", bill.no, before, {
      payable: bill.payable,
      remaining: x.remaining,
      advance: x.no,
    });
    return { bill: { no: bill.no, payable: bill.payable }, advance: x };
  });

/** PR read for the approval drawer (lane E). */
export const prForApprover = (c: Caller, no: string) =>
  read(c, (w) => {
    const p = w.prs.find((x) => x.no === no) ?? prOf(w, no);
    if (!p) throw procError(404, "not_found");
    return {
      pr: p,
      budget: budgetOf(w, p.budgetCategory),
      limits: w.limits,
      vendorName: vendorName(w, p.vendorId) || p.vendorFreeText,
    };
  });
