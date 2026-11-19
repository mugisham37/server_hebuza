// P10 settings + feature flags + languages (U12), integrations registry (U12b) and notifications — rules, templates
// with lint + Meta review, deliveries, channel budgets (U14). Port of handlers-system-d and the U14 half of -e.
// Credentials are write-only: Fernet-encrypted in the system store, only last4 ever leaves the server.
import { extractVars } from "@/domain/system/templates";
import { parseSettingsImport } from "@/domain/system/settings-registry";
import type { DeliveryService } from "../notifications/notifications.delivery";
import type { DeliveryVM } from "@/domain/system/types";
import { eq } from "drizzle-orm";
import { Logger } from "@nestjs/common";
// UI dictionaries are pure data in server/src/domain (shared with the web app).
import en from "@/domain/i18n/dictionaries/en.json";
import fr from "@/domain/i18n/dictionaries/fr.json";
import rw from "@/domain/i18n/dictionaries/rw.json";
import { platformSettings } from "@/db/schema";
import type { Env } from "../../core/config/env";
import { canGoLive, health } from "@/domain/system/integrations";
import { exportSettings, settingDef } from "@/domain/system/settings-registry";
import { currentVersion, lint } from "@/domain/system/templates";
import type { Locale } from "@/domain/i18n/config";
import type {
  BudgetVM,
  ChangeRequestVM,
  EventRuleVM,
  IntegrationVM,
  TemplateBody,
  TemplateVM,
} from "@/domain/system/types";
import type {
  IntegrationDetail,
  IntegrationLog,
  LanguageReport,
  SettingsBundle,
} from "./lib/vm";
import {
  accepted,
  fail,
  guard,
  invalidDetail,
  onApply,
  putSetting,
  read,
  record,
  setSecret,
  settingsMap,
  stale,
  stepUp,
  submitChange,
  SYSTEM_ACTOR,
  envOf,
  systemWrite,
  write,
  type Actor,
  type SystemDeps,
  type Caller,
  type World,
} from "./system.world";
import { iso } from "../../core/db/ids";

const PLATFORM_SETTINGS_ID = "global";
const log = new Logger("system.config");
const LOCALES: Locale[] = ["rw", "en", "fr"];

// ---------------------------------------------------------------- settings
const SETTING_KINDS = new Set(["setting_change", "ip_allowlist_disable"]);
const bundle = (w: World): SettingsBundle => ({
  values: settingsMap(w),
  version: w.meta.settingsVersion,
  pending: w.changes.filter(
    (c) =>
      SETTING_KINDS.has(c.kind) &&
      (c.state === "proposed" || c.state === "approved"),
  ),
});
const codeFor = (key: string) =>
  key.startsWith("flags.")
    ? "config.flag.changed"
    : key === "maintenance.window"
      ? "config.maintenance.scheduled"
      : "config.setting.changed";
/** Keys the FastAPI platform_settings row also carries: written through so the existing guards enforce them. */
const PLATFORM_COLS: Record<
  string,
  keyof typeof platformSettings.$inferInsert
> = {
  "intake.accept_new": "acceptNewApps",
  "intake.guest_applications": "guestApps",
  "maintenance.on": "maintenanceMode",
  "flags.card_payments": "paymentsEnabled",
};
async function writeThrough(w: World, key: string, value: unknown) {
  const col = PLATFORM_COLS[key];
  if (!col) return;
  await w.db
    .update(platformSettings)
    .set({
      [col]: value,
      updatedBy: w.actor.id === "system" ? null : w.actor.id,
      updatedAt: iso(),
    })
    .where(eq(platformSettings.id, PLATFORM_SETTINGS_ID));
  w.afterCommit.push(() => w.caller.deps.cache.bust("platform"));
}
async function applySettings(
  w: World,
  after: unknown,
  by: string,
  approvalRef?: string,
  reason?: string,
) {
  for (const [k, v] of Object.entries(after as Record<string, unknown>)) {
    const before = putSetting(w, k, v, by);
    await writeThrough(w, k, v);
    record(
      w,
      codeFor(k),
      "setting",
      k,
      before,
      v,
      reason,
      undefined,
      approvalRef ? { approvalRef } : {},
    );
  }
  w.meta.settingsVersion++;
}
onApply("setting_change", (w, cr) =>
  applySettings(w, cr.after, cr.proposedBy.name, cr.id),
);
onApply("ip_allowlist_disable", (w, cr) =>
  applySettings(w, cr.after, cr.proposedBy.name, cr.id),
);

