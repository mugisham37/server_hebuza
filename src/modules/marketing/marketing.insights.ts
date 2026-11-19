// P11 growth, feedback and insights (port of src/mocks/handlers-marketing-insights.ts) on real data: the dashboard
// summary, report tabs and export, social metrics import, testimonials, feedback/NPS and the referral programme.
// Visits are first-party (tracked /c and /r link clicks); GA4 traffic stays "not connected" until its API is wired.
import { gte, sql } from "drizzle-orm";
import { npsResponses, outbox } from "@/db/schema";
import { siteEvents } from "@/db/schema/schema-marketing";
import type { Exec } from "./marketing.store";
import {
  avgRating,
  cpl,
  funnelRates,
  nps,
  roi,
  toCsv,
} from "@/domain/marketing/reports";
import { classifyReferral, rewardDue } from "@/domain/marketing/referral";
import { toE164 } from "@/domain/marketing/dedupe";
import type {
  Campaign,
  Contact,
  Lead,
  Referral,
  Referrer,
  Testimonial,
} from "@/domain/marketing/types";
import {
  type Caller,
  auditReason,
  countRequests,
  get,
  list,
  mktError,
  notFound,
  paidInvoices,
  policy,
  pushNote,
  put,
  record,
  remove,
  saveSetting,
  seqId,
  setting,
} from "./marketing.store";
import { health } from "./marketing.content";

const D = 86_400_000;
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- range
export type RangeQ = {
  range?: string;
  from?: string;
  to?: string;
  model?: string;
  source?: string;
  service?: string;
  report?: string;
  format?: string;
};
export function rangeOf(q: RangeQ) {
  const r = q.range ?? "30d";
  if (
    r === "custom" &&
    q.from &&
    q.to &&
    !Number.isNaN(Date.parse(q.from)) &&
    !Number.isNaN(Date.parse(q.to))
  ) {
    const days = Math.max(
      1,
      Math.round((Date.parse(q.to) - Date.parse(q.from)) / D) + 1,
    );
    return {
      range: r,
      days,
      from: Date.parse(q.from),
      to: Date.parse(q.to) + D,
    };
  }
  const days = r === "today" ? 1 : r === "7d" ? 7 : r === "90d" ? 90 : 30;
  const now = Date.now();
  return { range: r, days, from: now - days * D, to: now };
}
const inR = (iso: string | undefined, from: number, to: number) =>
  !!iso && Date.parse(iso) >= from && Date.parse(iso) < to;

// ---------------------------------------------------------------- first-party visits (link clicks)
export type LinkDoc = {
  code: string;
  target: string;
  campaign?: string;
  campaignId?: string;
  referrerId?: string;
  clicks: number;
  daily?: Record<string, number>;
  sources?: Record<string, number>;
  createdAt: string;
};
function clicksIn(
  links: LinkDoc[],
  from: number,
  to: number,
  f?: (l: LinkDoc) => boolean,
) {
  let n = 0;
  for (const l of links)
    if (!f || f(l))
      for (const [day, c] of Object.entries(l.daily ?? {}))
        if (inR(`${day}T12:00:00Z`, from, to)) n += c;
  return n;
}
const sparkOf = (dates: string[], from: number, to: number) => {
  const w = (to - from) / 12;
  const out = Array<number>(12).fill(0);
  for (const d of dates) {
    const t = Date.parse(d);
    if (t >= from && t < to) out[Math.min(11, Math.floor((t - from) / w))]++;
  }
  return out;
};

// ---------------------------------------------------------------- funnel + attribution
type Model = "last" | "first";
const touchOf = (l: Lead, m: Model) =>
  m === "first" ? l.firstTouch : l.lastTouch;
const isConsult = (l: Lead) =>
  l.source === "booking" || l.stage === "quote_sent" || l.stage === "won";

