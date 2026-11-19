// Catalogue: categories, subcategories, services, pricing, the versioned structure (builder draft → publish) and ops
// sub-statuses. Port of the reference catalogue.service.ts: the query functions are kept as-is (taking a tx), the
// CatalogueService class at the bottom runs them in TxService and drops the public cache after each write.
import { Injectable } from "@nestjs/common";
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNotNull,
  sql as dsql,
} from "drizzle-orm";
import {
  applications,
  serviceCategories,
  servicePriceBands,
  servicePricingTiers,
  serviceStructureVersions,
  serviceSubcategories,
  services,
} from "@/db/schema";
import { serviceSubStatuses } from "@/db/schema/schema-catalogue";
import {
  bandFee,
  bandsProblem,
  copyLimitIssues,
  EMPTY_META,
  type BandIn,
} from "@/domain/catalogue/rules";
import type { Tx } from "../../core/db/db";
import { TxService } from "../../core/db/tx";
import { OutboxService } from "../../core/db/outbox";
import { facetsOf, type SearchIn } from "@/domain/catalogue/search";
import { AuditService, type AuditEntry } from "../../core/db/audit";
import { AppError } from "../../core/http/errors";
import { PublicCache } from "./cache";
import { generateId } from "../../core/db/ids";

type Exec = Tx;
const err = {
  notFound: (m: string) => new AppError(404, "not_found", m),
  conflict: (m: string, f?: Record<string, number | boolean>) =>
    new AppError(409, "conflict", m, f && Object.fromEntries(Object.entries(f).map(([k, v]) => [k, String(v)]))),
};
const validateBands = (b: BandIn[]) => {
  const p = bandsProblem(b);
  if (p) throw new AppError(422, "validation", p);
};
type Cat = typeof serviceCategories.$inferSelect;
type Sub = typeof serviceSubcategories.$inferSelect;
type Svc = typeof services.$inferSelect;
type Tier = typeof servicePricingTiers.$inferSelect;
type Band = typeof servicePriceBands.$inferSelect;
type Ver = typeof serviceStructureVersions.$inferSelect;
export type L3 = { rw: string; en: string; fr: string };
type Definition = {
  steps: Record<string, unknown>[];
  meta: Record<string, unknown>;
};

const now = () => new Date().toISOString();
const bad = (message: string) => new AppError(422, "validation", message);
// Terminal case statuses live in SQL `service_active_counts()` (migration 0007).
const SERVICE_STATUSES = new Set(["draft", "published", "paused", "archived"]);
const TIERS: Record<string, { label: string; days: number }> = {
  standard: { label: "Standard", days: 5 },
  express: { label: "Express", days: 2 },
  urgent: { label: "Urgent", days: 1 },
}

// ---------------------------------------------------------------- projections (Python category_to_response etc.)
export const categoryOut = (
  r: Cat,
  c?: { services?: number; subs?: number },
) => ({
  id: r.id,
  slug: r.slug,
  name_rw: r.nameRw,
  name_en: r.nameEn,
  name_fr: r.nameFr,
  description: r.descriptionEn ?? r.description,
  description_rw: r.descriptionRw,
  description_en: r.descriptionEn ?? r.description,
  description_fr: r.descriptionFr,
  icon: r.icon,
  color: r.color,
  sort_order: r.sortOrder,
  is_active: r.isActive,
  service_count: c?.services ?? null,
  subcategory_count: c?.subs ?? null,
});
export const subcategoryOut = (r: Sub, services?: number) => ({
  id: r.id,
  category_id: r.categoryId,
  slug: r.slug,
  name_rw: r.nameRw,
  name_en: r.nameEn,
  name_fr: r.nameFr,
  description: r.descriptionEn ?? r.description,
  description_rw: r.descriptionRw,
  description_en: r.descriptionEn ?? r.description,
  description_fr: r.descriptionFr,
  icon: r.icon,
  color: r.color,
  sort_order: r.sortOrder,
  is_active: r.isActive,
  service_count: services ?? null,
});
const tierOut = (t: Tier) => ({
  tier: t.tier,
  label: t.displayName,
  fee: t.platformFee,
  governmentFee: t.governmentFee,
  eta: `${t.etaBusinessDays} business days`,
  etaBusinessDays: t.etaBusinessDays,
  includes: (t.features as string[] | null) ?? [],
  isAvailable: t.isAvailable,
});
const bandOut = (b: Band) => ({
  id: b.id,
  min_amount_rwf: b.minAmountRwf,
  max_amount_rwf: b.maxAmountRwf,
  fee_type: b.feeType,
  fee_rwf: b.feeRwf,
  fee_percent: b.feePercent == null ? null : Number(b.feePercent),
  min_fee_rwf: b.minFeeRwf,
  max_fee_rwf: b.maxFeeRwf,
  sort_order: b.sortOrder,
});
const TIER_ORDER = ["standard", "express", "urgent"];

type Loaded = Svc & {
  cat: Cat | null;
  sub: Sub | null;
  tiers: Tier[];
  bands: Band[];
  versions: Ver[];
};

/** The lowest platform fee a client can be charged, or null when quoted (Python from_fee). */
export function fromFee(
  s: Pick<Svc, "pricingMode" | "handler">,
  tiers: Pick<Tier, "platformFee" | "isAvailable">[],
  bands: BandIn[],
) {
  if (s.pricingMode === "quote" || s.handler === "partner") return null;
  if (s.pricingMode === "range")
    return bands.length
      ? Math.min(...bands.map((b) => bandFee(b, b.min_amount_rwf)))
      : null;
  const fees = tiers.filter((t) => t.isAvailable).map((t) => t.platformFee);
  return fees.length ? Math.min(...fees) : null;
}

const draftOf = (s: Loaded) =>
  s.versions.find((v) => v.status === "draft") ?? null;
const publishedOf = (s: Loaded) =>
  s.versions
    .filter((v) => v.status === "published")
    .sort((a, b) => b.version - a.version)[0] ?? null;
const defOf = (v: Ver | null): Definition => ({
  steps: ((v?.definition as Definition | null)?.steps ??
    []) as Definition["steps"],
  meta: ((v?.definition as Definition | null)?.meta ??
    {}) as Definition["meta"],
});

