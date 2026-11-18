// Procurement core (P7, contract: src/mocks/handlers-procurement.ts + handlers-procurement-a.ts): summary, alerts, bell,
// approvals queue, settings with four-eyes proposals, entity audit trail, reports (ageing, spend, export audit), simulate.
import { and, desc, eq } from "drizzle-orm";
import { auditLog } from "@/db/schema";
import { BUCKETS } from "@/domain/finance/ageing";
import type { ApprovalLimits } from "@/domain/procurement/types";
import {
  ageing,
  alerts,
  approvalsFor,
  nowIso,
  notesFor,
  procError,
  read,
  record,
  ref,
  summary,
  today,
  uid,
  vendorOf,
  write,
  type Caller,
} from "./procurement.world";

export const getSummary = (c: Caller) => read(c, (w) => summary(w));
export const getAlerts = (c: Caller, horizon = 90) =>
  read(c, (w) => ({ items: alerts(w, horizon) }));
export const getNotes = (c: Caller) => read(c, (w) => ({ items: notesFor(w) }));
export const getApprovals = (c: Caller, type?: string) =>
  read(c, (w) => ({
    items: approvalsFor(w).filter((i) => !type || i.kind === type),
  }));
export const getSettings = (c: Caller) =>
  read(c, (w) => ({
    limits: w.limits,
    budgets: w.budgets,
    proposals: w.proposals,
  }));

export type ProposalIn = {
  limits?: Partial<ApprovalLimits>;
  budgets?: { code: string; annualBudget: number }[];
  effectiveOn: string;
  reason: string;
};
export const proposeSettings = (c: Caller, b: ProposalIn) =>
  write(c, (w) => {
    if (!b.reason?.trim()) throw procError(422, "reason_required");
    if (w.proposals.some((p) => p.status === "pending"))
      throw procError(409, "already_pending");
    const p = {
      id: uid("SET"),
      by: ref(w.actor),
      at: nowIso(w),
      effectiveOn: b.effectiveOn,
      reason: b.reason,
      status: "pending" as const,
      limits: b.limits,
      budgets: b.budgets,
    };
    w.proposals.push(p);
    record(
      w,
      "config.setting.proposed",
      "procurement_settings",
      p.id,
      null,
      { limits: b.limits, budgets: b.budgets },
      b.reason,
    );
    return p;
  });

export const decideProposal = (
  c: Caller,
  id: string,
  b: { decision: "approve" | "reject"; reason?: string },
) =>
  write(
    c,
    (w) => {
      const p = w.proposals.find((x) => x.id === id);
      if (!p) throw procError(404, "not_found");
      if (p.status !== "pending") throw procError(409, "already_decided");
      if (p.by.id === w.actor.id) throw procError(403, "segregation_violation");
      const before = {
        limits: { ...w.limits },
        budgets: w.budgets.map((x) => ({
          code: x.code,
          annualBudget: x.annualBudget,
        })),
      };
      p.status = b.decision === "approve" ? "approved" : "rejected";
      p.decidedBy = ref(w.actor);
      if (p.status === "approved") {
        Object.assign(w.limits, p.limits ?? {});
        for (const x of p.budgets ?? []) {
          const bud = w.budgets.find((y) => y.code === x.code);
          if (bud) bud.annualBudget = Math.round(x.annualBudget);
        }
      }
      record(
        w,
        "config.setting.changed",
        "procurement_settings",
        p.id,
        before,
        { status: p.status, limits: w.limits },
        b.reason,
      );
      return p;
    },
    { stepUp: true },
  );

/** Entity audit trail in the mocks' AuditEvent shape, newest first. */
export async function getAudit(c: Caller, kind: string, id: string) {
  if (!kind || !id) return { items: [] };
  const rows = await c.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.resourceType, kind), eq(auditLog.resourceId, id)))
    .orderBy(desc(auditLog.createdAt))
    .limit(200);
  return {
    items: rows.map((r) => {
      const d = r.details as {
        actorName?: string;
        before?: unknown;
        after?: unknown;
        reason?: string | null;
      };
      return {
        id: r.id,
        at: r.createdAt,
        actor: d.actorName ?? r.actorId ?? "system",
        action: r.action,
        entity: { kind, id },
        before: d.before ?? undefined,
        after: d.after ?? undefined,
        reason: d.reason ?? undefined,
        ip: r.ipAddress ?? "",
      };
    }),
  };
}