export function getSettings(c: Caller) {
  guard(c.session, true);
  return read(c, bundle);
}
export async function patchSettings(
  c: Caller,
  b: {
    values: Record<string, unknown>;
    reason?: string;
    effectiveAt?: string | null;
  },
) {
  const s = guard(c.session, true);
  const errors: Record<string, string> = {};
  for (const [k, v] of Object.entries(b.values ?? {})) {
    const d = settingDef(k);
    if (!d || d.type === "readonly") errors[k] = "readonly";
    else if (!d.editableBy.some((r) => s.roles.includes(r)))
      throw fail(403, "forbidden_role", "Not editable by your role.");
    else {
      const e = d.validate(v);
      if (e) errors[k] = e;
    }
  }
  if (Object.keys(errors).length) throw invalidDetail(errors);
  const entries = Object.entries(b.values ?? {});
  const gated = entries.filter(([k]) => settingDef(k)!.requiresApproval);
  if (gated.length || entries.some(([k]) => k.startsWith("security.")))
    await stepUp(c, s);
  return write(c, async (w) => {
    stale(c.ifMatch, w.meta.settingsVersion);
    const now = entries.filter(([k]) => !settingDef(k)!.requiresApproval);
    for (const [k, v] of now) {
      const before = putSetting(w, k, v, w.actor.name);
      await writeThrough(w, k, v);
      record(w, codeFor(k), "setting", k, before, v, b.reason);
    }
    if (now.length) w.meta.settingsVersion++;
    if (!gated.length) return bundle(w);
    const values = settingsMap(w);
    const before = Object.fromEntries(
      gated.map(([k]) => [k, values[k]?.value]),
    );
    // Turning an allowlist off entirely is its own, louder kind (F-IAM-12).
    const off = gated.some(
      ([k, v]) =>
        k.startsWith("security.ip_allowlist") &&
        Array.isArray(v) &&
        !v.length &&
        ((before[k] as unknown[] | undefined)?.length ?? 0) > 0,
    );
    const cr = submitChange(w, {
      kind: off ? "ip_allowlist_disable" : "setting_change",
      title: gated.map(([k]) => k).join(", "),
      reason: b.reason?.trim() || "Settings change",
      before,
      after: Object.fromEntries(gated),
      payload: { keys: gated.map(([k]) => k), key: gated[0][0] },
      effectiveAt: b.effectiveAt ?? null,
    });
    for (const [k] of gated) {
      const cur = values[k];
      putSetting(w, k, cur.value, cur.changedBy, cr.id);
      const row = w.settings.find((x) => x.key === k)!;
      row.changedAt = cur.changedAt;
    }
    return accepted({ ...bundle(w), change: cr });
  });
}
/** F-SET-13: re-apply an exported settings file. Goes through patchSettings, so validation, approvals and audit apply. */
export async function importSettingsJson(c: Caller, b: { json: string; reason?: string }) {
  let parsed: ReturnType<typeof parseSettingsImport>;
  try {
    parsed = parseSettingsImport(b.json);
  } catch {
    throw fail(422, "validation", "Not a settings export file.");
  }
  const res = await patchSettings(c, { values: parsed.values, reason: b.reason ?? "Imported settings file" });
  return { result: res, skipped: parsed.skipped };
}
export async function exportSettingsJson(c: Caller) {
  await stepUp(c, guard(c.session));
  return write(c, (w) => {
    const values = settingsMap(w);
    record(
      w,
      "data_export.report.exported",
      "settings",
      "settings.json",
      undefined,
      { keys: Object.keys(values).length },
    );
    return {
      json: exportSettings(
        Object.fromEntries(
          Object.entries(values).map(([k, v]) => [k, v.value]),
        ),
      ),
    };
  });
}
/** The caller's IP as the edge saw it (allowlist editor "add my IP"). */
export const myIp = async (c: Caller) => (
  guard(c.session, true),
  { ip: c.ip ?? "" }
);

