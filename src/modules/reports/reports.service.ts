// Finance reports (U3, U16, F-FIN-13): catalogue/run/drill, export jobs (CSV → object storage, presigned link via
// GET /reports/exports/:id + notification), and the overview / cash position / journal read models finance calls.
// shortcut: reads primary, move to read replica when provisioned.
import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import type IORedis from "ioredis";
import { REDIS } from "../../core/queue/queue.module";
import { users } from "@/db/schema";
import type { ExportJob } from "@/domain/finance/types";
import { AuditService } from "../../core/db/audit";
import type { Tx } from "../../core/db/db";
import { OutboxService } from "../../core/db/outbox";
import { TxService } from "../../core/db/tx";
import { AppError, notFound } from "../../core/http/errors";
import type { SessionUser } from "../../core/http/context";
import { StorageService } from "../../core/storage/storage.service";
import { NotificationsService } from "../notifications/notifications.service";
import { ageingSummary } from "@/domain/finance/ageing";
import {
  ACCOUNTS,
  journal,
  type Account,
  type JournalEvent,
} from "@/domain/finance/journal";
import {
  isReportKey,
  payoutLine,
  REPORT_KEYS,
  type CatalogItem,
  type DrillItem,
  type JournalBody,
  type Overview,
  type ReportKey,
} from "./lib/types";
import {
  APPROVED,
  CONFIRMED,
  d10,
  issued,
  reportCtx,
  run,
  type RCtx,
  type RunQ,
} from "./reports.engine";
import {
  addDays,
  all,
  DAY,
  directory,
  nowIso,
  one,
  put,
  rid,
  settings,
  sum,
  today,
  type StatementImport,
  type StatementLine,
} from "./reports.store";

import type { ExecSummary } from "./reports.dto";

type Job = ExportJob & {
  key?: string | null;
  report: ReportKey;
  filters: Record<string, string>;
  by: string;
  error?: string;
};
/** Executive without a finance role: sees only their own exports and no work queues (D12). */
const isExecOnly = (me: SessionUser) =>
  me.roles.includes("staff:executive") && !me.roles.includes("staff:finance");
const csvLine = (xs: (string | number)[]) =>
  xs.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",");
const invalid = () =>
  new AppError(422, "validation", "Check the highlighted fields.");

@Injectable()
export class ReportsService {
  constructor(
    private readonly tx: TxService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly notifications: NotificationsService,
    @Inject(REDIS) private readonly redis: IORedis,
  ) {}

  /** Executive KPIs in one read (finance store + cases + bookings + leads + AI spend), cached 60 s in Redis. */
  async execSummary(): Promise<ExecSummary> {
    const KEY = "reports:exec-summary";
    const hit = await this.redis.get(KEY).catch(() => null);
    if (hit) return JSON.parse(hit) as ExecSummary;
    const v = await this.tx.run(async (db) => {
      const c = await this.ctx(db);
      const date = today();
      const from = addDays(date, -29);
      const inv = issued(c);
      const open = inv.filter((i) => i.balanceDue > 0);
      const rows = <T>(q: ReturnType<typeof sql>) => db.execute(q) as unknown as Promise<T[]>;
      const [cases, [sla], bookings, leads, [ai]] = await Promise.all([
        rows<{ status: string; n: number }>(sql`select status, count(*)::int n from applications group by status order by n desc`),
        rows<{ n: number }>(sql`select count(*)::int n from applications where status not in ('completed_delivered','rejected','cancelled','refunded')
          and (sla_breached_at is not null or coalesce(due_at, sla_deadline) < now())`),
        rows<{ status: string; n: number }>(sql`select status, count(*)::int n from bkg_bookings group by status`),
        rows<{ stage: string; n: number }>(sql`select data->>'stage' stage, count(*)::int n from mkt_records where kind = 'lead' group by 1`),
        rows<{ usd: number; calls: number }>(sql`select coalesce(sum(usd_micros), 0)::bigint::float8 / 1e6 usd, count(*)::int calls
          from ai_usage where at >= now() - interval '30 days'`),
      ]);
      const leadN = sum(leads, (l) => l.n);
      const won = leads.find((l) => l.stage === "won")?.n ?? 0;
      return {
        date,
        period: { from, to: date },
        revenue: sum(inv.filter((i) => d10(i.issuedAt!) >= from), (i) => i.totals.total),
        revenueAll: sum(inv, (i) => i.totals.total),
        collections: sum(c.data.pays.filter((p) => CONFIRMED.has(p.state) && d10(p.at) >= from), (p) => p.amountReceived ?? p.amountExpected),
        receivables: sum(open, (i) => i.balanceDue),
        ageing: ageingSummary(open, date),
        cases: { total: sum(cases, (r) => r.n), byStatus: cases },
        slaBreaches: sla?.n ?? 0,
        bookings: { total: sum(bookings, (b) => b.n), byStatus: bookings },
        conversion: { leads: leadN, won, rate: leadN ? won / leadN : 0 },
        ai: { usd: Number(ai?.usd ?? 0), calls: ai?.calls ?? 0 },
      };
    });
    await this.redis.set(KEY, JSON.stringify(v), "EX", 60).catch(() => null);
    return v;
  }

