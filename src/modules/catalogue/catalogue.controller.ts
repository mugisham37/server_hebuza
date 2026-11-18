import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { CurrentUser } from "../../core/auth/decorators";
import type { SessionUser } from "../../core/http/context";
import { invalid } from "../../core/http/errors";
import { Route } from "../../core/http/route";
import * as D from "./catalogue.dto";
import { CatalogueService } from "./catalogue.service";

const AGENT_READERS = ["staff:service_manager", "staff:sysadmin", "staff:executive", "staff:agent"] as const;
const ver = (v: string) => {
  const r = D.Ver.safeParse(v);
  if (!r.success) throw invalid({ v: "Version must be a non-negative integer." });
  return r.data;
};

@Controller()
export class CatalogueController {
  constructor(private readonly svc: CatalogueService) {}

  // ---- public catalogue
  @Get("services")
  @Route({ auth: "public", limit: "read", out: D.ServiceListOut })
  listPublic() {
    return this.svc.listPublicServices();
  }
  @Get("services/:slug")
  @Route({ auth: "public", limit: "read", out: D.ServiceDetailOut })
  getPublic(@Param("slug") slug: string) {
    return this.svc.getPublicService(slug);
  }
  @Get("service-categories")
  @Route({ auth: "public", limit: "read", out: D.CategoryListOut })
  publicCategories() {
    return this.svc.listPublicCategories();
  }
  @Get("service-subcategories")
  @Route({ auth: "public", limit: "read", out: D.SubcategoryListOut })
  publicSubcategories() {
    return this.svc.listPublicSubcategories();
  }

  // ---- categories / subcategories
  @Get("admin/service-categories")
  @Route({ auth: D.READERS, out: D.CategoryListOut })
  categories() {
    return this.svc.listCategories();
  }
  @Post("admin/service-categories")
  @Route({ auth: D.CATALOGUE_ADMIN, out: D.CategoryOut })
  createCategory(@Body() b: D.CategoryDto) {
    return this.svc.createCategory(b);
  }
  @Patch("admin/service-categories/:id")
  @Route({ auth: D.CATALOGUE_ADMIN, out: D.CategoryOut })
  updateCategory(@Param("id") id: string, @Body() b: D.CategoryPatchDto) {
    return this.svc.updateCategory(id, b);
  }
  @Delete("admin/service-categories/:id")
  @Route({ auth: D.CATALOGUE_ADMIN, out: D.Deleted })
  deleteCategory(@Param("id") id: string) {
    return this.svc.deleteCategory(id);
  }
  @Get("admin/service-subcategories")
  @Route({ auth: D.READERS, out: D.SubcategoryListOut })
  subcategories(@Query() q: D.SubcategoryQueryDto) {
    return this.svc.listSubcategories(q.category_id);
  }
  @Post("admin/service-subcategories")
  @Route({ auth: D.CATALOGUE_ADMIN, out: D.SubcategoryOut })
  createSubcategory(@Body() b: D.SubcategoryDto) {
    return this.svc.createSubcategory(b);
  }
  @Patch("admin/service-subcategories/:id")
  @Route({ auth: D.CATALOGUE_ADMIN, out: D.SubcategoryOut })
  updateSubcategory(@Param("id") id: string, @Body() b: D.SubcategoryPatchDto) {
    return this.svc.updateSubcategory(id, b);
  }
  @Delete("admin/service-subcategories/:id")
  @Route({ auth: D.CATALOGUE_ADMIN, out: D.Deleted })
  deleteSubcategory(@Param("id") id: string) {
    return this.svc.deleteSubcategory(id);
  }

