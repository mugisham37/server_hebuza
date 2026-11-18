// P11 content lane (port of src/mocks/handlers-marketing-content.ts) + the marketing shell: media library (sharp
// re-encode, EXIF strip, WebP widths, stored in S3/MinIO), tracking IDs, site health, landing performance, knowledge
// insights, tracked links (/c/{code}, /r/{code}) and the shell badges / notification feed / staff directory.
import sharp from "sharp";
import { eq } from "drizzle-orm";
import type { Exec } from "./marketing.store";
import type { StorageService } from "../../core/storage/storage.service";
import { Logger } from "@nestjs/common";
const log = new Logger("marketing");
import { cmsEntries } from "@/db/schema";
import type {
  Campaign,
  CmsEntry,
  InboxThread,
  Lead,
  Locale,
  MediaAsset,
  MktNote,
  Referrer,
  Testimonial,
} from "@/domain/marketing/types";
import {
  type Caller,
  actorId,
  count,
  get,
  list,
  meOf,
  mktError,
  notFound,
  paidInvoices,
  policy,
  put,
  record,
  remove,
  saveSetting,
  seqId,
  setting,
  staffList,
} from "./marketing.store";
import type { LinkDoc } from "./marketing.insights";

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- shell
export async function shell(c: Caller) {
  const me = await meOf(c);
  const [leads, unreadThreads, pendingTs, cps] = await Promise.all([
    list<Lead>(c.db, "lead", { status: ["new"] }),
    list<InboxThread>(c.db, "thread", { status: ["unread"] }),
    count(c.db, "testimonial", ["pending"]),
    list<Campaign>(c.db, "campaign", {
      status: ["pending_approval", "scheduled"],
    }),
  ]);
  const id = me?.id;
  const next = cps
    .filter((x) => x.status === "scheduled" && x.scheduledAt)
    .sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!))[0];
  return {
    me,
    badges: {
      leads: leads.filter((l) => l.ownerId === id || !l.ownerId).length,
      inbox: unreadThreads.reduce((n, t) => n + t.unread, 0),
      testimonials: pendingTs,
      content: 0, // the CMS review queue has its own /api/admin/cms/review-count
      campaigns: cps.filter((x) => x.status === "pending_approval").length,
    },
    nextScheduled: next
      ? {
          label: next.name,
          at: next.scheduledAt!,
          href: `/marketing/campaigns/${next.id}`,
        }
      : undefined,
  };
}

export async function notifications(db: Exec) {
  return { items: (await list<MktNote>(db, "feed")).slice(0, 50) };
}
export async function staff(db: Exec) {
  return { items: await staffList(db) };
}

// ---------------------------------------------------------------- media
const IMAGE = ["image/jpeg", "image/png", "image/webp"];
const WIDTHS = [480, 960, 1600];
const sniff = (b: Uint8Array) => {
  const s = (i: number, n: number) =>
    String.fromCharCode(...b.subarray(i, i + n));
  if (s(0, 5) === "%PDF-") return "application/pdf";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && s(1, 3) === "PNG") return "image/png";
  if (s(0, 4) === "RIFF" && s(8, 4) === "WEBP") return "image/webp";
  return null;
};
const mediaUrl = (id: string, w?: number) =>
  `/api/media/${id}${w ? `?w=${w}` : ""}`;
type StoredMedia = MediaAsset & {
  storage?: { keys: Record<string, string>; mime: string };
};

/** Which CMS entries reference an asset (blocks/meta carry asset ids). */
async function usageMap(db: Exec) {
  const rows = await db
    .select({ id: cmsEntries.id, doc: cmsEntries.doc })
    .from(cmsEntries)
    .where(eq(cmsEntries.archived, false));
  return rows.map((r) => ({
    entryId: r.id,
    title: titleOf(r.doc),
    text: JSON.stringify([
      r.doc.blocks,
      r.doc.meta,
      Object.values(r.doc.variants).map((v) => v?.seo),
    ]),
  }));
}
const titleOf = (e: CmsEntry) =>
  e.variants.en?.title ?? e.variants.rw?.title ?? e.variants.fr?.title ?? e.key;