  private async ctx(db: Tx): Promise<RCtx> {
    return reportCtx(db, await directory(db), await settings(db));
  }

  catalog() {
    return this.tx.run(async (db) => {
      const runs = await all<{ id: string; at: string }>(db, "report_run");
      return {
        items: REPORT_KEYS.map((key): CatalogItem => ({
          key,
          lastRun: runs.find((r) => r.id === key)?.at ?? null,
        })),
      };
    });
  }

  report(key: string, q: RunQ) {
    if (!isReportKey(key)) throw notFound("Report");
    return this.tx.run(async (db) => {
      const c = await this.ctx(db);
      const r = run(c, key, q);
      const at = nowIso();
      await put(db, "report_run", key, { id: key, at } as { status?: string });
      const five =
        key === "fin.revenue_reconciliation"
          ? {
              invoiced: r.total.invoiced,
              collected: r.total.collected,
              allocated: r.total.allocated,
              approved: r.total.approved,
              paid: r.total.paid,
            }
          : undefined;
      return {
        key,
        columns: r.cols,
        groups: r.def.groups,
        group: r.group,
        rows: r.rows,
        total: r.total,
        totals: {},
        five,
        empty: r.def.empty?.(c) ?? null,
        meta: {
          period: { from: r.from, to: r.to },
          tz: "Africa/Kigali" as const,
          filters: { group: r.group },
          definitions: r.cols.map((x) => ({ key: x.key, text: x.key })),
          generatedAt: at,
          freshness: at,
        },
      };
    });
  }

  drill(key: string, q: RunQ & { metric?: string; row?: string }) {
    if (!isReportKey(key)) throw notFound("Report");
    return this.tx.run(async (db) => {
      const { recs, group } = run(await this.ctx(db), key, q);
      const metric = q.metric ?? "";
      const items: DrillItem[] = recs
        .filter(
          (r) =>
            (!q.row || r.dims[group]?.key === q.row) &&
            (r.values[metric] ?? 0) !== 0,
        )
        .map((r) => ({
          ref: r.ref,
          href: r.href,
          date: r.date,
          party: r.party,
          state: r.state,
          value: r.values[metric],
        }))
        .sort((a, b) => b.date.localeCompare(a.date));
      return { items, total: sum(items, (i) => i.value) };
    });
  }

  // ---------------------------------------------------------------- export jobs
  startExport(
    me: SessionUser,
    key: string,
    b: { format: string; filters: Record<string, string> },
  ) {
    if (!isReportKey(key)) throw notFound("Report");
    return this.tx.run((db) => this.queueExport(db, me.id, key, b));
  }