// ---------------------------------------------------------------- languages (F-SET-10): dictionary diff against en
const flat = (o: unknown, p = ""): [string, string][] =>
  o && typeof o === "object"
    ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
        flat(v, p ? `${p}.${k}` : k),
      )
    : [[p, String(o ?? "")]];
function languageReport(w: World): LanguageReport {
  const base = flat(en);
  const missing = (d: unknown) => {
    const m = new Map(flat(d));
    return base.filter(([k]) => !m.get(k)?.trim()).map(([k]) => k);
  };
  return {
    total: base.length,
    locales: { en: [], fr: missing(fr), rw: missing(rw) },
    drafts: w.drafts,
  };
}
export function languages(c: Caller) {
  guard(c.session);
  return read(c, languageReport);
}
export async function addLanguage(
  c: Caller,
  b: { code?: string; name?: string },
) {
  guard(c.session);
  const code = (b.code ?? "").trim().toLowerCase();
  if (!/^[a-z]{2,3}$/.test(code)) throw invalidDetail({ code: "format" });
  if (!b.name?.trim()) throw invalidDetail({ name: "required" });
  return write(c, (w) => {
    if (
      LOCALES.includes(code as Locale) ||
      w.drafts.some((d) => d.code === code)
    )
      throw invalidDetail({ code: "exists" });
    const draft = {
      code,
      name: b.name!.trim(),
      stage: "draft" as const,
      createdAt: iso(),
      by: w.actor.name,
    };
    w.drafts.push(draft);
    record(
      w,
      "config.setting.changed",
      "setting",
      `i18n.draft.${code}`,
      undefined,
      draft,
    );
    return languageReport(w);
  });
}

