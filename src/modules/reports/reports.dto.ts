import { z } from "zod";
import type { Role } from "@/domain/auth/roles";
import { dto } from "../../core/http/dto";

export const FINX: Role[] = ["staff:finance", "staff:executive"];
const RunQ = z.object({
  from: z.string().max(10).optional(),
  to: z.string().max(10).optional(),
  group: z.string().max(24).optional(),
});
export class RunQueryDto extends dto(RunQ) {}
export class DrillQueryDto extends dto(
  RunQ.extend({
    metric: z.string().max(40).optional(),
    row: z.string().max(120).optional(),
  }),
) {}
export class ExportDto extends dto(
  z.object({
    format: z.enum(["csv", "xlsx", "pdf"]),
    filters: z.record(z.string(), z.string().max(200)).default({}),
  }),
) {}
export class ViewDto extends dto(z.object({ name: z.string().trim().min(1).max(60), filters: z.record(z.string(), z.string().max(200)).default({}) })) {}
export class TargetDto extends dto(z.object({ report: z.string().max(64), metric: z.string().max(48), monthly: z.number().int().min(0), direction: z.enum(["up", "down"]) })) {}
/** F-RPT-05: scheduled email report. */
export class SubscriptionDto extends dto(
  z.object({ report: z.string().max(64), format: z.enum(["csv", "xlsx"]), freq: z.enum(["weekly", "monthly"]) }),
) {}
const byStatus = z.array(z.object({ status: z.string(), n: z.number() }));
export const ExecSummaryOut = z.object({
  date: z.string(),
  period: z.object({ from: z.string(), to: z.string() }),
  revenue: z.number(),
  revenueAll: z.number(),
  collections: z.number(),
  receivables: z.number(),
  ageing: z.object({ not_due: z.number(), "0_30": z.number(), "31_60": z.number(), "61_90": z.number(), "90_plus": z.number() }),
  cases: z.object({ total: z.number(), byStatus }),
  slaBreaches: z.number(),
  bookings: z.object({ total: z.number(), byStatus }),
  conversion: z.object({ leads: z.number(), won: z.number(), rate: z.number() }),
  ai: z.object({ usd: z.number(), calls: z.number() }),
}).meta({ id: "ExecSummaryResponse" });
export type ExecSummary = z.infer<typeof ExecSummaryOut>;