  /** Job row + audit + bulk-queue event in the caller's tx (also used by the weekly cron). */
  private async queueExport(
    db: Tx,
    by: string,
    key: ReportKey,
    b: { format: string; filters: Record<string, string> },
  ) {
    const rows = run(await this.ctx(db), key, b.filters).rows.length;
    const job: Job = {
      id: rid("exp"),
      status: "queued",
      format: b.format,
      rowCount: rows,
      report: key,
      filters: b.filters,
      by,
    };
    await put(db, "export_job", job.id, job);
    await this.outbox.add(db, {
      type: "reports.export",
      payload: { id: job.id },
      queue: "bulk",
    });
    await this.audit.record(db, {
      action: "report.exported",
      entity: "report",
      entityId: key,
      after: { format: b.format, filters: b.filters, rows },
    });
    const { by: _b, filters: _f, report: _r, key: _k, ...out } = job;
    return out as ExportJob;
  }

  exportJob(me: SessionUser, id: string): Promise<ExportJob> {
    return this.tx.run(async (db) => {
      const j = await one<Job>(db, "export_job", id);
      if (!j || (j.by !== me.id && isExecOnly(me))) throw notFound("Export");
      if (
        j.status === "ready" &&
        j.expiresAt &&
        Date.parse(j.expiresAt) < Date.now()
      )
        return {
          id: j.id,
          status: "expired",
          format: j.format,
          rowCount: j.rowCount,
        };
      const url =
        j.status === "ready" && j.key
          ? await this.storage.presignGet(j.key, `${j.report}.csv`)
          : undefined;
      return {
        id: j.id,
        status: j.status,
        format: j.format,
        rowCount: j.rowCount,
        url,
        expiresAt: j.expiresAt,
      };
    });
  }

  /** Worker: builds and stores one queued export, then notifies the requester. */
  runExport(id: string) {
    return this.tx.runAsSystem(async (db) => {
      const j = await one<Job>(db, "export_job", id, true);
      if (!j || j.status !== "queued") return;
      try {
        const { csv, rows } = this.reportCsv(
          await this.ctx(db),
          j.report,
          j.filters,
        );
        // shortcut: xlsx/pdf formats are delivered as CSV (as in the reference); render real XLSX/PDF when the templates are approved.
        const file = await this.publishFile(
          `${j.report}-${j.filters.from ?? ""}_${j.filters.to ?? ""}.csv`,
          csv,
          "text/csv",
        );
        Object.assign(j, {
          status: "ready",
          rowCount: rows,
          key: file.key,
          expiresAt: file.expiresAt,
        });
      } catch (e) {
        Object.assign(j, { status: "failed", error: String(e) });
      }
      await put(db, "export_job", j.id, j);
      const ok = (j as ExportJob).status === "ready";
      await this.notifications.notify(db, {
        userId: j.by,
        kind: "report",
        title:
          ok
            ? `Your ${j.report} export is ready`
            : `Your ${j.report} export failed`,
        link: `/finance/reports/${j.report}?export=${j.id}`,
        data: { type: ok ? "report.export_ready" : "report.export_failed", vars: { report: j.report } },
      });
    });
  }

  /** Weekly cron: last 7 days of fin.revenue to every active finance user. */
  scheduledExports() {
    return this.tx.runAsSystem(async (db) => {
      const to = today(),
        from = addDays(to, -7);
      const fin = await db
        .select({ id: users.userId })
        .from(users)
        .where(and(eq(users.role, "staff:finance"), eq(users.isActive, true)));
      for (const u of fin)
        await this.queueExport(db, u.id, "fin.revenue", {
          format: "csv",
          filters: { from, to },
        });
      return fin.length;
    });
  }

