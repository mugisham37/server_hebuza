// CMS: entries + per-locale variants with the editorial workflow, versions, comments, locks, redirects, nav, site
// settings and the public read side. Port of .ref cms.service.ts; workflow rules stay in @/domain/marketing/cms/rules.
// Every write that changes public output returns cache tags; the service turns them into a `cms.revalidate` outbox event
// (web /hooks/revalidate) in the same tx and drops the Redis public cache after commit.
import { randomUUID } from "node:crypto";
import { generateId, iso } from "../../core/db/ids";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { and, asc, desc, eq, ne, sql as dsql } from "drizzle-orm";
import { contactInquiries, users } from "@/db/schema";
import { complianceRules } from "@/db/schema/schema-ops";
import { captureFrom } from "../marketing/marketing.crm";
import {
  cmsComments,
  cmsEntries,
  cmsLocks,
  cmsNav,
  cmsNotFound,
  cmsFeedback,
  cmsRedirects,
  cmsSiteSettings,
  cmsVersions,
  contactRefSeq,
} from "@/db/schema/schema-cms";
import {
  canApprove,
  canTransition,
  coverage,
  entryStatus,
  isLive,
  kbState,
  nextStatus,
  publicPath,
  publishBlockers,
  slugError,
  slugify,
  type CmsAction,
  type CmsRole,
} from "@/domain/marketing/cms/rules";
import {
  LOCALES,
  type CmsComment,
  type CmsEntry,
  type CmsRow,
  type CmsStatus,
  type CmsType,
  type CmsVariant,
  type Locale,
  type NavLocation,
  type NavNode,
  type Redirect,
  type SiteSettings,
} from "@/domain/marketing/types";
import type { Role } from "@/domain/auth/roles";
import type { Env } from "../../core/config/env";
import { CryptoService } from "../../core/crypto/crypto.service";
import { DB, type Db, type Tx } from "../../core/db/db";
import { OutboxService } from "../../core/db/outbox";
import { TxService } from "../../core/db/tx";
import { AppError, forbidden } from "../../core/http/errors";
import type { SessionUser } from "../../core/http/context";
import { PublicCache } from "../catalogue/cache";

export type Me = { id: string; role: CmsRole; name: string };
const fail = (
  status: number,
  code: string,
  message: string,
  data?: Record<string, unknown>,
) => new AppError(status, code, message, undefined, data);
const NOT_FOUND_CAP = 5000;
const LOCK_TTL_MS = 90_000;
const PREVIEW_TTL_MS = 15 * 60_000;
const SETTINGS_ID = "global";
// PLACEHOLDER(CONTACT): mirrors web content/marketing CONTACT until site settings are seeded.
const DEFAULT_SETTINGS: SiteSettings = {
  address: "Kigali, Rwanda",
  phone: "+250 788 313 582",
  email: "info@hebuza.rw",
  whatsapp: "250788313582",
  hours: {
    en: "Mon–Fri 08:00–17:00",
    fr: "Lun–ven 08:00–17:00",
    rw: "Kuwa mbere–Kuwa gatanu 08:00–17:00",
  },
  social: [],
};

/** CMS role from session roles; executive outranks service manager outranks marketing. */
export function cmsRole(roles: readonly Role[]): CmsRole | null {
  if (roles.includes("staff:executive")) return "executive";
  if (roles.includes("staff:service_manager")) return "service_manager";
  if (roles.includes("staff:marketing")) return "marketing";
  return null;
}

export const entryTags = (e: CmsEntry, oldSlugs: string[] = []) => {
  const tags = [
    "cms",
    `cms:entry:${e.id}`,
    `cms:list:${e.type}`,
    `cms:${e.type}:${e.key}`,
    ...oldSlugs.map((s) => `cms:${e.type}:${s}`),
    "cms:manifest",
    "cms:kb",
  ];
  if (e.type === "guide" || e.type === "page") tags.push("cms:page:home");
  return [...new Set(tags)];
};

// ---------------------------------------------------------------- persistence (pure functions over a Tx)
export async function getEntry(db: Tx, id: string, lock = false) {
  const q = db
    .select({ doc: cmsEntries.doc })
    .from(cmsEntries)
    .where(eq(cmsEntries.id, id));
  const [r] = lock ? await q.for("update") : await q;
  if (!r) throw fail(404, "not_found", "Not found.");
  return r.doc;
}
export async function saveEntry(db: Tx, e: CmsEntry, t: number) {
  await db
    .update(cmsEntries)
    .set({
      doc: e,
      version: e.version,
      key: e.key,
      archived: !!e.archivedTo,
      updatedAt: iso(t),
    })
    .where(eq(cmsEntries.id, e.id));
}
async function insertEntry(db: Tx, e: CmsEntry, t: number) {
  await db
    .insert(cmsEntries)
    .values({
      id: e.id,
      type: e.type,
      key: e.key,
      version: e.version,
      archived: !!e.archivedTo,
      doc: e,
      createdAt: e.createdAt,
      updatedAt: iso(t),
    });
}
const ofType = async (db: Tx, type: string) =>
  (
    await db
      .select({ doc: cmsEntries.doc })
      .from(cmsEntries)
      .where(eq(cmsEntries.type, type))
  ).map((r) => r.doc);
const blockersAll = (e: CmsEntry, t: number) =>
  LOCALES.flatMap((l) => (e.variants[l] ? publishBlockers(e, l, t) : []));
