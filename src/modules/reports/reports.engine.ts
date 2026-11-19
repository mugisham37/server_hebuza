// Report engine (RPT §9), ported verbatim from the reference: finance records → grouped rows; drill returns the same
// records, so every total is Σ of its drill. Pure over an RCtx loaded once per request.
import type { Tx } from "../../core/db/db";
import { ageingBucket, BUCKETS } from "@/domain/finance/ageing";
import type { ColKind, ReportCol, ReportKey, ReportRow } from "./lib/types";
import { all, sum, today, type Alloc, type Batch, type CreditNote, type Directory, type Inv, type Payment, type RefundRequest, type Settings, type StatementImport, type StatementLine } from "./reports.store";

export const d10 = (s: string) => s.slice(0, 10);
export const CONFIRMED = new Set(["confirmed", "confirmed_late"]);
export const APPROVED = new Set(["approved_for_payment", "in_batch", "paid"]);

// ---------------------------------------------------------------- data
type Data = {
  invs: Inv[];
  cns: CreditNote[];
  pays: Payment[];
  imps: StatementImport[];
  lines: StatementLine[];
  refunds: RefundRequest[];
  allocs: Alloc[];
  batches: Batch[];
};
export type RCtx = { D: Directory; S: Settings; data: Data };
export async function reportCtx(
  db: Tx,
  D: Directory,
  S: Settings,
): Promise<RCtx> {
  const [invs, cns, pays, imps, lines, refunds, allocs, batches] =
    await Promise.all([
      all<Inv>(db, "invoice"),
      all<CreditNote>(db, "credit_note"),
      all<Payment>(db, "payment"),
      all<StatementImport>(db, "import"),
      all<StatementLine>(db, "line"),
      all<RefundRequest>(db, "refund"),
      all<Alloc>(db, "allocation"),
      all<Batch>(db, "batch"),
    ]);
  return {
    D,
    S,
    data: { invs, cns, pays, imps, lines, refunds, allocs, batches },
  };
}

// ---------------------------------------------------------------- report engine: records → grouped rows (drill = same records)
type Dim = { key: string; label: string };
export type Rec = {
  date: string;
  dims: Record<string, Dim>;
  values: Record<string, number>;
  ref: string;
  href: string;
  party: string;
  state?: string;
};
type Def = {
  groups: string[];
  cols: [string, ColKind, boolean?][];
  recs: (c: RCtx) => Rec[];
  derive?: (v: Record<string, number>) => void;
  empty?: (c: RCtx) => "no_import" | "stage12" | null;
};
const week = (d: string) => {
  const t = new Date(d10(d));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return t.toISOString().slice(0, 10);
};
const timeDims = (d: string) => ({
  day: { key: d10(d), label: d10(d) },
  week: { key: week(d), label: week(d) },
  month: { key: d.slice(0, 7), label: d.slice(0, 7) },
});
const clientDim = (c: RCtx, id: string) => ({
  key: id,
  label: c.D.clientName(id),
});
const serviceDim = (c: RCtx, ref?: string) => {
  const k = c.D.caseOf(ref);
  return k
    ? { key: k.service, label: c.D.serviceName(k.service) }
    : { key: "standalone", label: "standalone" };
};
const invHref = (no: string) => `/finance/invoices/${no}`;
export const issued = (c: RCtx) =>
  c.data.invs.filter(
    (i) => i.no && i.status !== "draft" && i.status !== "void",
  );
const payDay = (c: RCtx, period: string) =>
  `${period}-${String(c.S.payout_day).padStart(2, "0")}`;