async function funnel(
  db: Exec,
  from: number,
  to: number,
  leads: Lead[],
  links: LinkDoc[],
  paid: Awaited<ReturnType<typeof paidInvoices>>,
  source?: string,
) {
  const ls = leads.filter(
    (l) =>
      inR(l.createdAt, from, to) &&
      (!source || (l.lastTouch?.source ?? "direct") === source),
  );
  const payers = new Set(
    paid.filter((p) => inR(p.paidAt, from, to)).map((p) => p.clientId),
  );
  return {
    visits: clicksIn(
      links,
      from,
      to,
      source
        ? (l) =>
            (l.referrerId ? "referral" : "campaign") === source ||
            l.campaign === source
        : undefined,
    ),
    leads: ls.length,
    consultations: ls.filter(isConsult).length,
    requests: source
      ? ls.filter((l) => !!l.clientId).length
      : await countRequestsBetween(db, from, to),
    paid: source
      ? ls.filter((l) => l.clientId && payers.has(l.clientId)).length
      : payers.size,
  };
}
const countRequestsBetween = (db: Exec, from: number, to: number) =>
  countRequests(db, new Date(from).toISOString(), new Date(to).toISOString());

async function campaignRows(db: Exec, model: Model, from: number, to: number) {
  const [cps, leads, paid, cts, p] = await Promise.all([
    list<Campaign>(db, "campaign"),
    list<Lead>(db, "lead"),
    paidInvoices(db),
    list<Contact>(db, "contact", { status: ["customer"] }),
    policy(db),
  ]);
  const win = p.attributionDays * D;
  const nameOf = (id: string) => cts.find((x) => x.clientId === id)?.name ?? id;
  return cps
    .map((c) => {
      const ls = leads.filter(
        (l) =>
          l.stage !== "merged" &&
          touchOf(l, model)?.campaign === c.slug &&
          Date.parse(l.createdAt) >= from - win &&
          Date.parse(l.createdAt) < to,
      );
      const chain = ls.flatMap((l) =>
        paid
          .filter(
            (x) =>
              l.clientId &&
              x.clientId === l.clientId &&
              Date.parse(x.paidAt) >= Date.parse(l.createdAt) &&
              Date.parse(x.paidAt) <= Date.parse(l.createdAt) + win,
          )
          .map((x) => ({
            leadId: l.id,
            leadName: l.name,
            client: nameOf(l.clientId!),
            invoiceNo: x.no,
            total: x.total,
            paidAt: x.paidAt,
          })),
      );
      const cost = c.stats.sent * (p.unitCost[c.channel] ?? 0);
      const revenue = chain.reduce((a, x) => a + x.total, 0);
      return {
        id: c.id,
        name: c.name,
        slug: c.slug,
        channel: c.channel,
        source: c.channel,
        leads: ls.length,
        consultations: ls.filter(isConsult).length,
        requests: ls.filter((l) => l.stage === "won" || !!l.clientId).length,
        paid: new Set(chain.map((x) => x.leadId)).size,
        revenue,
        cost,
        cpl: cpl(cost, ls.length),
        roi: roi(revenue, cost),
        chain,
      };
    })
    .filter((r) => r.leads || r.cost);
}

const group = <T>(xs: T[], f: (x: T) => string | undefined) =>
  Object.entries(
    xs.reduce(
      (m, x) => {
        const k = f(x);
        if (k) m[k] = (m[k] ?? 0) + 1;
        return m;
      },
      {} as Record<string, number>,
    ),
  )
    .map(([key, n]) => ({ key, n }))
    .sort((a, b) => b.n - a.n);

