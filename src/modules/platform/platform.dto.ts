// Zod schemas moved verbatim from the reference platform.routes.ts.
import { z } from "zod";
export const PlatformSettingsOut = z.object({
  acceptNewApps: z.boolean(),
  guestApps: z.boolean(),
  dataRetention: z.string(),
  compactTables: z.boolean(),
  enforce2FA: z.boolean(),
  sessionTimeout: z.number().int(),
  ipAllowlist: z.string(),
  maintenanceMode: z.boolean(),
  requireAgentPapers: z.boolean(),
  paymentsEnabled: z.boolean(),
  defaultMonthlyPercent: z.number().int(),
  defaultOneOffPercent: z.number().int(),
  chatRetentionYears: z.number().int(),
}).meta({ id: "PlatformSettingsResponse" });

export const PublicSettingsOut = z.object({
  paymentsEnabled: z.boolean(),
  guestApps: z.boolean(),
  acceptNewApps: z.boolean(),
  maintenanceMode: z.boolean(),
}).meta({ id: "PublicSettingsResponse" });

const State = z.enum(["operational", "degraded", "outage"]);
export const StatusOut = z.object({
  updatedAt: z.string(),
  components: z.array(z.object({
    key: z.string(),
    name: z.string(),
    state: State,
    detail: z.string(),
    uptime: z.number().nullable(),
    days: z.array(State),
    since: z.string().nullable().optional(), // worker: last heartbeat while down
  })),
  incidents: z.array(z.object({ title: z.string(), at: z.string(), state: State, body: z.string() })),
}).meta({ id: "PlatformStatusResponse" });