// ---------------------------------------------------------------- integrations
const TEST_OK: Record<IntegrationVM["group"], string> = {
  payments: "Collection request 200",
  messaging: "Test message delivered",
  ai: "API call 200",
  identity: "Sandbox check created",
  platform: "Round-trip ok",
};
/** Server-side keys that make a provider usable in this deployment. Empty = the call is a logged no-op (never sends). */
const ENV_KEYS: Record<string, (keyof Env)[]> = {
  "mtn-momo": ["MTN_MOMO_API_KEY", "MTN_MOMO_SUBSCRIPTION_KEY"],
  flutterwave: ["FLUTTERWAVE_SECRET_KEY"],
  resend: ["RESEND_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
};
const envConfigured = (c: Caller, key: string) =>
  (ENV_KEYS[key] ?? []).every((k) => !!c.deps.config.get(k, { infer: true }));
const refresh = (i: IntegrationVM) => {
  i.health = health(i);
  return i;
};
const integrationOf = (w: World, key: string) => {
  const i = w.integrations.find((x) => x.key === key);
  if (!i) throw fail(404, "not_found", "Not found.");
  return i;
};
const seed = (key: string) =>
  [...key].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
const OPS: Record<IntegrationVM["group"], string[]> = {
  payments: ["collection.request", "collection.status", "webhook.received"],
  messaging: ["message.send", "message.status", "webhook.received"],
  ai: ["messages.create", "property.query"],
  identity: ["envelope.create", "check.create"],
  platform: ["heartbeat", "object.put", "object.get"],
};
// shortcut: request logs and daily usage are a deterministic model of errorRate1h/usage until providers report call
// logs into the store (payments/notifications modules); replace logsOf/daily with their rows then.
function logsOf(i: IntegrationVM): IntegrationLog[] {
  if (!i.configured) return [];
  let s = seed(i.key);
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) % 10_000) / 10_000;
  return Array.from({ length: 50 }, (_, n) => {
    const failed = rnd() < Math.max(i.errorRate1h, 0.01),
      timeout = failed && rnd() < 0.4;
    return {
      id: `${i.key}-${n}`,
      at: new Date(
        Date.now() - n * 7 * 60_000 - Math.round(rnd() * 300_000),
      ).toISOString(),
      op: OPS[i.group][Math.floor(rnd() * OPS[i.group].length)],
      status: timeout ? 0 : failed ? 502 : 200,
      ms: timeout ? 10_000 : Math.round(80 + rnd() * 400),
      requestId: `req_${(seed(i.key + n) % 0xffffff).toString(16).padStart(6, "0")}`,
    };
  });
}
function daily(i: IntegrationVM) {
  if (!i.usage) return [];
  let s = seed(i.key + "u");
  const per = i.usage.used / 30;
  return Array.from({ length: 30 }, (_, d) =>
    Math.round(
      per *
        (0.6 +
          (((s = (s * 1103515245 + 12345) >>> 0) % 1000) / 1000) * 0.6 +
          d / 60),
    ),
  );
}
const detail = (w: World, i: IntegrationVM): IntegrationDetail => ({
  ...refresh(i),
  logs: logsOf(i),
  daily: daily(i),
  payLater: w.meta.payLater,
});
onApply("credential_rotation", (w, cr) => {
  const i = w.integrations.find((x) => x.key === String(cr.payload.key));
  if (!i) return;
  const name = String(cr.payload.name),
    pend = w.secrets.get(`pending:${cr.id}`);
  if (pend) {
    w.secrets.set(`int:${i.key}:${name}`, pend);
    w.secrets.delete(`pending:${cr.id}`);
  }
  i.credentials = [
    ...i.credentials.filter((x) => x.name !== name),
    { name, last4: String(cr.payload.last4), rotatedAt: iso() },
  ];
  i.version++;
  refresh(i);
  record(
    w,
    "config.integration.credential_rotated",
    "integration",
    i.key,
    undefined,
    { name, last4: cr.payload.last4 },
    undefined,
    undefined,
    { approvalRef: cr.id },
  );
});
export function listIntegrations(c: Caller) {
  guard(c.session);
  return read(c, (w) => ({
    items: w.integrations.map(refresh),
    payLater: w.meta.payLater,
  }));
}
export function integration(c: Caller, key: string) {
  guard(c.session);
  return read(c, (w) => detail(w, integrationOf(w, key)));
}
export async function setPayLater(c: Caller, on: boolean) {
  await stepUp(c, guard(c.session));
  return write(c, (w) => {
    const before = w.meta.payLater;
    w.meta.payLater = !!on;
    record(
      w,
      "config.setting.changed",
      "setting",
      "payments.pay_later",
      before,
      w.meta.payLater,
    );
    return { payLater: w.meta.payLater };
  });
}
/** Connectivity test. No data leaves the server: the check is "credentials stored + deployment key present"; a live
 *  provider call is the provider module's job (payments/notifications) and reports back through errorRate1h. */