// ---------------------------------------------------------------- summary
export async function summary(db: Exec, q: RangeQ) {
  const { range, days, from, to } = rangeOf(q);
  const prevFrom = from - (to - from);
  const [leads, links, paid, cps, hl] = await Promise.all([
    list<Lead>(db, "lead"),
    list<LinkDoc>(db, "link"),
    paidInvoices(db),
    list<Campaign>(db, "campaign"),
    health(db),
  ]);
  const live = leads.filter((l) => l.stage !== "merged");
  const [f, prev] = await Promise.all([
    funnel(db, from, to, live, links, paid),
    funnel(db, prevFrom, from, live, links, paid),
  ]);
  const rows = await campaignRows(db, "last", from, to);
  const revenue = paid
    .filter((p) => inR(p.paidAt, from, to))
    .reduce((a, p) => a + p.total, 0);
  const prevRevenue = paid
    .filter((p) => inR(p.paidAt, prevFrom, from))
    .reduce((a, p) => a + p.total, 0);
  const inRange = live.filter((l) => inR(l.createdAt, from, to));
  const ga4 = false; // shortcut: GA4 Data API not wired (needs a service account); first-party clicks drive the funnel until then.
  return {
    range,
    days,
    generatedAt: nowIso(),
    firstWeek: live.length === 0,
    ga4Connected: ga4,
    trafficError: ga4 ? null : "ga4_not_connected",
    kpis: {
      visitors: null as null | { value: number; prev: number; spark: number[] },
      leads: {
        value: f.leads,
        prev: prev.leads,
        spark: sparkOf(
          inRange.map((l) => l.createdAt),
          from,
          to,
        ),
      },
      consultations: {
        value: f.consultations,
        prev: prev.consultations,
        spark: sparkOf(
          inRange.filter(isConsult).map((l) => l.createdAt),
          from,
          to,
        ),
      },
      paidClients: {
        value: f.paid,
        prev: prev.paid,
        spark: sparkOf(
          paid.map((p) => p.paidAt),
          from,
          to,
        ),
      },
      revenue: { value: revenue, prev: prevRevenue, spark: [] as number[] },
    },
    funnel: funnelRates(
      (["visits", "leads", "consultations", "requests", "paid"] as const).map(
        (key) => ({ key, count: f[key] }),
      ),
    ),
    bySource: group(inRange, (l) => l.lastTouch?.source ?? "direct").map(
      ({ key, n }) => ({ source: key, leads: n }),
    ),
    topPages: [] as { path: string; views: number }[],
    topServices: group(inRange, (l) => l.serviceInterest[0])
      .slice(0, 5)
      .map(({ key, n }) => ({ slug: key, leads: n })),
    campaigns: rows.map(({ chain: _c, ...r }) => r),
    attention: {
      newLeads: live.filter((l) => l.stage === "new").length,
      awaitingApproval: cps.filter((c) => c.status === "pending_approval")
        .length,
      brokenLinks: hl.broken.length,
      pausedBudget: cps.filter(
        (c) => c.status === "paused" && c.pausedReason === "budget_cap",
      ).length,
    },
    recent: live
      .slice(0, 6)
      .map((l) => ({
        id: l.id,
        kind: "lead",
        text: l.name,
        sub: l.lastTouch?.source ?? "direct",
        at: l.createdAt,
        href: `/marketing/leads?lead=${l.id}`,
      })),
    next:
      cps
        .filter(
          (c) => c.status === "scheduled" || c.status === "pending_approval",
        )
        .map((c) => ({
          id: c.id,
          label: c.name,
          status: c.status,
          at: c.scheduledAt ?? null,
          href: `/marketing/campaigns/${c.id}`,
        }))[0] ?? null,
  };
}

