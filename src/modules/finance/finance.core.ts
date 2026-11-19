// Finance core read models + settings (plan 05 §9.2–9.3, U17): summary badges, approvals inbox, notifications, payables tile,
// effective-dated tax/limit settings with executive approval, numbering/policy proposals, payout accounts (masked,
// Fernet-encrypted, reveal audited, call-back verified) and the financial change history + export.
import { and, desc, gte, or, like } from "drizzle-orm";
import type { Tx as Exec } from "../../core/db/db";
import { auditLog } from "@/db/schema";
import { servicePriceChanges } from "@/db/schema/schema-catalogue";
import { eq } from "drizzle-orm";
import { canSign, settingChain, sign } from "@/domain/finance/approvals";
import { isRetroactive } from "@/domain/finance/rules";
import type {
  ApprovalItem,
  FinNote,
  FinSummary,
  FinanceSettingKey,
  Payment,
  SettingChange,
  SettingRow,
  Step,
} from "@/domain/finance/types";
import type {
  FinAccount,
  HistoryRow,
  LocalChange,
  NumberingRow,
} from "./lib/views";
import {
  POLICY,
  SETTING_DEFAULTS,
  accepted,
  all,
  fail,
  isExec,
  isExecOnly,
  isFinanceUser,
  lastUsed,
  need,
  nowIso,
  one,
  put,
  refOf,
  rid,
  today,
  where,
  type Actor,
  type Fin,
} from "./finance.store";
import type { Payable } from "./finance.cases";
import type { R } from "./finance.refunds";
import type { Alloc, Batch } from "./finance.revenue";