  private reportCsv(c: RCtx, key: ReportKey, filters: Record<string, string>) {
    const r = run(c, key, filters);
    const base = r.cols.map((x) => x.key);
    // Every export carries period, filters and definitions (RPT AC).
    return {
      rows: r.rows.length,
      csv: [
        csvLine(["report", key]),
        csvLine(["period", `${r.from}..${r.to}`]),
        csvLine(["timezone", "Africa/Kigali"]),
        csvLine(["filters", JSON.stringify(filters)]),
        csvLine(["definitions", "see /finance/reports definitions drawer"]),
        "",
        csvLine([r.group, ...base]),
        ...r.rows.map((row) =>
          csvLine([row.label, ...base.map((k) => row.values[k] ?? 0)]),
        ),
        csvLine(["total", ...base.map((k) => r.total[k] ?? 0)]),
      ].join("\n"),
    };
  }

  private async publishFile(name: string, content: string, type: string) {
    const key = `exports/${rid("f")}/${name}`;
    await this.storage.putObject(key, `\uFEFF${content}`, `${type}; charset=utf-8`);
    return { key, name, expiresAt: new Date(Date.now() + DAY).toISOString() };
  }

  // ---------------------------------------------------------------- journal (F-FIN-13) — called by the finance module
  private journalFor(c: RCtx, b: JournalBody) {
    const inP = (d?: string) => !!d && d10(d) >= b.from && d10(d) <= b.to;
    const dates = new Map<string, string>();
    const ev = (e: JournalEvent, d: string) => (dates.set(e.ref, d10(d)), e);
    const events: JournalEvent[] = [
      ...issued(c)
        .filter((i) => inP(i.issuedAt))
        .map((i) =>
          ev({ kind: "invoice", ref: i.no!, totals: i.totals }, i.issuedAt!),
        ),
      ...c.data.cns
        .filter((x) => inP(x.issuedAt))
        .map((x) =>
          ev({ kind: "credit_note", ref: x.no, totals: x.totals }, x.issuedAt),
        ),
      ...c.data.pays
        .filter((p) => CONFIRMED.has(p.state) && inP(p.at))
        .map((p) =>
          ev(
            {
              kind: "payment",
              ref: p.receiptNo ?? p.id,
              applied: p.amountReceived ?? 0,
              credit: 0,
              fee: p.providerFee,
            },
            p.at,
          ),
        ),
      ...c.data.allocs
        .filter((a) => APPROVED.has(a.status) && inP(a.frozenAt))
        .map((a) =>
          ev({ kind: "allocation", ref: a.id, pool: a.pool }, a.frozenAt),
        ),
    ];
    const entries = journal(events);
    const code = (a: Account) => b.map?.[a] || ACCOUNTS[a];
    const debits = sum(entries, (e) => e.debit),
      credits = sum(entries, (e) => e.credit);
    const of = (a: Account) => entries.filter((e) => e.account === a);
    return {
      entries,
      dates,
      code,
      preview: {
        count: entries.length,
        debits,
        credits,
        balanced: debits === credits,
        byAccount: (Object.keys(ACCOUNTS) as Account[])
          .map((a) => ({
            account: a,
            code: code(a),
            debit: sum(of(a), (e) => e.debit),
            credit: sum(of(a), (e) => e.credit),
          }))
          .filter((x) => x.debit || x.credit),
        sample: entries
          .slice(0, 12)
          .map((e) => ({
            ref: e.ref,
            date: dates.get(e.ref) ?? b.from,
            account: e.account,
            code: code(e.account),
            debit: e.debit,
            credit: e.credit,
          })),
      },
    };
  }

  journalPreview(b: JournalBody) {
    if (!(b.from && b.to && b.from <= b.to)) throw invalid();
    return this.tx.run(
      async (db) => this.journalFor(await this.ctx(db), b).preview,
    );
  }

