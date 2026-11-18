// Assistant seed (dev/staging), port of .ref assistant.seed.ts: settings, six KB sources across every review state
// (indexed ones chunked into ai_kb_chunks so retrieval works at once), console sessions + transcripts, unanswered
// questions forming the clusters, three eval runs and two handoffs. Idempotent. Run after seedAuth/seedCms.
import { like } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import {
  aiEvals,
  aiHandoffs,
  aiKbChunks,
  aiKbSources,
  aiMessages,
  aiSessions,
  aiSettings,
} from "../schema/schema-assistant";
import { dayOf } from "@/domain/booking/rules";
import type { KbSource } from "@/domain/booking/types";
import type * as schema from "../schema";

type Exec = PgDatabase<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;
const D = 86_400_000;
// Same defaults as AI_DEFAULTS in server/src/modules/assistant/assistant.engine.ts (the API also creates the row lazily).
const AI_DEFAULTS = {
  budgetUsd: 50,
  perIpDaily: 30,
  retentionMonths: 12,
  officeHours: "Mon–Fri 08:00–17:00",
  value: { promise: "within 1 working hour", whatsapp: "https://wa.me/250788000000" },
};
/** Same paragraph chunker as the API's `chunk()` (assistant.service.ts). */
function chunk(body: string, max = 800) {
  const out: string[] = [];
  let cur = "";
  for (const p of body.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean)) {
    if (cur && cur.length + p.length > max) { out.push(cur); cur = ""; }
    cur = cur ? `${cur}\n\n${p}` : p;
    while (cur.length > max * 1.5) { out.push(cur.slice(0, max)); cur = cur.slice(max); }
  }
  if (cur) out.push(cur);
  return out;
}