// ---------------------------------------------------------------- approvals inbox + summary
const mineOf = (
  chain: Step[],
  a: Actor,
  makers: string[],
): ApprovalItem["mine"] => {
  const c = canSign(chain, a, makers);
  return c.ok ? "sign" : c.reason === "same_approver" ? "waiting" : "blocked";
};
type Q = {
  pays: Payment[];
  refunds: R[];
  allocs: Alloc[];
  changes: SettingChange[];
  batches: Batch[];
  lines: { match: string }[];
  prices: (typeof servicePriceChanges.$inferSelect)[];
};
async function queues(db: Exec): Promise<Q> {
  const [pays, refunds, allocs, changes, batches, lines] = await Promise.all([
    where<Payment>(db, "payment", {
      status: ["proof_submitted", "under_verification", "pending_provider"],
    }),
    all<R>(db, "refund"),
    where<Alloc>(db, "allocation", { status: ["reviewed"] }),
    where<SettingChange>(db, "setting_change", { status: ["proposed"] }),
    where<Batch>(db, "batch", { status: ["submitted"] }),
    all<{ match: string }>(db, "line"),
  ]);
  // F-CAT-10 catalogue price changes waiting for finance (decided on the service's pricing step).
  const prices = await db.select().from(servicePriceChanges).where(eq(servicePriceChanges.status, "pending"));
  return { pays, refunds, allocs, changes, batches, lines, prices };
}
function approvalsOf(f: Fin, w: Q): ApprovalItem[] {
  const a = f.me;
  const items: ApprovalItem[] = [];
  for (const p of w.pays)
    if (
      p.chain &&
      (p.state === "under_verification" ||
        (p.state === "proof_submitted" && p.chain.some((s) => s.signedBy)))
    )
      items.push({
        id: p.id,
        type: "manual_payment",
        record: p.bankReference ?? p.id,
        href: `/finance/payments/proofs?id=${p.id}`,
        maker: {
          id: p.makerId ?? "",
          name: p.makerId ? (f.D.client(p.makerId)?.name ?? p.makerId) : "",
        },
        amount: p.amountExpected,
        reason: "manual_confirm",
        at: p.at,
        slaAt: new Date(Date.parse(p.at) + POLICY.manualReturnMs).toISOString(),
        mine: mineOf(p.chain, a, p.makerId ? [p.makerId] : []),
      });
  for (const r of w.refunds)
    if (["recommended", "awaiting_executive"].includes(r.status))
      items.push({
        id: r.no,
        type: "refund",
        record: r.no,
        href: `/finance/refunds/${r.no}`,
        maker: r.chain[0]?.signedBy ?? r.requestedBy,
        amount: r.recommended ?? r.requested,
        reason: r.reason,
        at: r.at,
        mine: mineOf(r.chain, a, [
          r.requestedBy.id,
          ...(r.adjustedBy ? [r.adjustedBy.id] : []),
        ]),
      });
  for (const al of w.allocs)
    items.push({
      id: al.id,
      type: "allocation",
      record: al.caseRef,
      href: `/finance/revenue?tab=allocations&id=${al.id}`,
      maker: al.reviewedBy ?? { id: "", name: "Service manager" },
      amount: al.pool,
      reason: "allocation_review",
      at: al.frozenAt,
      mine: isFinanceUser(a) || isExec(a) ? "sign" : "blocked",
    });
  for (const ch of w.changes)
    items.push({
      id: ch.id,
      type: "setting",
      record: ch.key,
      href: `/finance/settings/history?id=${ch.id}`,
      maker: ch.proposedBy,
      amount: null,
      reason: ch.reason,
      at: ch.effectiveAt,
      mine: mineOf(sign(settingChain(), ch.proposedBy, ch.effectiveAt), a, [
        ch.proposedBy.id,
      ]),
    });
  for (const b of w.batches)
    items.push({
      id: b.no,
      type: "batch",
      record: b.no,
      href: `/finance/payouts/${b.no}`,
      maker: b.preparedBy,
      amount: b.totals.net,
      reason: "batch_authorise",
      at: b.period,
      mine:
        a.id === b.preparedBy.id
          ? "waiting"
          : isFinanceUser(a) || isExec(a)
            ? "sign"
            : "blocked",
    });
  for (const p of w.prices)
    items.push({
      id: p.id,
      type: "price_change",
      record: p.slug,
      href: `/ops/catalogue/${p.slug}?step=pricing`,
      maker: { id: p.proposedBy, name: p.proposedByName ?? p.proposedBy },
      amount: typeof p.body.platform_fee === "number" ? p.body.platform_fee : null,
      reason: p.kind === "tier" ? `tier:${p.tier}` : "pricing",
      at: p.createdAt,
      mine: a.id === p.proposedBy ? "waiting" : isFinanceUser(a) ? "sign" : "blocked",
    });
  // Executives see only steps they can act on (U4).
  return isExecOnly(a) ? items.filter((i) => i.mine === "sign") : items;
}
export async function approvals(f: Fin, type?: string) {
  return {
    items: approvalsOf(f, await queues(f.db)).filter(
      (i) => !type || i.type === type,
    ),
  };
}
export async function summary(f: Fin): Promise<FinSummary> {
  const w = await queues(f.db);
  const a = f.me;
  const approvalsN = approvalsOf(f, w).filter((i) => i.mine === "sign").length;
  const proofs = w.pays.filter(
    (p) => p.state === "proof_submitted" || p.state === "under_verification",
  ).length;
  const unmatched = w.lines.filter(
    (l) => l.match === "unmatched" || l.match === "suggested",
  ).length;
  const refunds = w.refunds.filter((r) =>
    ["recommended", "approved", "credited", "execution_failed"].includes(
      r.status,
    ),
  ).length;
  const allocations = w.allocs.length;
  return {
    me: {
      id: a.id,
      name: a.name,
      roles: a.roles,
      executiveOnly: isExecOnly(a),
    },
    badges: { approvals: approvalsN, proofs, unmatched, refunds },
    needsYou: (
      [
        { key: "proofs", n: proofs, href: "/finance/payments/proofs" },
        { key: "approvals", n: approvalsN, href: "/finance/approvals" },
        { key: "unmatched", n: unmatched, href: "/finance/reconciliation" },
        { key: "refunds", n: refunds, href: "/finance/refunds" },
        {
          key: "allocations",
          n: allocations,
          href: "/finance/revenue?tab=allocations&state=reviewed",
        },
      ] as FinSummary["needsYou"]
    ).filter((x) => x.n > 0 && (!isExecOnly(a) || x.key === "approvals")),
  };
}
export async function notes(f: Fin): Promise<{ items: FinNote[] }> {
  const w = await queues(f.db);
  const n: FinNote[] = w.pays
    .filter((p) => p.state === "proof_submitted")
    .map((p) => ({
      id: `n-${p.id}`,
      kind: "proof",
      text: f.D.clientName(p.clientId),
      ref: p.bankReference,
      href: `/finance/payments/proofs?id=${p.id}`,
      at: p.at,
      read: false,
    }));
  for (const r of w.refunds)
    if (r.status === "recommended")
      n.push({
        id: `n-${r.no}`,
        kind: "refund",
        text: r.no,
        ref: r.no,
        href: `/finance/refunds/${r.no}`,
        at: r.at,
        read: false,
      });
  for (const ch of w.changes)
    n.push({
      id: `n-${ch.id}`,
      kind: "setting",
      text: ch.key,
      ref: ch.id,
      href: `/finance/settings/history?id=${ch.id}`,
      at: ch.effectiveAt,
      read: false,
    });
  return {
    items: isExecOnly(f.me)
      ? n.filter((x) => x.kind === "approval" || x.kind === "setting")
      : n.sort((x, y) => y.at.localeCompare(x.at)),
  };
}
/** Payables tile. shortcut: supplier bills belong to procurement (P7); read its open bills here when that module lands. */
/** Approved obligations other modules handed to finance (partner commissions) that are not yet paid. */
export async function payablesDue(db: Exec) {
  const items = (await all<Payable>(db, "payable")).filter((p) => p.status === "due");
  return { total: items.reduce((x, p) => x + p.amount, 0), count: items.length, items };
}