/** Non-production only: +24 h clock (bank-change lock expiry) and the reminders sweep on demand. */
export const simulate = (c: Caller, key: string) => {
  if (c.deps.prod) throw procError(404, "not_found");
  if (key === "clock")
    return write(c, (w) => {
      w.meta.clockOffset = (w.meta.clockOffset || 0) + 24 * 3600_000;
      return { now: nowIso(w) };
    });
  if (key === "reminders")
    return read(c, (w) => ({ alerts: alerts(w, 90).length }));
  throw procError(404, "not_found");
};

// ---------------------------------------------------------------- reports (lane A)
export const payablesAgeing = (c: Caller, asOfIn?: string) =>
  read(c, (w) => {
    const asOf = asOfIn || today(w);
    const rows = ageing(w, asOf);
    const totals = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<
      (typeof BUCKETS)[number],
      number
    >;
    const byVendor = new Map<
      string,
      {
        vendorId: string;
        name: string;
        buckets: Record<string, number>;
        total: number;
      }
    >();
    for (const r of rows) {
      totals[r.bucket] += r.open;
      const v = byVendor.get(r.bill.vendorId) ?? {
        vendorId: r.bill.vendorId,
        name: vendorOf(w, r.bill.vendorId)?.legalName ?? "",
        buckets: Object.fromEntries(BUCKETS.map((b) => [b, 0])),
        total: 0,
      };
      v.buckets[r.bucket] += r.open;
      v.total += r.open;
      byVendor.set(r.bill.vendorId, v);
    }
    return {
      asOf,
      totals,
      total: rows.reduce((s, r) => s + r.open, 0),
      vendors: [...byVendor.values()].sort((a, b) => b.total - a.total),
      bills: rows.map((r) => ({
        no: r.bill.no,
        vendorName: vendorOf(w, r.bill.vendorId)?.legalName ?? "",
        vendorInvoiceNo: r.bill.vendorInvoiceNo,
        dueOn: r.bill.dueOn,
        open: r.open,
        bucket: r.bucket,
        status: r.bill.status,
      })),
    };
  });

export const spendReport = (c: Caller, q: { from?: string; to?: string }) =>
  read(c, (w) => {
    const from = q.from || `${today(w).slice(0, 4)}-01-01`,
      to = q.to || today(w);
    // Spend = bills approved or later, by invoice date (R-8 "actual").
    const spent = w.bills.filter(
      (b) =>
        ["approved", "authorised", "partially_paid", "paid"].includes(
          b.status,
        ) &&
        b.invoiceDate >= from &&
        b.invoiceDate <= to,
    );
    const byMonth = new Map<string, number>(),
      byVendor = new Map<string, number>();
    for (const b of spent) {
      byMonth.set(
        b.invoiceDate.slice(0, 7),
        (byMonth.get(b.invoiceDate.slice(0, 7)) ?? 0) + b.total,
      );
      byVendor.set(b.vendorId, (byVendor.get(b.vendorId) ?? 0) + b.total);
    }
    const monthlyBudget = Math.round(
      w.budgets.reduce((s, b) => s + b.annualBudget, 0) / 12,
    );
    return {
      from,
      to,
      months: [...byMonth.entries()]
        .sort()
        .map(([month, spend]) => ({ month, spend, budget: monthlyBudget })),
      categories: w.budgets.map((b) => ({
        ...b,
        available: b.annualBudget - b.committed - b.actual,
        pct: b.annualBudget
          ? Math.round(((b.committed + b.actual) * 100) / b.annualBudget)
          : 0,
      })),
      vendors: [...byVendor.entries()]
        .map(([id, total]) => ({
          vendorId: id,
          name: vendorOf(w, id)?.legalName ?? id,
          total,
        }))
        .sort((a, b) => b.total - a.total),
      paid: w.payments
        .filter(
          (p) => p.paidAt.slice(0, 10) >= from && p.paidAt.slice(0, 10) <= to,
        )
        .reduce((s, p) => s + p.amount, 0),
    };
  });

/** Client-side export, server-side audit (F-AUD-05 sensitive read). */
export const logExport = (
  c: Caller,
  b: { report: string; rows: number; params?: string },
) =>
  write(c, (w) => {
    record(w, "data_export", "procurement_report", b.report, null, {
      rows: b.rows,
      params: b.params,
    });
    return { logged: true };
  });
