// Zod schemas moved verbatim from the reference catalogue.routes.ts (out schemas are the field-level filter).
import { z } from "zod";
import { dto } from "../../core/http/dto";
import type { Role } from "@/domain/auth/roles";
export const SM: Role[] = ["staff:service_manager"];
export const CATALOGUE_ADMIN: Role[] = ["staff:service_manager", "staff:sysadmin"];
/** Who may open /ops/catalogue read-only (cat.draft.read + editors). */
export const READERS: Role[] = [
  "staff:service_manager",
  "staff:marketing",
  "staff:finance",
  "staff:executive",
  "staff:sysadmin",
];
export const EDITORS: Role[] = ["staff:service_manager", "staff:marketing"];
export const PRICERS: Role[] = ["staff:service_manager", "staff:finance"];
const n = z.number().nullable().optional();
const s = z.string().nullable().optional();
const L3 = z.object({
  rw: z.string().max(2000),
  en: z.string().max(2000),
  fr: z.string().max(2000),
});
const COLOR = z.enum(["marigold", "pink", "green", "blue", "red", "cream"]);
const Slug = z
  .string()
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    "Use lowercase letters, numbers and dashes.",
  )
  .max(128);

const SeoL = z.object({
  title: z.string().max(70).optional(),
  description: z.string().max(170).optional(),
  og_image: z.string().max(500).optional(),
});
export const CategoryOut = z
  .object({
    id: z.string(),
    slug: z.string(),
    name_rw: z.string(),
    name_en: z.string(),
    name_fr: z.string(),
    description: s,
    description_rw: s,
    description_en: s,
    description_fr: s,
    icon: s,
    color: s,
    sort_order: z.number(),
    is_active: z.boolean(),
    service_count: n,
    subcategory_count: n,
  })
  .meta({ id: "ServiceCategoryResponse" });
export const SubcategoryOut = z
  .object({
    id: z.string(),
    category_id: z.string(),
    slug: z.string(),
    name_rw: z.string(),
    name_en: z.string(),
    name_fr: z.string(),
    description: s,
    description_rw: s,
    description_en: s,
    description_fr: s,
    icon: s,
    color: s,
    sort_order: z.number(),
    is_active: z.boolean(),
    service_count: n,
  })
  .meta({ id: "ServiceSubcategoryResponse" });
const TierOut = z
  .object({
    tier: z.string(),
    label: z.string(),
    fee: z.number().int(),
    governmentFee: z.number().int(),
    eta: z.string(),
    etaBusinessDays: z.number().int(),
    includes: z.array(z.string()),
    isAvailable: z.boolean(),
  })
  .meta({ id: "PricingTierResponse" });
const BandOut = z
  .object({
    id: z.string(),
    min_amount_rwf: z.number().int(),
    max_amount_rwf: n,
    fee_type: z.string(),
    fee_rwf: n,
    fee_percent: n,
    min_fee_rwf: n,
    max_fee_rwf: n,
    sort_order: z.number().int(),
  })
  .meta({ id: "PriceBandResponse" });
const summaryShape = {
  service_id: z.string(),
  slug: z.string(),
  name: z.string(),
  name_rw: s,
  name_en: s,
  name_fr: s,
  category: z.string(),
  category_id: s,
  category_ref: CategoryOut.nullable(),
  subcategory: s,
  subcategory_id: s,
  subcategory_ref: SubcategoryOut.nullable(),
  short_description: s,
  short_description_rw: s,
  short_description_en: s,
  short_description_fr: s,
  color: s,
  icon: s,
  status: z.string(),
  version: z.number().int(),
  is_featured: z.boolean(),
  handler: z.string(),
  pricing_tiers: z.array(TierOut),
  volume30d: z.number().int(),
  pricing_mode: z.string(),
  range_basis_label: z.record(z.string(), z.string()).nullable(),
  plan_covered: z.boolean(),
  urgent_surcharge_type: s,
  urgent_surcharge_value: n,
  price_bands: z.array(BandOut),
  from_fee: n,
  copy_too_long: z.boolean(),
  engagement_type: z.string(),
  eligibility: z.array(L3),
  deliverables: z.array(L3),
  turnaround_days_min: n,
  turnaround_days_max: n,
  delivery_mode: s,
  seo: z.record(z.string(), z.object({ title: z.string().optional(), description: z.string().optional(), og_image: z.string().optional() })),
  related_slugs: z.array(z.string()),
  locale_slugs: z.record(z.string(), z.string()),
  updated_at: z.string(),
  revenue_agent_bps: n,
  fee_explainer: L3.nullable(),
  markets: z.array(z.string()),
};
export const ServiceSummaryOut = z
  .object(summaryShape)
  .meta({ id: "ServiceSummaryResponse" });