// ---------------------------------------------------------------- tax/limit settings (SET §7)
async function settingRows(db: Exec): Promise<SettingRow[]> {
  const rows = await all<SettingRow>(db, "setting");
  return SETTING_DEFAULTS.map(
    ([key, value, enforcedBy]) =>
      rows.find((r) => r.key === key) ?? {
        key,
        value,
        effectiveFrom: "2026-01-01",
        status: "active",
        enforcedBy,
      },
  );
}
export async function getSettings(f: Fin) {
  const [items, changes] = await Promise.all([
    settingRows(f.db),
    all<SettingChange>(f.db, "setting_change"),
  ]);
  return { items, changes: changes.sort((a, b) => b.id.localeCompare(a.id)) };
}
export async function settingChanges(f: Fin) {
  return { items: (await getSettings(f)).changes };
}

export async function proposeSetting(
  f: Fin,
  b: {
    key: FinanceSettingKey;
    value: unknown;
    effectiveAt: string;
    reason: string;
  },
) {
  need(isFinanceUser(f.me), 403, "forbidden");
  const rows = await settingRows(f.db);
  const row = rows.find((s) => s.key === b.key);
  need(row, 422, "validation");
  need(b.reason?.trim(), 422, "reason_required");
  need(
    b.effectiveAt && !isRetroactive(b.effectiveAt, today()),
    422,
    "retroactive",
  );
  const open = await where<SettingChange>(f.db, "setting_change", {
    status: ["proposed"],
  });
  need(!open.some((c) => c.key === b.key), 409, "version_conflict");
  const ch: SettingChange = {
    id: rid("sc"),
    key: b.key,
    old: row!.value,
    next: b.value,
    effectiveAt: b.effectiveAt.slice(0, 10),
    status: "proposed",
    proposedBy: refOf(f.me),
    reason: b.reason,
  };
  await put(f.db, "setting_change", ch.id, ch, ch.key);
  await put(f.db, "setting", row!.key, { ...row!, status: "pending_approval" });
  f.rec(
    "setting.change.proposed",
    "setting",
    b.key,
    { value: row!.value },
    { value: b.value, effectiveAt: ch.effectiveAt },
    b.reason,
    "config",
  );
  return accepted(ch);
}
/** Executive decision; applies at once when effective today, else stays scheduled (never retroactive, W16). */
export async function decideSetting(
  f: Fin,
  id: string,
  decision: "approve" | "reject",
  reason = "",
) {
  const ch = await one<SettingChange>(f.db, "setting_change", id, true);
  if (!ch) throw fail(404, "not_found");
  need(ch.status === "proposed", 409, "conflict");
  need(isExec(f.me), 403, "forbidden");
  if (ch.proposedBy.id === f.me.id) throw fail(403, "same_approver");
  need(decision !== "reject" || reason.trim(), 422, "reason_required");
  const row = (await settingRows(f.db)).find((s) => s.key === ch.key)!;
  const before = { status: ch.status };
  if (decision === "reject") {
    ch.status = "rejected";
    row.status = "active";
  } else {
    ch.status = "approved";
    ch.approvedBy = refOf(f.me);
    if (ch.effectiveAt <= today()) {
      ch.status = "applied";
      row.value = ch.next;
      row.effectiveFrom = ch.effectiveAt;
      row.status = "active";
      row.changedAt = nowIso();
    } else row.status = "scheduled";
  }
  await put(f.db, "setting_change", ch.id, ch, ch.key);
  await put(f.db, "setting", row.key, row);
  f.rec(
    `setting.change.${ch.status}`,
    "setting",
    ch.key,
    before,
    { status: ch.status, value: ch.next },
    reason || null,
    "config",
  );
  return ch;
}
/** Daily: approved changes whose date arrived become the stored value (reads already apply them, this persists it). */
export async function applyDueSettings(db: Exec) {
  const t = today();
  const due = (
    await where<SettingChange>(db, "setting_change", { status: ["approved"] })
  ).filter((c) => c.effectiveAt <= t);
  const rows = await settingRows(db);
  for (const ch of due) {
    const row = rows.find((r) => r.key === ch.key);
    if (!row) continue;
    ch.status = "applied";
    Object.assign(row, {
      value: ch.next,
      effectiveFrom: ch.effectiveAt,
      status: "active",
      changedAt: nowIso(),
    });
    await put(db, "setting_change", ch.id, ch, ch.key);
    await put(db, "setting", row.key, row);
  }
  const local = (
    await where<LocalChange>(db, "local_change", { status: ["approved"] })
  ).filter((c) => c.effectiveAt <= t);
  for (const ch of local) await applyLocal(db, ch);
  return due.length + local.length;
}