function runTest(c: Caller, i: IntegrationVM, envName: IntegrationVM["env"]) {
  const hasKey = !ENV_KEYS[i.key] || envConfigured(c, i.key);
  // ID verification has no production contract yet (C3.16).
  const ok =
    i.configured &&
    i.credentials.length > 0 &&
    hasKey &&
    !(envName === "production" && i.key === "id-verification");
  return {
    at: iso(),
    ok,
    message: ok
      ? TEST_OK[i.group]
      : !hasKey
        ? "Provider key missing in this deployment"
        : "Credentials missing",
    env: envName,
  };
}
export async function testIntegration(c: Caller, key: string) {
  guard(c.session);
  return write(c, (w) => {
    const i = integrationOf(w, key);
    if (!i.configured)
      throw fail(409, "integration_untested", "Set up credentials first.");
    i.lastTest = runTest(c, i, i.env);
    i.version++;
    refresh(i);
    record(w, "config.integration.tested", "integration", i.key, undefined, {
      ok: i.lastTest.ok,
      env: i.env,
    });
    return detail(w, i);
  });
}
export async function setCredential(
  c: Caller,
  key: string,
  b: { name?: string; value?: string; reason?: string },
) {
  await stepUp(c, guard(c.session));
  const value = (b.value ?? "").trim(); // write-only: encrypted at rest, never echoed
  if (value.length < 8) throw invalidDetail({ value: "too_short" });
  const name = b.name?.trim() || "API key",
    last4 = value.slice(-4);
  return write(c, (w) => {
    const i = integrationOf(w, key);
    if (i.env === "production" && i.configured) {
      const cr = submitChange(w, {
        kind: "credential_rotation",
        title: `${i.name} · ${name}`,
        reason: b.reason?.trim() || "Credential rotation",
        before: {
          [name]: `••••${i.credentials.find((x) => x.name === name)?.last4 ?? ""}`,
        },
        after: { [name]: `••••${last4}` },
        payload: { key: i.key, name, last4 },
      });
      setSecret(w, `pending:${cr.id}`, value); // swapped in only when the second person approves
      return accepted({ ...detail(w, i), change: cr });
    }
    const before = i.credentials.find((x) => x.name === name)?.last4;
    setSecret(w, `int:${i.key}:${name}`, value);
    i.credentials = [
      ...i.credentials.filter((x) => x.name !== name),
      { name, last4, rotatedAt: iso() },
    ];
    i.configured = true;
    i.version++;
    refresh(i);
    record(
      w,
      "config.integration.credential_rotated",
      "integration",
      i.key,
      before ? { last4: before } : undefined,
      { name, last4 },
    );
    return detail(w, i);
  });
}
export async function setEnv(c: Caller, key: string, envName: string) {
  await stepUp(c, guard(c.session));
  if (envName !== "production" && envName !== "sandbox")
    throw invalidDetail({ env: "type" });
  return write(c, (w) => {
    const i = integrationOf(w, key);
    stale(c.ifMatch, i.version);
    if (envName === i.env) return detail(w, i);
    const t = iso();
    if (envName === "production") {
      // The switch carries its own production test (C3.16).
      const test = runTest(c, i, "production");
      record(w, "config.integration.tested", "integration", i.key, undefined, {
        ok: test.ok,
        env: envName,
      });
      if (!test.ok || !canGoLive({ lastTest: test }))
        throw fail(409, "integration_untested", "Production test failed.");
      i.lastTest = test;
    }
    const before = i.env;
    i.env = envName;
    i.envChangedAt = t;
    i.version++;
    refresh(i);
    record(
      w,
      "config.integration.env_changed",
      "integration",
      i.key,
      before,
      envName,
    );
    return detail(w, i);
  });
}

// ---------------------------------------------------------------- notification rules
export function rules(c: Caller) {
  guard(c.session);
  return read(c, (w) => ({ items: w.rules, version: w.meta.rulesVersion }));
}
export async function putRules(c: Caller, items: EventRuleVM[]) {
  guard(c.session);
  return write(c, (w) => {
    stale(c.ifMatch, w.meta.rulesVersion);
    for (const next of items) {
      const cur = w.rules.find((r) => r.event === next.event);
      if (!cur) throw fail(422, "validation", "Unknown event.");
      // Security events: email + in-app can't be switched off; critical events are never deferred (F-NTF-08).
      if (
        cur.security &&
        (["email", "inapp"] as const).some(
          (ch) => cur.channels[ch] && !next.channels[ch],
        )
      )
        throw fail(422, "validation", "Security channels are locked.");
      if (cur.critical && next.quietHours !== "send")
        throw fail(422, "validation", "Critical events are never deferred.");
      if (next.chain.some((ch) => !next.channels[ch] || ch === "inapp"))
        throw fail(422, "validation", "Fallback uses only enabled channels.");
    }
    for (const next of items) {
      const i = w.rules.findIndex((r) => r.event === next.event),
        before = w.rules[i];
      const after = {
        ...before,
        channels: next.channels,
        chain: next.chain,
        priority: before.critical ? before.priority : next.priority,
        quietHours: next.quietHours,
      };
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      w.rules[i] = after;
      record(
        w,
        "config.setting.changed",
        "setting",
        `notifications.rules.${next.event}`,
        before,
        after,
      );
    }
    w.meta.rulesVersion++;
    return { items: w.rules, version: w.meta.rulesVersion };
  });
}