function summary(s: Loaded, volume = 0) {
  const bands = s.bands.map(bandOut);
  const meta = defOf(draftOf(s) ?? publishedOf(s)).meta;
  return {
    service_id: s.serviceId,
    slug: s.slug,
    name: s.name,
    name_rw: s.nameRw,
    name_en: s.nameEn ?? s.name,
    name_fr: s.nameFr,
    category: s.category,
    category_id: s.categoryId,
    category_ref: s.cat ? categoryOut(s.cat) : null,
    subcategory: s.sub?.slug ?? null,
    subcategory_id: s.subcategoryId,
    subcategory_ref: s.sub ? subcategoryOut(s.sub) : null,
    short_description: s.shortDescription,
    short_description_rw: s.shortDescriptionRw,
    short_description_en: s.shortDescriptionEn,
    short_description_fr: s.shortDescriptionFr,
    color: s.color,
    icon: s.icon,
    status: s.status,
    version: s.publishedVersion,
    is_featured: s.isFeatured,
    handler: s.handler || "agent",
    pricing_tiers: [...s.tiers]
      .sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier))
      .map(tierOut),
    volume30d: volume,
    pricing_mode: s.pricingMode || "fixed",
    range_basis_label:
      (s.rangeBasisLabel as Record<string, string> | null) ?? null,
    plan_covered: s.planCovered,
    urgent_surcharge_type: s.urgentSurchargeType,
    urgent_surcharge_value: s.urgentSurchargeValue,
    price_bands: bands,
    from_fee: fromFee(s, s.tiers, bands),
    copy_too_long: copyLimitIssues(meta).length > 0,
    engagement_type: s.engagementType,
    eligibility: s.eligibility as L3[],
    deliverables: s.deliverables as L3[],
    turnaround_days_min: s.turnaroundDaysMin,
    turnaround_days_max: s.turnaroundDaysMax,
    delivery_mode: s.deliveryMode,
    seo: s.seo as Partial<Record<keyof L3, { title?: string; description?: string; og_image?: string }>>,
    related_slugs: s.relatedSlugs as string[],
  };
}
const detail = (s: Loaded, volume = 0) => ({
  ...summary(s, volume),
  description: s.description,
  description_rw: s.descriptionRw,
  description_en: s.descriptionEn,
  description_fr: s.descriptionFr,
  created_at: s.createdAt,
  updated_at: s.updatedAt,
  steps: [] as unknown[],
  requirements: requirementsOf(publishedOf(s)),
  structure: publishedOf(s) ? defOf(publishedOf(s)) : null,
});
/** Public requirement list = the published structure's documents (builder meta.documents). */
type DocMeta = { id: string; name: Partial<L3>; types?: string[]; maxMb?: number; required?: boolean };
const requirementsOf = (v: Ver | null) =>
  ((defOf(v).meta.documents ?? []) as DocMeta[]).map((d, i) => ({
    key: d.id,
    label: d.name.en ?? "",
    label_rw: d.name.rw || d.name.en || "",
    label_en: d.name.en ?? "",
    label_fr: d.name.fr || d.name.en || "",
    is_required: !!d.required,
    max_size_mb: d.maxMb ?? 5,
    types: d.types ?? [],
    sort_order: i,
  }));

/** Services with their category, subcategory, tiers, bands and structure versions, in 5 batched queries. */
async function load(
  db: Exec,
  where?: ReturnType<typeof eq>,
  lock = false,
): Promise<Loaded[]> {
  const q = db.select().from(services).where(where).orderBy(asc(services.name));
  const rows = lock ? await q.for("update") : await q;
  if (!rows.length) return [];
  const ids = rows.map((r) => r.serviceId);
  const [cats, subs, tiers, bands, versions] = await Promise.all([
    db.select().from(serviceCategories),
    db.select().from(serviceSubcategories),
    db
      .select()
      .from(servicePricingTiers)
      .where(inArray(servicePricingTiers.serviceId, ids)),
    db
      .select()
      .from(servicePriceBands)
      .where(inArray(servicePriceBands.serviceId, ids))
      .orderBy(asc(servicePriceBands.sortOrder)),
    db
      .select()
      .from(serviceStructureVersions)
      .where(inArray(serviceStructureVersions.serviceId, ids))
      .orderBy(asc(serviceStructureVersions.version)),
  ]);
  return rows.map((r) => ({
    ...r,
    cat: cats.find((c) => c.id === r.categoryId) ?? null,
    sub: subs.find((c) => c.id === r.subcategoryId) ?? null,
    tiers: tiers.filter((t) => t.serviceId === r.serviceId),
    bands: bands.filter((b) => b.serviceId === r.serviceId),
    versions: versions.filter((v) => v.serviceId === r.serviceId),
  }));
}
async function requireService(db: Exec, slug: string, lock = false) {
  const [s] = await load(db, eq(services.slug, slug), lock);
  if (!s) throw err.notFound("Service not found.");
  return s;
}
/** Public 30-day volume across all clients via SECURITY DEFINER `public_service_volume` (RLS hides others' applications). */
async function volumes(db: Exec) {
  const rows = (await db.execute(dsql`select service_id, n from public_service_volume(30)`)) as unknown as { service_id: string; n: string | number }[]; // cast: execute() rows are untyped
  return new Map(rows.map((r) => [r.service_id, Number(r.n)]));
}
/** Active case rows per (service, version) via SECURITY DEFINER `service_active_counts` (RLS hides others' cases). */
async function activeRows(db: Exec) {
  return (await db.execute(dsql`select service_id, structure_version_id, n from service_active_counts()`)) as unknown as { service_id: string; structure_version_id: string; n: string | number }[]; // cast: execute() rows are untyped
}
async function activeCounts(db: Exec) {
  const m = new Map<string, number>();
  for (const r of await activeRows(db)) m.set(r.service_id, (m.get(r.service_id) ?? 0) + Number(r.n));
  return m;
}

// ---------------------------------------------------------------- public reads
export async function listPublicServices(db: Exec) {
  const [rows, vol] = await Promise.all([load(db), volumes(db)]);
  // Paused services stay listed (the site shows them as "temporarily unavailable"); drafts and archived never do.
  const out = {
    services: rows
      .filter((s) => s.status === "published" || s.status === "paused")
      .map((s) => summary(s, vol.get(s.serviceId) ?? 0)),
  };
  return out;
}
/** Trigram match over the generated `search_text` (all locales), best first; ids only, rows come from the cached list. */
export async function searchIds(db: Exec, q: string) {
  const t = q.trim().toLowerCase().slice(0, 100);
  const rows = (await db.execute(dsql`select service_id from services
    where search_text ilike ${"%" + t.replace(/[\\%_]/g, "\\$&") + "%"} or ${t} <% search_text
    order by word_similarity(${t}, search_text) desc limit 100`)) as unknown as { service_id: string }[]; // cast: execute() rows are untyped
  return rows.map((r) => r.service_id);
}
export async function getPublicService(db: Exec, slug: string) {
  const [s] = await load(db, eq(services.slug, slug));
  if (!s || (s.status !== "published" && s.status !== "paused"))
    throw err.notFound("Service not found.");
  return detail(s, (await volumes(db)).get(s.serviceId) ?? 0);
}

// ---------------------------------------------------------------- categories
export async function listCategories(db: Exec, admin: boolean) {
  const rows = await db
    .select()
    .from(serviceCategories)
    .where(admin ? undefined : eq(serviceCategories.isActive, true))
    .orderBy(asc(serviceCategories.sortOrder), asc(serviceCategories.slug));
  if (!admin) return { categories: rows.map((r) => categoryOut(r)) };
  const [svc, subs] = await Promise.all([
    db
      .select({ id: services.categoryId, n: count() })
      .from(services)
      .where(isNotNull(services.categoryId))
      .groupBy(services.categoryId),
    db
      .select({ id: serviceSubcategories.categoryId, n: count() })
      .from(serviceSubcategories)
      .groupBy(serviceSubcategories.categoryId),
  ]);
  const n = (xs: { id: string | null; n: number }[], id: string) =>
    xs.find((x) => x.id === id)?.n ?? 0;
  return {
    categories: rows.map((r) =>
      categoryOut(r, { services: n(svc, r.id), subs: n(subs, r.id) }),
    ),
  };
}