// ---------------------------------------------------------------- numbering + policy proposals (lane F)
const SERIES = ["INV", "QUO", "RCPT", "CN", "RFD", "PB"] as const;
async function prefixes(db: Exec): Promise<Record<string, string>> {
  const c = await one<{ id: string; value: Record<string, string> }>(
    db,
    "config",
    "prefixes",
  );
  return { ...Object.fromEntries(SERIES.map((s) => [s, s])), ...c?.value };
}
async function policies(db: Exec) {
  const [rp, ro] = await Promise.all([
    one<{ value: Record<string, number> }>(db, "config", "refund_policy"),
    one<{ value: number[] }>(db, "config", "reminder_offsets"),
  ]);
  return {
    refundPolicy: { ...(rp?.value ?? POLICY.refundPolicyBps) },
    reminderOffsets: [...(ro?.value ?? POLICY.reminderOffsets)],
  };
}
export async function numbering(f: Fin) {
  const y = Number(today().slice(0, 4));
  const P = await prefixes(f.db);
  const rows: NumberingRow[] = [];
  for (const s of ["INV", "QUO", "RCPT", "CN", "RFD"] as const) {
    const last = await lastUsed(f.db, s, y);
    const no = (n: number) => `${P[s]}-${y}-${String(n).padStart(5, "0")}`;
    rows.push({
      series: s,
      prefix: P[s],
      reset: "yearly",
      next: no(last + 1),
      last: last ? no(last) : null,
    });
  }
  const batches = await all<{ no: string }>(f.db, "batch");
  rows.push({
    series: "PB",
    prefix: P.PB,
    reset: "monthly",
    next: null,
    last:
      batches
        .map((b) => b.no)
        .sort()
        .at(-1) ?? null,
  });
  const changes = await all<LocalChange>(f.db, "local_change");
  return {
    items: rows,
    changes: changes
      .filter((c) => c.area === "numbering")
      .sort((a, b) => b.at.localeCompare(a.at)),
  };
}
export async function policySettings(f: Fin) {
  const changes = await all<LocalChange>(f.db, "local_change");
  return {
    ...(await policies(f.db)),
    changes: changes
      .filter((c) => c.area === "policy")
      .sort((a, b) => b.at.localeCompare(a.at)),
  };
}
export async function proposeLocal(
  f: Fin,
  b: {
    area: LocalChange["area"];
    key: string;
    next: unknown;
    effectiveAt: string;
    reason: string;
  },
) {
  need(isFinanceUser(f.me), 403, "forbidden");
  need(b.reason?.trim(), 422, "reason_required");
  need(
    b.effectiveAt && !isRetroactive(b.effectiveAt, today()),
    422,
    "retroactive",
  );
  let old: unknown;
  if (b.area === "numbering") {
    const P = await prefixes(f.db);
    need(
      b.key in P && typeof b.next === "string" && /^[A-Z]{2,5}$/.test(b.next),
      422,
      "validation",
    );
    old = P[b.key];
  } else if (b.key === "refund_policy") {
    const v = b.next as Record<string, number>;
    need(
      v &&
        typeof v === "object" &&
        !Object.values(v).some(
          (x) => !Number.isInteger(x) || x < 0 || x > 10_000,
        ),
      422,
      "validation",
    );
    old = (await policies(f.db)).refundPolicy;
  } else if (b.key === "reminder_offsets") {
    need(
      Array.isArray(b.next) &&
        b.next.length &&
        !b.next.some((x) => !Number.isInteger(x)),
      422,
      "validation",
    );
    old = (await policies(f.db)).reminderOffsets;
  } else throw fail(422, "validation");
  const open = await where<LocalChange>(f.db, "local_change", {
    status: ["proposed"],
  });
  need(!open.some((c) => c.key === b.key), 409, "version_conflict");
  const ch: LocalChange = {
    id: rid("xc"),
    area: b.area,
    key: b.key,
    old,
    next: b.next,
    effectiveAt: b.effectiveAt.slice(0, 10),
    status: "proposed",
    proposedBy: refOf(f.me),
    reason: b.reason,
    at: nowIso(),
  };
  await put(f.db, "local_change", ch.id, ch, ch.key);
  f.rec(
    "setting.change.proposed",
    b.area,
    b.key,
    { value: old },
    { value: b.next, effectiveAt: ch.effectiveAt },
    b.reason,
    "config",
  );
  return accepted(ch);
}
async function applyLocal(db: Exec, ch: LocalChange) {
  if (ch.area === "numbering") {
    const P = await prefixes(db);
    await put(db, "config", "prefixes", {
      id: "prefixes",
      value: { ...P, [ch.key]: String(ch.next) },
    });
  } else
    await put(db, "config", ch.key, {
      id: ch.key,
      value:
        ch.key === "refund_policy"
          ? { ...(await policies(db)).refundPolicy, ...(ch.next as object) }
          : ch.next,
    });
  ch.status = "applied";
  await put(db, "local_change", ch.id, ch, ch.key);
}
export async function decideLocal(
  f: Fin,
  id: string,
  decision: "approve" | "reject",
  reason = "",
) {
  const ch = await one<LocalChange>(f.db, "local_change", id, true);
  if (!ch) throw fail(404, "not_found");
  need(ch.status === "proposed", 409, "version_conflict");
  need(isExec(f.me), 403, "forbidden");
  if (ch.proposedBy.id === f.me.id) throw fail(403, "same_approver");
  need(decision !== "reject" || reason.trim(), 422, "reason_required");
  const before = { status: ch.status };
  if (decision === "reject") ch.status = "rejected";
  else {
    ch.approvedBy = refOf(f.me);
    ch.status = "approved";
    if (ch.effectiveAt <= today()) await applyLocal(f.db, ch);
  }
  await put(f.db, "local_change", ch.id, ch, ch.key);
  f.rec(
    `setting.change.${ch.status}`,
    ch.area,
    ch.key,
    before,
    { status: ch.status, value: ch.next },
    reason || null,
    "config",
  );
  return ch;
}