  // ---- services (static paths before :slug)
  @Get("admin/services")
  @Route({ auth: D.READERS, out: D.ServiceListOut })
  services() {
    return this.svc.listAdminServices();
  }
  @Get("admin/services/catalogue/structures")
  @Route({ auth: D.READERS, out: D.StructureListOut })
  structures(@Query() q: D.StructuresQueryDto) {
    return this.svc.structureCatalogue(q.include_archived === "true");
  }
  @Post("admin/services")
  @Route({ auth: D.SM, permission: "cat.draft.edit", idempotent: true, out: D.CreatedServiceOut })
  createService(@Body() b: D.CreateServiceDto, @CurrentUser() me: SessionUser | null) {
    return this.svc.createService(me?.id ?? null, b);
  }
  @Get("admin/services/:slug")
  @Route({ auth: D.READERS, out: D.ServiceDetailOut })
  service(@Param("slug") slug: string) {
    return this.svc.getAdminService(slug);
  }
  @Patch("admin/services/:slug")
  @Route({ auth: D.EDITORS, permission: "cat.draft.edit", out: D.ServiceDetailOut })
  updateService(@Param("slug") slug: string, @Body() b: D.UpdateServiceDto) {
    return this.svc.updateService(slug, b);
  }
  @Delete("admin/services/:slug")
  @Route({ auth: D.SM, out: D.DeletedServiceOut })
  deleteService(@Param("slug") slug: string) {
    return this.svc.deleteService(slug);
  }
  @Patch("admin/services/:slug/status")
  @Route({ auth: D.SM, permission: "cat.draft.publish", out: D.ServiceDetailOut })
  status(@Param("slug") slug: string, @Body() b: D.StatusDto) {
    return this.svc.updateStatus(slug, b.status);
  }
  @Put("admin/services/:slug/pricing")
  @Route({ auth: D.PRICERS, permission: "cat.price.edit", out: D.ServiceDetailOut })
  pricing(@Param("slug") slug: string, @Body() b: D.PricingDto) {
    return this.svc.updatePricing(slug, b);
  }
  @Patch("admin/services/:slug/pricing/:tier")
  @Route({ auth: D.PRICERS, permission: "cat.price.edit", out: D.ServiceDetailOut })
  tier(@Param("slug") slug: string, @Param("tier") tier: string, @Body() b: D.TierDto) {
    return this.svc.updateTier(slug, tier, b);
  }

  // ---- structure builder
  @Get("admin/services/:slug/structure/draft")
  @Route({ auth: D.READERS, out: D.StructureOut })
  draft(@Param("slug") slug: string) {
    return this.svc.getDraft(slug);
  }
  @Put("admin/services/:slug/structure/draft")
  @Route({ auth: D.EDITORS, permission: "cat.draft.edit", out: D.StructureOut })
  saveDraft(@Param("slug") slug: string, @Body() b: D.StructureDto) {
    return this.svc.saveDraft(slug, b);
  }
  @Post("admin/services/:slug/structure/publish")
  @Route({ auth: D.SM, permission: "cat.draft.publish", stepUp: true, idempotent: true, out: D.StructureOut })
  publish(@Param("slug") slug: string, @Headers("x-audit-reason") reason?: string) {
    return this.svc.publish(slug, safeDecode(reason ?? "").slice(0, 500));
  }
  @Get("admin/services/:slug/structure/published")
  @Route({ auth: D.READERS, out: D.StructureOut })
  published(@Param("slug") slug: string) {
    return this.svc.getPublished(slug);
  }
  @Get("admin/services/:slug/structure/versions")
  @Route({ auth: D.READERS, out: D.VersionListOut })
  versions(@Param("slug") slug: string) {
    return this.svc.listVersions(slug);
  }
  @Get("admin/services/:slug/structure/versions/:v")
  @Route({ auth: D.READERS, out: D.StructureOut })
  version(@Param("slug") slug: string, @Param("v") v: string) {
    return this.svc.getVersion(slug, ver(v));
  }
  @Get("admin/services/:slug/structure/versions/:v/in-flight-count")
  @Route({ auth: D.READERS, out: D.CountOut })
  inFlight(@Param("slug") slug: string, @Param("v") v: string) {
    return this.svc.inFlightCount(slug, ver(v));
  }

  // ---- ops sub-statuses (static "order" before :id)
  @Get("admin/ops/sub-statuses")
  @Route({ auth: AGENT_READERS, out: D.SubStatusListOut })
  subStatuses() {
    return this.svc.listSubStatuses();
  }
  @Post("admin/ops/sub-statuses")
  @Route({ auth: D.CATALOGUE_ADMIN, permission: "req.substatus.configure", out: D.SubStatusOut })
  createSubStatus(@Body() b: D.SubStatusDto) {
    return this.svc.createSubStatus(b);
  }
  @Post("admin/ops/sub-statuses/order")
  @Route({ auth: D.CATALOGUE_ADMIN, permission: "req.substatus.configure", out: D.OkOut })
  orderSubStatuses(@Body() b: D.SubStatusOrderDto) {
    return this.svc.orderSubStatuses(b.canonical, b.ids);
  }
  @Patch("admin/ops/sub-statuses/:id")
  @Route({ auth: D.CATALOGUE_ADMIN, permission: "req.substatus.configure", out: D.SubStatusOut })
  updateSubStatus(@Param("id") id: string, @Body() b: D.SubStatusPatchDto) {
    return this.svc.updateSubStatus(id, b);
  }
  @Delete("admin/ops/sub-statuses/:id")
  @Route({ auth: D.CATALOGUE_ADMIN, permission: "req.substatus.configure", out: D.OkOut })
  deleteSubStatus(@Param("id") id: string) {
    return this.svc.deleteSubStatus(id);
  }
}

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