export function slugifyName(name: string) {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, 64) || "category";
}
async function uniqueSlug(
  db: Exec,
  table: typeof serviceCategories | typeof serviceSubcategories,
  base: string,
) {
  for (let i = 1; ; i++) {
    const extra = i === 1 ? "" : `-${i}`;
    const cand = `${base.slice(0, 64 - extra.length)}${extra}`;
    const [hit] = await db
      .select({ id: table.id })
      .from(table)
      .where(eq(table.slug, cand))
      .limit(1);
    if (!hit) return cand;
  }
}
const clean = (v?: string | null) => (v == null ? null : v.trim() || null);
const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

export type CategoryIn = {
  name_rw?: string | null;
  name_en?: string | null;
  name_fr?: string | null;
  description?: string | null;
  description_rw?: string | null;
  description_en?: string | null;
  description_fr?: string | null;
  is_active?: boolean | null;
  slug?: string | null;
  icon?: string | null;
  color?: string | null;
  sort_order?: number | null;
  category_id?: string | null;
};
const copyFields = (b: CategoryIn) => ({
  ...(b.name_rw != null && { nameRw: b.name_rw.trim() }),
  ...(b.name_en != null && { nameEn: b.name_en.trim() }),
  ...(b.name_fr != null && { nameFr: b.name_fr.trim() }),
  ...((b.description_en ?? b.description) !== undefined && {
    description: clean(b.description_en ?? b.description),
    descriptionEn: clean(b.description_en ?? b.description),
  }),
  ...(b.description_rw !== undefined && {
    descriptionRw: clean(b.description_rw),
  }),
  ...(b.description_fr !== undefined && {
    descriptionFr: clean(b.description_fr),
  }),
  ...(b.is_active != null && { isActive: b.is_active }),
  ...(b.icon != null && { icon: b.icon }),
  ...(b.color !== undefined && { color: b.color }),
  ...(b.sort_order != null && { sortOrder: b.sort_order }),
});

export async function createCategory(
  db: Exec,
  b: CategoryIn & {
    name_rw: string;
    name_en: string;
    name_fr: string;
    is_active: boolean;
  },
) {
  const slug = await uniqueSlug(
    db,
    serviceCategories,
    b.slug || slugifyName(b.name_en),
  );
  const [{ max }] = await db
    .select({
      max: dsql<number>`coalesce(max(${serviceCategories.sortOrder}), 0)`,
    })
    .from(serviceCategories);
  const t = now();
  const [row] = await db
    .insert(serviceCategories)
    .values({
      id: generateId("scat"),
      slug,
      nameRw: "",
      nameEn: "",
      nameFr: "",
      icon: "Layers",
      sortOrder: Number(max) + 1,
      isActive: true,
      createdAt: t,
      updatedAt: t,
      ...copyFields(b),
    })
    .returning();
  return categoryOut(row, { services: 0, subs: 0 });
}
export async function updateCategory(db: Exec, id: string, b: CategoryIn) {
  const [cur] = await db
    .select()
    .from(serviceCategories)
    .where(eq(serviceCategories.id, id))
    .for("update");
  if (!cur) throw err.notFound("Category not found.");
  if (b.slug && b.slug !== cur.slug) {
    const [dup] = await db
      .select({ id: serviceCategories.id })
      .from(serviceCategories)
      .where(eq(serviceCategories.slug, b.slug));
    if (dup) throw err.conflict("Category slug already exists.");
  }
  const [row] = await db
    .update(serviceCategories)
    .set({
      ...copyFields(b),
      ...(b.slug && { slug: b.slug }),
      updatedAt: now(),
    })
    .where(eq(serviceCategories.id, id))
    .returning();
  // services.category carries the slug (Python rewrite_service_slugs); keep it in step.
  if (row.slug !== cur.slug)
    await db
      .update(services)
      .set({ category: row.slug })
      .where(eq(services.categoryId, id));
  return (await listCategories(db, true)).categories.find((c) => c.id === id)!;
}
export async function deleteCategory(db: Exec, id: string) {
  const [cur] = await db
    .select()
    .from(serviceCategories)
    .where(eq(serviceCategories.id, id))
    .for("update");
  if (!cur) throw err.notFound("Category not found.");
  const [[{ subs }], [{ svcs }]] = await Promise.all([
    db
      .select({ subs: count() })
      .from(serviceSubcategories)
      .where(eq(serviceSubcategories.categoryId, id)),
    db
      .select({ svcs: count() })
      .from(services)
      .where(eq(services.categoryId, id)),
  ]);
  if (subs || svcs) {
    const parts = [
      subs && plural(subs, "subcategory", "subcategories"),
      svcs && plural(svcs, "service", "services"),
    ]
      .filter(Boolean)
      .join(" and ");
    throw err.conflict(
      `This category still holds ${parts}. Move or delete them first.`,
      { subcategory_count: subs, service_count: svcs },
    );
  }
  await db.delete(serviceCategories).where(eq(serviceCategories.id, id));
  return { id, status: "deleted" };
}