// ---------------------------------------------------------------- payout accounts (masked; reveal audited; call-back + 24 h lock)
export type AccountRec = Omit<FinAccount, "masked"> & {
  numberEnc: string;
  last4: string;
};
const ACCOUNT_LOCK_MS = 24 * 3_600_000;
const accountView = (x: AccountRec): FinAccount => {
  const { numberEnc: _n, last4, ...rest } = x;
  return { ...rest, masked: `•••• ${last4}` };
};
export const newAccount = (encrypt: (s: string) => string, o: {
  id: string;
  name: string;
  method: FinAccount["method"];
  number: string;
  status: FinAccount["status"];
  addedBy: FinAccount["addedBy"];
  verifiedBy?: FinAccount["verifiedBy"];
}): AccountRec => ({
  id: o.id,
  name: o.name,
  method: o.method,
  status: o.status,
  addedBy: o.addedBy,
  verifiedBy: o.verifiedBy,
  numberEnc: encrypt(o.number),
  last4: o.number.slice(-4),
});
export async function accounts(f: Fin) {
  return {
    items: (await all<AccountRec>(f.db, "account"))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(accountView),
  };
}
export async function addAccount(
  f: Fin,
  b: { name: string; method: FinAccount["method"]; number: string },
) {
  need(
    b.name?.trim() &&
      /^[A-Za-z0-9]{6,24}$/.test(b.number ?? "") &&
      ["bank", "mtn_momo", "airtel_money"].includes(b.method),
    422,
    "validation",
  );
  const x = newAccount(f.deps.encrypt, {
    id: rid("acc"),
    name: b.name.trim(),
    method: b.method,
    number: b.number,
    status: "pending_callback",
    addedBy: refOf(f.me),
  });
  await put(f.db, "account", x.id, x);
  f.rec(
    "account.added",
    "account",
    x.id,
    null,
    {
      name: x.name,
      method: x.method,
      number: `•••• ${x.last4}`,
      status: x.status,
    },
    undefined,
    "config",
  );
  return accountView(x);
}
export async function verifyAccount(f: Fin, id: string) {
  const x = await one<AccountRec>(f.db, "account", id, true);
  if (!x) throw fail(404, "not_found");
  need(x.status !== "verified", 409, "version_conflict");
  if (x.addedBy.id === f.me.id) throw fail(403, "same_approver");
  x.status = "verified";
  x.verifiedBy = refOf(f.me);
  x.payoutLockedUntil = new Date(Date.now() + ACCOUNT_LOCK_MS).toISOString();
  await put(f.db, "account", x.id, x);
  f.rec(
    "account.verified",
    "account",
    x.id,
    { status: "pending_callback" },
    { status: "verified", payoutLockedUntil: x.payoutLockedUntil },
    "call-back confirmed",
    "config",
  );
  return accountView(x);
}
export async function revealAccount(f: Fin, id: string) {
  const x = await one<AccountRec>(f.db, "account", id);
  if (!x) throw fail(404, "not_found");
  f.rec("account.revealed", "account", x.id, null, null, undefined, "config");
  return { number: f.deps.decrypt(x.numberEnc) };
}