  journalExport(b: JournalBody) {
    if (!(b.from && b.to && b.from <= b.to)) throw invalid();
    return this.tx.run(async (db) => {
      const j = this.journalFor(await this.ctx(db), b);
      if (!j.preview.balanced)
        throw new AppError(422, "unbalanced", "The journal does not balance.");
      const rows = j.entries.map((e) => {
        const d = j.dates.get(e.ref) ?? b.from;
        return b.format === "quickbooks"
          ? [
              d,
              e.ref,
              `${j.code(e.account)} ${e.account}`,
              e.debit,
              e.credit,
              e.ref,
            ]
          : [d, e.ref, j.code(e.account), e.account, e.debit, e.credit];
      });
      const csv = [csvLine(JOURNAL_HEAD[b.format]), ...rows.map(csvLine)].join(
        "\n",
      );
      const checksum = createHash("sha256")
        .update(csv)
        .digest("hex")
        .slice(0, 8);
      const name = `journal-${b.from}_${b.to}-${b.format}.csv`;
      const file = await this.publishFile(name, csv, "text/csv");
      await this.audit.record(db, {
        action: "journal.exported",
        entity: "journal",
        entityId: `${b.from}..${b.to}`,
        after: {
          format: b.format,
          entries: j.entries.length,
          checksum,
          map: b.map,
        },
      });
      return {
        id: rid("jr"),
        status: "ready" as const,
        format: b.format,
        rowCount: j.entries.length,
        url: await this.storage.presignGet(file.key, name),
        expiresAt: file.expiresAt,
        checksum,
        name,
      };
    });
  }