export async function listSubcategories(
  db: Exec,
  admin: boolean,
  categoryId?: string,
) {
  if (!admin) {
    // Active subcategories whose parent is active too (Python list_public join).
    const rows = await db
      .select({ s: serviceSubcategories })
      .from(serviceSubcategories)
      .innerJoin(
        serviceCategories,
        eq(serviceCategories.id, serviceSubcategories.categoryId),
      )
      .where(
        and(
          eq(serviceSubcategories.isActive, true),
          eq(serviceCategories.isActive, true),
        ),
      )
      .orderBy(
        asc(serviceCategories.sortOrder),
        asc(serviceSubcategories.sortOrder),
        asc(serviceSubcategories.slug),
      );
    return { subcategories: rows.map((r) => subcategoryOut(r.s)) };
  }
  const [rows, counts] = await Promise.all([
    db
      .select()
      .from(serviceSubcategories)
      .where(
        categoryId
          ? eq(serviceSubcategories.categoryId, categoryId)
          : undefined,
      )
      .orderBy(
        asc(serviceSubcategories.categoryId),
        asc(serviceSubcategories.sortOrder),
        asc(serviceSubcategories.slug),
      ),
    db
      .select({ id: services.subcategoryId, n: count() })
      .from(services)
      .where(isNotNull(services.subcategoryId))
      .groupBy(services.subcategoryId),
  ]);
  return {
    subcategories: rows.map((r) =>
      subcategoryOut(r, counts.find((c) => c.id === r.id)?.n ?? 0),
    ),
  };
}
async function requireCategory(db: Exec, id: string) {
  const [c] = await db
    .select()
    .from(serviceCategories)
    .where(eq(serviceCategories.id, id));
  if (!c) throw err.notFound("Category not found.");
  return c;
}
export async function createSubcategory(
  db: Exec,
  b: CategoryIn & {
    category_id: string;
    name_rw: string;
    name_en: string;
    name_fr: string;
    is_active: boolean;
  },
) {
  await requireCategory(db, b.category_id);
  const slug = await uniqueSlug(
    db,
    serviceSubcategories,
    b.slug || slugifyName(b.name_en),
  );
  const [{ max }] = await db
    .select({
      max: dsql<number>`coalesce(max(${serviceSubcategories.sortOrder}), 0)`,
    })
    .from(serviceSubcategories)
    .where(eq(serviceSubcategories.categoryId, b.category_id));
  const t = now();
  const [row] = await db
    .insert(serviceSubcategories)
    .values({
      id: generateId("ssub"),
      categoryId: b.category_id,
      slug,
      nameRw: "",
      nameEn: "",
      nameFr: "",
      sortOrder: Number(max) + 1,
      isActive: true,
      createdAt: t,
      updatedAt: t,
      ...copyFields(b),
    })
    .returning();
  return subcategoryOut(row, 0);
}
export async function updateSubcategory(db: Exec, id: string, b: CategoryIn) {
  const [cur] = await db
    .select()
    .from(serviceSubcategories)
    .where(eq(serviceSubcategories.id, id))
    .for("update");
  if (!cur) throw err.notFound("Subcategory not found.");
  const [{ n }] = await db
    .select({ n: count() })
    .from(services)
    .where(eq(services.subcategoryId, id));
  if (b.category_id && b.category_id !== cur.categoryId) {
    // Re-parenting would leave every service here pointing at a category it no longer belongs to.
    if (n)
      throw err.conflict(
        `Move the ${plural(n, "service", "services")} in this subcategory before changing its category.`,
        { service_count: n },
      );
    await requireCategory(db, b.category_id);
  }
  if (b.slug && b.slug !== cur.slug) {
    const [dup] = await db
      .select({ id: serviceSubcategories.id })
      .from(serviceSubcategories)
      .where(eq(serviceSubcategories.slug, b.slug));
    if (dup) throw err.conflict("Subcategory slug already exists.");
  }
  const [row] = await db
    .update(serviceSubcategories)
    .set({
      ...copyFields(b),
      ...(b.slug && { slug: b.slug }),
      ...(b.category_id && { categoryId: b.category_id }),
      updatedAt: now(),
    })
    .where(eq(serviceSubcategories.id, id))
    .returning();
  return subcategoryOut(row, n);
}
export async function deleteSubcategory(db: Exec, id: string) {
  const [cur] = await db
    .select()
    .from(serviceSubcategories)
    .where(eq(serviceSubcategories.id, id))
    .for("update");
  if (!cur) throw err.notFound("Subcategory not found.");
  const [{ n }] = await db
    .select({ n: count() })
    .from(services)
    .where(eq(services.subcategoryId, id));
  if (n)
    throw err.conflict(
      `This subcategory still holds ${plural(n, "service", "services")}. Move or delete them first.`,
      { service_count: n },
    );
  await db.delete(serviceSubcategories).where(eq(serviceSubcategories.id, id));
  return { id, status: "deleted" };
}

// ---------------------------------------------------------------- admin services
export async function listAdminServices(db: Exec) {
  const [rows, vol] = await Promise.all([load(db), activeCounts(db)]);
  return { services: rows.map((s) => summary(s, vol.get(s.serviceId) ?? 0)) };
}
export async function getAdminService(db: Exec, slug: string) {
  const s = await requireService(db, slug);
  return detail(s, (await activeCounts(db)).get(s.serviceId) ?? 0);
}

/** Category by slug or id; hidden categories cannot take services (Python _resolve_category). */
async function resolveCategory(db: Exec, ref: string) {
  const v = ref.trim();
  if (!v) throw bad("Category cannot be empty.");
  const [c] = await db
    .select()
    .from(serviceCategories)
    .where(
      dsql`${serviceCategories.slug} = ${v} or ${serviceCategories.id} = ${v} or ${serviceCategories.nameEn} = ${v}`,
    )
    .limit(1);
  if (!c) throw bad(`Unknown service category: ${v}.`);
  if (!c.isActive)
    throw bad(
      `Category ${v} is hidden. Make it visible before assigning services.`,
    );
  return c;
}
/** Subcategory must belong to the category: nothing in the schema can express that invariant. */
async function resolveSubcategory(db: Exec, ref: string, cat: Cat) {
  const v = ref.trim();
  if (!v) throw bad("Subcategory cannot be empty.");
  const [s] = await db
    .select()
    .from(serviceSubcategories)
    .where(
      dsql`${serviceSubcategories.slug} = ${v} or ${serviceSubcategories.id} = ${v}`,
    )
    .limit(1);
  if (!s) throw bad(`Unknown service subcategory: ${v}.`);
  if (s.categoryId !== cat.id)
    throw bad(`Subcategory ${v} does not belong to category ${cat.slug}.`);
  if (!s.isActive)
    throw bad(
      `Subcategory ${v} is hidden. Make it visible before assigning services.`,
    );
  return s;
}
const cleanHandler = (v?: string | null) => {
  if (v == null) return null;
  const h = v.trim().toLowerCase();
  if (h !== "agent" && h !== "partner")
    throw bad("A service is handled by an agent or a partner.");
  return h;
};

export type CreateServiceIn = {
  name: string;
  slug: string;
  category: string;
  subcategory?: string | null;
  short_description?: string | null;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  is_featured?: boolean;
  handler?: string | null;
};
export async function createService(
  db: Exec,
  actorId: string | null,
  b: CreateServiceIn,
) {
  const [dup] = await db
    .select({ id: services.serviceId })
    .from(services)
    .where(eq(services.slug, b.slug));
  if (dup) throw err.conflict("Slug already in use");
  const cat = await resolveCategory(db, b.category);
  const sub = b.subcategory
    ? await resolveSubcategory(db, b.subcategory, cat)
    : null;
  const t = now();
  const serviceId = generateId("svc");
  await db.insert(services).values({
    serviceId,
    slug: b.slug,
    name: b.name.trim(),
    nameEn: b.name.trim(),
    category: cat.slug,
    categoryId: cat.id,
    subcategoryId: sub?.id ?? null,
    shortDescription: clean(b.short_description),
    shortDescriptionEn: clean(b.short_description),
    description: clean(b.description),
    descriptionEn: clean(b.description),
    color: b.color ?? null,
    icon: b.icon ?? null,
    status: "draft",
    handler: cleanHandler(b.handler) ?? "agent",
    publishedVersion: 0,
    isFeatured: !!b.is_featured,
    createdBy: actorId?.startsWith("usr_") ? actorId : null,
    createdAt: t,
    updatedAt: t,
    deadlineMode: "none",
    pricingMode: "fixed",
    planCovered: false,
  });
  // Standard is on; express and urgent exist but stay off until priced (mock contract, U16).
  await db.insert(servicePricingTiers).values(
    Object.entries(TIERS).map(([tier, m]) => ({
      id: generateId("tier"),
      serviceId,
      tier,
      displayName: m.label,
      description: `${m.label} processing`,
      platformFee: 0,
      governmentFee: 0,
      etaBusinessDays: m.days,
      features: [`${m.label} processing`],
      isAvailable: tier === "standard",
    })),
  );
  await db.insert(serviceStructureVersions).values({
    id: generateId("str"),
    serviceId,
    version: 1,
    status: "draft",
    createdAt: t,
    updatedAt: t,
    definition: {
      steps: [{ id: "form", fields: [] }],
      meta: EMPTY_META(
        b.name.trim(),
        b.short_description ?? "",
        cat.id,
        sub?.id ?? "",
      ),
    },
  });
  return {
    service_id: serviceId,
    slug: b.slug,
    status: "draft",
  };
}