// ---------------------------------------------------------------- history (financial + config audit rows)
const KIND_OF: Record<string, string> = { quote: "invoice" };
type Det = {
  actorName?: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
};
export async function history(
  f: Fin,
  q: { range?: string; kind?: string; q?: string; page?: string },
  everything = false,
) {
  const days = Number(q.range ?? 90) || 90,
    kind = q.kind ?? "all",
    text = (q.q ?? "").toLowerCase();
  const page = Math.max(1, Number(q.page ?? 1) || 1);
  const from = new Date(Date.now() - days * 86_400_000).toISOString();
  // shortcut: capped scan of the newest 5,000 finance/config rows; add a (resource_type, created_at) index + keyset when it grows.
  const rows = await f.db
    .select()
    .from(auditLog)
    .where(
      and(
        gte(auditLog.createdAt, from),
        or(
          like(auditLog.action, "financial.%"),
          like(auditLog.action, "config.%"),
        ),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(5000);
  const items: HistoryRow[] = rows
    .filter(
      (e) =>
        kind === "all" || (KIND_OF[e.resourceType] ?? e.resourceType) === kind,
    )
    .map((e) => {
      const d = e.details as Det;
      const b = (d.before ?? {}) as Record<string, unknown>,
        a = (d.after ?? {}) as Record<string, unknown>;
      const field =
        typeof b === "object" && typeof a === "object"
          ? ([
              ...new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})]),
            ].find((k) => JSON.stringify(b?.[k]) !== JSON.stringify(a?.[k])) ??
            null)
          : null;
      return {
        id: e.id,
        at: e.createdAt,
        actor: d.actorName ?? e.actorId ?? "system",
        action: e.action.split(".").slice(1).join("."),
        kind: e.resourceType,
        record: e.resourceId ?? "",
        field,
        before: d.before ?? null,
        after: d.after ?? null,
        reason: d.reason ?? null,
      };
    })
    .filter(
      (r) =>
        !text ||
        [r.actor, r.record, r.action, r.reason ?? ""].some((s) =>
          s.toLowerCase().includes(text),
        ),
    );
  return {
    items: everything ? items : items.slice((page - 1) * 20, page * 20),
    meta: { total: items.length, page, pageSize: 20 },
  };
}
const csvCell = (v: unknown) =>
  `"${(v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)).replace(/"/g, '""')}"`;
export async function exportHistory(f: Fin, q: { range?: string; kind?: string; q?: string }) {
  const all_ = await history(f, q, true);
  const csv = [
    "at,user,action,record,field,before,after,reason",
    ...all_.items.map((r) =>
      [
        r.at,
        r.actor,
        r.action,
        `${r.kind}:${r.record}`,
        r.field,
        r.before,
        r.after,
        r.reason,
      ]
        .map(csvCell)
        .join(","),
    ),
  ].join("\n");
  const file = await f.deps.publishFile(
    `finance-history-${today()}.csv`,
    csv,
    "text/csv",
  );
  f.rec(
    "history.exported",
    "history",
    "finance",
    null,
    { rows: all_.items.length, filters: q },
    undefined,
    "config",
  );
  return {
    id: rid("exp"),
    status: "ready" as const,
    format: "csv",
    rowCount: all_.items.length,
    ...file,
  };
}