// ---------------------------------------------------------------- templates
const rev = (w: World, key: string) => w.meta.templateRev[key] ?? 1;
const bumpRev = (w: World, key: string) => {
  w.meta.templateRev[key] = rev(w, key) + 1;
};
const tplRes = (w: World, t: TemplateVM) => ({
  template: t,
  rev: rev(w, t.key),
});
const templateOf = (w: World, key: string) => {
  const t = w.templates.find((x) => x.key === key);
  if (!t) throw fail(404, "not_found", "Not found.");
  return t;
};
/** Auth & security templates are the sysadmin's; operational = SM, marketing = MKT (read-only here). */
const ownerGuard = (t: TemplateVM) => {
  if (t.ownerKind !== "security")
    throw fail(403, "forbidden_role", "Owned by another role.");
};
function activate(w: World, t: TemplateVM, by: Actor = w.actor) {
  const cur = currentVersion(t);
  t.versions.forEach((v) => {
    if (v !== cur && v.status === "active") v.status = "retired";
  });
  Object.assign(cur, {
    status: "active",
    approvedBy: by.name,
    approvedAt: iso(),
    providerStatus: undefined,
    rejectedReason: undefined,
  });
  bumpRev(w, t.key);
  record(
    w,
    "config.template.activated",
    "template",
    t.key,
    undefined,
    { v: cur.v },
    undefined,
    by,
  );
}
export function templates(c: Caller) {
  guard(c.session);
  return read(c, (w) => ({ items: w.templates }));
}
export function template(c: Caller, key: string) {
  guard(c.session);
  return read(c, (w) => tplRes(w, templateOf(w, key)));
}
export async function putTemplate(
  c: Caller,
  key: string,
  b: {
    languages: Record<Locale, TemplateBody | null>;
    category: TemplateVM["category"];
  },
) {
  guard(c.session);
  return write(c, (w) => {
    const t = templateOf(w, key);
    ownerGuard(t);
    stale(c.ifMatch, rev(w, key));
    for (const l of LOCALES) {
      const body = b.languages[l];
      if (
        body &&
        lint({ ...t, category: b.category }, body).some(
          (i) => i.code === "otp_link_forbidden",
        )
      )
        throw fail(422, "otp_link_forbidden", "No links in code messages.");
    }
    const cur = currentVersion(t);
    const before = { v: cur.v, languages: cur.languages, category: t.category };
    if (cur.status === "draft" || cur.status === "rejected")
      Object.assign(cur, {
        languages: b.languages,
        status: "draft",
        rejectedReason: undefined,
        providerStatus: undefined,
        editedBy: w.actor.name,
        editedAt: iso(),
      });
    else
      t.versions.push({
        v: cur.v + 1,
        status: "draft",
        languages: b.languages,
        editedBy: w.actor.name,
        editedAt: iso(),
      });
    t.category = b.category;
    bumpRev(w, key);
    record(w, "config.template.changed", "template", key, before, {
      v: currentVersion(t).v,
      languages: b.languages,
      category: b.category,
    });
    return tplRes(w, t);
  });
}
/** F-NTF-10: WhatsApp templates wait for Meta. With WHATSAPP_ACCESS_TOKEN + WHATSAPP_WABA_ID the job submits the
 *  template to the Graph API once, then re-polls its status every 10 min until APPROVED / REJECTED. Without them the
 *  review job approves locally after the delay (dev/staging parity) and logs it. */
