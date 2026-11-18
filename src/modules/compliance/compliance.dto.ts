import { z } from "zod";
import { dto } from "../../core/http/dto";
import { AUTHORITIES } from "@/domain/ops/rules";

const L3 = z.object({
  rw: z.string().max(200),
  en: z.string().max(200),
  fr: z.string().max(200),
});
const Rec = z.union([
  z.object({ kind: z.literal("monthly"), day: z.number().int() }),
  z.object({ kind: z.literal("quarterly"), day: z.number().int() }),
  z.object({
    kind: z.literal("annual"),
    month: z.number().int(),
    day: z.number().int(),
  }),
  z.object({
    kind: z.literal("dates"),
    dates: z.array(z.string().max(5)).max(24),
  }),
]);
export const RuleIn = z.object({
  code: z.string().max(40),
  authority: z.enum(AUTHORITIES),
  label: L3,
  recurrence: Rec,
  dueRule: z.enum(["fixed", "next_business_day"]),
  leadDays: z.number().int(),
  remindOffsets: z.array(z.number().int()).max(10),
  serviceSlug: z.string().max(128).nullable(),
  active: z.boolean(),
});
export const RulePatch = RuleIn.partial();
export type RulePatch = z.infer<typeof RulePatch>;
export class RuleDto extends dto(RuleIn) {}
export class RulePatchDto extends dto(RulePatch) {}

export const RuleOut = z.object({
  id: z.string(),
  code: z.string(),
  authority: z.string(),
  label: L3,
  recurrence: z.unknown(),
  dueRule: z.string(),
  leadDays: z.number(),
  remindOffsets: z.array(z.number()),
  serviceSlug: z.string().nullable(),
  active: z.boolean(),
  verified: z.boolean(),
  nextDates: z.array(z.string()),
  updatedAt: z.string(),
});
export const RulesOut = z.object({ items: z.array(RuleOut) });
export const HolidaysOut = z.object({
  holidays: z.array(z.object({ day: z.string(), name: z.string() })),
});