// ---------------------------------------------------------------- report tabs
export async function analytics(db: Exec, tab: string, q: RangeQ) {
  const { days, from, to } = rangeOf(q);
  const model: Model = q.model === "first" ? "first" : "last";
  const generatedAt = nowIso();
  switch (tab) {
    case "funnel": {
      const [leads, links, paid] = await Promise.all([
        list<Lead>(db, "lead"),
        list<LinkDoc>(db, "link"),
        paidInvoices(db),
      ]);
      const live = leads.filter((l) => l.stage !== "merged");
      const f = await funnel(
        db,
        from,
        to,
        live,
        links,
        paid,
        q.source || undefined,
      );
      const months = Array.from(
        { length: Math.min(6, Math.ceil(days / 30)) },
        (_, i) => {
          const d = new Date();
          d.setUTCMonth(d.getUTCMonth() - i);
          const month = d.toISOString().slice(0, 7);
          return {
            month,
            leads: live.filter(
              (l) =>
                l.createdAt.startsWith(month) &&
                (!q.source || (l.lastTouch?.source ?? "direct") === q.source),
            ).length,
          };
        },
      ).reverse();
      return {
        generatedAt,
        model,
        steps: funnelRates(
          (
            ["visits", "leads", "consultations", "requests", "paid"] as const
          ).map((key) => ({ key, count: f[key] })),
        ),
        months,
      };
    }
    case "campaigns":
      return {
        generatedAt,
        model,
        rows: await campaignRows(db, model, from, to),
      };
    case "leads": {
      const ls = (await list<Lead>(db, "lead")).filter(
        (l) => l.stage !== "merged" && inR(l.createdAt, from, to),
      );
      const won = ls.filter((l) => l.stage === "won").length,
        lost = ls.filter((l) => l.stage === "lost").length;
      const responded = ls.filter((l) => l.firstResponseAt);
      const ttfr = responded.length
        ? Math.round(
            (responded.reduce(
              (a, l) =>
                a + (Date.parse(l.firstResponseAt!) - Date.parse(l.createdAt)),
              0,
            ) /
              responded.length /
              3600_000) *
              10,
          ) / 10
        : null;
      return {
        generatedAt,
        total: ls.length,
        bySource: group(ls, (l) => l.source),
        byStage: group(ls, (l) => l.stage),
        lostReasons: group(ls, (l) => l.lostReason),
        ttfrHours: ttfr,
        winRate:
          won + lost ? Math.round((won / (won + lost)) * 1000) / 10 : null,
      };
    }
    case "traffic": {
      const links = await list<LinkDoc>(db, "link");
      const sessions = clicksIn(links, from, to);
      const src: Record<string, number> = {};
      for (const l of links) {
        const n = clicksIn([l], from, to);
        if (n)
          src[l.referrerId ? "referral" : "campaign"] =
            (src[l.referrerId ? "referral" : "campaign"] ?? 0) + n;
      }
      const pages: Record<string, number> = {};
      for (const l of links) {
        const n = clicksIn([l], from, to);
        if (n) pages[l.target] = (pages[l.target] ?? 0) + n;
      }
      return {
        generatedAt,
        provider: "first_party",
        // F-CRM-16 first-party page views (consented visitors): sessions add page views, users = distinct visitor ids.
        ...(await (async () => {
          const [pv] = await db.select({ views: sql<number>`count(*)::int`, users: sql<number>`count(distinct ${siteEvents.visitor})::int` })
            .from(siteEvents).where(sql`${siteEvents.name} = 'page_view' and ${siteEvents.createdAt} >= ${from} and ${siteEvents.createdAt} <= ${to}`);
          return { sessions: sessions + (pv?.views ?? 0), users: pv?.users || sessions };
        })()),
        sources: Object.entries(src)
          .map(([source, s]) => ({ source, sessions: s }))
          .sort((a, b) => b.sessions - a.sessions),
        pages: Object.entries(pages)
          .map(([path, views]) => ({ path, views }))
          .sort((a, b) => b.views - a.views)
          .slice(0, 10),
      };
    }
    case "social":
      return {
        generatedAt,
        rows: (await list<SocialRow>(db, "social")).sort((a, b) =>
          b.date.localeCompare(a.date),
        ),
      };
    case "clients": {
      const [cs, paid, p] = await Promise.all([
        list<Contact>(db, "contact", { status: ["customer"] }),
        paidInvoices(db),
        policy(db),
      ]);
      const all = await list<Contact>(db, "contact");
      const n = (id?: string) => paid.filter((x) => x.clientId === id).length;
      return {
        generatedAt,
        inactiveDays: p.inactiveDays,
        newClients: cs.filter((c) => n(c.clientId) <= 1).length,
        returning: cs.filter((c) => n(c.clientId) > 1).length,
        inactive: all.filter(
          (c) => Date.parse(c.lastActiveAt) < Date.now() - p.inactiveDays * D,
        ).length,
        active: all.filter((c) => Date.parse(c.lastActiveAt) >= from).length,
        reactivationRate: null,
        renewalsDue: null,
      };
    }
  }
  throw notFound("Report");
}