const withUsage = (
  a: StoredMedia,
  u: Awaited<ReturnType<typeof usageMap>>,
): MediaAsset => {
  const { storage: _s, ...rest } = a;
  const hits = u
    .filter((x) => x.text.includes(`"${a.id}"`))
    .map(({ entryId, title }) => ({ entryId, title }));
  return { ...rest, usage: hits.length ? hits : a.usage };
};

export async function media(db: Exec) {
  const [items, u] = await Promise.all([
    list<StoredMedia>(db, "media"),
    usageMap(db),
  ]);
  return { items: items.map((a) => withUsage(a, u)) };
}

type MediaMeta = { key?: string; alt?: MediaAsset["alt"]; credit?: string; licence?: string; replaceId?: string };
type PendingMedia = { key: string; name: string; mime: string; size: number; meta: MediaMeta; by: string };

/** Step 1: presigned PUT to a staging key; bytes never cross the API. */
export async function presignMedia(
  c: Caller,
  storage: StorageService,
  b: { filename: string; mime: string; size: number } & MediaMeta,
) {
  const p = await policy(c.db);
  if (b.size > (b.mime === "application/pdf" ? p.maxPdfMb : p.maxImageMb) * 1024 * 1024)
    throw mktError(413, "FILE_TOO_LARGE");
  const id = await seqId(c.db, "mu");
  const key = `marketing/staging/${id}`;
  const upload = await storage.presignPut({ key, contentType: b.mime, size: b.size, purpose: "cms-media" });
  const { filename, mime, size, ...meta } = b;
  await put(c.db, { kind: "media_upload", id, data: { key, name: filename, mime, size, meta, by: actorId(c) } satisfies PendingMedia });
  return { id, upload };
}

/** Step 2: the staged bytes go through the same sniff + re-encode (EXIF strip) as a direct upload, then staging is dropped. */
export async function completeMedia(c: Caller, storage: StorageService, id: string) {
  const u = await get<PendingMedia>(c.db, "media_upload", id, true);
  if (!u) throw notFound("Upload");
  if (!(await storage.head(u.key))) throw mktError(409, "upload_missing", null, "The file has not finished uploading.");
  const bytes = new Uint8Array(Buffer.concat(await (await storage.getStream(u.key)).toArray()));
  if (bytes.length !== u.size) throw mktError(422, "validation", null, "Uploaded size does not match.");
  const asset = await uploadMedia(c, storage, { name: u.name, bytes }, JSON.stringify(u.meta));
  await remove(c.db, "media_upload", id);
  await storage.delete(u.key).catch(() => null); // staging leftovers only cost storage
  return asset;
}