async function full(db: Tx, e: CmsEntry, t: number) {
  const [l] = await db
    .select()
    .from(cmsLocks)
    .where(eq(cmsLocks.entryId, e.id));
  return {
    ...e,
    kb: kbState(e, t),
    blockers: blockersAll(e, t),
    ...(l && { lock: { holder: l.holder, since: l.since } }),
  };
}
const row = (e: CmsEntry, t: number): CmsRow => {
  const v = (e.variants.en ?? e.variants.rw ?? e.variants.fr)!;
  return {
    id: e.id,
    type: e.type,
    key: e.key,
    title: v.title,
    coverage: coverage(e),
    status: e.archivedTo ? "archived" : entryStatus(e),
    updatedAt: v.updatedAt,
    updatedBy: v.updatedBy,
    scheduledAt: LOCALES.map((l) => e.variants[l]?.scheduledAt).find(Boolean),
    aiApproved: e.aiApproved,
    kb: kbState(e, t),
    serviceFacts: e.serviceFacts,
    slug: v.slug,
  };
};
async function snapshot(
  db: Tx,
  e: CmsEntry,
  l: Locale,
  by: string,
  summary: string,
  t: number,
) {
  const v = e.variants[l];
  if (!v) return;
  await db
    .insert(cmsVersions)
    .values({
      entryId: e.id,
      language: l,
      version: v.version,
      at: iso(t),
      by,
      summary,
      snapshot: {
        blocks: structuredClone(e.blocks),
        variant: structuredClone(v),
      },
    })
    .onConflictDoNothing();
}
const langsOf = (b: { langs?: Locale[] }, e: CmsEntry) =>
  b.langs?.length
    ? b.langs.filter((l) => LOCALES.includes(l))
    : LOCALES.filter((l) => e.variants[l]);
/** Moves every language through action `a`; returns the first language that may not, or null. */
function step(
  e: CmsEntry,
  langs: Locale[],
  a: CmsAction,
  set: Partial<CmsVariant> = {},
) {
  const bad = langs.find(
    (l) => !e.variants[l] || !canTransition(e.variants[l].status, a),
  );
  if (bad) return bad;
  for (const l of langs)
    Object.assign(e.variants[l]!, { status: nextStatus(a), ...set });
  for (const l of langs)
    for (const k of Object.keys(set) as (keyof CmsVariant)[])
      if (set[k] === undefined) delete e.variants[l]![k];
  e.version++;
  return null;
}
const stageRule = () =>
  fail(422, "STAGE_RULE", "That stage change isn't allowed.");
async function conflictIf(
  db: Tx,
  e: CmsEntry,
  current: number,
  ifMatch: string | null,
  t: number,
) {
  if (ifMatch != null && ifMatch !== "*" && Number(ifMatch) !== current)
    throw fail(409, "VERSION_CONFLICT", "Someone changed this meanwhile.", {
      entry: await full(db, e, t),
    });
}
async function addRedirect(
  db: Tx,
  from: string,
  to: string,
  code: 301 | 302,
  by: string,
  t: number,
) {
  // A re-slug of an existing source path replaces it (unique from_path).
  await db
    .insert(cmsRedirects)
    .values({
      id: generateId("rd"),
      from,
      to,
      code,
      hits: 0,
      createdBy: by,
      createdAt: iso(t),
    })
    .onConflictDoUpdate({ target: cmsRedirects.from, set: { to, code } });
}
const errorsOf = (e: CmsEntry, langs: Locale[], t: number) =>
  langs
    .flatMap((l) => publishBlockers(e, l, t))
    .filter((b) => b.severity === "error");
const blocked = (blockers: unknown[]) =>
  fail(
    422,
    "CMS_PUBLISH_BLOCKED",
    "Fix the items in the checklist before publishing.",
    { blockers },
  );

/** Scheduled → published at its time; overdue regulatory updates → stale. Pure. */
export function applySchedule(e: CmsEntry, t: number): CmsEntry {
  let out = e;
  for (const l of LOCALES) {
    const v = out.variants[l];
    if (!v) continue;
    const due =
      v.status === "scheduled" &&
      v.scheduledAt &&
      Date.parse(v.scheduledAt) <= t;
    const stale =
      v.status === "published" &&
      out.type === "regulatory_update" &&
      out.reviewBy &&
      Date.parse(out.reviewBy) < t;
    if (due || stale) {
      out = out === e ? structuredClone(e) : out;
      Object.assign(
        out.variants[l]!,
        due
          ? { status: "published", publishedAt: v.scheduledAt }
          : { status: "stale" },
      );
    }
  }
  return out;
}
/** Public payload never carries unpublished variants or reviewer bookkeeping. */
function stripDrafts(e: CmsEntry): CmsEntry {
  const variants = Object.fromEntries(
    Object.entries(e.variants)
      .filter(([, v]) => isLive(v))
      .map(([l, v]) => {
        const {
          reviewerId: _r,
          approvedBy: _a,
          authorId: _au,
          updatedBy: _u,
          ...rest
        } = v!;
        return [l, { ...rest, authorId: "", updatedBy: "" }];
      }),
  );
  return { ...e, ownerId: "", variants };
}
const commentOut = (c: typeof cmsComments.$inferSelect): CmsComment => ({
  id: c.id,
  entryId: c.entryId,
  ...(c.blockId && { blockId: c.blockId }),
  ...(c.language && { language: c.language as Locale }),
  by: c.by,
  body: c.body,
  at: c.at,
  resolved: c.resolved,
});
const redirectOut = (r: typeof cmsRedirects.$inferSelect): Redirect => ({
  id: r.id,
  from: r.from,
  to: r.to,
  code: r.code === 302 ? 302 : 301,
  hits: r.hits,
  createdBy: r.createdBy,
  createdAt: r.createdAt,
});
/** True when adding from→to closes a cycle through the existing redirects. */
export function loops(
  rs: Pick<Redirect, "from" | "to">[],
  from: string,
  to: string,
) {
  const map = new Map(
    rs.filter((r) => r.from !== from).map((r) => [r.from, r.to]),
  );
  map.set(from, to);
  for (
    let cur: string | undefined = to, i = 0;
    cur && i < 50;
    cur = map.get(cur), i++
  )
    if (cur === from) return true;
  return false;
}
const isPath = (p: string) => p.startsWith("/") && !p.startsWith("//");