export const ServiceDetailOut = z
  .object({
    ...summaryShape,
    description: s,
    description_rw: s,
    description_en: s,
    description_fr: s,
    created_at: z.string(),
    updated_at: z.string(),
    steps: z.array(z.unknown()),
    requirements: z.array(z.unknown()),
    structure: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .meta({ id: "ServiceDetailResponse" });
const Counts = z.record(z.string(), z.number().int());
export const ServiceListOut = z
  .object({
    services: z.array(ServiceSummaryOut),
    facets: z.object({ category: Counts, engagement_type: Counts, delivery_mode: Counts, price: Counts, turnaround: Counts }).optional(),
  })
  .meta({ id: "ServiceListResponse" });
export const StructureOut = z
  .object({
    serviceSlug: z.string(),
    version: z.number().int(),
    status: z.string(),
    publishedVersion: n,
    updatedAt: z.string(),
    steps: z.array(z.record(z.string(), z.unknown())),
    meta: z.record(z.string(), z.unknown()),
  })
  .meta({ id: "ServiceStructureResponse" });
export const StructureRowOut = z
  .object({
    slug: z.string(),
    name: z.string(),
    category: z.string(),
    categoryId: s,
    subcategory: s,
    subcategoryId: s,
    subcategoryLabel: s,
    applicationCount: z.number().int(),
    status: z.string(),
    serviceStatus: z.string(),
    handler: z.string(),
    version: z.number().int(),
    publishedVersion: n,
    stepCount: z.number().int(),
    componentCount: z.number().int(),
    hasUnpublishedChanges: z.boolean(),
    updatedAt: z.string(),
    copyTooLong: z.boolean(),
  })
  .meta({ id: "StructureCatalogueRowResponse" });
export const VersionOut = z
  .object({
    version: z.number().int(),
    status: z.string(),
    publishedAt: s,
    updatedAt: z.string(),
  })
  .meta({ id: "StructureVersionSummaryResponse" });
export const Deleted = z.object({ id: z.string(), status: z.string() });
export const SubStatusOut = z
  .object({
    id: z.string(),
    canonical: z.string(),
    name: L3,
    clientText: L3,
    clientVisible: z.boolean(),
    color: z.string(),
    order: z.number().int(),
    usage: z.number().int(),
  })
  .meta({ id: "SubStatusResponse" });

const CategoryBody = {
  name_rw: z.string().trim().min(1).max(128),
  name_en: z.string().trim().min(1).max(128),
  name_fr: z.string().trim().min(1).max(128),
  description: s,
  description_rw: s,
  description_en: s,
  description_fr: s,
  is_active: z.boolean(),
  slug: Slug.max(64).nullable().optional(),
  icon: z.string().max(64).nullable().optional(),
  color: COLOR.nullable().optional(),
  sort_order: z.number().int().min(0).nullable().optional(),
};
export const CategoryIn = z.object(CategoryBody);
export const CategoryPatch = z
  .object(CategoryBody)
  .partial()
  .extend({
    name_rw: s,
    name_en: s,
    name_fr: s,
    is_active: z.boolean().nullable().optional(),
  });
export const SubcategoryIn = CategoryIn.extend({
  category_id: z.string().min(1).max(64),
});
export const SubcategoryPatch = CategoryPatch.extend({ category_id: s });
export const CreateServiceIn = z.object({
  name: z.string().trim().min(1).max(255),
  slug: Slug,
  category: z.string().min(1).max(64),
  subcategory: s,
  short_description: z.string().max(2000).nullable().optional(),
  description: z.string().max(10_000).nullable().optional(),
  color: s,
  icon: s,
  is_featured: z.boolean().default(false),
  handler: s,
  step2_title: s,
  step2_lede: s,
});
export const UpdateServiceIn = CreateServiceIn.omit({ slug: true, is_featured: true })
  .partial()
  .extend({
    name: z.string().trim().min(1).max(255).nullable().optional(),
    category: s,
    is_featured: z.boolean().nullable().optional(),
    engagement_type: z.enum(["application", "consultation"]).nullable().optional(),
    eligibility: z.array(L3).max(20).nullable().optional(),
    deliverables: z.array(L3).max(20).nullable().optional(),
    turnaround_days_min: z.number().int().min(0).max(365).nullable().optional(),
    turnaround_days_max: z.number().int().min(0).max(365).nullable().optional(),
    delivery_mode: z.enum(["online", "in_person", "hybrid"]).nullable().optional(),
    seo: z.partialRecord(z.enum(["rw", "en", "fr"]), SeoL).nullable().optional(),
    related_slugs: z.array(Slug).max(6).nullable().optional(),
    locale_slugs: z.partialRecord(z.enum(["rw", "en", "fr"]), Slug).nullable().optional(),
    revenue_agent_bps: z.number().int().min(0).max(10_000).nullable().optional(),
    fee_explainer: L3.nullable().optional(),
    markets: z.array(z.string().regex(/^[A-Za-z]{2}$/)).min(1).max(20).nullable().optional(),
  });
export const SearchQuery = z.object({
  q: z.string().max(100).optional(),
  category: z.string().max(64).optional(),
  max_price: z.coerce.number().int().min(0).optional(),
  max_days: z.coerce.number().int().min(0).max(365).optional(),
  engagement: z.enum(["application", "consultation"]).optional(),
  mode: z.enum(["online", "in_person", "hybrid"]).optional(),
});
export class SearchQueryDto extends dto(SearchQuery) {}
const Rwf = z.number().int().min(0).max(1_000_000_000_000);
const BandIn = z.object({
  min_amount_rwf: Rwf,
  max_amount_rwf: Rwf.nullable().optional(),
  fee_type: z.enum(["flat", "percent"]),
  fee_rwf: Rwf.nullable().optional(),
  fee_percent: z.number().min(0).max(100).nullable().optional(),
  min_fee_rwf: Rwf.nullable().optional(),
  max_fee_rwf: Rwf.nullable().optional(),
});
export const PricingIn = z.object({
  pricing_mode: z.enum(["fixed", "range", "quote"]),
  range_basis_label: z
    .record(z.string(), z.string().max(200))
    .nullable()
    .optional(),
  plan_covered: z.boolean().nullable().optional(),
  urgent_surcharge_type: z.enum(["flat", "percent"]).nullable().optional(),
  urgent_surcharge_value: z
    .number()
    .int()
    .min(0)
    .max(100_000_000)
    .nullable()
    .optional(),
  bands: z.array(BandIn).max(50).default([]),
  effective_at: z.iso.datetime({ offset: true }).optional(), // F-CAT-10: applies on approval, not before this
});
export const TierIn = z.object({
  display_name: z.string().max(128).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  platform_fee: Rwf.nullable().optional(),
  government_fee: Rwf.nullable().optional(),
  eta_business_days: z.number().int().min(0).max(365).nullable().optional(),
  features: z.array(z.string().max(200)).max(20).nullable().optional(),
  is_available: z.boolean().nullable().optional(),
  effective_at: z.iso.datetime({ offset: true }).optional(),
});
export const PriceChangeOut = z.object({
  id: z.string(), slug: z.string(), kind: z.string(), tier: z.string().nullable(), body: z.record(z.string(), z.unknown()),
  effective_at: z.string(), status: z.string(), proposed_by: z.string(), proposed_by_name: z.string().nullable(),
  decided_by: z.string().nullable(), decided_at: z.string().nullable(), reason: z.string().nullable(), created_at: z.string(),
}).meta({ id: "PriceChangeResponse" });
export const PriceChangeListOut = z.object({ items: z.array(PriceChangeOut) });
export const PriceDecisionIn = z.object({ approve: z.boolean(), reason: z.string().trim().max(500).optional() });
export class PriceDecisionDto extends dto(PriceDecisionIn) {}
export const FINANCE_APPROVERS: Role[] = ["staff:finance"];
// The builder model (src/lib/ops/e.ts toBody): one step of fields + a meta object. Capped so a draft can't balloon.
export const StructureIn = z
  .object({
    steps: z.array(z.record(z.string(), z.unknown())).max(20),
    meta: z.record(z.string(), z.unknown()),
  })
  .refine(
    (b) => JSON.stringify(b).length <= 512_000,
    "The structure is too large.",
  );
export const SubStatusIn = z.object({
  canonical: z.string().min(1).max(48),
  name: L3.refine(
    (x) => x.rw.trim() && x.en.trim() && x.fr.trim(),
    "Name required in all languages",
  ),
  clientText: L3,
  clientVisible: z.boolean(),
  color: z.string().min(1).max(16),
});
export class CategoryDto extends dto(CategoryIn) {}
export class CategoryPatchDto extends dto(CategoryPatch) {}
export class SubcategoryDto extends dto(SubcategoryIn) {}
export class SubcategoryPatchDto extends dto(SubcategoryPatch) {}
export class CreateServiceDto extends dto(CreateServiceIn) {}
export class UpdateServiceDto extends dto(UpdateServiceIn) {}
export class StatusDto extends dto(z.object({ status: z.string().max(32) })) {}
export class PricingDto extends dto(PricingIn) {}
export class TierDto extends dto(TierIn) {}
export class StructureDto extends dto(StructureIn) {}
export class SubStatusDto extends dto(SubStatusIn) {}
export class SubStatusPatchDto extends dto(SubStatusIn.partial()) {}
export class SubStatusOrderDto extends dto(
  z.object({ canonical: z.string().max(48), ids: z.array(z.string().max(64)).max(100) }),
) {}
export class SubcategoryQueryDto extends dto(z.object({ category_id: z.string().max(64).optional() })) {}
export class StructuresQueryDto extends dto(z.object({ include_archived: z.enum(["true", "false"]).optional() })) {}
export const CategoryListOut = z.object({ categories: z.array(CategoryOut) });
export const SubcategoryListOut = z.object({ subcategories: z.array(SubcategoryOut) });
export const CreatedServiceOut = z.object({ service_id: z.string(), slug: z.string(), status: z.string() });
export const DeletedServiceOut = z.object({ slug: z.string(), service_id: z.string(), status: z.string() });
export const StructureListOut = z.object({ structures: z.array(StructureRowOut) });
export const VersionListOut = z.object({ versions: z.array(VersionOut) });
export const CountOut = z.object({ count: z.number().int() });
export const SubStatusListOut = z.object({ items: z.array(SubStatusOut) });
export const OkOut = z.object({ ok: z.boolean() });
/** Path version: non-negative integer. */
export const Ver = z.coerce.number().int().min(0);
export const PublicFormOut = z.object({ serviceSlug: z.string(), version: z.number().int().nullable(), fields: z.array(z.record(z.string(), z.unknown())) }).meta({ id: "PublicServiceForm" });
