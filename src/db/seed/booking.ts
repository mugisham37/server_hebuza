// Booking seed (dev/staging only), mirroring the web mock booking-world: 3 consultation types (on-site inactive),
// 4 advisers (Mon–Fri 08–12/13–17, Diane afternoons, Grace on leave next Thursday), today's board, the client
// persona's bookings (one starting soon, one upcoming, one attended with next steps, one no-show), a paid lead
// booking, a lead with two no-shows and three callback requests. Re-running refreshes every date to today.
import { createHash } from "node:crypto";
import { like, sql as dsql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../schema";
import { bkgAdvisers, bkgBookings, bkgCounters, bkgRequests, bkgSettings, bkgTypes } from "../schema/schema-booking";
import { addDays, at, dayOf, planReminders, weekdayOf } from "@/domain/booking/rules";
import type { AvailabilityRule, BookingStatus, ConsultationType, Mode } from "@/domain/booking/types";
import type { Locale } from "@/domain/i18n/config";
import { mask } from "@/domain/format";

// Same values/derivations as BKG_DEFAULTS and the contact helpers in server booking.service.ts (seed can't import the api).
const BKG_DEFAULTS = { consultationPrice: 20_000, officeAddress: "HEBUZA office, Sonatube — Kicukiro, Kigali", videoBase: "https://meet.google.com/" };
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const contactKey = (c: { clientId?: string | null; phone?: string | null; email?: string | null }) =>
  c.clientId ?? sha(c.phone ? c.phone.replace(/\D/g, "").slice(-9) : (c.email ?? "").trim().toLowerCase());
const maskPhone = (p?: string | null) => (p ? mask(p, 3) : undefined);
const maskEmail = (e?: string | null) => (e ? e.replace(/^(.)[^@]*(@.*)$/, "$1•••$2") : undefined);

const MIN = 60_000;
const tl = (en: string, fr: string, rw: string) => ({ en, fr, rw });
const WEEK: AvailabilityRule[] = [1, 2, 3, 4, 5].flatMap((weekday) => [
  { weekday, start: "08:00", end: "12:00" },
  { weekday, start: "13:00", end: "17:00" },
]);

const TYPES: Omit<ConsultationType, "currency">[] = [
  {
    id: "ct-intro",
    slug: "intro-30",
    version: 1,
    isActive: true,
    name: tl(
      "Free intro call",
      "Appel découverte gratuit",
      "Ikiganiro cy'ibanze cy'ubuntu",
    ),
    description: tl(
      "30 minutes to understand your need and the right service. Once per service family.",
      "30 minutes pour comprendre votre besoin et le bon service. Une fois par famille de services.",
      "Iminota 30 yo gusobanukirwa icyo ukeneye na serivisi ikwiye.",
    ),
    durationMin: 30,
    modes: ["video", "phone", "office"],
    price: 0,
    bufferBeforeMin: 0,
    bufferAfterMin: 15,
    minNoticeMin: 240,
    horizonDays: 14,
    maxPerDay: 6,
    familySlugs: [],
    serviceSlugs: [],
    adviserIds: ["ag-eric", "ag-grace", "ag-jp", "sm-diane"],
    freeOncePerFamily: true,
    intakeSchema: [
      {
        id: "stage",
        type: "radio",
        required: true,
        label: tl("Where are you today?", "Où en êtes-vous ?", "Ugeze he?"),
        options: ["Just an idea", "Business running", "Investor abroad"],
      },
      {
        id: "goal",
        type: "text",
        required: false,
        label: tl(
          "What would you like to achieve?",
          "Que souhaitez-vous accomplir ?",
          "Wifuza kugera kuki?",
        ),
      },
    ],
    prepare: {
      en: [
        "Your questions, written down",
        "Any registration numbers you already have (TIN, company code)",
      ],
      fr: [
        "Vos questions, par écrit",
        "Vos numéros existants (NIF, code société)",
      ],
      rw: [
        "Ibibazo byawe, byanditse",
        "Nomero usanzwe ufite (TIN, kode ya sosiyete)",
      ],
    },
  },
  {
    id: "ct-consult",
    slug: "consult-60",
    version: 1,
    isActive: true,
    name: tl(
      "Expert consultation",
      "Consultation d'expert",
      "Inama n'impuguke",
    ),
    description: tl(
      "60 minutes with a specialist on your case: documents, steps, costs and a written next-step summary.",
      "60 minutes avec un spécialiste : documents, étapes, coûts et un résumé écrit.",
      "Iminota 60 n'inzobere ku kibazo cyawe.",
    ),
    durationMin: 60,
    modes: ["video", "office", "phone"],
    price: BKG_DEFAULTS.consultationPrice,
    bufferBeforeMin: 15,
    bufferAfterMin: 15,
    minNoticeMin: 240,
    horizonDays: 30,
    maxPerDay: 5,
    familySlugs: [],
    serviceSlugs: [],
    adviserIds: ["ag-eric", "ag-grace", "ag-jp"],
    freeOncePerFamily: false,
    intakeSchema: [
      {
        id: "topic",
        type: "text",
        required: true,
        label: tl(
          "What should the adviser prepare?",
          "Que doit préparer le conseiller ?",
          "Umujyanama yitegure iki?",
        ),
      },
      {
        id: "docs",
        type: "checkbox",
        required: false,
        label: tl(
          "I'll bring documents to review",
          "J'apporterai des documents à examiner",
          "Nzazana inyandiko zo gusuzuma",
        ),
      },
    ],
    prepare: {
      en: [
        "Passport or ID copy",
        "A short summary of your business idea",
        "Any letters from RDB or RRA",
      ],
      fr: [
        "Copie du passeport ou de la carte d'identité",
        "Un court résumé de votre projet",
        "Tout courrier de RDB ou RRA",
      ],
      rw: [
        "Kopi ya pasiporo cyangwa indangamuntu",
        "Incamake y'umushinga wawe",
        "Amabaruwa ya RDB cyangwa RRA",
      ],
    },
  },
  {
    id: "ct-onsite",
    slug: "on-site-60",
    version: 1,
    isActive: false, // D-6: inactive until HEBUZA confirms price/coverage
    name: tl(
      "On-site visit (Kigali)",
      "Visite sur place (Kigali)",
      "Gusurwa aho ukorera (Kigali)",
    ),
    description: tl(
      "An adviser visits your premises in Kigali.",
      "Un conseiller se déplace dans vos locaux à Kigali.",
      "Umujyanama agusura aho ukorera i Kigali.",
    ),
    durationMin: 60,
    modes: ["premises"],
    price: 35_000 /* PLACEHOLDER(on-site-price) */,
    bufferBeforeMin: 45,
    bufferAfterMin: 45,
    minNoticeMin: 1440,
    horizonDays: 30,
    maxPerDay: 2,
    familySlugs: [],
    serviceSlugs: [],
    adviserIds: ["ag-eric"],
    freeOncePerFamily: false,
    intakeSchema: [],
    prepare: { en: [], fr: [], rw: [] },
  },
];

export type SeedBookingDeps = { encrypt: (plain: string) => string };

export async function seedBooking(tx: PostgresJsDatabase<typeof schema>, deps: SeedBookingDeps) {
  const enc = (v?: string | null) => (v ? deps.encrypt(v) : null);
  const now = Date.now();
  const today = dayOf(now);
  const nextWeekday = (wd: number, minDays = 1) => {
    let d = addDays(today, minDays);
    while (weekdayOf(d) !== wd) d = addDays(d, 1);
    return d;
  };

  await tx
    .insert(bkgSettings)
    .values({ id: "default", value: {} }) // service defaults apply
    .onConflictDoNothing();
  for (const t of TYPES) {
    const { id, ...rest } = t;
    await tx
      .insert(bkgTypes)
      .values({ id, ...rest })
      .onConflictDoUpdate({ target: bkgTypes.id, set: rest });
  }
  const advisers = [
    {
      id: "ag-eric",
      userId: "mock-agent",
      name: "Eric Habimana",
      title: "Tax adviser",
      photo: "/hebuza/faces/2.jpg",
      priority: 1,
      rules: WEEK,
      leave: [],
      externalBusy: [
        {
          from: at(addDays(today, 2), "15:00"),
          to: at(addDays(today, 2), "16:00"),
        },
      ],
    },
    {
      id: "ag-grace",
      userId: null,
      name: "Grace Uwimana",
      title: "Business adviser",
      photo: "/hebuza/faces/5.jpg",
      priority: 2,
      rules: WEEK,
      leave: [{ from: nextWeekday(4), to: nextWeekday(4) }],
      externalBusy: [],
    },
    {
      id: "ag-jp",
      userId: "mock-ext",
      name: "Jean-Paul Nkurunziza",
      title: "Investment adviser",
      photo: "/hebuza/faces/3.jpg",
      priority: 3,
      rules: WEEK,
      leave: [],
      externalBusy: [],
    },
    {
      id: "sm-diane",
      userId: "mock-sm",
      name: "Diane Mukamana",
      title: "Service manager",
      photo: "/hebuza/faces/6.jpg",
      priority: 4,
      rules: WEEK.filter((r) => r.start === "13:00"),
      leave: [],
      externalBusy: [],
    },
  ];
  for (const a of advisers) {
    const { id, ...rest } = a;
    await tx
      .insert(bkgAdvisers)
      .values({ id, ...rest, overrides: [], active: true })
      .onConflictDoUpdate({
        target: bkgAdvisers.id,
        set: {
          leave: rest.leave,
          externalBusy: rest.externalBusy,
          userId: rest.userId,
        },
      });
  }

  // Bookings: seed rows are replaced each run so their times follow today.
  await tx.delete(bkgBookings).where(like(bkgBookings.id, "bk_seed_%"));
  const y = new Date(now).getFullYear();
  let seq = 217;
  const soon = new Date(Math.ceil((now + 10 * MIN) / (5 * MIN)) * 5 * MIN);
  const soonTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Kigali",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(soon);
  type S = {
    type: string;
    adviser: string;
    date: string;
    time: string;
    status: BookingStatus;
    name: string;
    clientId?: string;
    phone?: string;
    email?: string;
    lang: Locale;
    mode: Mode;
    family?: string;
    source?: string;
    summary?: string;
    recommend?: string[];
    notes?: string;
    token?: string;
  };
  const rows: S[] = [
    {
      type: "consult-60",
      adviser: "ag-eric",
      date: today,
      time: "10:30",
      status: "confirmed",
      name: "Kigali Fresh Foods Ltd",
      phone: "+250 788 555 210",
      email: "finance@kff.example.rw",
      lang: "en",
      mode: "office",
    },
    {
      type: "intro-30",
      adviser: "ag-grace",
      date: today,
      time: "11:00",
      status: "confirmed",
      name: "Nyamirambo Tailors Coop",
      phone: "+250 722 410 998",
      lang: "rw",
      mode: "phone",
      family: "business-training-coaching",
    },
    {
      type: "consult-60",
      adviser: "ag-jp",
      date: today,
      time: "14:00",
      status: "confirmed",
      name: "Rwandan Ltd",
      email: "admin@rwl.example.rw",
      lang: "fr",
      mode: "video",
      family: "investment-financing",
    },
    {
      type: "intro-30",
      adviser: "ag-eric",
      date: dayOf(soon.getTime()),
      time: soonTime,
      status: "confirmed",
      name: "Aline Uwase",
      clientId: "mock-client",
      phone: "+250 788 123 456",
      email: "aline.uwase@example.rw",
      lang: "rw",
      mode: "video",
      family: "online-services",
      token: "mt_aline_soon",
    },
    {
      type: "consult-60",
      adviser: "ag-eric",
      date: nextWeekday(2, 3),
      time: "09:00",
      status: "confirmed",
      name: "Aline Uwase",
      clientId: "mock-client",
      phone: "+250 788 123 456",
      email: "aline.uwase@example.rw",
      lang: "rw",
      mode: "office",
      token: "mt_aline_next",
    },
    {
      type: "intro-30",
      adviser: "ag-eric",
      date: addDays(today, -12),
      time: "10:00",
      status: "completed",
      name: "Aline Uwase",
      clientId: "mock-client",
      phone: "+250 788 123 456",
      lang: "rw",
      mode: "video",
      summary:
        "We agreed to register your company with RDB first, then file your first VAT declaration once you start invoicing. Bring your passport copy and the address of your office.",
      recommend: ["company-registration", "vat-declaration"],
      notes: "Client is ready; prefers Kinyarwanda. Follow up next week.",
    },
    {
      type: "consult-60",
      adviser: "ag-grace",
      date: addDays(today, -30),
      time: "15:00",
      status: "no_show",
      name: "Aline Uwase",
      clientId: "mock-client",
      phone: "+250 788 123 456",
      lang: "rw",
      mode: "phone",
    },
    {
      type: "consult-60",
      adviser: "ag-eric",
      date: nextWeekday(4, 2),
      time: "10:30",
      status: "confirmed",
      name: "Jean Claude Habimana",
      phone: "+32 470 12 34 56",
      email: "jc.habimana@example.be",
      lang: "fr",
      mode: "video",
      family: "investment-financing",
      source: "assistant",
      token: "mt_jc",
    },
    {
      type: "intro-30",
      adviser: "ag-grace",
      date: nextWeekday(4),
      time: "14:00",
      status: "confirmed",
      name: "Kigali Fresh Foods Ltd",
      phone: "+250 788 555 210",
      lang: "en",
      mode: "office",
    },
    ...[-40, -20].map((d): S => ({
      type: "intro-30",
      adviser: "ag-jp",
      date: addDays(today, d),
      time: "09:00",
      status: "no_show",
      name: "Demo Lead",
      phone: "+250 788 999 001",
      lang: "en",
      mode: "phone",
      family: "online-services",
    })),
  ];
  const typeMap = new Map(TYPES.map((t) => [t.slug, t]));
  const values = rows.map((o, i) => {
    const t = typeMap.get(o.type)!;
    const startsAt = at(o.date, o.time);
    const endsAt = new Date(
      Date.parse(startsAt) + t.durationMin * MIN,
    ).toISOString();
    const createdAt = new Date(
      Date.parse(startsAt) - 3 * 86_400_000,
    ).toISOString();
    const reference = `BKG-${y}-${String(++seq).padStart(4, "0")}`;
    const events = [
      { at: createdAt, kind: "booked" as const },
      {
        at: new Date(Date.parse(createdAt) + MIN).toISOString(),
        kind: "confirmed" as const,
      },
      ...(o.status === "completed"
        ? [{ at: endsAt, kind: "completed" as const }]
        : o.status === "no_show"
          ? [{ at: endsAt, kind: "no_show" as const }]
          : []),
    ];
    return {
      id: `bk_seed_${i + 1}`,
      reference,
      typeSlug: t.slug,
      typeName: t.name,
      price: t.price,
      adviserId: o.adviser,
      clientId: o.clientId ?? null,
      leadId: o.clientId ? null : `lead_seed_${i + 1}`,
      contactName: o.name,
      phoneEnc: enc(o.phone),
      emailEnc: enc(o.email),
      phoneMasked: maskPhone(o.phone) ?? null,
      emailMasked: maskEmail(o.email) ?? null,
      contactKey: contactKey({
        clientId: o.clientId,
        phone: o.phone,
        email: o.email,
      }),
      whatsapp: true,
      language: o.lang,
      startsAt,
      endsAt,
      mode: o.mode,
      location: o.mode === "office" ? BKG_DEFAULTS.officeAddress : null,
      status: o.status,
      intake:
        o.type === "intro-30"
          ? { stage: "Business running" }
          : { topic: "Company set-up as a foreign investor" },
      familySlug: o.family ?? "taxes-and-business-support",
      invoiceRef: t.price ? `INV-BKG-${reference.slice(-4)}` : null,
      paid: t.price > 0,
      clientSummary: o.summary ?? null,
      outcomeNotes: o.notes ?? null,
      recommended: o.recommend ?? [],
      startLinks: (o.recommend ?? []).map((slug) => ({
        slug,
        name: slug.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()),
        href: `/apply/${slug}?from=booking`,
      })),
      reminders:
        o.status === "confirmed"
          ? planReminders(startsAt, Date.parse(createdAt), "whatsapp", now)
          : [],
      events,
      source: o.source ?? "web",
      tokenHash: sha(o.token ?? `seed-${i}-${reference}`),
      confirmKey: sha(`ck-${reference}`).slice(0, 32),
      joinUrl:
        o.mode === "video"
          ? `${BKG_DEFAULTS.videoBase}hbz-${reference.slice(-4)}-seed`
          : null,
      createdAt,
    };
  });
  await tx.insert(bkgBookings).values(values);
  await tx
    .insert(bkgCounters)
    .values({ name: `bkg-${y}`, value: seq })
    .onConflictDoUpdate({
      target: bkgCounters.name,
      set: { value: dsql`greatest(${bkgCounters.value}, ${seq})` },
    });

  const H = 3_600_000;
  const reqs = [
    {
      id: "CB-0031",
      name: "Claudine M.",
      phone: "+250 788 410 221",
      topic: "taxes-and-business-support",
      preferredTimes: ["Weekdays · Morning"],
      language: "rw",
      status: "new",
      ago: 3,
    },
    {
      id: "CB-0030",
      name: "Olivier N.",
      phone: "+250 733 112 908",
      email: "olivier@example.rw",
      topic: "investment-financing",
      preferredTimes: ["Weekdays · Afternoon", "Saturday · Morning"],
      language: "fr",
      status: "new",
      ago: 20,
    },
    {
      id: "CB-0029",
      name: "Samuel K.",
      phone: "+250 722 300 441",
      topic: "online-services",
      preferredTimes: ["Weekdays · Evening"],
      language: "en",
      status: "scheduled",
      ago: 50,
      bookingRef: `BKG-${y}-0201`,
    },
  ];
  for (const r of reqs)
    await tx
      .insert(bkgRequests)
      .values({
        id: r.id,
        name: r.name,
        phoneEnc: enc(r.phone)!,
        phoneMasked: maskPhone(r.phone)!,
        emailEnc: enc(r.email),
        topic: r.topic,
        preferredTimes: r.preferredTimes,
        language: r.language,
        status: r.status,
        bookingRef: r.bookingRef ?? null,
        createdAt: new Date(now - r.ago * H).toISOString(),
      })
      .onConflictDoNothing();
  await tx
    .insert(bkgCounters)
    .values({ name: "cb", value: 31 })
    .onConflictDoNothing();
}