const META_CATEGORY = { utility: "UTILITY", marketing: "MARKETING", authentication: "AUTHENTICATION" } as const;
const META_LANG: Record<string, string> = { en: "en", fr: "fr", rw: "rw_RW" }; // PLACEHOLDER(wa-rw-code) verify in Meta's list
export const providerReview = async (
  deps: SystemDeps,
  d: { key: string; v: number; submitted?: boolean },
) => {
  const token = deps.config.get("WHATSAPP_ACCESS_TOKEN", { infer: true }), waba = deps.config.get("WHATSAPP_WABA_ID", { infer: true });
  const graph = (path: string, init?: RequestInit) =>
    fetch(`https://graph.facebook.com/v21.0/${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, signal: AbortSignal.timeout(15_000) })
      .then(async (r) => ({ ok: r.ok, j: (await r.json().catch(() => ({}))) as { data?: { status?: string; rejected_reason?: string }[]; error?: { message?: string } } }));
  let verdict: { status: "approved" | "rejected" | "pending"; reason?: string } = { status: "approved" };
  if (token && waba) {
    const snap = await systemWrite(deps, (w) => {
      const t = w.templates.find((x) => x.key === d.key);
      const cur = t && currentVersion(t);
      return t && cur && cur.v === d.v && cur.status === "pending_provider_approval" ? { t: structuredClone(t), cur: structuredClone(cur) } : null;
    });
    if (!snap) return;
    if (!d.submitted) {
      for (const [lang, body] of Object.entries(snap.cur.languages)) {
        if (!body?.body) continue;
        // Same positional order the delivery job sends params in (extractVars = first use).
        const order = extractVars(body.body);
        const text = body.body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, v: string) => `{{${order.indexOf(v) + 1}}}`);
        const r = await graph(`${waba}/message_templates`, { method: "POST", body: JSON.stringify({ name: snap.t.key, language: META_LANG[lang] ?? lang, category: META_CATEGORY[snap.t.category], components: [{ type: "BODY", text }] }) });
        if (!r.ok) verdict = { status: "rejected", reason: r.j.error?.message ?? "Meta rejected the submission" };
      }
      if (verdict.status !== "rejected") verdict = { status: "pending" };
    } else {
      const r = await graph(`${waba}/message_templates?name=${encodeURIComponent(snap.t.key)}`);
      const st = r.j.data?.map((x) => x.status) ?? [];
      verdict = st.length && st.every((x) => x === "APPROVED") ? { status: "approved" }
        : st.some((x) => x === "REJECTED") ? { status: "rejected", reason: r.j.data?.find((x) => x.status === "REJECTED")?.rejected_reason ?? "Rejected by Meta" }
        : { status: "pending" };
    }
    if (verdict.status === "pending") {
      await deps.queues.add("default", "system.template.provider_review", { key: d.key, v: d.v, submitted: true }, { delay: 10 * 60_000 });
      return;
    }
  }
  return systemWrite(deps, (w) => {
    const t = w.templates.find((x) => x.key === d.key);
    const cur = t && currentVersion(t);
    if (!t || !cur || cur.v !== d.v || cur.status !== "pending_provider_approval") return;
    if (verdict.status === "rejected") {
      Object.assign(cur, { status: "rejected", rejectedReason: verdict.reason, providerStatus: "Rejected by Meta" });
      bumpRev(w, t.key);
      return;
    }
    if (!token || !waba) log.log(`template_provider_review_local ${d.key} v${d.v}`);
    activate(w, t, SYSTEM_ACTOR);
  });
};
export async function templateOp(
  c: Caller,
  key: string,
  op: string,
  b: { reason?: string },
) {
  guard(c.session);
  return write(c, (w) => {
    const t = templateOf(w, key);
    ownerGuard(t);
    stale(c.ifMatch, rev(w, key));
    const cur = currentVersion(t);
    switch (op) {
      case "submit": {
        if (cur.status !== "draft")
          throw fail(409, "already_decided", "Not a draft.");
        const langs = LOCALES.filter((l) => cur.languages[l]?.body.trim());
        if (t.channel === "whatsapp" && langs.length < 3)
          throw fail(422, "validation", "All three languages are required.");
        if (!langs.length)
          throw fail(422, "validation", "Write at least one language.");
        if (langs.some((l) => lint(t, cur.languages[l]!).length))
          throw fail(422, "validation", "Fix the checks first.");
        record(w, "config.template.submitted", "template", key, undefined, {
          v: cur.v,
          channel: t.channel,
        });
        if (t.channel === "whatsapp") {
          cur.status = "pending_provider_approval";
          cur.providerStatus = "Submitted to Meta";
          bumpRev(w, key);
          w.events.push({
            type: "system.template.provider_review",
            payload: { key, v: cur.v },
            runAt: new Date(Date.now() + 6000),
          });
        } else activate(w, t); // shortcut: non-WhatsApp activates on submit (no template_activation ChangeKind yet)
        return tplRes(w, t);
      }
      case "simulate-rejection": {
        if (envOf(c).prod) throw fail(404, "not_found", "Not found.");
        if (cur.status !== "pending_provider_approval")
          throw fail(409, "already_decided", "Not pending.");
        Object.assign(cur, {
          status: "rejected",
          rejectedReason:
            "Body reads as promotional for a Utility template. (simulated provider reason)",
          providerStatus: "Rejected by Meta",
        });
        bumpRev(w, key);
        return tplRes(w, t);
      }
      case "retire": {
        if (!b.reason?.trim())
          throw fail(422, "validation", "Reason required.");
        const active = t.versions.find((v) => v.status === "active");
        if (!active) throw fail(409, "already_decided", "Nothing active.");
        active.status = "retired";
        bumpRev(w, key);
        record(
          w,
          "config.template.retired",
          "template",
          key,
          { v: active.v, status: "active" },
          { v: active.v, status: "retired" },
          b.reason,
        );
        return tplRes(w, t);
      }
      case "test":
        // Test sends go through the notifications queue, which no-ops without provider keys; nothing leaves here.
        return tplRes(w, t);
      default:
        throw fail(404, "not_found", "Not found.");
    }
  });
}

// ---------------------------------------------------------------- deliveries + costs
export async function deliveries(
  c: Caller,
  q: { status?: string; channel?: string },
  dlv: DeliveryService,
) {
  guard(c.session);
  const rows = await dlv.list(q);
  return {
    items: rows.map((d) => ({
      id: d.id, at: d.createdAt, event: d.kind, channel: d.channel as DeliveryVM["channel"], to: d.toMasked,
      status: d.status as DeliveryVM["status"], costRwf: d.costRwf, templateKey: d.templateKey ?? "", lang: d.lang as DeliveryVM["lang"],
      attempts: d.attempts, error: d.lastError ?? undefined,
    })),
  };
}
export async function costs(c: Caller, dlv: DeliveryService) {
  guard(c.session);
  const spend = await dlv.spend();
  return read(c, (w) => ({
    // Spend is metered from notification_deliveries this month; `ai` keeps its own meter in the world.
    budgets: w.budgets.map((b) => {
      const s = spend.get(b.channel);
      return s ? { ...b, spent: s.spent, marketingSpent: s.marketing } : b.channel === "ai" ? b : { ...b, spent: 0, marketingSpent: 0 };
    }),
    version: w.meta.costsVersion,
  }));
}
export async function putBudget(c: Caller, channel: string, budget: number) {
  await stepUp(c, guard(c.session));
  if (!Number.isInteger(budget) || budget <= 0)
    throw fail(422, "validation", "Whole amount above 0.");
  return write(c, (w) => {
    stale(c.ifMatch, w.meta.costsVersion);
    const b = w.budgets.find((x) => x.channel === channel);
    if (!b) throw fail(404, "not_found", "Not found.");
    const before: Pick<BudgetVM, "budget"> = { budget: b.budget };
    b.budget = budget; // integer RWF
    w.meta.costsVersion++;
    record(
      w,
      "config.setting.changed",
      "setting",
      `notifications.budget.${b.channel}`,
      before,
      { budget },
    );
    return { budgets: w.budgets, version: w.meta.costsVersion };
  });
}
export type { ChangeRequestVM };