/** PII-bearing export: the reason travels in X-Audit-Reason and lands in the audit log. */
export async function exportReport(c: Caller, q: RangeQ) {
  const reason = auditReason(c.req);
  if (!reason) throw mktError(422, "reason_required", null, "Reason required");
  const report = q.report ?? "campaigns",
    format = q.format ?? "csv";
  await record(c, "report.exported", report, { format, range: q.range }, reason);
  // shortcut: CSV only; XLSX/PDF answer "queued" until the reports export job (P6 reports.jobs) takes marketing reports.
  if (format !== "csv") return { queued: true, csv: null, filename: null };
  const { from, to } = rangeOf(q);
  const rows =
    report === "social"
      ? [
          [
            "date",
            "network",
            "campaign",
            "reach",
            "impressions",
            "engagements",
            "clicks",
            "followers",
            "spend_rwf",
          ],
          ...(await list<SocialRow>(c.db, "social")).map((s) => [
            s.date,
            s.network,
            s.campaign,
            s.reach,
            s.impressions,
            s.engagements,
            s.clicks,
            s.followers,
            s.spend,
          ]),
        ]
      : [
          [
            "campaign",
            "id",
            "leads",
            "paid",
            "revenue_rwf",
            "cost_rwf",
            "cpl_rwf",
            "roi_pct",
          ],
          ...(
            await campaignRows(
              c.db,
              q.model === "first" ? "first" : "last",
              from,
              to,
            )
          ).map((r) => [
            r.name,
            r.id,
            r.leads,
            r.paid,
            r.revenue,
            r.cost,
            r.cpl,
            r.roi,
          ]),
        ];
  return {
    queued: false,
    csv: toCsv(rows),
    filename: `hebuza-${report}-${nowIso().slice(0, 10)}.csv`,
  };
}

// ---------------------------------------------------------------- social metrics
export type SocialRow = {
  id: string;
  date: string;
  network: string;
  campaign: string;
  reach: number;
  impressions: number;
  engagements: number;
  clicks: number;
  followers: number;
  spend: number;
  utmMatch: string | null;
};
const NEED = [
  "date",
  "network",
  "campaign",
  "reach",
  "impressions",
  "engagements",
  "clicks",
  "followers",
  "spend",
];
const NUMS = [
  "reach",
  "impressions",
  "engagements",
  "clicks",
  "followers",
  "spend",
] as const;

async function utmMatcher(db: Exec) {
  const [cps, leads] = await Promise.all([
    list<Campaign>(db, "campaign"),
    list<Lead>(db, "lead"),
  ]);
  return (campaign: string) =>
    cps.find((c) => c.slug === campaign)?.id ??
    (leads.some(
      (l) =>
        l.lastTouch?.campaign === campaign ||
        l.firstTouch?.campaign === campaign,
    )
      ? `utm:${campaign}`
      : null);
}