export type UpdateServiceIn = {
  [K in keyof Omit<CreateServiceIn, "slug">]?: CreateServiceIn[K] | null;
} & {
  engagement_type?: "application" | "consultation" | null;
  eligibility?: L3[] | null;
  deliverables?: L3[] | null;
  turnaround_days_min?: number | null;
  turnaround_days_max?: number | null;
  delivery_mode?: "online" | "in_person" | "hybrid" | null;
  seo?: Partial<Record<keyof L3, { title?: string; description?: string; og_image?: string }>> | null;
  related_slugs?: string[] | null;
};
export async function updateService(
  db: Exec,
  slug: string,
  b: UpdateServiceIn,
) {
  const s = await requireService(db, slug, true);
  const set: Partial<Svc> = { updatedAt: now() };
  let cat: Cat | null = null;
  if (b.category != null) {
    cat = await resolveCategory(db, b.category);
    set.category = cat.slug;
    set.categoryId = cat.id;
  }
  if (b.subcategory != null && !b.subcategory.trim())
    set.subcategoryId = null; // "" is the explicit unassign signal
  else if (b.subcategory != null) {
    const parent =
      cat ?? (s.categoryId ? await resolveCategory(db, s.categoryId) : null);
    if (!parent) throw bad("Assign a category before choosing a subcategory.");
    set.subcategoryId = (
      await resolveSubcategory(db, b.subcategory, parent)
    ).id;
  } else if (cat && s.sub && s.sub.categoryId !== cat.id)
    set.subcategoryId = null; // old one belongs to another parent now
  if (b.name != null) {
    set.name = b.name.trim();
    set.nameEn = b.name.trim();
  }
  if (b.short_description != null) {
    set.shortDescription = b.short_description;
    set.shortDescriptionEn = b.short_description;
  }
  if (b.description != null) {
    set.description = b.description;
    set.descriptionEn = b.description;
  }
  if (b.color != null) set.color = b.color;
  if (b.icon != null) set.icon = b.icon;
  if (b.is_featured != null) set.isFeatured = b.is_featured;
  const h = cleanHandler(b.handler);
  if (h) set.handler = h;
  if (b.engagement_type != null) set.engagementType = b.engagement_type;
  if (b.eligibility != null) set.eligibility = b.eligibility;
  if (b.deliverables != null) set.deliverables = b.deliverables;
  if (b.turnaround_days_min !== undefined) set.turnaroundDaysMin = b.turnaround_days_min;
  if (b.turnaround_days_max !== undefined) set.turnaroundDaysMax = b.turnaround_days_max;
  const lo = set.turnaroundDaysMin !== undefined ? set.turnaroundDaysMin : s.turnaroundDaysMin;
  const hi = set.turnaroundDaysMax !== undefined ? set.turnaroundDaysMax : s.turnaroundDaysMax;
  if (lo != null && hi != null && lo > hi) throw bad("Turnaround minimum cannot exceed the maximum.");
  if (b.delivery_mode !== undefined) set.deliveryMode = b.delivery_mode;
  if (b.seo != null) set.seo = b.seo;
  if (b.related_slugs != null) set.relatedSlugs = [...new Set(b.related_slugs)].filter((x) => x !== slug);
  await db.update(services).set(set).where(eq(services.serviceId, s.serviceId));
  // Keep the draft's copy in step so the builder shows what was just saved.
  const d = draftOf(s);
  if (d) {
    const def = defOf(d);
    const meta = { ...def.meta } as Record<string, unknown> & {
      name?: L3;
      short?: L3;
    };
    if (b.name != null)
      meta.name = { ...(meta.name ?? { rw: "", fr: "" }), en: b.name } as L3;
    if (b.short_description != null)
      meta.short = {
        ...(meta.short ?? { rw: "", fr: "" }),
        en: b.short_description,
      } as L3;
    if (set.categoryId) meta.categoryId = set.categoryId;
    if (set.subcategoryId !== undefined)
      meta.subcategoryId = set.subcategoryId ?? "";
    await db
      .update(serviceStructureVersions)
      .set({ definition: { ...def, meta }, updatedAt: set.updatedAt! })
      .where(eq(serviceStructureVersions.id, d.id));
  }
  return getAdminService(db, slug);
}

export async function deleteService(db: Exec, slug: string) {
  const s = await requireService(db, slug, true);
  const [{ n }] = await db
    .select({ n: count() })
    .from(applications)
    .where(eq(applications.serviceId, s.serviceId));
  if (n) {
    throw err.conflict(
      `${n === 1 ? "1 case references" : `${n} cases reference`} this service, so it cannot be deleted. Archive it instead to remove it from the catalogue.`,
      { application_count: n, can_archive: s.status !== "archived" },
    );
  }
  await db.delete(services).where(eq(services.serviceId, s.serviceId));
  return { slug, service_id: s.serviceId, status: "deleted" };
}

export async function updateStatus(db: Exec, slug: string, status: string) {
  const s = await requireService(db, slug, true);
  if (!SERVICE_STATUSES.has(status)) throw bad("Invalid service status.");
  if (status === "published") {
    if (!publishedOf(s))
      throw bad("Publish a structure version before publishing service.");
    if (!s.subcategoryId)
      throw bad("Assign a subcategory before publishing this service.");
  }
  await db
    .update(services)
    .set({ status, updatedAt: now() })
    .where(eq(services.serviceId, s.serviceId));
  return getAdminService(db, slug);
}

// ---------------------------------------------------------------- pricing (money: integer RWF, row-locked)
export type PricingIn = {
  pricing_mode: "fixed" | "range" | "quote";
  range_basis_label?: Record<string, string> | null;
  plan_covered?: boolean | null;
  urgent_surcharge_type?: "flat" | "percent" | null;
  urgent_surcharge_value?: number | null;
  bands?: BandIn[];
};
export async function updatePricing(db: Exec, slug: string, b: PricingIn) {
  const s = await requireService(db, slug, true);
  const mode = b.pricing_mode;
  if (s.handler === "partner" && mode !== "quote")
    throw bad("Partner services are always priced by quote.");
  const bands = b.bands ?? [];
  if (mode === "range") validateBands(bands);
  const set: Partial<Svc> = { pricingMode: mode, updatedAt: now() };
  if (mode === "range" && b.range_basis_label) {
    const label = Object.fromEntries(
      Object.entries(b.range_basis_label).map(([k, v]) => [
        k,
        (v ?? "").trim().slice(0, 80),
      ]),
    );
    if (Object.values(label).some(Boolean)) set.rangeBasisLabel = label;
  }
  if (b.plan_covered != null) set.planCovered = b.plan_covered;
  else if (mode !== (s.pricingMode || "fixed"))
    set.planCovered = mode === "fixed"; // D15: range/quote default to not covered
  if (b.urgent_surcharge_type && b.urgent_surcharge_value) {
    if (b.urgent_surcharge_type === "percent" && b.urgent_surcharge_value > 100)
      throw bad("An urgent surcharge percentage is at most 100.");
    set.urgentSurchargeType = b.urgent_surcharge_type;
    set.urgentSurchargeValue = b.urgent_surcharge_value;
  } else {
    set.urgentSurchargeType = null;
    set.urgentSurchargeValue = null;
  }
  await db.update(services).set(set).where(eq(services.serviceId, s.serviceId));
  if (mode === "range") {
    // Bands are replaced wholesale; open cases keep their own price snapshot.
    await db
      .delete(servicePriceBands)
      .where(eq(servicePriceBands.serviceId, s.serviceId));
    await db.insert(servicePriceBands).values(
      bands.map((x, i) => {
        const pct = x.fee_type === "percent";
        return {
          id: generateId("band"),
          serviceId: s.serviceId,
          minAmountRwf: x.min_amount_rwf,
          maxAmountRwf: x.max_amount_rwf ?? null,
          feeType: x.fee_type,
          feeRwf: pct ? null : (x.fee_rwf ?? 0),
          feePercent: pct ? String(x.fee_percent) : null,
          minFeeRwf: pct ? (x.min_fee_rwf ?? null) : null,
          maxFeeRwf: pct ? (x.max_fee_rwf ?? null) : null,
          sortOrder: i,
        };
      }),
    );
  }
  return {
    out: await getAdminService(db, slug),
    audit: {
      service_id: s.serviceId,
      pricing_mode: mode,
      plan_covered: set.planCovered ?? s.planCovered,
      bands: mode === "range" ? bands : [],
      urgent_surcharge_type: set.urgentSurchargeType,
      urgent_surcharge_value: set.urgentSurchargeValue,
    },
  };
}

