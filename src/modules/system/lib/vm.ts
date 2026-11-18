// View-model types copied from web/src/lib/system/{a,c,d,f}.ts (type-only parts; the rest are React hooks).
import type { Role } from "@/domain/auth/roles";
import type { Scope } from "@/domain/auth/permissions";
import type { AuditCategory, AuditEntryVM, BackupVM, BreakGlassVM, BudgetVM, ChangeRequestVM, ComponentHealthVM, DrillVM, DsrVM, IntegrationVM, Iso, PersonRef, ReviewCampaignVM, SettingValueVM, SodPair, SodWaiverVM } from "@/domain/system/types";
export type Card<T> = { ok: true; data: T; at: Iso } | { ok: false; data: T | null; at: Iso | null };
export type RecentChange = { id: string; at: Iso; actorLabel: string; action: string; category: AuditCategory; resourceType: string; resourceId: string };
export type OverviewVM = {
  health: Card<ComponentHealthVM[]>;
  users: Card<{ active: number; invited: number; locked: number }>;
  posture: Card<{ enrolled: number; total: number; pendingFirst: number; withoutKey: number; ipAllowlist: boolean }>;
  backup: Card<{ lastAt: Iso | null; ok: boolean; nextAt: Iso | null; drillAt: Iso | null }>;
  integrations: Card<{ ok: number; degraded: number; untested: number; notSetUp: number }>;
  budgets: Card<BudgetVM[]>;
  review: Card<(Pick<ReviewCampaignVM, "id" | "name" | "status" | "dueAt"> & { decided: number; total: number }) | null>;
  recent: Card<RecentChange[]>;
};

export type RoleRowVM = {
  slug: string; role: string; name: string; builtin: boolean; privileged: boolean; members: number;
  lastChangedAt: Iso | null; status: "active" | "retired"; pending: boolean;
  description?: string; base?: string; perms?: Record<string, Scope>; version: number;
};
export type RoleDetailVM = RoleRowVM & { memberList: { id: string; name: string; email: string }[]; change: ChangeRequestVM | null };
export type CustomRoleInput = { name: string; description: string; base: string; perms: Record<string, Scope> };
export type SodVM = {
  pairs: SodPair[]; process: { maker: string; checker: string; rule: string }[]; waivers: SodWaiverVM[];
  pending: ChangeRequestVM[]; exceptions: AuditEntryVM[]; people: { id: string; name: string; roles: string[] }[];
};
export type CampaignRowVM = Omit<ReviewCampaignVM, "items"> & { done: number; total: number; pct: number; kept: number; removed: number; suspended: number };
export type BreakGlassViewVM = BreakGlassVM & { change: ChangeRequestVM | null; approvers: (PersonRef & { role: Role })[] };
export type WaiverInput = { userId: string; pair: [string, string]; why: string; expiresAt: Iso };
export type BreakGlassInput = { reason: string; minutes: 60 | 120 | 240; incidentId?: string };

export type SettingsBundle = { values: Record<string, SettingValueVM>; version: number; pending: ChangeRequestVM[]; change?: ChangeRequestVM };
export type LanguageDraft = { code: string; name: string; stage: "draft" | "translating" | "review" | "published"; createdAt: Iso; by: string };
export type LanguageReport = { total: number; locales: Record<"rw" | "en" | "fr", string[]>; drafts: LanguageDraft[] };
export type IntegrationLog = { id: string; at: Iso; op: string; status: number; ms: number; requestId: string };
export type IntegrationDetail = IntegrationVM & { logs: IntegrationLog[]; daily: number[]; payLater: boolean; change?: ChangeRequestVM };
export type Visibility = "full" | "masked" | "own" | "none";
export type DataMapRow = { category: string; stored: string; location: string; retention: string; visibility: Record<string, Visibility> };
export type MonitoringVM = {
  components: ComponentHealthVM[]; p95: number[]; targetMs: number; errorRate: number[]; errorPct: number;
  slow: { path: string; p95: number }[]; jobs: { name: string; failures: number; lastAt: string }[];
  uptime: { date: string; up: number }[]; links: { label: string; href: string }[];
};
export type BackupsVM = { items: BackupVM[]; tiers: { tier: BackupVM["tier"]; keep: string }[] };
export type DrillsVM = { items: DrillVM[]; gateOpen: boolean };
export type DsrDetailVM = DsrVM & { events: { at: string; status: DsrVM["status"] }[]; version: number };