const DEFS: Record<ReportKey, Def> = {
  "fin.revenue": {
    groups: ["service", "client", "month"],
    cols: [
      ["invoiced", "money", true],
      ["collected", "money", true],
      ["refunds", "money", true],
      ["vat", "money", true],
      ["net", "money"],
    ],
    recs: (c) => [
      ...issued(c).map((i) => ({
        date: i.issuedAt!,
        dims: {
          service: serviceDim(c, i.caseRef),
          client: clientDim(c, i.clientId),
          ...timeDims(i.issuedAt!),
        },
        values: {
          invoiced: i.totals.total,
          collected: i.amountPaid,
          refunds: 0,
          vat: i.totals.vat,
        },
        ref: i.no!,
        href: invHref(i.no!),
        party: i.billTo.name,
        state: i.status,
      })),
      ...c.data.cns.map((cn) => {
        const i = c.data.invs.find((x) => x.no === cn.invoiceNo);
        return {
          date: cn.issuedAt,
          dims: {
            service: serviceDim(c, i?.caseRef),
            client: clientDim(c, i?.clientId ?? ""),
            ...timeDims(cn.issuedAt),
          },
          values: {
            invoiced: 0,
            collected: 0,
            refunds: Math.abs(cn.totals.total),
            vat: 0,
          },
          ref: cn.no,
          href: `/finance/credit-notes/${cn.no}`,
          party: i?.billTo.name ?? "",
        };
      }),
    ],
    derive: (v) => {
      v.net = v.invoiced - v.refunds;
    },
  },
  "fin.collections": {
    groups: ["method", "client", "day", "invoice"],
    cols: [
      ["collected", "money", true],
      ["initiated", "count", true],
      ["confirmed", "count", true],
      ["failed", "count", true],
      ["failure_rate", "pct"],
    ],
    recs: (c) =>
      c.data.pays.map((p) => ({
        date: p.at,
        dims: {
          method: { key: p.method, label: p.method },
          client: clientDim(c, p.clientId),
          invoice: { key: p.invoiceNo, label: p.invoiceNo },
          ...timeDims(p.at),
        },
        values: {
          collected: CONFIRMED.has(p.state) ? (p.amountReceived ?? 0) : 0,
          initiated: 1,
          confirmed: CONFIRMED.has(p.state) ? 1 : 0,
          failed: p.state === "failed" || p.state === "expired" ? 1 : 0,
        },
        ref: p.receiptNo ?? p.providerRef ?? p.bankReference ?? p.id,
        href: `/finance/payments?id=${p.id}`,
        party: c.D.clientName(p.clientId),
        state: p.state,
      })),
    derive: (v) => {
      v.failure_rate = v.initiated
        ? Math.round((v.failed * 10_000) / v.initiated)
        : 0;
    },
  },
  "fin.receivables_ageing": {
    groups: ["client", "service"],
    cols: [
      ...BUCKETS.map((b) => [b, "money", true] as [string, ColKind, boolean]),
      ["total", "money", true],
    ],
    recs: (c) =>
      issued(c)
        .filter((i) => i.balanceDue > 0 && i.dueAt)
        .map((i) => {
          const b = ageingBucket(i.dueAt!, today());
          return {
            date: i.issuedAt!,
            dims: {
              client: clientDim(c, i.clientId),
              service: serviceDim(c, i.caseRef),
            },
            values: {
              ...Object.fromEntries(
                BUCKETS.map((x) => [x, x === b ? i.balanceDue : 0]),
              ),
              total: i.balanceDue,
            },
            ref: i.no!,
            href: invHref(i.no!),
            party: i.billTo.name,
            state: i.status,
          };
        }),
  },
  "fin.reconciliation": {
    groups: ["provider", "day"],
    cols: [
      ["amount", "money", true],
      ["matched", "count", true],
      ["unmatched", "count", true],
      ["difference", "money", true],
    ],
    recs: (c) =>
      c.data.lines.map((l) => {
        const imp = c.data.imps.find((x) => x.id === l.importId);
        const open =
          l.match === "unmatched" ||
          l.match === "exception" ||
          l.match === "suggested";
        return {
          date: l.occurredAt,
          dims: {
            provider: {
              key: imp?.provider ?? "bank",
              label: imp?.provider ?? "bank",
            },
            ...timeDims(l.occurredAt),
          },
          values: {
            amount: l.amount,
            matched: l.match === "matched" ? 1 : 0,
            unmatched: open ? 1 : 0,
            difference: open ? l.amount : 0,
          },
          ref: l.externalRef,
          href: `/finance/reconciliation/${l.importId}?line=${l.id}`,
          party: imp?.provider ?? "",
          state: l.match,
        };
      }),
    empty: (c) => (c.data.imps.length ? null : "no_import"),
  },
  "fin.refunds_credit_notes": {
    groups: ["reason", "service"],
    cols: [
      ["refunds", "count", true],
      ["amount", "money", true],
      ["credit_notes", "count", true],
    ],
    recs: (c) => [
      ...c.data.refunds.map((r) => ({
        date: r.at,
        dims: {
          reason: { key: r.reason, label: r.reason },
          service: serviceDim(c, r.caseRef),
        },
        values: {
          refunds: 1,
          amount: r.approved ?? r.recommended ?? r.requested,
          credit_notes: 0,
        },
        ref: r.no,
        href: `/finance/refunds/${r.no}`,
        party: r.requestedBy.name,
        state: r.status,
      })),
      ...c.data.cns.map((cn) => {
        const r = c.data.refunds.find((x) => x.no === cn.refundNo);
        const i = c.data.invs.find((x) => x.no === cn.invoiceNo);
        return {
          date: cn.issuedAt,
          dims: {
            reason: { key: r?.reason ?? "other", label: r?.reason ?? "other" },
            service: serviceDim(c, i?.caseRef),
          },
          values: { refunds: 0, amount: 0, credit_notes: 1 },
          ref: cn.no,
          href: `/finance/credit-notes/${cn.no}`,
          party: i?.billTo.name ?? "",
        };
      }),
    ],
  },
  "fin.revenue_share": {
    groups: ["agent", "service", "month"],
    cols: [
      ["allocated", "money", true],
      ["approved", "money", true],
      ["paid", "money", true],
      ["outstanding", "money"],
      ["hebuza", "money", true],
    ],
    recs: (c) =>
      c.data.allocs.flatMap((a) =>
        a.shares.map((s, k) => ({
          date: a.frozenAt,
          dims: {
            agent: { key: s.workerId, label: c.D.workerName(s.workerId) },
            service: serviceDim(c, a.caseRef),
            ...timeDims(a.frozenAt),
          },
          // Hebuza's retained part is counted once per allocation, on the lead share (definition "hebuza").
          values: {
            allocated: s.amount,
            approved: APPROVED.has(a.status) ? s.amount : 0,
            paid: a.status === "paid" ? s.amount : 0,
            hebuza: k === 0 ? a.hebuza : 0,
          },
          ref: a.caseRef,
          href: `/finance/revenue?tab=allocations&id=${a.id}`,
          party: c.D.workerName(s.workerId),
          state: a.status,
        })),
      ),
    derive: (v) => {
      v.outstanding = v.allocated - v.paid;
    },
  },
  "fin.revenue_reconciliation": {
    groups: ["service", "month"],
    cols: [
      ["invoiced", "money", true],
      ["collected", "money", true],
      ["allocated", "money", true],
      ["approved", "money", true],
      ["paid", "money", true],
      ["difference", "money"],
    ],
    recs: (c) => [
      ...issued(c).map((i) => ({
        date: i.issuedAt!,
        dims: { service: serviceDim(c, i.caseRef), ...timeDims(i.issuedAt!) },
        values: {
          invoiced: i.totals.total,
          collected: i.amountPaid,
          allocated: 0,
          approved: 0,
          paid: 0,
        },
        ref: i.no!,
        href: invHref(i.no!),
        party: i.billTo.name,
        state: i.status,
      })),
      ...c.data.allocs.map((a) => ({
        date: a.frozenAt,
        dims: { service: serviceDim(c, a.caseRef), ...timeDims(a.frozenAt) },
        values: {
          invoiced: 0,
          collected: 0,
          allocated: a.pool,
          approved: APPROVED.has(a.status) ? a.pool : 0,
          paid: a.status === "paid" ? a.pool : 0,
        },
        ref: a.caseRef,
        href: `/finance/revenue?tab=allocations&id=${a.id}`,
        party: a.shares.map((s) => c.D.workerName(s.workerId)).join(", "),
        state: a.status,
      })),
    ],
    // Allocated is the agent pool on the eligible base, so the difference is allocated − paid (owed to agents).
    derive: (v) => {
      v.difference = v.allocated - v.paid;
    },
  },
  "fin.vat": {
    groups: ["month", "client"],
    cols: [
      ["base", "money", true],
      ["vat", "money", true],
      ["invoices", "count", true],
      ["missing_ebm", "count", true],
    ],
    recs: (c) =>
      issued(c).map((i) => ({
        date: i.issuedAt!,
        dims: { client: clientDim(c, i.clientId), ...timeDims(i.issuedAt!) },
        values: {
          base: i.totals.subtotal,
          vat: i.totals.vat,
          invoices: 1,
          missing_ebm: !i.ebmReceiptNo && i.totals.vat > 0 ? 1 : 0,
        },
        ref: i.no!,
        href: invHref(i.no!),
        party: i.billTo.name,
        state: i.status,
      })),
  },
  "fin.wht_payable": {
    groups: ["batch", "agent"],
    cols: [
      ["gross", "money", true],
      ["wht", "money", true],
      ["net", "money", true],
    ],
    recs: (c) =>
      c.data.batches.flatMap((b) =>
        b.lines.map((l) => ({
          date: payDay(c, b.period),
          dims: {
            batch: { key: b.no, label: b.no },
            agent: { key: l.workerId, label: c.D.workerName(l.workerId) },
          },
          values: { gross: l.gross, wht: l.wht, net: l.net },
          ref: b.no,
          href: `/finance/payouts/${b.no}?line=${l.id}`,
          party: c.D.workerName(l.workerId),
          state: l.status,
        })),
      ),
  },
  "fin.cash_flow": {
    groups: ["week", "month"],
    cols: [
      ["inflows", "money", true],
      ["outflows", "money", true],
      ["net", "money"],
      // F-FIN-19 projection: open receivables on their due date (pick a future period to see the forecast).
      ["expected", "money", true],
    ],
    recs: (c) => [
      ...c.data.invs
        .filter((i) => i.no && i.dueAt && i.balanceDue > 0 && !["void", "draft", "paid_by_plan"].includes(i.status))
        .map((i) => ({
          date: i.dueAt!,
          dims: timeDims(i.dueAt!),
          values: { inflows: 0, outflows: 0, expected: i.balanceDue },
          ref: i.no!,
          href: invHref(i.no!),
          party: i.billTo.name,
          state: i.status,
        })),
      ...c.data.pays
        .filter((p) => CONFIRMED.has(p.state))
        .map((p) => ({
          date: p.at,
          dims: timeDims(p.at),
          values: { inflows: p.amountReceived ?? 0, outflows: 0, expected: 0 },
          ref: p.receiptNo ?? p.id,
          href: `/finance/payments?id=${p.id}`,
          party: c.D.clientName(p.clientId),
          state: p.state,
        })),
      ...c.data.batches.flatMap((b) =>
        b.lines
          .filter((l) => l.status === "paid")
          .map((l) => {
            const d = payDay(c, b.period);
            return {
              date: d,
              dims: timeDims(d),
              values: { inflows: 0, outflows: l.net, expected: 0 },
              ref: b.no,
              href: `/finance/payouts/${b.no}?line=${l.id}`,
              party: c.D.workerName(l.workerId),
              state: l.status,
            };
          }),
      ),
    ],
    derive: (v) => {
      v.net = v.inflows - v.outflows;
    },
  },
  "fin.subscriptions": {
    groups: ["client", "month"],
    cols: [
      ["renewals", "count", true],
      ["amount", "money", true],
      ["due", "money", true],
    ],
    recs: (c) =>
      c.data.invs
        .filter((i) => i.series === "plan" && i.issuedAt)
        .map((i) => ({
          date: i.issuedAt!,
          dims: { client: clientDim(c, i.clientId), ...timeDims(i.issuedAt!) },
          values: { renewals: 1, amount: i.totals.total, due: i.balanceDue },
          ref: i.no ?? "",
          href: invHref(i.no ?? ""),
          party: i.billTo.name,
          state: i.status,
        })),
  },
  // shortcut: supplier payables come from procurement (P7); empty "stage12" until it lands.
  "fin.payables_ageing": {
    groups: ["supplier"],
    cols: [["total", "money", true]],
    recs: () => [],
    empty: () => "stage12",
  },
};