export type TierIn = {
  display_name?: string | null;
  description?: string | null;
  platform_fee?: number | null;
  government_fee?: number | null;
  eta_business_days?: number | null;
  features?: string[] | null;
  is_available?: boolean | null;
};
export async function updateTier(
  db: Exec,
  slug: string,
  tierName: string,
  b: TierIn,
) {
  const s = await requireService(db, slug, true);
  const name = tierName.trim().toLowerCase();
  const meta = TIERS[name];
  if (!meta) throw err.notFound("Tier not found");
  let tier = s.tiers.find((t) => t.tier === name);
  const created = !tier;
  if (!tier) {
    // Setting a price for the first time creates the tier (Python update_pricing_tier).
    [tier] = await db
      .insert(servicePricingTiers)
      .values({
        id: generateId("tier"),
        serviceId: s.serviceId,
        tier: name,
        displayName: meta.label,
        description: `${meta.label} processing`,
        platformFee: 0,
        governmentFee: 0,
        etaBusinessDays: meta.days,
        features: [`${meta.label} processing`],
        isAvailable: true,
      })
      .returning();
  }
  const [row] = await db
    .update(servicePricingTiers)
    .set({
      ...(b.display_name != null && { displayName: b.display_name }),
      ...(b.description != null && { description: b.description }),
      ...(b.platform_fee != null && { platformFee: b.platform_fee }),
      ...(b.government_fee != null && { governmentFee: b.government_fee }),
      ...(b.eta_business_days != null && {
        etaBusinessDays: b.eta_business_days,
      }),
      ...(b.features != null && { features: b.features }),
      ...(b.is_available != null && { isAvailable: b.is_available }),
    })
    .where(eq(servicePricingTiers.id, tier.id))
    .returning();
  await db
    .update(services)
    .set({ updatedAt: now() })
    .where(eq(services.serviceId, s.serviceId));
  return {
    out: await getAdminService(db, slug),
    audit: {
      service_id: s.serviceId,
      tier: name,
      created,
      platform_fee: row.platformFee,
      government_fee: row.governmentFee,
    },
  };
}

// ---------------------------------------------------------------- structure (versioned builder)
const structureOut = (s: Loaded, v: Ver) => ({
  serviceSlug: s.slug,
  version: v.version,
  status: v.status,
  publishedVersion: publishedOf(s)?.version ?? (s.publishedVersion || null),
  updatedAt: v.updatedAt,
  ...defOf(v),
});
const content = (v: Ver | null) => JSON.stringify(defOf(v));

/** The open draft, created from the live version on first edit after a publish (mock draftOf). */
async function ensureDraft(db: Exec, s: Loaded) {
  const d = draftOf(s);
  if (d) return d;
  const p = publishedOf(s);
  const t = now();
  const [row] = await db
    .insert(serviceStructureVersions)
    .values({
      id: generateId("str"),
      serviceId: s.serviceId,
      version: Math.max(0, ...s.versions.map((v) => v.version)) + 1,
      status: "draft",
      definition: p
        ? defOf(p)
        : {
            steps: [{ id: "form", fields: [] }],
            meta: EMPTY_META(
              s.name,
              s.shortDescription ?? "",
              s.categoryId ?? "",
              s.subcategoryId ?? "",
            ),
          },
      createdAt: t,
      updatedAt: t,
    })
    .returning();
  s.versions.push(row);
  return row;
}

export async function getDraft(db: Exec, slug: string) {
  const s = await requireService(db, slug, true);
  return structureOut(s, await ensureDraft(db, s));
}

/** Copy the builder's localized name/short into the service row, so lists and the public site follow the draft. */
function copyFromMeta(meta: Record<string, unknown>): Partial<Svc> {
  const l = (x: unknown): L3 => ({
    rw: "",
    en: "",
    fr: "",
    ...(typeof x === "string" ? { en: x } : (x as Partial<L3> | undefined)),
  });
  const name = l(meta.name),
    short = l(meta.short ?? meta.shortDescription);
  const out: Partial<Svc> = {
    nameRw: name.rw || null,
    nameEn: name.en || null,
    nameFr: name.fr || null,
    shortDescriptionRw: short.rw || null,
    shortDescriptionEn: short.en || null,
    shortDescriptionFr: short.fr || null,
  };
  if (name.en || name.rw) out.name = name.en || name.rw;
  out.shortDescription = short.en || null;
  return out;
}

export async function saveDraft(db: Exec, slug: string, body: Definition) {
  const s = await requireService(db, slug, true);
  const issues = copyLimitIssues(body.meta);
  if (issues.length) throw bad(issues.join(" "));
  const d = await ensureDraft(db, s);
  const t = now();
  const [row] = await db
    .update(serviceStructureVersions)
    .set({ definition: { steps: body.steps, meta: body.meta }, updatedAt: t })
    .where(eq(serviceStructureVersions.id, d.id))
    .returning();
  await db
    .update(services)
    .set({ ...copyFromMeta(body.meta), updatedAt: t })
    .where(eq(services.serviceId, s.serviceId));
  s.versions = s.versions.map((v) => (v.id === row.id ? row : v));
  return structureOut(s, row);
}

/** Server-side publish gate (the builder shows the same list as blockers()). */
export function publishProblems(def: Definition): string[] {
  const meta = def.meta as { name?: Partial<L3> | string };
  const name =
    typeof meta.name === "string"
      ? meta.name
      : `${meta.name?.en ?? ""}${meta.name?.rw ?? ""}`;
  const fields = def.steps.reduce(
    (n, st) =>
      n +
      (((st.fields ?? st.components) as unknown[] | undefined)?.length ?? 0),
    0,
  );
  return [
    ...(name.trim() ? [] : ["Give the service a name."]),
    ...(fields ? [] : ["Add at least one form field."]),
    ...copyLimitIssues(def.meta),
  ];
}

