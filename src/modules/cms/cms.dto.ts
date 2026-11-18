// Zod schemas moved verbatim from .ref cms.routes.ts.
import { z } from "zod";
import type { Role } from "@/domain/auth/roles";
import { LOCALES, type Locale, type NavNode as NavNodeT } from "@/domain/marketing/types";
import { dto } from "../../core/http/dto";

export const CMS_ROLES: readonly Role[] = ["staff:marketing", "staff:service_manager", "staff:executive"];

export const Lang = z.enum(LOCALES as [Locale, ...Locale[]]);
const Langs = z.array(Lang).max(3).optional();
const Json = z.record(z.string(), z.unknown());
const Type = z.enum(["page", "landing_page", "article", "guide", "regulatory_update", "faq", "team_member", "testimonial", "partner_logo", "legal_doc"]);
const Block = z.object({ id: z.string().min(1).max(96), type: z.string().min(1).max(48), hidden: z.boolean().optional(), props: Json.optional() });
const Seo = z.object({
  title: z.string().max(300),
  description: z.string().max(1000),
  canonical: z.string().max(512).optional(),
  ogTitle: z.string().max(300).optional(),
  ogDescription: z.string().max(1000).optional(),
  ogImageId: z.string().max(96).optional(),
  robots: z.enum(["index", "noindex"]),
  jsonLdType: z.enum(["Article", "FAQPage", "HowTo", "Service", "WebPage"]).optional(),
  focusKeyword: z.string().max(120).optional(),
});
const NavNode: z.ZodType<NavNodeT> = z.lazy(() =>
  z.object({ id: z.string().max(96), href: z.string().max(512), label: z.partialRecord(Lang, z.string().max(120)), children: z.array(NavNode).max(50).optional() }),
);
const Big = <S extends z.ZodType>(s: S) => s.refine((b) => JSON.stringify(b).length <= 1_000_000, "Too large.");
// shortcut: CMS outputs are unvalidated (no `out`) because the documents are typed in @/domain/marketing/types and staff-only; public reads strip drafts in the service. Add zod mirrors when the OpenAPI client types are regenerated.

export class ListQueryDto extends dto(
  z.object({
    type: z.string().max(200).optional(),
    status: z.string().max(32).optional(),
    locale: Lang.optional(),
    owner: z.string().max(64).optional(),
    q: z.string().max(200).optional(),
    page: z.coerce.number().int().min(1).max(10_000).optional(),
  }),
) {}
export class CreateDto extends dto(
  z.object({ type: Type, locale: Lang.optional(), title: z.string().trim().min(1).max(300), slug: z.string().max(160).optional(), key: z.string().max(160).optional() }),
) {}
export class PatchDto extends dto(
  Big(
    z.object({
      blocks: z.array(Block).max(200).optional(),
      meta: Json.optional(),
      serviceSlugs: z.array(z.string().max(128)).max(50).optional(),
      tags: z.array(z.string().max(64)).max(50).optional(),
      aiApproved: z.boolean().optional(),
      reviewBy: z.string().max(40).optional(),
      serviceFacts: z.boolean().optional(),
    }),
  ),
) {}
export class VariantDto extends dto(
  Big(
    z.object({
      slug: z.string().max(160).optional(),
      title: z.string().max(300).optional(),
      excerpt: z.string().max(2000).optional(),
      body: z.record(z.string(), Json).optional(),
      seo: Seo.optional(),
      unpublishAt: z.string().max(40).optional(),
      needsReview: z.boolean().optional(),
      fallbackAllowed: z.boolean().optional(),
    }),
  ),
) {}
export class LockDto extends dto(z.object({ force: z.boolean().optional() })) {}
export class SubmitDto extends dto(z.object({ langs: Langs, reviewerId: z.string().max(64).optional() })) {}
export class LangsDto extends dto(z.object({ langs: Langs })) {}
export class ChangesDto extends dto(z.object({ langs: Langs, comment: z.string().max(5000).optional() })) {}
export class PublishDto extends dto(z.object({ langs: Langs, fallback: z.boolean().optional() })) {}
export class ScheduleDto extends dto(z.object({ langs: Langs, at: z.string().max(40) })) {}
export class ArchiveDto extends dto(z.object({ redirectTo: z.string().max(512).optional() })) {}
export class LangQueryDto extends dto(z.object({ lang: Lang.optional() })) {}
export class CommentDto extends dto(z.object({ body: z.string().trim().min(1).max(5000), blockId: z.string().max(96).optional(), language: Lang.optional() })) {}
export class TranslateDto extends dto(z.object({ from: Lang, to: Lang })) {}
export class ResolveDto extends dto(z.object({ resolved: z.boolean() })) {}
export const ReviewCountOut = z.object({ n: z.number().int() });
export class NavDto extends dto(Big(z.object({ items: z.array(NavNode).max(100) }))) {}
export class SettingsDto extends dto(
  Big(
    z
      .object({
        address: z.string().max(500),
        phone: z.string().max(40),
        email: z.email().max(255),
        whatsapp: z.string().max(40),
        hours: z.partialRecord(Lang, z.string().max(200)),
        social: z.array(z.object({ network: z.string().max(40), url: z.url().max(512) })).max(20),
        announcement: z
          .object({
            text: z.partialRecord(Lang, z.string().max(500)),
            href: z.string().max(512).optional(),
            from: z.string().max(40).optional(),
            to: z.string().max(40).optional(),
            dismissible: z.boolean(),
          })
          .optional(),
      })
      .partial(),
  ),
) {}
export class RedirectDto extends dto(z.object({ from: z.string().max(512), to: z.string().max(512), code: z.union([z.literal(301), z.literal(302)]).optional() })) {}
export class ContactDto extends dto(
  z.object({
    name: z.string().trim().min(1).max(255),
    contact: z.string().trim().min(1).max(255),
    topic: z.string().trim().min(1).max(128),
    message: z.string().trim().min(1).max(5000),
  }),
) {}
export const ContactOut = z.object({ submitted: z.boolean(), reference: z.string() });
export class PreviewQueryDto extends dto(z.object({ token: z.string().min(1).max(2048) })) {}
export class RssQueryDto extends dto(z.object({ locale: Lang.default("en") })) {}
export class NotFoundDto extends dto(z.object({ path: z.string().regex(/^\/(?!\/)/).max(512) })) {}