export async function importSocial(c: Caller, csv: string) {
  const lines = csv.replace(/^\uFEFF/, "").trim().split(/\r?\n/).filter(Boolean);
  const head = (lines.shift() ?? "")
    .toLowerCase()
    .split(",")
    .map((h) => h.trim());
  const missing = NEED.filter((h) => !head.includes(h));
  if (missing.length) throw mktError(422, "mapping_required", { missing });
  const match = await utmMatcher(c.db);
  const rows = lines.slice(0, 5000).map((ln, i) => {
    const cells = ln.split(",").map((x) => x.trim());
    const v = (k: string) => cells[head.indexOf(k)] ?? "";
    const nums = NUMS.map((k) => (/^\d+$/.test(v(k)) ? Number(v(k)) : NaN));
    const error = !/^\d{4}-\d{2}-\d{2}$/.test(v("date"))
      ? "date"
      : nums.some(Number.isNaN)
        ? "number"
        : null; // spend must be whole RWF
    const row: SocialRow = {
      id: "",
      date: v("date"),
      network: v("network").toLowerCase(),
      campaign: v("campaign"),
      reach: nums[0],
      impressions: nums[1],
      engagements: nums[2],
      clicks: nums[3],
      followers: nums[4],
      spend: nums[5],
      utmMatch: match(v("campaign")),
    };
    return { line: i + 2, error, row };
  });
  const id = await seqId(c.db, "simp");
  await put(c.db, {
    kind: "social_preview",
    id,
    data: {
      rows: rows.filter((r) => !r.error).map((r) => r.row),
      by: c.session?.id ?? "",
    },
    ref: c.session?.id ?? null,
  });
  return { id, rows };
}
export async function confirmSocial(c: Caller, id: string) {
  const p = await get<{ rows: SocialRow[]; by: string }>(
    c.db,
    "social_preview",
    id,
    true,
  );
  if (!p || p.by !== (c.session?.id ?? "")) throw notFound("Preview");
  for (const r of p.rows) {
    const sid = await seqId(c.db, "so");
    await put(c.db, {
      kind: "social",
      id: sid,
      data: { ...r, id: sid },
      ref: r.campaign,
    });
  }
  await remove(c.db, "social_preview", id);
  await record(c, "social.imported", id, { count: p.rows.length });
  return { created: p.rows.length };
}
export async function addSocial(
  c: Caller,
  b: Omit<SocialRow, "id" | "utmMatch">,
) {
  const id = await seqId(c.db, "so");
  const row: SocialRow = {
    ...b,
    network: b.network.toLowerCase(),
    id,
    utmMatch: (await utmMatcher(c.db))(b.campaign),
  };
  await put(c.db, { kind: "social", id, data: row, ref: b.campaign });
  await record(c, "social.added", id);
  return row;
}

// ---------------------------------------------------------------- testimonials (F-FBK-07)
const saveTs = (db: Exec, t: Testimonial) =>
  put(db, { kind: "testimonial", id: t.id, data: t, status: t.status });
export async function testimonials(db: Exec, status = "pending") {
  const all = await list<Testimonial>(db, "testimonial");
  const n = (s: string) => all.filter((t) => t.status === s).length;
  return {
    items: all.filter((t) => t.status === status),
    counts: {
      pending: n("pending"),
      published: n("published"),
      rejected: n("rejected"),
    },
  };
}
/** Published testimonials for the public site (RSC; cache with a "testimonials" tag). */
export async function publishedTestimonials(
  db: Exec,
  placement?: "home" | "service" | "landing",
  serviceSlug?: string,
) {
  return (await list<Testimonial>(db, "testimonial", { status: ["published"] }))
    .filter(
      (t) =>
        t.consent &&
        (!placement || t.placements.includes(placement)) &&
        (!serviceSlug || t.serviceSlug === serviceSlug),
    )
    .map((t) => ({
      id: t.id,
      clientLabel: t.clientLabel,
      stars: t.stars,
      quote: t.excerpt ?? t.quote,
      language: t.language,
      serviceSlug: t.serviceSlug,
    }));
}
export async function testimonialAction(
  c: Caller,
  id: string,
  action: string,
  b: {
    placements?: ("home" | "service" | "landing")[];
    reason?: string;
    excerpt?: string;
  },
) {
  const t = await get<Testimonial>(c.db, "testimonial", id, true);
  if (!t) throw notFound("Testimonial");
  switch (action) {
    case "approve":
      if (!t.consent)
        throw mktError(422, "CONSENT_REQUIRED", null, "No consent");
      if (!b.placements?.length)
        throw mktError(422, "validation", null, "Pick a placement");
      Object.assign(t, {
        status: "published",
        placements: [...new Set(b.placements)],
        rejectedReason: undefined,
      });
      await record(c, "testimonial.published", t.id, { placements: b.placements });
      break;
    case "reject":
      if (!b.reason?.trim())
        throw mktError(422, "reason_required", null, "Reason required");
      Object.assign(t, {
        status: "rejected",
        rejectedReason: b.reason.trim(),
        placements: [],
      });
      await record(c, "testimonial.rejected", t.id, {}, b.reason.trim());
      break;
    case "unpublish":
      Object.assign(t, { status: "pending", placements: [] });
      await record(c, "testimonial.unpublished", t.id);
      break;
    case "request-consent":
      // The client answers on their dashboard (GET/POST me/testimonial-requests); tell them in-app.
      t.consentRequested = true;
      // Applications are RLS-hidden from marketing: the worker finds the owner and sends the in-app notification.
      await c.db.insert(outbox).values({ type: "marketing.testimonial_consent_requested", payload: { ratingId: t.ratingId } });
      await record(c, "testimonial.consent_requested", t.id);
      break;
    case "excerpt": {
      const ex = b.excerpt?.trim() ?? "";
      if (!ex || !t.quote.includes(ex.replace(/…$/, "")))
        throw mktError(
          422,
          "validation",
          null,
          "Excerpt must come from the original words",
        );
      Object.assign(t, {
        excerpt: ex,
        consent: false,
        consentRequested: true,
        status: "pending",
        placements: [],
      }); // edited words need fresh client consent
      await record(c, "testimonial.excerpted", t.id);
      break;
    }
    case "simulate-consent":
      if (c.prod !== false) throw notFound("Action"); // dev only; unknown env counts as production
      t.consent = true;
      t.consentRequested = false;
      await pushNote(c.db, {
        kind: "testimonial",
        text: `Consent given: ${t.clientLabel}`,
        href: "/marketing/testimonials",
      });
      break;
    default:
      throw notFound("Action");
  }
  await saveTs(c.db, t);
  return t;
}
/** Client gave (or withdrew) consent from their feedback screen. */
export async function testimonialConsent(
  db: Exec,
  id: string,
  consent: boolean,
) {
  const t = await get<Testimonial>(db, "testimonial", id, true);
  if (!t) throw notFound("Testimonial");
  t.consent = consent;
  t.consentRequested = false;
  if (!consent) Object.assign(t, { status: "pending", placements: [] });
  await saveTs(db, t);
  if (consent)
    await pushNote(db, {
      kind: "testimonial",
      text: `Consent given: ${t.clientLabel}`,
      href: "/marketing/testimonials",
    });
  return t;
}