export async function publish(db: Exec, slug: string) {
  const s = await requireService(db, slug, true);
  const d = draftOf(s);
  if (!d) throw err.notFound("Draft structure not found.");
  const problems = publishProblems(defOf(d));
  if (problems.length) throw bad(problems.join(" "));
  // First publish is what makes a draft service visible; it needs a subcategory (Python _require_subcategory_to_publish).
  if (s.status === "draft" && !s.subcategoryId)
    throw bad("Assign a subcategory before publishing this service.");
  const t = now();
  // A legacy FastAPI draft sits at version 0; the published row always takes the next free number.
  const prior = Math.max(0, ...s.versions.filter((v) => v.id !== d.id).map((v) => v.version));
  const version = d.version > prior ? d.version : prior + 1;
  await db
    .update(serviceStructureVersions)
    .set({ status: "archived", updatedAt: t })
    .where(
      and(
        eq(serviceStructureVersions.serviceId, s.serviceId),
        eq(serviceStructureVersions.status, "published"),
      ),
    );
  // Open cases keep pointing at the row they were submitted on; this row becomes the live one.
  const [row] = await db
    .update(serviceStructureVersions)
    .set({ status: "published", version, publishedAt: t, updatedAt: t })
    .where(eq(serviceStructureVersions.id, d.id))
    .returning();
  await db
    .update(services)
    .set({
      ...copyFromMeta(defOf(d).meta),
      publishedVersion: version,
      status: s.status === "draft" ? "published" : s.status,
      updatedAt: t,
    })
    .where(eq(services.serviceId, s.serviceId));
  s.versions = s.versions.map((v) =>
    v.status === "published"
      ? { ...v, status: "archived" }
      : v.id === row.id
        ? row
        : v,
  );
  return {
    out: structureOut(s, row),
    audit: { service_id: s.serviceId, version },
  };
}

export async function getPublished(db: Exec, slug: string) {
  const s = await requireService(db, slug);
  const p = publishedOf(s);
  if (!p) throw err.notFound("Never published");
  return structureOut(s, p);
}
export async function listVersions(db: Exec, slug: string) {
  const s = await requireService(db, slug);
  return {
    versions: [...s.versions]
      .sort((a, b) => b.version - a.version)
      .map((v) => ({
        version: v.version,
        status: v.status,
        publishedAt: v.publishedAt,
        updatedAt: v.updatedAt,
      })),
  };
}
export async function getVersion(db: Exec, slug: string, version: number) {
  const s = await requireService(db, slug);
  const v = s.versions.find((x) => x.version === version);
  if (!v) throw err.notFound("Version not found");
  return structureOut(s, v);
}
export async function inFlightCount(db: Exec, slug: string, version: number) {
  const s = await requireService(db, slug);
  const v = s.versions.find((x) => x.version === version);
  if (!v) throw err.notFound("Version not found");
  const n = (await activeRows(db)).filter((r) => r.structure_version_id === v.id).reduce((a, r) => a + Number(r.n), 0);
  return { count: n };
}

export async function structureCatalogue(db: Exec, includeArchived = false) {
  const [rows, active] = await Promise.all([load(db), activeCounts(db)]);
  return {
    structures: rows
      .filter((s) => includeArchived || s.status !== "archived")
      .map((s) => {
        const d = draftOf(s),
          p = publishedOf(s);
        const def = defOf(d ?? p);
        const changes = !!d && (!p || content(d) !== content(p));
        return {
          slug: s.slug,
          name: s.name,
          category: s.category,
          categoryId: s.categoryId,
          subcategory: s.sub?.slug ?? null,
          subcategoryId: s.subcategoryId,
          subcategoryLabel: s.sub?.nameEn ?? null,
          applicationCount: active.get(s.serviceId) ?? 0,
          status: p && !changes ? "published" : "draft",
          serviceStatus: s.status,
          handler: s.handler || "agent",
          version: (d ?? p)?.version ?? 0,
          publishedVersion: p?.version ?? null,
          stepCount: def.steps.length,
          componentCount: def.steps.reduce(
            (n, st) =>
              n +
              (((st.fields ?? st.components) as unknown[] | undefined)
                ?.length ?? 0),
            0,
          ),
          hasUnpublishedChanges: changes,
          updatedAt: [s.updatedAt, d?.updatedAt ?? ""].sort().at(-1)!,
          copyTooLong: copyLimitIssues(def.meta).length > 0,
        };
      }),
  };
}

// ---------------------------------------------------------------- sub-statuses (U17)
type SubStatus = typeof serviceSubStatuses.$inferSelect;
const subStatusOut = (x: SubStatus) => ({
  id: x.id,
  canonical: x.canonical,
  name: x.name,
  clientText: x.clientText,
  clientVisible: x.clientVisible,
  color: x.color,
  order: x.sortOrder,
  // shortcut: usage is 0 until applications carry a sub-status column (P3/P5 case workflow); then count open cases per id.
  usage: 0,
});
export async function listSubStatuses(db: Exec) {
  const rows = await db
    .select()
    .from(serviceSubStatuses)
    .orderBy(
      asc(serviceSubStatuses.canonical),
      asc(serviceSubStatuses.sortOrder),
    );
  return { items: rows.map(subStatusOut) };
}
const nextOrder = async (db: Exec, canonical: string) =>
  (
    await db
      .select({ n: count() })
      .from(serviceSubStatuses)
      .where(eq(serviceSubStatuses.canonical, canonical))
  )[0].n;
export type SubStatusIn = {
  canonical: string;
  name: L3;
  clientText: L3;
  clientVisible: boolean;
  color: string;
};
export async function createSubStatus(db: Exec, b: SubStatusIn) {
  const t = now();
  const [row] = await db
    .insert(serviceSubStatuses)
    .values({
      id: generateId("ss"),
      ...b,
      sortOrder: await nextOrder(db, b.canonical),
      createdAt: t,
      updatedAt: t,
    })
    .returning();
  return subStatusOut(row);
}
export async function updateSubStatus(
  db: Exec,
  id: string,
  b: Partial<SubStatusIn>,
) {
  const [cur] = await db
    .select()
    .from(serviceSubStatuses)
    .where(eq(serviceSubStatuses.id, id))
    .for("update");
  if (!cur) throw err.notFound("Not found");
  const moved = b.canonical && b.canonical !== cur.canonical;
  const [row] = await db
    .update(serviceSubStatuses)
    .set({
      ...b,
      ...(moved && { sortOrder: await nextOrder(db, b.canonical!) }),
      updatedAt: now(),
    })
    .where(eq(serviceSubStatuses.id, id))
    .returning();
  return subStatusOut(row);
}
export async function orderSubStatuses(
  db: Exec,
  canonical: string,
  ids: string[],
) {
  for (const [i, id] of ids.entries())
    await db
      .update(serviceSubStatuses)
      .set({ sortOrder: i, updatedAt: now() })
      .where(
        and(
          eq(serviceSubStatuses.id, id),
          eq(serviceSubStatuses.canonical, canonical),
        ),
      );
  return { ok: true };
}
export async function deleteSubStatus(db: Exec, id: string) {
  const [cur] = await db
    .select()
    .from(serviceSubStatuses)
    .where(eq(serviceSubStatuses.id, id))
    .for("update");
  if (!cur) throw err.notFound("Not found");
  if (subStatusOut(cur).usage)
    throw new AppError(409, "in_use", "Sub-status in use");
  await db.delete(serviceSubStatuses).where(eq(serviceSubStatuses.id, id));
  return { ok: true };
}


