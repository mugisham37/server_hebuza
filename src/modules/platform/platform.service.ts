// Port of the reference platform.service.ts (read side). Settings writes live in the system module (system.config
// writeThrough busts PublicCache "platform" after commit).
import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { platformSettings } from "@/db/schema";
import type { Tx } from "../../core/db/db";
import { TxService } from "../../core/db/tx";
import { PublicCache } from "../catalogue/cache";

export const PLATFORM_SETTINGS_ID = "global";

// Python model defaults (models.py) — the table has no DB-side defaults.
const DEFAULTS = {
  acceptNewApps: true, guestApps: true,
  sessionTimeoutMinutes: 60, maintenanceMode: false, requireAgentPapers: false, paymentsEnabled: false,
  defaultMonthlyPercent: 30, defaultOneOffPercent: 30,
};

type Row = typeof platformSettings.$inferSelect;

const project = (r: Row) => ({
  acceptNewApps: r.acceptNewApps,
  guestApps: r.guestApps,
  sessionTimeout: r.sessionTimeoutMinutes,
  ipAllowlist: r.ipAllowlist ?? "",
  maintenanceMode: r.maintenanceMode,
  requireAgentPapers: r.requireAgentPapers,
  paymentsEnabled: r.paymentsEnabled,
  defaultMonthlyPercent: r.defaultMonthlyPercent,
  defaultOneOffPercent: r.defaultOneOffPercent,
  // shortcut: schema has no chat_retention_years column, so the Python default is returned; read it once the column exists.
  chatRetentionYears: 7,
});

const read = (db: Tx) => db.select().from(platformSettings).where(eq(platformSettings.id, PLATFORM_SETTINGS_ID)).then((r) => r[0]);

@Injectable()
export class PlatformService {
  constructor(private readonly tx: TxService, private readonly cache: PublicCache) {}

  /** Admin view; creates the singleton row with defaults on first read, like Python _ensure_settings. */
  getSettings() {
    return this.tx.run(async (db) => {
      let row = await read(db);
      if (!row) {
        await db.insert(platformSettings).values({ id: PLATFORM_SETTINGS_ID, ...DEFAULTS, updatedAt: new Date().toISOString() }).onConflictDoNothing();
        row = (await read(db))!;
      }
      return project(row);
    });
  }

  /** Public, read-only: a missing row means every default applies. */
  getPublicSettings() {
    return this.cache.get("platform", "public", () =>
      this.tx.run(async (db) => {
        const r = await read(db);
        return {
          paymentsEnabled: r?.paymentsEnabled ?? false,
          guestApps: r?.guestApps ?? true,
          acceptNewApps: r?.acceptNewApps ?? true,
          maintenanceMode: r?.maintenanceMode ?? false,
        };
      }),
    );
  }
}
