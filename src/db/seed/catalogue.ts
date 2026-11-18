// Dev/staging catalogue seed. Categories, subcategories, services, tiers, bands and copy come from the public site's seed
// (web/src/content (copied to ./content)/seed/*.json) so API prices match the site; builder structures and ops sub-statuses come from the
// reference seed. Idempotent: existing rows (by id) are left alone.
import { readFileSync } from "node:fs";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { EMPTY_META } from "@/domain/catalogue/rules";
import type * as schema from "../schema";
import {
  serviceCategories,
  servicePriceBands,
  servicePricingTiers,
  serviceStructureVersions,
  serviceSubcategories,
  services,
  subscriptionPlans,
} from "../schema/schema";
import { serviceSubStatuses } from "../schema/schema-catalogue";

type Db = PgDatabase<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;
type L3 = { rw: string; en: string; fr: string };
const json = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./content/${name}.json`, import.meta.url), "utf8")) as T;

type Ref = {
  id: string; slug: string; name_rw: string; name_en: string; name_fr: string; description?: string | null;
  description_rw?: string | null; description_en?: string | null; description_fr?: string | null;
  icon?: string | null; color?: string | null; sort_order: number; is_active: boolean; category_id?: string;
};
type Site = {
  service_id: string; slug: string; name: string; name_rw: string | null; name_en: string | null; name_fr: string | null;
  category: string; category_id: string | null; category_ref: Ref | null; subcategory_id: string | null; subcategory_ref: Ref | null;
  short_description: string | null; short_description_rw: string | null; short_description_en: string | null; short_description_fr: string | null;
  color: string | null; icon: string | null; status: string; version: number; is_featured: boolean; handler: string;
  pricing_mode: string; range_basis_label: Record<string, string> | null; plan_covered: boolean;
  urgent_surcharge_type: string | null; urgent_surcharge_value: number | null;
  pricing_tiers: { tier: string; label: string; fee: number; governmentFee: number; etaBusinessDays: number; includes: string[]; isAvailable: boolean }[];
  price_bands: { id: string; min_amount_rwf: number; max_amount_rwf: number | null; fee_type: string; fee_rwf: number | null; fee_percent: number | null; min_fee_rwf: number | null; max_fee_rwf: number | null; sort_order: number }[];
};
type Req = { key: string; label: string; is_required: boolean; max_size_mb: number; allowed_mime_types: string[] };
type Details = Record<string, { description?: string | null; description_rw?: string | null; description_en?: string | null; description_fr?: string | null; requirements?: Req[] }>;
type SitePlan = {
  planId: string; name: string; amountRwf: number; isActive: boolean; kind: string; maxApplicationsPerMonth: number | null;
  trialDays: number | null; description: string | null; features: string[]; badge: string | null; sortOrder: number; isPublic: boolean;
};

const l3 = (en: string, rw = en, fr = en): L3 => ({ rw, en, fr });
const AT = "2026-01-10T08:00:00Z";
const refRow = (r: Ref) => ({
  id: r.id, slug: r.slug, nameRw: r.name_rw, nameEn: r.name_en, nameFr: r.name_fr,
  description: r.description ?? null, descriptionRw: r.description_rw ?? null, descriptionEn: r.description_en ?? null,
  descriptionFr: r.description_fr ?? null, icon: r.icon ?? null, color: r.color ?? null, sortOrder: r.sort_order,
  isActive: r.is_active, createdAt: AT, updatedAt: AT,
});
const field = (
  id: string,
  type: string,
  label: L3,
  more: Record<string, unknown> = {},
) => ({
  id,
  type,
  label,
  help: l3(""),
  required: true,
  validation: "none",
  ...more,
});
const doc = (id: string, name: L3, maxMb = 5) => ({
  id,
  name,
  types: ["PDF", "JPG"],
  maxMb,
  expiry: true,
  nameMatch: true,
  perApplicant: false,
  required: true,
});

function definition(
  slug: string,
  name: string,
  cat: string,
  sub: string | null,
  days: number,
  reqs: Req[] = [],
) {
  const company = slug === "company-registration";
  const meta = {
    ...EMPTY_META(
      name,
      `${name}, handled end to end by HEBUZA.`,
      cat,
      sub ?? "",
    ),
    name: company
      ? l3(
          "Company registration (RDB)",
          "Kwandikisha isosiyete (RDB)",
          "Immatriculation d'entreprise (RDB)",
        )
      : l3(name),
  };
  meta.sla.days.standard = days;
  const fields = company
    ? [
        field(
          "company-type",
          "select",
          l3("Company type", "Ubwoko bw'isosiyete", "Type de société"),
          { options: ["Ltd", "Sole proprietor", "Cooperative"] },
        ),
        field(
          "activity",
          "isic",
          l3("Business activity", "Umuco w'ishabikora", "Activité principale"),
        ),
        field(
          "shareholders",
          "group",
          l3("Shareholders", "Abanyamigabane", "Actionnaires"),
          {
            visibleIf: { field: "company-type", equals: "Ltd" },
            totalField: "sh-shares",
            children: [
              field(
                "sh-name",
                "text",
                l3("Full name", "Amazina yombi", "Nom complet"),
              ),
              field(
                "sh-id",
                "id",
                l3("ID number", "Nimero y'indangamuntu", "N° d'identité"),
                { validation: "nid" },
              ),
              field(
                "sh-shares",
                "number",
                l3("Shares (%)", "Imigabane (%)", "Parts (%)"),
                { validation: "percent" },
              ),
            ],
          },
        ),
      ]
    : [
        field(
          "full-name",
          "text",
          l3("Full name", "Amazina yombi", "Nom complet"),
        ),
        field("phone", "phone", l3("Phone", "Telefoni", "Téléphone"), {
          validation: "phone",
        }),
        field("tin", "text", l3("TIN", "TIN", "NIF"), { validation: "tin" }),
      ];
  return {
    steps: [{ id: "form", fields }],
    meta: {
      ...meta,
      documents: company
        ? [
            doc("doc-nid", l3("National ID", "Indangamuntu", "Carte d'identité")),
            doc("doc-address", l3("Proof of address", "Icyemezo cy'aho utuye", "Justificatif de domicile")),
          ]
        : [
            doc("doc-nid", l3("National ID", "Indangamuntu", "Carte d'identité")),
            // Site requirements (service-details.json), English-only labels in the source.
            ...reqs.map((r) => ({
              ...doc(r.key, l3(r.label), r.max_size_mb),
              types: r.allowed_mime_types.map((m) => (m === "application/pdf" ? "PDF" : m.split("/")[1].toUpperCase())),
              required: r.is_required,
            })),
          ],
      checklist: [
        {
          id: "ck-id",
          label: l3("ID provided", "Indangamuntu yatanzwe", "Pièce fournie"),
          source: "doc:doc-nid",
        },
      ],
      deliverables: [
        {
          id: "dl-main",
          name: l3(`${name} result`),
          format: "PDF",
          required: true,
        },
      ],
    },
  };
}

export async function seedCatalogue(db: Db) {
  const site = json<{ data: { services: Site[] } }>("services").data.services;
  const details = json<Details>("service-details");
  const uniq = <T extends { id: string }>(xs: (T | null)[]) => [...new Map(xs.filter((x): x is T => !!x).map((x) => [x.id, x])).values()];
  const cats = uniq(site.map((s) => s.category_ref));
  const subs = uniq(site.map((s) => s.subcategory_ref));
  if (cats.length) await db.insert(serviceCategories).values(cats.map(refRow)).onConflictDoNothing();
  if (subs.length)
    await db.insert(serviceSubcategories).values(subs.map((r) => ({ ...refRow(r), categoryId: r.category_id! }))).onConflictDoNothing();

  for (const s of site) {
    const d = details[s.slug] ?? {};
    const inserted = await db
      .insert(services)
      .values({
        serviceId: s.service_id, slug: s.slug, name: s.name, nameRw: s.name_rw, nameEn: s.name_en ?? s.name, nameFr: s.name_fr,
        category: s.category, categoryId: s.category_id, subcategoryId: s.subcategory_id,
        shortDescription: s.short_description, shortDescriptionRw: s.short_description_rw,
        shortDescriptionEn: s.short_description_en, shortDescriptionFr: s.short_description_fr,
        description: d.description ?? null, descriptionRw: d.description_rw ?? null,
        descriptionEn: d.description_en ?? null, descriptionFr: d.description_fr ?? null,
        color: s.color, icon: s.icon, status: s.status, publishedVersion: s.version || 1, isFeatured: s.is_featured,
        handler: s.handler || "agent", deadlineMode: "none", pricingMode: s.pricing_mode || "fixed",
        rangeBasisLabel: s.range_basis_label, planCovered: s.plan_covered,
        urgentSurchargeType: s.urgent_surcharge_type, urgentSurchargeValue: s.urgent_surcharge_value,
        createdAt: AT, updatedAt: AT,
      })
      .onConflictDoNothing()
      .returning({ id: services.serviceId });
    if (!inserted.length) continue;
    if (s.pricing_tiers.length)
      await db.insert(servicePricingTiers).values(
        s.pricing_tiers.map((t) => ({
          id: `tier-${s.service_id}-${t.tier}`, serviceId: s.service_id, tier: t.tier, displayName: t.label,
          description: `${t.label} processing`, platformFee: t.fee, governmentFee: t.governmentFee,
          etaBusinessDays: t.etaBusinessDays, features: t.includes, isAvailable: t.isAvailable,
        })),
      );
    if (s.price_bands.length)
      await db.insert(servicePriceBands).values(
        s.price_bands.map((b) => ({
          id: b.id, serviceId: s.service_id, minAmountRwf: b.min_amount_rwf, maxAmountRwf: b.max_amount_rwf, feeType: b.fee_type,
          feeRwf: b.fee_rwf, feePercent: b.fee_percent == null ? null : String(b.fee_percent), minFeeRwf: b.min_fee_rwf,
          maxFeeRwf: b.max_fee_rwf, sortOrder: b.sort_order,
        })),
      );
    const days = s.pricing_tiers.find((t) => t.tier === "standard")?.etaBusinessDays ?? 5;
    const def = definition(s.slug, s.name, s.category_id ?? "", s.subcategory_id, days, d.requirements);
    const v = s.version || 1;
    await db.insert(serviceStructureVersions).values({
      id: `str-${s.service_id}-${v}`, serviceId: s.service_id, version: v, status: "published", definition: def,
      publishedAt: AT, createdAt: AT, updatedAt: AT,
    });
  }

  const ss = (
    id: string,
    canonical: string,
    en: string,
    rw: string,
    fr: string,
    color: string,
    sortOrder: number,
    clientVisible = true,
  ) => ({
    id,
    canonical,
    name: l3(en, rw, fr),
    clientText: l3(en, rw, fr),
    clientVisible,
    color,
    sortOrder,
    createdAt: AT,
    updatedAt: AT,
  });
  await db
    .insert(serviceSubStatuses)
    .values([
      ss(
        "ss-more-info",
        "awaiting_client_documents",
        "Pending more information",
        "Hategerejwe andi makuru",
        "En attente d'informations",
        "yellow",
        0,
      ),
      ss(
        "ss-notary",
        "awaiting_client_documents",
        "Awaiting notary signature",
        "Gutegereza umukono wa noteri",
        "En attente de la signature du notaire",
        "lavender",
        1,
      ),
      ss(
        "ss-client-review",
        "awaiting_quotation",
        "Under review by client",
        "Umukiriya arimo kubisuzuma",
        "En cours d'examen par le client",
        "lavender",
        0,
      ),
      ss(
        "ss-name",
        "awaiting_external_institution",
        "Awaiting name reservation",
        "Gutegereza kubika izina",
        "En attente de réservation du nom",
        "lavender",
        0,
      ),
      ss(
        "ss-rra",
        "awaiting_external_institution",
        "Awaiting RRA response",
        "Gutegereza igisubizo cya RRA",
        "En attente de la réponse de la RRA",
        "lavender",
        1,
      ),
      ss(
        "ss-call",
        "on_hold",
        "Waiting for client call",
        "Gutegereza guhamagarwa n'umukiriya",
        "En attente d'un appel du client",
        "grey",
        0,
        false,
      ),
      ss(
        "ss-scope",
        "rejected",
        "Out of scope",
        "Ntibiri mu byo dukora",
        "Hors du périmètre",
        "red",
        0,
      ),
    ])
    .onConflictDoNothing();
}

/** Public plans from the site seed (plans.json) plus the signup trial (reference seedSubscriptions). */
export async function seedPlans(db: Db) {
  const now = new Date().toISOString();
  const src = json<{ data: { plans: SitePlan[] } }>("plans").data.plans;
  await db
    .insert(subscriptionPlans)
    .values([
      ...src.map((p) => ({
        planId: p.planId, name: p.name, interval: "month", amountRwf: p.amountRwf, isActive: p.isActive, kind: p.kind,
        maxApplicationsPerMonth: p.maxApplicationsPerMonth, trialDays: p.trialDays, description: p.description,
        features: p.features, badge: p.badge, sortOrder: p.sortOrder, isPublic: p.isPublic, createdAt: now, updatedAt: now,
      })),
      {
        planId: "pln_trial_default", name: "Free trial", interval: "month", amountRwf: 0, isActive: true, kind: "trial",
        maxApplicationsPerMonth: 1,
        trialDays: 30, // PLACEHOLDER(trial-days), PLACEHOLDER(trial-cap)
        description: "Every new client starts here.", features: [], badge: null, sortOrder: 0, isPublic: false,
        createdAt: now, updatedAt: now,
      },
    ])
    .onConflictDoNothing();
}