/** Cron body: persist due schedules and stale flags; returns the tags to revalidate. */
export async function sweepSchedule(db: Tx, t = Date.now()) {
  const rows = await db
    .select({ doc: cmsEntries.doc })
    .from(cmsEntries)
    .where(
      and(
        eq(cmsEntries.archived, false),
        dsql`(${cmsEntries.doc}::text like '%"scheduled"%' or ${cmsEntries.type} = 'regulatory_update')`,
      ),
    )
    .for("update");
  const tags: string[] = [];
  for (const { doc } of rows) {
    const next = applySchedule(doc, t);
    if (next === doc) continue;
    for (const l of LOCALES)
      if (
        doc.variants[l]?.status === "scheduled" &&
        next.variants[l]?.status === "published"
      )
        await snapshot(db, next, l, "scheduler", "Published (scheduled)", t);
    next.version++;
    await saveEntry(db, next, t);
    tags.push(...entryTags(next));
  }
  return [...new Set(tags)];
}

// ---------------------------------------------------------------- inputs
export type ListQuery = {
  type?: string;
  status?: string;
  locale?: Locale;
  owner?: string;
  q?: string;
  page?: number;
};
export type EntryPatch = Partial<
  Pick<
    CmsEntry,
    | "blocks"
    | "meta"
    | "serviceSlugs"
    | "tags"
    | "aiApproved"
    | "reviewBy"
    | "serviceFacts"
  >
>;
export type VariantIn = Partial<
  Pick<
    CmsVariant,
    | "slug"
    | "title"
    | "excerpt"
    | "body"
    | "seo"
    | "unpublishAt"
    | "needsReview"
    | "fallbackAllowed"
  >
>;
type Langs = { langs?: Locale[] };

@Injectable()
export class CmsService {
  private readonly origin: string;
  constructor(
    private readonly txs: TxService,
    @Inject(DB) private readonly db: Db,
    private readonly outbox: OutboxService,
    private readonly cache: PublicCache,
    private readonly crypto: CryptoService,
    config: ConfigService<Env, true>,
  ) {
    this.origin = config
      .get("WEB_ORIGIN", { infer: true })
      .split(",")[0]
      .trim();
  }

  /** One tx; tags returned by fn become a `cms.revalidate` outbox event in it, and the public cache drops after commit. */
  private async write<T>(
    fn: (tx: Tx, bust: (tags: string[]) => string[]) => Promise<T>,
  ): Promise<T> {
    let any = false;
    const out = await this.txs.run(async (tx) => {
      const pending: string[] = [];
      const r = await fn(
        tx,
        (tags) => (pending.push(...tags), [...new Set(tags)]),
      );
      if (pending.length) {
        any = true;
        await this.outbox.add(tx, {
          type: "cms.revalidate",
          payload: { tags: [...new Set(pending)] },
        });
      }
      return r;
    });
    if (any) await this.cache.bust("cms");
    return out;
  }
  private read<T>(fn: (tx: Tx) => Promise<T>) {
    return this.txs.run(fn);
  }

  private async me(tx: Tx, u: SessionUser): Promise<Me> {
    const role = cmsRole(u.roles);
    if (!role) throw forbidden();
    const [r] = await tx
      .select({ name: users.name })
      .from(users)
      .where(eq(users.userId, u.id))
      .limit(1);
    return { id: u.id, role, name: r?.name ?? u.id };
  }

  // ---------------------------------------------------------------- entries
  listEntries(q: ListQuery, t = Date.now()) {
    return this.read(async (tx) => {
      const docs = (
        await tx
          .select({ doc: cmsEntries.doc })
          .from(cmsEntries)
          .orderBy(desc(cmsEntries.updatedAt))
      ).map((r) => r.doc);
      const text = (q.q ?? "").toLowerCase();
      let items = docs.map((e) => ({ e, r: row(e, t) }));
      if (q.type)
        items = items.filter((x) => q.type!.split(",").includes(x.r.type));
      if (q.status) items = items.filter((x) => x.r.status === q.status);
      if (q.locale)
        items = items.filter((x) => x.r.coverage[q.locale!] !== "missing");
      if (q.owner) items = items.filter((x) => x.e.ownerId === q.owner);
      if (text)
        items = items.filter(
          (x) =>
            x.r.title.toLowerCase().includes(text) || x.r.key.includes(text),
        );
      const page = Math.max(1, q.page ?? 1),
        size = 50;
      // shortcut: filters run in memory over every entry (fine for a few thousand); move type/status to SQL when the CMS outgrows that.
      return {
        items: items.slice((page - 1) * size, page * size).map((x) => x.r),
        total: items.length,
      };
    });
  }