  // ---------------------------------------------------------------- overview (U3)
  overview(me: SessionUser, date: string): Promise<Overview> {
    return this.tx.run(async (db) => {
      const c = await this.ctx(db);
      const { pays, lines, refunds, allocs, imps } = c.data;
      const exec = isExecOnly(me);
      const col = (from: string, to: string) =>
        run(c, "fin.collections", { from, to });
      const todayCol = col(date, date);
      const yday = col(addDays(date, -1), addDays(date, -1)).total.collected;
      const spark = Array.from({ length: 7 }, (_, i) => {
        const d = addDays(date, i - 6);
        return col(d, d).total.collected;
      });
      const pending = pays.filter((p) =>
        ["proof_submitted", "under_verification", "pending_provider"].includes(
          p.state,
        ),
      );
      const openLines = lines.filter((l) =>
        ["unmatched", "suggested", "exception"].includes(l.match),
      );
      const rfs = refunds.filter((r) =>
        [
          "recommended",
          "awaiting_executive",
          "approved",
          "execution_failed",
        ].includes(r.status),
      );
      const rev = allocs.filter((x) => x.status === "reviewed");
      // Next run: payout_day of this month, or next month once passed (D-12).
      const day = c.S.payout_day;
      const t = new Date(date);
      const thisRun = new Date(
        Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), day),
      );
      const next =
        thisRun.toISOString().slice(0, 10) >= date
          ? thisRun
          : new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, day));
      const gross = new Map<string, number>();
      for (const al of allocs.filter(
        (x) => x.status === "approved_for_payment",
      ))
        for (const s of al.shares)
          gross.set(s.workerId, (gross.get(s.workerId) ?? 0) + s.amount);
      const projectedNet = sum(
        [...gross],
        ([id, g]) =>
          payoutLine({
            gross: g,
            adjustments: 0,
            fees: c.S.licence_fee_monthly,
            external: c.D.workerKind(id) === "external",
            whtBps: c.S.wht_bps,
          }).net,
      );
      const open = issued(c).filter((i) => i.balanceDue > 0);
      const ageing = ageingSummary(open, date);
      const receivables = sum(open, (i) => i.balanceDue);
      const plan = open.filter((i) => i.series === "plan" && i.dueAt);
      const overdue = open.filter((i) => i.dueAt && d10(i.dueAt) < date);
      const queues: Overview["queues"] = exec
        ? []
        : [
            {
              key: "proofs",
              n: pays.filter(
                (p) =>
                  p.state === "proof_submitted" ||
                  p.state === "under_verification",
              ).length,
              href: "/finance/payments/proofs",
            },
            {
              key: "pending_momo",
              n: pays.filter((p) => p.state === "pending_provider").length,
              href: "/finance/payments?tab=pending",
            },
            {
              key: "allocations",
              n: rev.length,
              href: "/finance/revenue?tab=allocations&state=reviewed",
            },
            {
              key: "unmatched",
              n: openLines.length,
              href: "/finance/reconciliation",
            },
            { key: "refunds", n: rfs.length, href: "/finance/refunds" },
            {
              key: "overdue",
              n: overdue.length,
              href: "/finance/receivables?bucket=0_30",
            },
          ];
      const work = queues
        .filter((q) => q.key !== "overdue")
        .reduce((s, q) => s + q.n, 0);
      return {
        date,
        execOnly: exec,
        quiet: !exec && work === 0,
        tiles: {
          collected: {
            total: todayCol.total.collected,
            count: todayCol.total.confirmed,
            spark,
            delta: yday
              ? Math.round(((todayCol.total.collected - yday) * 100) / yday)
              : null,
            href: `/finance/reports/fin.collections?from=${date}&to=${date}&group=method`,
          },
          pending: {
            total: sum(pending, (p) => p.amountExpected),
            count: pending.length,
            href: "/finance/payments?tab=pending",
          },
          unreconciled: {
            total: sum(openLines, (l) => l.amount),
            count: openLines.length,
            hasImport: imps.length > 0,
            href: "/finance/reconciliation",
          },
          refunds: {
            total: sum(rfs, (r) => r.approved ?? r.recommended ?? r.requested),
            count: rfs.length,
            href: "/finance/refunds",
          },
          allocations: {
            total: sum(rev, (x) => x.pool),
            count: rev.length,
            href: "/finance/revenue?tab=allocations&state=reviewed",
          },
        },
        nextPayout: {
          date: next.toISOString().slice(0, 10),
          projectedNet,
          agents: gross.size,
        },
        ageing,
        receivables,
        currentPct: receivables
          ? Math.round((ageing.not_due * 100) / receivables)
          : 100,
        renewals: {
          due7: plan.filter(
            (i) => d10(i.dueAt!) >= date && d10(i.dueAt!) <= addDays(date, 7),
          ).length,
          pastDue: plan.filter((i) => d10(i.dueAt!) < date).length,
        },
        queues,
      };
    });
  }

  /** Statement balances by provider (last import). shortcut: from imported statements, not live provider balance APIs. */
  cashPosition() {
    return this.tx.run(async (db) => {
      const [imps, lines] = await Promise.all([
        all<StatementImport>(db, "import"),
        all<StatementLine>(db, "line"),
      ]);
      if (!imps.length)
        return {
          asOf: null,
          accounts: [] as { provider: string; balance: number }[],
          total: 0,
        };
      const byProvider = new Map<string, number>();
      for (const l of lines) {
        const p = imps.find((i) => i.id === l.importId)?.provider ?? "bank";
        byProvider.set(p, (byProvider.get(p) ?? 0) + l.amount - l.fee);
      }
      const accounts = [...byProvider].map(([provider, balance]) => ({
        provider,
        balance,
      }));
      return {
        asOf:
          imps
            .map((i) => i.to)
            .sort()
            .at(-1) ?? null,
        accounts,
        total: sum(accounts, (a) => a.balance),
      };
    });
  }
}

// shortcut: column sets are PLACEHOLDER(accounting-export-columns) approximations, confirm against each package's import template.
const JOURNAL_HEAD: Record<JournalBody["format"], string[]> = {
  generic_csv: [
    "date",
    "reference",
    "account_code",
    "account",
    "debit",
    "credit",
  ],
  quickbooks: [
    "JournalDate",
    "JournalNo",
    "AccountName",
    "Debits",
    "Credits",
    "Description",
  ],
  xero: ["Date", "Reference", "AccountCode", "Description", "Debit", "Credit"],
  odoo: ["date", "ref", "account_id", "name", "debit", "credit"],
};