/** Multipart upload: `file` + optional `meta` JSON ({ key?, alt?, credit?, licence?, replaceId? }). */
export async function uploadMedia(
  c: Caller,
  storage: StorageService,
  f: { name: string; bytes: Uint8Array },
  metaRaw: string,
) {
  if (!f.bytes.length)
    throw mktError(422, "validation", null, "file is required");
  let meta: {
    key?: string;
    alt?: MediaAsset["alt"];
    credit?: string;
    licence?: string;
    replaceId?: string;
  } = {};
  try {
    meta = JSON.parse(metaRaw || "{}");
  } catch {
    throw mktError(422, "validation", null, "meta must be JSON");
  }
  const bytes = f.bytes;
  const mime = sniff(bytes);
  if (!mime) throw mktError(415, "UNSUPPORTED_TYPE");
  const p = await policy(c.db);
  if (
    bytes.length >
    (mime === "application/pdf" ? p.maxPdfMb : p.maxImageMb) * 1024 * 1024
  )
    throw mktError(413, "FILE_TOO_LARGE");
  const prev = meta.replaceId
    ? await get<StoredMedia>(c.db, "media", meta.replaceId, true)
    : undefined;
  if (meta.replaceId && !prev) throw notFound("Asset");
  const id = prev?.id ?? (await seqId(c.db, "md"));
  const name =
    (meta.key ?? f.name)
      .split(/[\\/]/)
      .pop()!
      .replace(/[^\w.\- ]+/g, "_")
      .slice(0, 160) || "upload";
  const keys: Record<string, string> = {};
  let asset: StoredMedia;
  if (IMAGE.includes(mime)) {
    // Re-encode drops EXIF/GPS; widths never upscale.
    const img = sharp(bytes, { failOn: "error" }).rotate();
    const m = await img.metadata();
    const width = m.autoOrient?.width ?? m.width ?? 0,
      height = m.autoOrient?.height ?? m.height ?? 0;
    const widths = [
      ...new Set(WIDTHS.map((w) => Math.min(w, width)).filter((w) => w > 0)),
    ];
    const variants: MediaAsset["variants"] = [];
    let mainBytes = 0;
    for (const w of widths) {
      const out = await img
        .clone()
        .resize({ width: w, withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
      keys[w] = `marketing/media/${id}/${Date.now()}-${w}.webp`;
      await storage.putObject(keys[w], out, "image/webp");
      variants.push({ w, url: mediaUrl(id, w) });
      mainBytes = out.length;
    }
    asset = {
      id,
      key: name.replace(/\.(jpe?g|png)$/i, ".webp"),
      mime: "image/webp",
      width,
      height,
      bytes: mainBytes,
      url: mediaUrl(id),
      variants,
      alt: meta.alt ?? prev?.alt ?? {},
      credit: meta.credit ?? prev?.credit,
      licence: meta.licence ?? prev?.licence,
      focal: prev?.focal,
      usage: prev?.usage ?? [],
      uploadedBy: actorId(c),
      uploadedAt: nowIso(),
      storage: { keys, mime: "image/webp" },
    };
  } else {
    keys.orig = `marketing/media/${id}/${Date.now()}-${name}`;
    await storage.putObject(keys.orig, bytes, mime);
    asset = {
      id,
      key: name,
      mime,
      bytes: bytes.length,
      url: mediaUrl(id),
      variants: [],
      alt: meta.alt ?? prev?.alt ?? {},
      credit: meta.credit,
      licence: meta.licence,
      usage: prev?.usage ?? [],
      uploadedBy: actorId(c),
      uploadedAt: nowIso(),
      storage: { keys, mime },
    };
  }
  await put(c.db, { kind: "media", id, data: asset });
  await record(c, prev ? "media.replaced" : "media.uploaded", id, {
    mime,
    bytes: bytes.length,
  });
  return withUsage(asset, []);
}

export async function patchMedia(
  c: Caller,
  id: string,
  b: Partial<Pick<MediaAsset, "alt" | "credit" | "licence" | "focal">>,
) {
  const a = await get<StoredMedia>(c.db, "media", id, true);
  if (!a) throw notFound("Asset");
  Object.assign(a, {
    alt: b.alt ?? a.alt,
    credit: b.credit ?? a.credit,
    licence: b.licence ?? a.licence,
    focal: b.focal ?? a.focal,
  });
  await put(c.db, { kind: "media", id, data: a });
  return withUsage(a, await usageMap(c.db));
}

export async function deleteMedia(c: Caller, id: string) {
  const a = await get<StoredMedia>(c.db, "media", id, true);
  if (!a) throw notFound("Asset");
  if (withUsage(a, await usageMap(c.db)).usage.length)
    throw mktError(409, "IN_USE", null, "In use");
  await remove(c.db, "media", id);
  await record(c, "media.deleted", id);
  // shortcut: the S3 objects stay (cheap, and a CDN may still hold them); a lifecycle rule on marketing/media/ cleans up.
  return null;
}

/** Public read: 302 target, a short-lived presigned URL (seeded assets with a site path redirect there). */
export async function mediaRedirect(
  db: Exec,
  storage: StorageService,
  id: string,
  w?: number,
) {
  const a = await get<StoredMedia>(db, "media", id);
  if (!a) throw notFound("Asset");
  if (!a.storage) return a.url.startsWith("/") ? a.url : "/"; // site path, the controller prefixes the web origin
  const keys = a.storage.keys;
  const pick =
    keys.orig ??
    keys[
      String(
        Object.keys(keys)
          .map(Number)
          .filter((x) => !w || x <= w)
          .sort((x, y) => y - x)[0] ?? Object.keys(keys)[0],
      )
    ];
  return storage.presignGet(pick);
}

// ---------------------------------------------------------------- tracking IDs
type TrackingDoc = {
  ga4Id: string;
  gscToken: string;
  adsIds: string[];
  pixelId: string;
};
export async function tracking(db: Exec) {
  const t = await setting<TrackingDoc>(db, "tracking", {
    ga4Id: "",
    gscToken: "",
    adsIds: [],
    pixelId: "",
  });
  const rows = await db
    .select({ doc: cmsEntries.doc })
    .from(cmsEntries)
    .where(eq(cmsEntries.archived, false));
  const urls: Record<Locale, number> = { rw: 0, en: 0, fr: 0 };
  for (const r of rows)
    for (const [l, v] of Object.entries(r.doc.variants))
      if (v?.status === "published" && v.seo?.robots !== "noindex")
        urls[l as Locale]++;
  const [leads, paid] = await Promise.all([
    list<Lead>(db, "lead"),
    paidInvoices(db),
  ]);
  const last = (xs: string[]) => xs.sort().at(-1);
  return {
    ...t,
    sitemap: { generatedAt: nowIso(), urls },
    events: [
      {
        name: "lead_created",
        count: leads.length,
        lastAt: last(leads.map((l) => l.createdAt)),
      },
      {
        name: "booking_made",
        count: leads.filter((l) => l.source === "booking").length,
        lastAt: last(
          leads.filter((l) => l.source === "booking").map((l) => l.createdAt),
        ),
      },
      {
        name: "payment_confirmed",
        count: paid.length,
        lastAt: last(paid.map((p) => p.paidAt)),
      },
    ],
  };
}
export async function saveTracking(c: Caller, b: TrackingDoc) {
  if (b.ga4Id && !/^G-[A-Z0-9]{6,12}$/.test(b.ga4Id))
    throw mktError(422, "validation", { field: "ga4Id" }, "ga4");
  if (b.adsIds.some((x) => !/^AW-\d{6,12}$/.test(x)))
    throw mktError(422, "validation", { field: "adsIds" }, "ads");
  if (b.pixelId && !/^\d{10,20}$/.test(b.pixelId))
    throw mktError(422, "validation", { field: "pixelId" }, "pixel");
  await saveSetting(c.db, "tracking", {
    ga4Id: b.ga4Id,
    gscToken: b.gscToken,
    adsIds: b.adsIds,
    pixelId: b.pixelId,
  });
  await record(c, "tracking.changed", "site", {
    ga4Id: b.ga4Id,
    adsIds: b.adsIds,
    pixelId: b.pixelId,
  });
  return tracking(c.db);
}
/** Public tag IDs for the site layout (RSC). */
export async function publicTracking(db: Exec) {
  const t = await setting<TrackingDoc>(db, "tracking", {
    ga4Id: "",
    gscToken: "",
    adsIds: [],
    pixelId: "",
  });
  return { ga4Id: t.ga4Id, adsIds: t.adsIds, pixelId: t.pixelId };
}

// ---------------------------------------------------------------- site health
type Broken = {
  url: string;
  foundOn: string;
  entryId?: string;
  blockId?: string;
  status: number;
};
type Speed = {
  id: string;
  at: string;
  page: string;
  lcp: number;
  cls: number;
  inp: number;
};
type HealthDoc = { broken: Broken[]; speed: Speed[]; checkedAt?: string };
export const health = (db: Exec) =>
  setting<HealthDoc>(db, "health", { broken: [], speed: [] });

/** Internal link check over published CMS content (job). External hosts are never contacted from here. */
export async function checkLinks(db: Exec) {
  const rows = await db
    .select({ id: cmsEntries.id, doc: cmsEntries.doc })
    .from(cmsEntries)
    .where(eq(cmsEntries.archived, false));
  const live = new Set<string>();
  for (const r of rows)
    for (const [l, v] of Object.entries(r.doc.variants))
      if (v?.status === "published") {
        live.add(`/${l}/${v.slug}`.replace(/\/+$/, ""));
        live.add(`/${l}`);
      }
  const broken: Broken[] = [];
  for (const r of rows) {
    const text = JSON.stringify([r.doc.blocks, r.doc.variants]);
    for (const m of text.matchAll(/"href":"(\/(?:rw|en|fr)\/[^"#?]*)"/g)) {
      const href = m[1].replace(/\/+$/, "");
      if (![...live].some((p) => href === p || href.startsWith(`${p}/`)))
        broken.push({
          url: m[1],
          foundOn: `/${r.doc.key}`,
          entryId: r.id,
          status: 404,
        });
    }
  }
  const h = await health(db);
  await saveSetting(db, "health", {
    ...h,
    broken: broken.slice(0, 200),
    checkedAt: nowIso(),
  });
  return broken.length;
}

/** Server-side response time of a public page, measured from this instance (same host, no third party). */
export async function runSpeed(c: Caller, page: string, base: string) {
  if (!/^\/[\w\-/]*$/.test(page))
    throw mktError(422, "validation", { field: "page" }, "page");
  const t0 = performance.now();
  try {
    await fetch(`${base}${page}`, {
      headers: { "user-agent": "hebuza-speed-check" },
    }).then((r) => r.arrayBuffer());
  } catch (e) {
    log.warn(`mkt_speed_check_failed ${page}: ${String(e)}`);
  }
  // shortcut: lcp = full server response time; cls/inp need field data (web-vitals beacons) which are not collected yet.
  const row: Speed = {
    id: await seqId(c.db, "sp"),
    at: nowIso(),
    page,
    lcp: Math.round(performance.now() - t0),
    cls: 0,
    inp: 0,
  };
  const h = await health(c.db);
  await saveSetting(c.db, "health", {
    ...h,
    speed: [row, ...h.speed].slice(0, 10),
  });
  return row;
}

// ---------------------------------------------------------------- landing performance & knowledge insights
export async function landingPerformance(db: Exec, id: string, range = "30d") {
  const [row] = await db
    .select({ doc: cmsEntries.doc })
    .from(cmsEntries)
    .where(eq(cmsEntries.id, id))
    .limit(1);
  if (!row) throw notFound("Landing page");
  const days = range === "7d" ? 7 : range === "90d" ? 90 : 30;
  const from = Date.now() - days * 86_400_000;
  const tag = row.doc.meta.landing?.campaignTag,
    cid = row.doc.meta.landing?.campaignId;
  const slugs = Object.values(row.doc.variants)
    .map((v) => v?.slug)
    .filter(Boolean) as string[];
  const leads = (await list<Lead>(db, "lead")).filter(
    (l) =>
      Date.parse(l.createdAt) >= from &&
      ((cid && l.campaignId === cid) ||
        (tag &&
          (l.lastTouch?.campaign === tag || l.firstTouch?.campaign === tag)) ||
        slugs.some((s) => l.lastTouch?.landing?.endsWith(`/${s}`))),
  );
  const links = (await list<LinkDoc>(db, "link")).filter(
    (l) =>
      (tag && l.campaign === tag) ||
      (cid && l.campaignId === cid) ||
      slugs.some((s) => l.target.endsWith(`/${s}`)),
  );
  let visits = 0;
  for (const l of links)
    for (const [d, n] of Object.entries(l.daily ?? {}))
      if (Date.parse(d) >= from) visits += n;
  const bySrc: Record<string, { visits: number; leads: number }> = {};
  for (const l of leads) {
    const s = l.lastTouch?.source ?? "direct";
    (bySrc[s] ??= { visits: 0, leads: 0 }).leads++;
  }
  for (const l of links)
    for (const [s, n] of Object.entries(l.sources ?? {}))
      (bySrc[s] ??= { visits: 0, leads: 0 }).visits += n;
  return {
    visits,
    starts: leads.length,
    submissions: leads.length, // shortcut: form starts need a client "form_start" beacon; submissions stand in
    bySource: Object.entries(bySrc).map(([source, v]) => ({ source, ...v })),
    leads: leads
      .slice(0, 20)
      .map((l) => ({ id: l.id, name: l.name, at: l.createdAt })),
    events: [
      { name: "lead_created", wired: true, lastAt: leads[0]?.createdAt },
      { name: "booking_made", wired: true },
    ],
  };
}

/** Helpful votes per knowledge entry and zero-result searches, from the "kb" settings counters the public site writes. */
export async function knowledgeInsights(db: Exec) {
  const kb = await setting<{
    helpful: Record<string, { yes: number; no: number }>;
    zeroResults: Record<string, { q: string; locale: Locale; n: number }>;
  }>(db, "kb_insights", { helpful: {}, zeroResults: {} });
  const ids = Object.keys(kb.helpful);
  const rows = ids.length
    ? await db
        .select({ id: cmsEntries.id, doc: cmsEntries.doc })
        .from(cmsEntries)
    : [];
  return {
    helpful: ids
      .map((id) => ({
        entryId: id,
        title: titleOf(
          rows.find((r) => r.id === id)?.doc ??
            ({ key: id, variants: {} } as CmsEntry),
        ),
        ...kb.helpful[id],
      }))
      .sort((a, b) => b.yes + b.no - (a.yes + a.no)),
    zeroResults: Object.values(kb.zeroResults)
      .sort((a, b) => b.n - a.n)
      .slice(0, 20),
  };
}

// ---------------------------------------------------------------- tracked links /c/{code} and /r/{code}
const day = () => nowIso().slice(0, 10);
async function bumpLink(db: Exec, l: LinkDoc, source: string) {
  const daily = { ...(l.daily ?? {}), [day()]: (l.daily?.[day()] ?? 0) + 1 };
  // Keep a rolling year of daily counts.
  for (const d of Object.keys(daily))
    if (Date.parse(d) < Date.now() - 400 * 86_400_000) delete daily[d];
  await put(db, {
    kind: "link",
    id: l.code,
    data: {
      ...l,
      clicks: l.clicks + 1,
      daily,
      sources: {
        ...(l.sources ?? {}),
        [source]: (l.sources?.[source] ?? 0) + 1,
      },
    },
    ref: l.campaignId ?? l.referrerId ?? null,
  });
}

export type LinkClick = { code: string; source: string; referrerId?: string };

/** Campaign link: target with UTM attached (the visitor's browser records the touch) + the click to count. Read-only. */
export async function resolveCampaignLink(db: Exec, code: string, base: string) {
  const l = /^[\w-]{1,80}$/.test(code) ? await get<LinkDoc>(db, "link", code) : undefined;
  const to = new URL(l?.target?.startsWith("/") ? l.target : "/", base);
  let click: LinkClick | null = null;
  if (l && !l.referrerId) {
    click = { code: l.code, source: to.searchParams.get("utm_source") ?? "campaign" };
    if (l.campaign && !to.searchParams.has("utm_campaign")) {
      to.searchParams.set("utm_source", to.searchParams.get("utm_source") ?? "campaign");
      to.searchParams.set("utm_medium", "campaign");
      to.searchParams.set("utm_campaign", l.campaign);
    }
  }
  return { to: to.toString(), click };
}

/** Referral link: the referral touch rides as UTM (medium = client|agent from the referrer), then home. Read-only. */
export async function resolveReferralLink(db: Exec, code: string, base: string) {
  const to = new URL("/", base);
  if (!/^REF-[A-Z0-9-]{3,24}$/i.test(code)) return { to: to.toString(), click: null };
  const r = (await list<Referrer>(db, "referrer")).find((x) => x.code.toUpperCase() === code.toUpperCase());
  to.searchParams.set("utm_source", "referral");
  to.searchParams.set("utm_medium", r?.kind ?? "referral");
  to.searchParams.set("utm_campaign", code.toUpperCase());
  const click: LinkClick | null = r ? { code: r.code.toUpperCase(), source: "referral", referrerId: r.id } : null;
  return { to: to.toString(), click };
}

/** Worker side of a click (outbox `marketing.link_click`): bumps the link and its campaign's clicked stat. */
export async function countClick(db: Exec, k: LinkClick) {
  const l =
    (await get<LinkDoc>(db, "link", k.code, true)) ??
    (k.referrerId ? { code: k.code, target: "/", referrerId: k.referrerId, clicks: 0, createdAt: nowIso() } : undefined);
  if (!l) return;
  await bumpLink(db, l, k.source);
  const cp = l.campaignId ? await get<Campaign>(db, "campaign", l.campaignId, true) : undefined;
  if (cp) {
    cp.stats = { ...cp.stats, clicked: cp.stats.clicked + 1 };
    await put(db, { kind: "campaign", id: cp.id, data: cp, status: cp.status, ref: cp.slug });
  }
}

// ---------------------------------------------------------------- dev toggles
/** Non-production: report what the dashboard would show (GA4 is never simulated against real data). */
export async function devInsights(db: Exec) {
  return { ga4: false, firstWeek: (await count(db, "lead")) === 0 };
}

export type { Testimonial };