  createEntry(
    u: SessionUser,
    b: {
      type: CmsType;
      locale?: Locale;
      title: string;
      slug?: string;
      key?: string;
    },
    t = Date.now(),
  ) {
    return this.write(async (tx) => {
      const me = await this.me(tx, u);
      const lang = b.locale ?? "en";
      const slug = slugify(b.slug ?? b.title);
      const se = slugError(slug);
      if (se)
        throw new AppError(422, "validation", "Check the web address.", {
          slug: se,
        });
      const key = b.key ? slugify(b.key) : slug;
      const [dup] = await tx
        .select({ id: cmsEntries.id })
        .from(cmsEntries)
        .where(and(eq(cmsEntries.type, b.type), eq(cmsEntries.key, key)));
      if (dup)
        throw fail(409, "SLUG_TAKEN", "That web address is already used.");
      const stamp = iso(t);
      const e: CmsEntry = {
        id: `cms-${b.type}-${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        type: b.type,
        key,
        ownerId: me.id,
        serviceSlugs: [],
        tags: [],
        aiApproved: false,
        serviceFacts: b.type === "regulatory_update",
        blocks: [],
        meta:
          b.type === "landing_page"
            ? {
                landing: {
                  form: {
                    email: true,
                    consent: ["email", "whatsapp", "sms"],
                    thankYou: {},
                  },
                },
              }
            : {},
        version: 1,
        createdAt: stamp,
        variants: {
          [lang]: {
            language: lang,
            slug,
            title: b.title,
            body: {},
            status: "draft",
            version: 1,
            authorId: me.id,
            updatedAt: stamp,
            updatedBy: me.name,
            seo: {
              title: "",
              description: "",
              robots: b.type === "landing_page" ? "noindex" : "index",
            },
          },
        },
      };
      await insertEntry(tx, e, t);
      return full(tx, e, t);
    });
  }

  getEntry(id: string, t = Date.now()) {
    return this.read(async (tx) => full(tx, await getEntry(tx, id), t));
  }

  patchEntry(
    u: SessionUser,
    id: string,
    ifMatch: string | null,
    b: EntryPatch,
    t = Date.now(),
  ) {
    return this.write(async (tx, bust) => {
      const me = await this.me(tx, u);
      const e = await getEntry(tx, id, true);
      await conflictIf(tx, e, e.version, ifMatch, t);
      // Service facts feed the AI assistant: only an approver (SM/exec) may mark them AI-approved.
      if (b.aiApproved && e.serviceFacts && me.role === "marketing")
        throw fail(
          403,
          "APPROVER_REQUIRED",
          "A Service Manager must approve this content.",
        );
      if (b.blocks) e.blocks = b.blocks;
      if (b.meta) e.meta = { ...e.meta, ...b.meta };
      if (b.serviceSlugs) e.serviceSlugs = b.serviceSlugs;
      if (b.tags) e.tags = b.tags;
      if (b.aiApproved !== undefined) e.aiApproved = b.aiApproved;
      if (b.reviewBy !== undefined) e.reviewBy = b.reviewBy || undefined;
      if (b.serviceFacts !== undefined) e.serviceFacts = b.serviceFacts;
      e.version++;
      await saveEntry(tx, e, t);
      if (b.aiApproved !== undefined) bust(["cms:kb"]);
      return full(tx, e, t);
    });
  }

  putVariant(
    u: SessionUser,
    id: string,
    l: Locale,
    ifMatch: string | null,
    b: VariantIn,
    t = Date.now(),
  ) {
    return this.write(async (tx, bust) => {
      const me = await this.me(tx, u);
      const e = await getEntry(tx, id, true);
      const cur = e.variants[l];
      if (cur) await conflictIf(tx, e, cur.version, ifMatch, t);
      const slug =
        b.slug !== undefined
          ? slugify(b.slug)
          : (cur?.slug ?? slugify(b.title ?? e.key));
      const others = await ofType(tx, e.type);
      if (
        others.some(
          (x) =>
            x.id !== e.id &&
            x.variants[l]?.slug === slug &&
            x.variants[l]?.status === "published",
        )
      )
        throw fail(409, "SLUG_TAKEN", "That web address is already used.");
      const stamp = iso(t);
      // Editing a published variant starts version n+1 as a draft; the live copy stays as the last snapshot.
      if (cur?.status === "published")
        await snapshot(tx, e, l, me.name, "Published version", t);
      const base: CmsVariant = cur ?? {
        language: l,
        body: {},
        version: 0,
        authorId: me.id,
        seo: { title: "", description: "", robots: "index" },
        status: "draft",
        slug,
        title: "",
        updatedAt: stamp,
        updatedBy: me.name,
      };
      e.variants[l] = {
        ...base,
        ...b,
        slug,
        language: l,
        status: cur && cur.status !== "published" ? cur.status : "draft",
        version: (cur?.version ?? 0) + 1,
        updatedAt: stamp,
        updatedBy: me.name,
      };
      if (cur && cur.slug !== slug && cur.publishedAt) {
        const from = publicPath(e.type, e.key, cur.slug, l),
          to = publicPath(e.type, e.key, slug, l);
        if (from && to && from !== to)
          await addRedirect(tx, from, to, 301, me.name, t);
        bust(entryTags(e, [cur.slug]));
      }
      await saveEntry(tx, e, t);
      return full(tx, e, t);
    });
  }

  duplicateEntry(u: SessionUser, id: string, t = Date.now()) {
    return this.write(async (tx) => {
      const me = await this.me(tx, u);
      const e = await getEntry(tx, id);
      const stamp = iso(t);
      let key = `${e.key}-copy`;
      for (
        let i = 2;
        (
          await tx
            .select({ id: cmsEntries.id })
            .from(cmsEntries)
            .where(and(eq(cmsEntries.type, e.type), eq(cmsEntries.key, key)))
        ).length;
        i++
      )
        key = `${e.key}-copy-${i}`;
      const variants = Object.fromEntries(
        Object.entries(e.variants).map(([l, v]) => {
          const {
            publishedAt: _p,
            scheduledAt: _s,
            approvedBy: _a,
            reviewerId: _r,
            ...rest
          } = v!;
          return [
            l,
            {
              ...rest,
              slug: `${v!.slug}-copy`,
              title: `${v!.title} (copy)`,
              status: "draft" as CmsStatus,
              version: 1,
              updatedAt: stamp,
              updatedBy: me.name,
            },
          ];
        }),
      );
      const { archivedTo: _x, ...restEntry } = structuredClone(e);
      const copy: CmsEntry = {
        ...restEntry,
        id: `cms-${e.type}-${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        key,
        ownerId: me.id,
        aiApproved: false,
        version: 1,
        createdAt: stamp,
        variants,
      };
      await insertEntry(tx, copy, t);
      return full(tx, copy, t);
    });
  }

  lockEntry(u: SessionUser, id: string, force: boolean, t = Date.now()) {
    return this.write(async (tx) => {
      const me = await this.me(tx, u);
      await getEntry(tx, id);
      const [l] = await tx
        .select()
        .from(cmsLocks)
        .where(eq(cmsLocks.entryId, id))
        .for("update");
      if (
        !l ||
        l.holder === me.name ||
        Date.parse(l.since) < t - LOCK_TTL_MS ||
        force
      ) {
        await tx
          .insert(cmsLocks)
          .values({ entryId: id, holder: me.name, since: iso(t) })
          .onConflictDoUpdate({
            target: cmsLocks.entryId,
            set: { holder: me.name, since: iso(t) },
          });
        return { holder: me.name, since: iso(t) };
      }
      return { holder: l.holder, since: l.since };
    });
  }
  unlockEntry(u: SessionUser, id: string) {
    return this.write(async (tx) => {
      const me = await this.me(tx, u);
      await tx
        .delete(cmsLocks)
        .where(and(eq(cmsLocks.entryId, id), eq(cmsLocks.holder, me.name)));
      return {};
    });
  }

  submit(
    u: SessionUser,
    id: string,
    b: Langs & { reviewerId?: string },
    t = Date.now(),
  ) {
    return this.write(async (tx) => {
      await this.me(tx, u);
      const e = await getEntry(tx, id, true);
      const langs = langsOf(b, e);
      if (langs.some((l) => e.variants[l]?.status === "in_review"))
        throw fail(
          409,
          "ALREADY_IN_REVIEW",
          "This is already waiting for review.",
        );
      const errs = errorsOf(e, langs, t);
      if (errs.length) throw blocked(errs);
      if (step(e, langs, "submit", { reviewerId: b.reviewerId }))
        throw stageRule();
      await saveEntry(tx, e, t);
      return full(tx, e, t);
    });
  }
  approve(u: SessionUser, id: string, b: Langs, t = Date.now()) {
    return this.write(async (tx) => {
      const me = await this.me(tx, u);
      const e = await getEntry(tx, id, true);
      const langs = langsOf(b, e).filter(
        (l) => e.variants[l]?.status === "in_review",
      );
      // Every approved language is checked: a mixed-author request can't slip the author's own variant through.
      const who =
        (langs.length ? langs : (["en"] as Locale[]))
          .map((l) =>
            canApprove(me.role, me.id, e, e.variants[l]?.authorId ?? e.ownerId),
          )
          .find(Boolean) ?? null;
      if (who)
        throw fail(
          403,
          who,
          who === "SOD_SELF_APPROVAL"
            ? "You can't approve your own work."
            : "A Service Manager must approve this content.",
        );
      if (!langs.length || step(e, langs, "approve", { approvedBy: me.name }))
        throw stageRule();
      await saveEntry(tx, e, t);
      return full(tx, e, t);
    });
  }
  requestChanges(
    u: SessionUser,
    id: string,
    b: Langs & { comment?: string },
    t = Date.now(),
  ) {
    return this.write(async (tx) => {
      const me = await this.me(tx, u);
      if (!String(b.comment ?? "").trim())
        throw fail(422, "reason_required", "Say what needs to change.");
      const e = await getEntry(tx, id, true);
      const langs = langsOf(b, e).filter(
        (l) => e.variants[l]?.status === "in_review",
      );
      if (!langs.length || step(e, langs, "request_changes")) throw stageRule();
      await saveEntry(tx, e, t);
      await tx
        .insert(cmsComments)
        .values({
          id: generateId("cm"),
          entryId: e.id,
          by: me.name,
          body: String(b.comment).trim(),
          at: iso(t),
          resolved: false,
        });
      return full(tx, e, t);
    });
  }

  publishOrSchedule(
    u: SessionUser,
    id: string,
    kind: "publish" | "schedule",
    b: Langs & { fallback?: boolean; at?: string },
    t = Date.now(),
  ) {
    return this.write(async (tx, bust) => {
      const me = await this.me(tx, u);
      const e = await getEntry(tx, id, true);
      const langs = langsOf(b, e);
      const missing = LOCALES.filter((l) => !e.variants[l]);
      if (missing.length && !b.fallback)
        throw blocked(
          missing.map((l) => ({
            language: l,
            code: "missing_variant",
            severity: "error",
          })),
        );
      const errs = errorsOf(e, langs, t);
      if (errs.length) throw blocked(errs);
      if (kind === "schedule") {
        const at = Date.parse(b.at ?? "");
        if (!(at >= t + 5 * 60_000))
          throw new AppError(
            422,
            "validation",
            "Pick a time at least 5 minutes from now.",
            { at: "too_soon" },
          );
        if (step(e, langs, "schedule", { scheduledAt: iso(at) }))
          throw stageRule();
      } else {
        if (
          step(e, langs, "publish", {
            publishedAt: iso(t),
            scheduledAt: undefined,
            fallbackAllowed: !!b.fallback,
          })
        )
          throw stageRule();
        for (const l of langs)
          await snapshot(tx, e, l, me.name, "Published", t);
        // F-CMS-10: link the authority's compliance-calendar rules and ask marketing for a draft campaign.
        if (e.type === "regulatory_update" && e.meta.regulatory) {
          const reg = e.meta.regulatory;
          const rules = await tx.select({ code: complianceRules.code, svc: complianceRules.serviceSlug }).from(complianceRules)
            .where(and(eq(complianceRules.authority, reg.authority), eq(complianceRules.active, true)));
          reg.calendarRules = rules.filter((r) => !r.svc || !e.serviceSlugs.length || e.serviceSlugs.includes(r.svc)).map((r) => r.code);
          if (!reg.campaignId) await this.outbox.add(tx, { type: "cms.regulatory_published", payload: { id: e.id, key: e.key, title: e.variants.en?.title ?? e.key } });
        }
      }
      await saveEntry(tx, e, t);
      return {
        entry: await full(tx, e, t),
        tags: bust(entryTags(e)),
        urls: Object.fromEntries(
          langs.map((l) => [
            l,
            publicPath(e.type, e.key, e.variants[l]!.slug, l),
          ]),
        ),
      };
    });
  }
  unscheduleOrUnpublish(
    u: SessionUser,
    id: string,
    kind: "unschedule" | "unpublish",
    b: Langs,
    t = Date.now(),
  ) {
    return this.write(async (tx, bust) => {
      await this.me(tx, u);
      const e = await getEntry(tx, id, true);
      if (step(e, langsOf(b, e), kind, { scheduledAt: undefined }))
        throw stageRule();
      await saveEntry(tx, e, t);
      return { entry: await full(tx, e, t), tags: bust(entryTags(e)) };
    });
  }
  archive(
    u: SessionUser,
    id: string,
    b: { redirectTo?: string },
    t = Date.now(),
  ) {
    return this.write(async (tx, bust) => {
      const me = await this.me(tx, u);
      const e = await getEntry(tx, id, true);
      const nav = await tx.select().from(cmsNav);
      const flat = (ns: NavNode[]): NavNode[] =>
        ns.flatMap((n) => [n, ...flat(n.children ?? [])]);
      if (
        nav.some((r) => flat(r.items).some((n) => n.href.endsWith(`/${e.key}`)))
      )
        throw fail(
          422,
          "IN_USE",
          "It's still in use. Remove it from those pages first.",
        );
      const to = String(b.redirectTo ?? "");
      if (!isPath(to))
        throw new AppError(
          422,
          "validation",
          "Choose where visitors should go instead.",
          { redirectTo: "required" },
        );
      for (const l of LOCALES) {
        const v = e.variants[l];
        const from = v?.publishedAt
          ? publicPath(e.type, e.key, v.slug, l)
          : null;
        if (from) await addRedirect(tx, from, `/${l}${to}`, 301, me.name, t);
        if (v) v.status = "archived";
      }
      e.archivedTo = to;
      e.version++;
      await saveEntry(tx, e, t);
      return { entry: await full(tx, e, t), tags: bust(entryTags(e)) };
    });
  }

  listVersions(id: string) {
    return this.read(async (tx) => {
      await getEntry(tx, id);
      const rows = await tx
        .select()
        .from(cmsVersions)
        .where(eq(cmsVersions.entryId, id))
        .orderBy(desc(cmsVersions.at), desc(cmsVersions.version));
      return {
        items: rows.map((r) => ({
          entryId: r.entryId,
          language: r.language as Locale,
          version: r.version,
          at: r.at,
          by: r.by,
          summary: r.summary,
          snapshot: r.snapshot,
        })),
      };
    });
  }
  restore(
    u: SessionUser,
    id: string,
    version: number,
    lang: Locale | undefined,
    t = Date.now(),
  ) {
    return this.write(async (tx) => {
      const me = await this.me(tx, u);
      const e = await getEntry(tx, id, true);
      const [v] = await tx
        .select()
        .from(cmsVersions)
        .where(
          and(
            eq(cmsVersions.entryId, id),
            eq(cmsVersions.version, version),
            ...(lang ? [eq(cmsVersions.language, lang)] : []),
          ),
        )
        .limit(1);
      if (!v) throw fail(404, "not_found", "Not found.");
      const l = v.language as Locale;
      const cur = e.variants[l];
      e.blocks = structuredClone(v.snapshot.blocks);
      e.variants[l] = {
        ...structuredClone(v.snapshot.variant),
        status: "draft",
        version: (cur?.version ?? v.version) + 1,
        updatedAt: iso(t),
        updatedBy: me.name,
      };
      e.version++;
      await saveEntry(tx, e, t);
      return full(tx, e, t);
    });
  }

  listComments(id: string) {
    return this.read(async (tx) => {
      await getEntry(tx, id);
      return {
        items: (
          await tx
            .select()
            .from(cmsComments)
            .where(eq(cmsComments.entryId, id))
            .orderBy(asc(cmsComments.at))
        ).map(commentOut),
      };
    });
  }
  addComment(
    u: SessionUser,
    id: string,
    b: { body: string; blockId?: string; language?: Locale },
    t = Date.now(),
  ) {
    return this.write(async (tx) => {
      const me = await this.me(tx, u);
      await getEntry(tx, id);
      const [c] = await tx
        .insert(cmsComments)
        .values({
          id: generateId("cm"),
          entryId: id,
          blockId: b.blockId ?? null,
          language: b.language ?? null,
          by: me.name,
          body: b.body.trim(),
          at: iso(t),
          resolved: false,
        })
        .returning();
      return commentOut(c);
    });
  }
  resolveComment(cid: string, resolved: boolean) {
    return this.write(async (tx) => {
      const [c] = await tx
        .update(cmsComments)
        .set({ resolved })
        .where(eq(cmsComments.id, cid))
        .returning();
      if (!c) throw fail(404, "not_found", "Not found.");
      return commentOut(c);
    });
  }

  translate(
    u: SessionUser,
    id: string,
    b: { from: Locale; to: Locale },
    t = Date.now(),
  ) {
    return this.write(async (tx) => {
      const me = await this.me(tx, u);
      const e = await getEntry(tx, id, true);
      const from = e.variants[b.from];
      if (!from || b.from === b.to)
        throw fail(422, "validation", "Pick two different languages.");
      // shortcut: machine translation copies the source and flags it for human review; wire a provider behind an env key later.
      const {
        publishedAt: _p,
        scheduledAt: _s,
        ...src
      } = structuredClone(from);
      e.variants[b.to] = {
        ...src,
        language: b.to,
        status: "draft",
        needsReview: true,
        version: (e.variants[b.to]?.version ?? 0) + 1,
        authorId: me.id,
        updatedAt: iso(t),
        updatedBy: me.name,
      };
      e.version++;
      await saveEntry(tx, e, t);
      return full(tx, e, t);
    });
  }

  /** Preview token = AES-GCM sealed {id, l, exp} (CryptoService): signed, opaque and short-lived; no extra secret. */
  previewToken(id: string, lang: Locale | undefined, t = Date.now()) {
    return this.read(async (tx) => {
      const e = await getEntry(tx, id);
      const l =
        lang && e.variants[lang] ? lang : LOCALES.find((x) => e.variants[x])!;
      const expiresAt = iso(t + PREVIEW_TTL_MS);
      const token = Buffer.from(
        this.crypto.encrypt(
          JSON.stringify({ id: e.id, l, exp: t + PREVIEW_TTL_MS }),
        ),
      ).toString("base64url");
      return {
        token,
        entryId: e.id,
        lang: l,
        expiresAt,
        url: `/preview?token=${encodeURIComponent(token)}`,
      };
    });
  }
  /** Public: the editor's copy (schedule applied) for a valid preview token. */
  preview(token: string, t = Date.now()) {
    let p: { id: string; l: Locale; exp: number };
    try {
      p = JSON.parse(
        this.crypto.decrypt(Buffer.from(token, "base64url").toString()),
      ) as typeof p;
    } catch {
      throw fail(401, "invalid_token", "This preview link is not valid.");
    }
    if (!(p.exp > t))
      throw fail(401, "token_expired", "This preview link has expired.");
    return this.read(async (tx) => ({
      entry: applySchedule(await getEntry(tx, p.id), t),
      lang: p.l,
    }));
  }

  reviewCount(u: SessionUser) {
    return this.read(async (tx) => {
      const me = await this.me(tx, u);
      const [{ n }] = await tx
        .select({ n: dsql<number>`count(*)::int` })
        .from(cmsEntries)
        .where(
          dsql`exists (select 1 from jsonb_each(${cmsEntries.doc}->'variants') v where v.value->>'status' = 'in_review' and v.value->>'reviewerId' = ${me.id})`,
        );
      return { n };
    });
  }

  // ---------------------------------------------------------------- nav, settings, redirects, 404 log
  getNav(loc: NavLocation) {
    return this.read(async (tx) => {
      const [r] = await tx
        .select()
        .from(cmsNav)
        .where(eq(cmsNav.location, loc));
      return { items: r?.items ?? [] };
    });
  }
  putNav(loc: NavLocation, items: NavNode[], t = Date.now()) {
    return this.write(async (tx, bust) => {
      await tx
        .insert(cmsNav)
        .values({ location: loc, items, updatedAt: iso(t) })
        .onConflictDoUpdate({
          target: cmsNav.location,
          set: { items, updatedAt: iso(t) },
        });
      bust(["cms:nav"]);
      return { items };
    });
  }
  private async settings(tx: Tx): Promise<SiteSettings> {
    const [r] = await tx
      .select()
      .from(cmsSiteSettings)
      .where(eq(cmsSiteSettings.id, SETTINGS_ID));
    return r?.doc ?? DEFAULT_SETTINGS;
  }
  /** Public (F-CMS-07): header/mobile/footer nav + site settings for the web layout; tags cms:nav / cms:settings. */
  publicSite() {
    return this.cache.get("cms", "site", () =>
      this.read(async (tx) => {
        const rows = await tx.select().from(cmsNav);
        const nav = Object.fromEntries(rows.map((r) => [r.location, r.items])) as Partial<Record<NavLocation, NavNode[]>>;
        return { nav: { header: nav.header ?? [], mobile: nav.mobile ?? [], footer: nav.footer ?? [] }, settings: await this.settings(tx) };
      }),
    );
  }
  getSiteSettings() {
    return this.read((tx) => this.settings(tx));
  }
  putSiteSettings(patch: Partial<SiteSettings>, t = Date.now()) {
    return this.write(async (tx, bust) => {
      const doc = { ...(await this.settings(tx)), ...patch };
      await tx
        .insert(cmsSiteSettings)
        .values({ id: SETTINGS_ID, doc, updatedAt: iso(t) })
        .onConflictDoUpdate({
          target: cmsSiteSettings.id,
          set: { doc, updatedAt: iso(t) },
        });
      bust(["cms:settings"]);
      return doc;
    });
  }

  listRedirects() {
    return this.read(async (tx) => ({
      items: (
        await tx
          .select()
          .from(cmsRedirects)
          .orderBy(asc(cmsRedirects.createdAt))
      ).map(redirectOut),
    }));
  }
  saveRedirect(
    u: SessionUser,
    id: string | null,
    b: { from: string; to: string; code?: number },
    t = Date.now(),
  ) {
    return this.write(async (tx, bust) => {
      const me = await this.me(tx, u);
      const from = b.from.trim(),
        to = b.to.trim();
      if (!isPath(from) || !isPath(to) || from === to)
        throw fail(
          422,
          "validation",
          "Both paths must start with / and differ.",
        );
      await tx.execute(
        dsql`select pg_advisory_xact_lock(hashtext('cms_redirects'))`,
      ); // loop check + write are one decision
      const all = (await tx.select().from(cmsRedirects)).map(redirectOut);
      if (
        loops(
          all.filter((r) => r.id !== id),
          from,
          to,
        )
      )
        throw fail(
          422,
          "REDIRECT_LOOP",
          "That redirect would loop back on itself.",
        );
      const existing =
        all.find((r) => r.id === id) ?? all.find((r) => r.from === from);
      if (id && !existing) throw fail(404, "not_found", "Not found.");
      const code = (b.code ?? existing?.code) === 302 ? 302 : 301;
      let out: typeof cmsRedirects.$inferSelect;
      if (existing) {
        // Saving onto another row's `from` would collide on the unique index; drop the stale duplicate first.
        await tx
          .delete(cmsRedirects)
          .where(
            and(eq(cmsRedirects.from, from), ne(cmsRedirects.id, existing.id)),
          );
        [out] = await tx
          .update(cmsRedirects)
          .set({ from, to, code })
          .where(eq(cmsRedirects.id, existing.id))
          .returning();
      } else
        [out] = await tx
          .insert(cmsRedirects)
          .values({
            id: generateId("rd"),
            from,
            to,
            code,
            hits: 0,
            createdBy: me.name,
            createdAt: iso(t),
          })
          .returning();
      bust(["cms:manifest"]);
      return redirectOut(out);
    });
  }
  deleteRedirect(id: string) {
    return this.write(async (tx, bust) => {
      await tx.delete(cmsRedirects).where(eq(cmsRedirects.id, id));
      bust(["cms:manifest"]);
      return { id };
    });
  }
  listNotFound() {
    return this.read(async (tx) => ({
      items: (
        await tx
          .select()
          .from(cmsNotFound)
          .orderBy(desc(cmsNotFound.hits))
          .limit(500)
      ).map((r) => ({ path: r.path, hits: r.hits, lastAt: r.lastAt })),
    }));
  }
  /** F-CMS-12: a service manager records (or withdraws) a checked credential; the public badge follows `verified`. */
  verifyCredential(u: SessionUser, id: string, b: { verified: boolean; title: string; issuer: string; documentId?: string }, t = Date.now()) {
    return this.write(async (tx, bust) => {
      const e = await getEntry(tx, id, true);
      if (e.type !== "team_member" || !e.meta.team) throw fail(422, "validation", "Only team profiles carry credentials.");
      e.meta.team = { ...e.meta.team, verified: b.verified,
        credential: { title: b.title, issuer: b.issuer, documentId: b.documentId, ...(b.verified && { verifiedBy: u.id, verifiedAt: iso(t) }) } };
      await saveEntry(tx, e, t);
      return { entry: await full(tx, e, t), tags: bust(entryTags(e)) };
    });
  }
  /** F-CMS-08 public vote; only counts for entries that are actually published. */
  async recordFeedback(b: { type: string; key: string; locale: Locale; helpful: boolean }) {
    if (!(await this.publicEntries()).some((e) => e.type === b.type && e.key === b.key)) throw fail(404, "not_found", "Unknown page.");
    await this.db.insert(cmsFeedback).values({ id: generateId("fb"), entryType: b.type, entryKey: b.key, locale: b.locale, helpful: b.helpful, createdAt: iso(Date.now()) });
    return { ok: true };
  }
  /** Helpful / not-helpful totals per entry, for the content list. */
  async feedbackStats() {
    const rows = await this.db.select({ type: cmsFeedback.entryType, key: cmsFeedback.entryKey, yes: dsql<number>`count(*) filter (where ${cmsFeedback.helpful})::int`, no: dsql<number>`count(*) filter (where not ${cmsFeedback.helpful})::int` })
      .from(cmsFeedback).groupBy(cmsFeedback.entryType, cmsFeedback.entryKey);
    return { items: rows };
  }
  /** Public: the web proxy reports a 404 path (counted for the redirects screen). */
  async recordNotFound(path: string, t = Date.now()) {
    // Existing paths just count; new paths stop at a row cap so a 404 scanner can't grow the table unbounded.
    await this.db.execute(dsql`insert into ${cmsNotFound} (path, hits, last_at)
      select ${path}, 1, ${iso(t)} where exists (select 1 from ${cmsNotFound} where path = ${path})
        or (select count(*) from ${cmsNotFound}) < ${NOT_FOUND_CAP}
      on conflict (path) do update set hits = ${cmsNotFound}.hits + 1, last_at = excluded.last_at`);
    return { ok: true };
  }

  // ---------------------------------------------------------------- public read side (Redis-cached, busted on every publishing write)
  /** Every non-archived entry with at least one live (or due-scheduled) variant; the reader resolves locales itself. */
  publicEntries(t = Date.now()) {
    return this.cache.get("cms", "entries", async () => {
      const docs = (
        await this.db
          .select({ doc: cmsEntries.doc })
          .from(cmsEntries)
          .where(eq(cmsEntries.archived, false))
      ).map((r) => r.doc);
      return docs
        .map((e) => applySchedule(e, t))
        .filter((e) => LOCALES.some((l) => isLive(e.variants[l])))
        .map(stripDrafts);
    });
  }
  /** Slugs (+ updatedAt for the sitemap) and redirects for the web proxy. */
  manifest() {
    return this.cache.get("cms", "manifest", async () => {
      const entries = await this.publicEntries();
      const pages = entries.flatMap((e) =>
        LOCALES.flatMap((l) => {
          const v = e.variants[l];
          const path = v && publicPath(e.type, e.key, v.slug, l);
          return path
            ? [
                {
                  path,
                  type: e.type,
                  locale: l,
                  updatedAt: v.updatedAt,
                  noindex: v.seo.robots === "noindex",
                },
              ]
            : [];
        }),
      );
      const redirects = (await this.db.select().from(cmsRedirects)).map(
        (r) => ({ from: r.from, to: r.to, code: r.code === 302 ? 302 : 301 }),
      );
      return { pages, redirects };
    });
  }
  /** RSS items (guides + regulatory updates), newest first; the web renders the XML. */
  rss(locale: Locale) {
    return this.cache.get("cms", `rss:${locale}`, async () => {
      const items = (await this.publicEntries())
        .filter(
          (e) =>
            (e.type === "guide" ||
              e.type === "regulatory_update" ||
              e.type === "article") &&
            e.variants[locale],
        )
        .map((e) => {
          const v = e.variants[locale]!;
          return {
            id: e.id,
            type: e.type,
            title: v.title,
            excerpt: v.excerpt ?? "",
            path: publicPath(e.type, e.key, v.slug, locale),
            publishedAt: v.publishedAt ?? v.updatedAt,
          };
        })
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
        .slice(0, 50);
      return { locale, items };
    });
  }

  // ---------------------------------------------------------------- contact form
  async submitContact(b: {
    name: string;
    contact: string;
    topic: string;
    message: string;
  }) {
    const r = {
      name: b.name.trim(),
      contact: b.contact.trim(),
      topic: b.topic.trim(),
      message: b.message.trim(),
    };
    return this.txs.run(async (tx) => {
      const [{ n }] = await tx.execute<{ n: string }>(
        dsql`select nextval(${contactRefSeq.seqName}) as n`,
      );
      const reference = `TKT-${new Date().getFullYear()}-${String(n).padStart(5, "0")}`;
      await tx
        .insert(contactInquiries)
        .values({ id: reference, ...r, createdAt: new Date().toISOString() });
      await captureFrom(tx, "contact_form", { name: r.name, contact: r.contact }); // CRM lead (dedupes against open leads)
      const inbox = (await this.settings(tx)).email; // PLACEHOLDER(contact-inbox)
      const visitor = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.contact)
        ? r.contact
        : null;
      const mail = (to: string, subject: string, text: string) =>
        this.outbox.add(tx, {
          type: "auth.mail",
          payload: this.crypto.seal({ to, subject, text }, ["text"]),
        });
      await mail(
        inbox,
        `Hebuza contact: ${r.topic} (${reference})`,
        `Someone wrote in from the public contact form.\n\nName: ${r.name}\nContact: ${r.contact}\nTopic: ${r.topic}\nReference: ${reference}\n\n${r.message}`,
      );
      if (visitor)
        await mail(
          visitor,
          "We received your message",
          `Hello ${r.name},\n\nWe have your note about ${r.topic} (reference ${reference}). Someone at Hebuza will reply during business hours. You do not need to send it again.\n\n${this.origin}`,
        );
      return { submitted: true, reference };
    });
  }
}