// ---------------------------------------------------------------- feedback / NPS
type Rating = {
  id: string;
  stars: number;
  nps: number | null;
  service: string;
  tag?: string;
  at: string;
};
export async function feedback(db: Exec, q: RangeQ) {
  const { from } = rangeOf(q);
  const p = await policy(db);
  const seeded = await list<Rating>(db, "rating");
  // applications are RLS-hidden from staff:marketing: read (id, rating, rated_at, service) through the 0012 definer fn.
  const real = [
    ...(await db.execute<{ id: string; stars: number; at: string; service: string }>(
      sql`select application_id as id, rating as stars, rated_at::text as at, service_slug as service from marketing_ratings()`,
    )),
  ];
  const all: Rating[] = [
    ...seeded,
    ...real.map((r) => ({
      id: r.id,
      stars: r.stars,
      nps: null,
      service: r.service,
      at: new Date(r.at).toISOString(),
    })),
  ];
  const xs = all.filter(
    (r) => Date.parse(r.at) >= from && (!q.service || r.service === q.service),
  );
  // F-FBK-02: real client NPS answers alongside seeded ones.
  const real_nps = await db.select({ score: npsResponses.score }).from(npsResponses).where(gte(npsResponses.createdAt, new Date(from).toISOString()));
  const scores = [...xs.flatMap((r) => (r.nps == null ? [] : [r.nps])), ...real_nps.map((r) => r.score)];
  const services = [...new Set(all.map((r) => r.service))];
  return {
    generatedAt: nowIso(),
    total: xs.length,
    avg: avgRating(xs.map((r) => r.stars)),
    nps: scores.length >= p.npsMinSample ? nps(scores) : null,
    npsMin: p.npsMinSample,
    byService: services.map((s) => {
      const x = xs.filter((r) => r.service === s);
      return { service: s, avg: avgRating(x.map((r) => r.stars)), n: x.length };
    }),
    themes: group(xs, (r) => r.tag).map(({ key, n }) => ({ tag: key, n })),
    services,
    recent: await list<Testimonial>(db, "testimonial", {
      status: ["published"],
    }),
    distribution: [5, 4, 3, 2, 1].map((s) => ({
      stars: s,
      n: xs.filter((r) => r.stars === s).length,
    })),
  };
}