// ---------------------------------------------------------------- Nest service
type Audit<T> = (r: T) => Omit<AuditEntry, "entity"> & { entity?: string };

@Injectable()
export class CatalogueService {
  constructor(
    private readonly tx: TxService,
    private readonly audit: AuditService,
    private readonly cache: PublicCache,
    private readonly outbox: OutboxService,
  ) {}

  private read<T>(fn: (t: Tx) => Promise<T>) {
    return this.tx.run(fn);
  }
  /** Write + in-tx audit (last statement), then drop the public catalogue cache once committed. */
  private async write<T>(fn: (t: Tx) => Promise<T>, audit?: Audit<T>) {
    const r = await this.tx.run(async (t) => {
      const out = await fn(t);
      // Tell the web app to drop its `catalogue` cache tag (same signed webhook as CMS publishes).
      await this.outbox.add(t, { type: "cms.revalidate", payload: { tags: ["catalogue"] } });
      if (audit) {
        const a = audit(out);
        await this.audit.record(t, { ...a, entity: a.entity ?? a.action.split(".")[0] });
      }
      return out;
    });
    await this.cache.bust("catalogue");
    return r;
  }

  // public (cached)
  listPublicServices() {
    return this.cache.get("catalogue", "services", () => this.read(listPublicServices));
  }
  /** F-CAT-06: trigram text match (uncached, any query) + facet filters over the cached list. */
  async searchPublicServices(f: SearchIn) {
    const all = (await this.listPublicServices()).services;
    const ids = f.q?.trim() ? await this.read((t) => searchIds(t, f.q!)) : null;
    const rows = ids ? ids.flatMap((id) => all.filter((s) => s.service_id === id)) : all;
    const { results, facets } = facetsOf(rows, f);
    return { services: results, facets };
  }
  getPublicService(slug: string) {
    return this.cache.get("catalogue", `service:${slug}`, () => this.read((t) => getPublicService(t, slug)));
  }
  listPublicCategories() {
    return this.cache.get("catalogue", "categories", () => this.read((t) => listCategories(t, false)));
  }
  listPublicSubcategories() {
    return this.cache.get("catalogue", "subcategories", () => this.read((t) => listSubcategories(t, false)));
  }

  // categories / subcategories
  listCategories() {
    return this.read((t) => listCategories(t, true));
  }
  createCategory(b: Parameters<typeof createCategory>[1]) {
    return this.write((t) => createCategory(t, b), (r) => ({ action: "service_category.created", entityId: r.id, after: r }));
  }
  updateCategory(id: string, b: CategoryIn) {
    return this.write((t) => updateCategory(t, id, b), (r) => ({ action: "service_category.updated", entityId: id, after: r }));
  }
  deleteCategory(id: string) {
    return this.write((t) => deleteCategory(t, id), () => ({ action: "service_category.deleted", entityId: id }));
  }
  listSubcategories(categoryId?: string) {
    return this.read((t) => listSubcategories(t, true, categoryId));
  }
  createSubcategory(b: Parameters<typeof createSubcategory>[1]) {
    return this.write((t) => createSubcategory(t, b), (r) => ({ action: "service_subcategory.created", entityId: r.id, after: r }));
  }
  updateSubcategory(id: string, b: CategoryIn) {
    return this.write((t) => updateSubcategory(t, id, b), (r) => ({ action: "service_subcategory.updated", entityId: id, after: r }));
  }
  deleteSubcategory(id: string) {
    return this.write((t) => deleteSubcategory(t, id), () => ({ action: "service_subcategory.deleted", entityId: id }));
  }

  // services
  listAdminServices() {
    return this.read(listAdminServices);
  }
  structureCatalogue(includeArchived: boolean) {
    return this.read((t) => structureCatalogue(t, includeArchived));
  }
  createService(actorId: string | null, b: CreateServiceIn) {
    return this.write((t) => createService(t, actorId, b), (r) => ({ action: "service.created", entityId: r.service_id, after: r }));
  }
  getAdminService(slug: string) {
    return this.read((t) => getAdminService(t, slug));
  }
  updateService(slug: string, b: UpdateServiceIn) {
    return this.write((t) => updateService(t, slug, b), (r) => ({ action: "service.updated", entityId: r.service_id, after: r }));
  }
  deleteService(slug: string) {
    return this.write((t) => deleteService(t, slug), (r) => ({ action: "service.deleted", entityId: r.service_id, after: r }));
  }
  updateStatus(slug: string, status: string) {
    return this.write((t) => updateStatus(t, slug, status), (r) => ({ action: "service.status_updated", entityId: r.service_id, after: { status } }));
  }
  async updatePricing(slug: string, b: PricingIn) {
    const r = await this.write((t) => updatePricing(t, slug, b), (r) => ({ action: "service.pricing_mode_updated", entityId: r.audit.service_id, after: r.audit }));
    return r.out;
  }
  async updateTier(slug: string, tier: string, b: TierIn) {
    const r = await this.write((t) => updateTier(t, slug, tier, b), (r) => ({ action: "service.pricing_updated", entityId: r.audit.service_id, after: r.audit }));
    return r.out;
  }

  // structure builder (GET draft may open a new draft, so it is a write)
  getDraft(slug: string) {
    return this.write((t) => getDraft(t, slug));
  }
  saveDraft(slug: string, b: Definition) {
    return this.write((t) => saveDraft(t, slug, b));
  }
  async publish(slug: string, reason: string) {
    const r = await this.write((t) => publish(t, slug), (r) => ({ action: "service.structure_published", entityId: r.audit.service_id, after: r.audit, reason }));
    return r.out;
  }
  getPublished(slug: string) {
    return this.read((t) => getPublished(t, slug));
  }
  listVersions(slug: string) {
    return this.read((t) => listVersions(t, slug));
  }
  getVersion(slug: string, v: number) {
    return this.read((t) => getVersion(t, slug, v));
  }
  inFlightCount(slug: string, v: number) {
    return this.read((t) => inFlightCount(t, slug, v));
  }

  // ops sub-statuses
  listSubStatuses() {
    return this.read(listSubStatuses);
  }
  createSubStatus(b: SubStatusIn) {
    return this.write((t) => createSubStatus(t, b), (r) => ({ action: "sub_status.created", entityId: r.id, after: r }));
  }
  updateSubStatus(id: string, b: Partial<SubStatusIn>) {
    return this.write((t) => updateSubStatus(t, id, b), (r) => ({ action: "sub_status.updated", entityId: id, after: r }));
  }
  orderSubStatuses(canonical: string, ids: string[]) {
    return this.write((t) => orderSubStatuses(t, canonical, ids), () => ({ action: "sub_status.reordered", entityId: canonical, after: { ids } }));
  }
  deleteSubStatus(id: string) {
    return this.write((t) => deleteSubStatus(t, id), () => ({ action: "sub_status.deleted", entityId: id }));
  }
}