export async function seedAssistant(tx: Exec) {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const day = (n: number) => iso(now - n * D);
  await tx
    .insert(aiSettings)
    .values({
      id: "global",
      budgetUsd: AI_DEFAULTS.budgetUsd,
      perIpDaily: AI_DEFAULTS.perIpDaily,
      retentionMonths: AI_DEFAULTS.retentionMonths,
      officeHours: AI_DEFAULTS.officeHours,
      value: AI_DEFAULTS.value,
    })
    .onConflictDoNothing();

  const KB: (Omit<KbSource, "comment" | "cms" | "locale"> & {
    locale: string;
    slug: string;
  })[] = [
    {
      id: "kb-1",
      slug: "register-company",
      title: "How to register a company with RDB",
      kind: "guide",
      locale: "en",
      status: "indexed",
      owner: "Grace Mutesi",
      factsBy: "Diane Mukamana",
      toneBy: "Grace Mutesi",
      reviewBy: dayOf(now + 150 * D),
      lastIndexedAt: day(10),
      updatedAt: day(10),
      version: 3,
      body: "1. Choose a legal form (Ltd, public, branch).\n\n2. Prepare passport/ID copies and a registered office address.\n\n3. Submit on the RDB portal. RDB usually decides within 6 working hours.\n\nForeign investors may own 100 % of a company.",
      previous:
        "1. Choose a legal form.\n2. Prepare documents.\n3. Submit at RDB offices.",
      flags: [],
    },
    {
      id: "kb-2",
      slug: "certificat-investissement",
      title: "Certificat d'investissement — FAQ",
      kind: "faq",
      locale: "fr",
      status: "approved_for_ai",
      owner: "Grace Mutesi",
      factsBy: "Diane Mukamana",
      toneBy: null,
      reviewBy: dayOf(now + 170 * D),
      lastIndexedAt: null,
      updatedAt: day(2),
      version: 1,
      body: "Le certificat d'investissement est délivré par RDB aux investisseurs remplissant le seuil d'investissement.",
      previous: null,
      flags: [],
    },
    {
      id: "kb-3",
      slug: "amategeko-imisoro",
      title: "Amategeko y'imisoro 2026",
      kind: "guide",
      locale: "rw",
      status: "draft",
      owner: "Grace Mutesi",
      factsBy: null,
      toneBy: null,
      reviewBy: dayOf(now + 180 * D),
      lastIndexedAt: null,
      updatedAt: day(1),
      version: 1,
      body: "Umusoro ku nyungu ni 30 %. Tuguha icyizere ko dosiye yawe izemerwa mu minsi 3.",
      previous: null,
      flags: [
        {
          text: "Tuguha icyizere ko dosiye yawe izemerwa mu minsi 3",
          why: "guarantee",
        },
        { text: "Umusoro ku nyungu ni 30 %", why: "unsourced_fee" },
      ],
    },
    {
      id: "kb-4",
      slug: "vat-declaration",
      title: "VAT declaration",
      kind: "catalogue",
      locale: "en",
      status: "indexed",
      owner: "Diane Mukamana",
      factsBy: "Diane Mukamana",
      toneBy: "Grace Mutesi",
      reviewBy: dayOf(now + 90 * D),
      lastIndexedAt: day(11),
      updatedAt: day(11),
      version: 2,
      body: "Monthly or quarterly VAT declaration filed with RRA by the 15th of the following month. Late filing has penalties. HEBUZA fee from RWF 15,000 (indicative).",
      previous: null,
      flags: [],
    },
    {
      id: "kb-5",
      slug: "paye-rates-2025",
      title: "PAYE rates 2025",
      kind: "policy",
      locale: "en",
      status: "stale",
      owner: "Diane Mukamana",
      factsBy: "Diane Mukamana",
      toneBy: "Grace Mutesi",
      reviewBy: dayOf(now - 20 * D),
      lastIndexedAt: day(200),
      updatedAt: day(200),
      version: 1,
      body: "PAYE bands for 2025…",
      previous: null,
      flags: [{ text: "PAYE bands for 2025", why: "outdated" }],
    },
    {
      id: "kb-6",
      slug: "expert-consultation",
      title: "Expert consultation (60 min)",
      kind: "consultation_type",
      locale: "en",
      status: "indexed",
      owner: "Diane Mukamana",
      factsBy: "Diane Mukamana",
      toneBy: "Grace Mutesi",
      reviewBy: dayOf(now + 120 * D),
      lastIndexedAt: day(5),
      updatedAt: day(5),
      version: 1,
      body: "60-minute paid consultation with a specialist. Price confirmed on invoice.",
      previous: null,
      flags: [],
    },
  ];
  for (const { slug, ...k } of KB) {
    await tx.insert(aiKbSources).values(k).onConflictDoNothing();
    if (k.status !== "indexed") continue;
    await tx.delete(aiKbChunks).where(like(aiKbChunks.sourceId, k.id));
    const parts = chunk(k.body);
    await tx
      .insert(aiKbChunks)
      .values(
        parts.map((content, ord) => ({
          id: `${k.id}:${ord}`,
          sourceId: k.id,
          ord,
          title: k.title,
          url: `/{lang}/knowledge/${slug}`,
          locale: k.locale,
          content,
          sourceVersion: k.version,
        })),
      );
  }

  // Console sessions (as-1000 … as-1019) with short transcripts; "no_source" ones feed the unanswered clusters.
  await tx.delete(aiMessages).where(like(aiMessages.sessionId, "as-10%"));
  await tx.delete(aiSessions).where(like(aiSessions.id, "as-10%"));
  const OUT = [
    "answered",
    "answered",
    "handed_off",
    "no_source",
    "answered",
    "abandoned",
    "answered",
    "blocked",
  ] as const;
  const TITLES = [
    "Comment créer une société au Rwanda ?",
    "Umusoro wa VAT ni iki?",
    "What documents do I need?",
    "Visa for investors",
    "Tax clearance certificate",
    "Where is my application?",
    "Guarantee my loan",
    "PAYE rates 2027",
  ];
  const UNANSWERED = [
    "Do I need a visa to invest?",
    "Visa investisseur Rwanda",
    "Investor residence permit",
    "PAYE 2027 bands",
    "New PAYE rates?",
    "Format du business plan",
    "Modèle de plan d'affaires",
  ];
  for (let i = 0; i < 20; i++) {
    const id = `as-${1000 + i}`;
    const outcome = OUT[i % OUT.length];
    const startedAt = iso(now - i * 5.3 * 3_600_000);
    const lang = (["fr", "rw", "en"] as const)[i % 3];
    await tx.insert(aiSessions).values({
      id,
      lang,
      context: i % 5 === 0 ? "portal" : "public",
      ownerId: i % 5 === 0 ? "mock-client" : null,
      title: TITLES[i % TITLES.length],
      turns: 2 + (i % 6),
      outcome,
      rating: i % 4 === 0 ? 1 : i % 7 === 0 ? -1 : null,
      handedOff: outcome === "handed_off",
      blocked: outcome === "blocked",
      tokensIn: 2140,
      tokensOut: 388,
      costMicroUsd: 12_000,
      latencyMs: 1830,
      model: "extractive",
      startedAt,
      lastAt: startedAt,
    });
    const t = (n: number) => iso(Date.parse(startedAt) + n * 1000);
    const userText =
      outcome === "no_source"
        ? UNANSWERED[i % UNANSWERED.length]
        : TITLES[i % TITLES.length];
    await tx.insert(aiMessages).values([
      {
        id: `${id}-m1`,
        sessionId: id,
        role: "user",
        text: userText,
        outcome: outcome === "no_source" ? "no_source" : "answered",
        createdAt: t(0),
      },
      {
        id: `${id}-m2`,
        sessionId: id,
        role: "tool",
        text: "search_knowledge(query) → company-registration",
        sources: ["How to register a company with RDB"],
        createdAt: t(1),
      },
      {
        id: `${id}-m3`,
        sessionId: id,
        role: "assistant",
        text:
          outcome === "no_source"
            ? "I don't have confirmed information on that, so I won't guess."
            : "Here are the main steps: 1. Choose a legal form 2. Prepare the documents 3. Submit to RDB.",
        sources:
          outcome === "no_source"
            ? []
            : ["How to register a company with RDB · v3"],
        flags:
          outcome === "blocked"
            ? ["abuse"]
            : outcome === "no_source"
              ? ["no_source"]
              : [],
        outcome,
        createdAt: t(2),
      },
      {
        id: `${id}-m4`,
        sessionId: id,
        role: "user",
        text: "My ID is ••••••••••••7890, can you check?",
        createdAt: t(30),
      },
      {
        id: `${id}-m5`,
        sessionId: id,
        role: "assistant",
        text: "Please don't share ID numbers here. Use the secure form.",
        flags: ["pii_masked"],
        createdAt: t(31),
      },
    ]);
  }
  // Extra unanswered questions in the last weeks so clusters carry realistic counts.
  for (let i = 0; i < UNANSWERED.length * 3; i++)
    await tx
      .insert(aiMessages)
      .values({
        id: `as-1000-u${i}`,
        sessionId: "as-1003",
        role: "user",
        text: UNANSWERED[i % UNANSWERED.length],
        outcome: "no_source",
        createdAt: iso(now - (i + 1) * 9 * 3_600_000),
      });

  await tx.delete(aiEvals).where(like(aiEvals.id, "ev-1_"));
  await tx.insert(aiEvals).values([
    {
      id: "ev-12",
      at: day(1),
      trigger: "Prompt update v14",
      passed: 146,
      total: 150,
      prohibited: 0,
      deployBlocked: false,
    },
    {
      id: "ev-11",
      at: day(8),
      trigger: "KB reindex",
      passed: 141,
      total: 150,
      prohibited: 2,
      deployBlocked: true,
    },
    {
      id: "ev-10",
      at: day(15),
      trigger: "Weekly",
      passed: 145,
      total: 150,
      prohibited: 0,
      deployBlocked: false,
    },
  ]);
  await tx
    .insert(aiHandoffs)
    .values([
      {
        id: "ho-1",
        sessionId: "as-1000",
        conversationId: "ai-as-1000",
        ticketRef: "SUP-4821",
        reason: "user_request",
        lang: "fr",
        at: iso(now - 25 * 60_000),
        who: "Visitor (lead)",
        summary:
          "Foreign investor (Belgium) wants to register a Ltd and asks about bank account opening. Asked for a person after fees answer.",
      },
      {
        id: "ho-2",
        sessionId: "as-1002",
        conversationId: "ai-as-1002",
        ticketRef: "SUP-4822",
        reason: "money_owed",
        lang: "rw",
        at: iso(now - 3 * 3_600_000),
        who: "Aline Uwase",
        claimedBy: "Diane Mukamana",
        claimedById: "mock-sm",
        summary:
          "Client says they were charged twice for a VAT filing. Needs finance check.",
      },
    ])
    .onConflictDoNothing();
}