// ---------------------------------------------------------------- referrals (F-CRM-13)
export type Programme = {
  active: boolean;
  reward: number;
  eligibility: "first_paid_request";
  channels: string[];
  updatedAt: string;
};
export async function programme(db: Exec) {
  const p = await policy(db);
  return setting<Programme>(db, "referral_programme", {
    active: true,
    reward: p.referralReward,
    eligibility: "first_paid_request",
    channels: ["client", "agent"],
    updatedAt: nowIso(),
  });
}
export async function saveProgramme(
  c: Caller,
  b: Partial<Pick<Programme, "active" | "reward" | "channels">>,
) {
  const cur = await programme(c.db);
  const next = { ...cur, ...b, updatedAt: nowIso() };
  await saveSetting(c.db, "referral_programme", next);
  await record(c, "referral.programme_changed", "default", b);
  return next;
}
export async function referrals(db: Exec) {
  const [rs, xs, prog] = await Promise.all([
    list<Referrer>(db, "referrer"),
    list<Referral>(db, "referral"),
    programme(db),
  ]);
  const referrers = rs.map((r) => {
    const mine = xs.filter((x) => x.referrerId === r.id);
    return {
      ...r,
      referred: mine.filter((x) => x.state !== "clicked").length,
      paid: mine.filter((x) => x.state === "paid" || x.state === "rewarded")
        .length,
      rewardDue: rewardDue(mine, prog.reward),
    };
  });
  return {
    referrers,
    referrals: xs,
    fraud: {
      selfBlocked: xs.filter((r) => r.state === "rejected_self").length,
      ineligible: xs.filter((r) => r.state === "ineligible").length,
    },
    totalDue: referrers.reduce((a, r) => a + r.rewardDue, 0),
  };
}

/** Sign-up with a referral code (auth P1 calls this after creating the account). Self-referral and existing clients never earn. */
export async function referralSignup(
  db: Exec,
  code: string,
  referee: {
    userId: string;
    name: string;
    phone?: string;
    email?: string;
    wasClient?: boolean;
  },
) {
  const r = (await list<Referrer>(db, "referrer")).find(
    (x) => x.code.toUpperCase() === code.toUpperCase(),
  );
  if (!r || !(await programme(db)).active) return null;
  const owner = (await list<Contact>(db, "contact", { ref: r.id }))[0];
  const state = classifyReferral(
    { userId: r.id, phone: owner?.phoneE164, email: owner?.email },
    {
      userId: referee.userId,
      phone: toE164(referee.phone) ?? undefined,
      email: referee.email,
      wasClient: referee.wasClient,
    },
  );
  const id = await seqId(db, "rf");
  const [first, ...rest] = referee.name.trim().split(/\s+/);
  const ref: Referral & { refereeId: string } = {
    id,
    code: r.code,
    referrerId: r.id,
    refereeLabel: `${first} ${rest[0]?.[0] ? `${rest[0][0]}.` : ""}`.trim(),
    state,
    at: nowIso(),
    refereeId: referee.userId,
  };
  await put(db, {
    kind: "referral",
    id,
    data: ref,
    status: state,
    ref: referee.userId,
  });
  return ref;
}

/** Referees whose first request is paid move signed_up → paid (cron beside the lead conversion sweep). */
export async function sweepReferrals(db: Exec) {
  const payers = new Set((await paidInvoices(db)).map((p) => p.clientId));
  let n = 0;
  for (const r of await list<Referral & { refereeId?: string }>(
    db,
    "referral",
    { status: ["signed_up"] },
  )) {
    if (!r.refereeId || !payers.has(r.refereeId)) continue;
    await put(db, {
      kind: "referral",
      id: r.id,
      data: { ...r, state: "paid" },
      status: "paid",
      ref: r.refereeId,
    });
    await pushNote(db, {
      kind: "lead",
      text: `Referral reward due: ${r.code}`,
      href: "/marketing/referrals",
    });
    n++;
  }
  return n;
}