export type RunQ = { from?: string; to?: string; group?: string };
export function run(c: RCtx, key: ReportKey, q: RunQ) {
  const def = DEFS[key];
  const t = today();
  const from = q.from || `${t.slice(0, 8)}01`,
    to = q.to || t;
  const group = def.groups.includes(q.group ?? "") ? q.group! : def.groups[0];
  const recs = def
    .recs(c)
    .filter((r) => d10(r.date) >= from && d10(r.date) <= to);
  const cols: ReportCol[] = def.cols.map(([k, kind, drill]) => ({
    key: k,
    kind,
    drill: !!drill,
  }));
  const base = def.cols.filter((x) => x[2]).map((x) => x[0]);
  const fold = (rs: Rec[]) => {
    const v = Object.fromEntries(
      base.map((k) => [k, sum(rs, (r) => r.values[k] ?? 0)]),
    );
    def.derive?.(v);
    return v;
  };
  const groups = new Map<string, { label: string; recs: Rec[] }>();
  for (const r of recs) {
    const d = r.dims[group];
    if (!d) continue;
    const g = groups.get(d.key) ?? { label: d.label, recs: [] };
    g.recs.push(r);
    groups.set(d.key, g);
  }
  const rows: ReportRow[] = [...groups]
    .map(([k, g]) => ({ key: k, label: g.label, values: fold(g.recs) }))
    .sort((a, b) =>
      ["day", "week", "month"].includes(group)
        ? b.key.localeCompare(a.key)
        : (b.values[base[0]] ?? 0) - (a.values[base[0]] ?? 0),
    );
  return { def, from, to, group, recs, rows, cols, total: fold(recs) };
}
