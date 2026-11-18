// Field seed (dev/staging only): Emmanuel's field world — today's and tomorrow's visits around Musanze, an expiring
// offer, a cancelled drop-off, this month's history (11 completed visits), 5 expense claims across every state and
// 2 case-pool shares. Re-running refreshes the visit windows to today. Run after seedAuth (mock-field, mock-sm).
// `deps.encrypt` = the API CryptoService.encrypt (client contacts are stored encrypted, minimised like the service does).
import { sql as dsql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "../schema";
import { fieldAgents, fieldCounters, fieldExpenses, fieldPoolShares, fieldSettings, fieldVisits } from "../schema/schema-field";
import type { I18nText, VisitPurpose } from "@/domain/field/types";
import { minimiseContact } from "@/domain/field/minimise";

export type SeedFieldDeps = { encrypt: (plain: string) => string };
const contactJson = (c: { name: string; phone: string; language: string }) => JSON.stringify(minimiseContact(c));

const AGENT = "mock-field";
const SM = "mock-sm";
const t3 = (en: string, fr: string, rw: string): I18nText => ({ en, fr, rw });
const kigaliDay = (offset: number) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kigali",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + offset * 86_400_000));
const at = (day: number, hhmm: string) =>
  new Date(`${kigaliDay(day)}T${hhmm}:00+02:00`).toISOString();
const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

const C = {
  beatrice: {
    name: "Mukamana Beatrice",
    phone: "+250788000214",
    language: "rw",
  },
  aline: { name: "Aline Uwimana", phone: "+250788000456", language: "en" },
  coop: {
    name: "Nyamirambo Tailors Coop",
    phone: "+250722000998",
    language: "rw",
  },
  hotel: {
    name: "Kinigi Hills Lodge (fictional)",
    phone: "+250788000731",
    language: "fr",
  },
};

type V = {
  n: number;
  purpose: VisitPurpose;
  title: I18nText;
  todo: I18nText;
  day: number;
  from: string;
  to: string;
  lat: number;
  lng: number;
  address: string;
  institution?: string;
  client: keyof typeof C;
  caseRef: string;
  serviceId: string;
  priority?: "high";
  checklist: [I18nText, boolean][];
  evidence: string[];
  status?: string;
  collectsDocs?: boolean;
  cancelledReason?: string;
  offerH?: number;
};
const VISITS: V[] = [
  {
    n: 114,
    purpose: "institution_submission",
    day: 0,
    from: "09:30",
    to: "10:00",
    priority: "high",
    lat: -1.499,
    lng: 29.6352,
    title: t3(
      "Deliver documents to RDB",
      "Déposer des documents au RDB",
      "Gutanga inyandiko kuri RDB",
    ),
    todo: t3(
      "Deliver the certified documents to RDB reception and photograph the stamped slip.",
      "Déposer les documents certifiés à l'accueil du RDB et photographier le récépissé tamponné.",
      "Tanga inyandiko zemejwe ku kwakira abantu kwa RDB, ufotore urupapuro rwashyizweho kashe.",
    ),
    address: "RDB office, Musanze town",
    institution: "RDB Musanze",
    client: "coop",
    caseRef: "HBZ-K2M9QA",
    serviceId: "company-registration",
    checklist: [
      [
        t3(
          "Certified documents handed over",
          "Documents certifiés remis",
          "Inyandiko zemejwe zatanzwe",
        ),
        true,
      ],
      [
        t3(
          "Stamped slip photographed",
          "Récépissé tamponné photographié",
          "Urupapuro rwa kashe rwafotowe",
        ),
        true,
      ],
    ],
    evidence: ["photo", "scan"],
  },
  {
    n: 115,
    purpose: "pickup",
    day: 0,
    from: "10:15",
    to: "11:00",
    lat: -1.5021,
    lng: 29.6301,
    title: t3(
      "Collect signed statutes",
      "Récupérer les statuts signés",
      "Gufata amategeko shingiro yasinywe",
    ),
    todo: t3(
      "Collect the 3 signed original statutes and a copy of the client's ID. Give the client a signed receipt.",
      "Récupérer les 3 statuts originaux signés et une copie de la pièce d'identité. Remettre un reçu signé.",
      "Fata amategeko shingiro 3 y'umwimerere yasinywe n'ikopi y'indangamuntu. Ha umukiriya inyemezabwishyu yasinywe.",
    ),
    address: "Nyamirambo Tailors Coop, Musanze branch, Muhoza",
    client: "beatrice",
    caseRef: "HBZ-7PX31A",
    serviceId: "company-registration",
    collectsDocs: true,
    checklist: [
      [
        t3("Signed statutes", "Statuts signés", "Amategeko shingiro yasinywe"),
        true,
      ],
      [
        t3(
          "Client ID copied",
          "Pièce d'identité copiée",
          "Indangamuntu yakopowe",
        ),
        true,
      ],
      [
        t3("Documents received", "Documents reçus", "Inyandiko zakiriwe"),
        false,
      ],
    ],
    evidence: ["signature", "scan", "photo"],
  },
  {
    n: 116,
    purpose: "assisted_application",
    day: 0,
    from: "11:30",
    to: "12:30",
    lat: -1.4295,
    lng: 29.5937,
    title: t3(
      "Assist client application",
      "Assister une demande client",
      "Gufasha umukiriya gusaba",
    ),
    todo: t3(
      "Help the client complete the company application on their phone. Client confirms by SMS code or signature.",
      "Aider le client à remplir la demande. Le client confirme par code SMS ou signature.",
      "Fasha umukiriya kuzuza ubusabe. Umukiriya yemeza akoresheje kode ya SMS cyangwa umukono.",
    ),
    address: "Kinigi sector office, Musanze",
    client: "aline",
    caseRef: "HBZ-WMVX19",
    serviceId: "company-registration",
    checklist: [
      [
        t3("Company details", "Détails de l'entreprise", "Amakuru y'ikigo"),
        true,
      ],
      [
        t3(
          "RDB process explained",
          "Processus RDB expliqué",
          "Uburyo bwa RDB bwasobanuwe",
        ),
        true,
      ],
      [t3("Client confirms", "Le client confirme", "Umukiriya yemeje"), true],
    ],
    evidence: ["otp", "signature"],
  },
  {
    n: 117,
    purpose: "site_visit",
    day: 0,
    from: "14:00",
    to: "15:00",
    lat: -1.4952,
    lng: 29.642,
    title: t3(
      "Visit client premises",
      "Visiter les locaux du client",
      "Gusura aho umukiriya akorera",
    ),
    todo: t3(
      "Photograph the premises and signboard for the trading licence file.",
      "Photographier les locaux et l'enseigne pour le dossier de licence.",
      "Fotora aho bakorera n'icyapa ku dosiye y'uruhushya.",
    ),
    address: "Kinigi Hills Lodge (fictional), Kinigi road",
    client: "hotel",
    caseRef: "HBZ-9QW5ZE",
    serviceId: "investment-certificate",
    checklist: [
      [
        t3(
          "Premises photographed",
          "Locaux photographiés",
          "Aho bakorera hafotowe",
        ),
        true,
      ],
      [
        t3(
          "Signboard photographed",
          "Enseigne photographiée",
          "Icyapa cyafotowe",
        ),
        false,
      ],
    ],
    evidence: ["photo"],
  },
  {
    n: 118,
    purpose: "meeting",
    day: 0,
    from: "15:30",
    to: "16:00",
    lat: -1.47,
    lng: 29.83,
    status: "offered",
    offerH: 2,
    title: t3(
      "Meet client at Burera sector",
      "Rencontrer le client au secteur Burera",
      "Guhura n'umukiriya ku murenge wa Burera",
    ),
    todo: t3(
      "Short meeting to collect a missing signature page.",
      "Courte réunion pour récupérer une page de signature manquante.",
      "Inama ngufi yo gufata urupapuro rw'umukono rwabuze.",
    ),
    address: "Burera sector office",
    client: "beatrice",
    caseRef: "HBZ-7PX31A",
    serviceId: "company-registration",
    checklist: [
      [
        t3(
          "Signature page collected",
          "Page de signature récupérée",
          "Urupapuro rw'umukono rwafashwe",
        ),
        true,
      ],
    ],
    evidence: ["signature"],
  },
  {
    n: 119,
    purpose: "dropoff",
    day: 0,
    from: "16:30",
    to: "17:00",
    lat: -1.508,
    lng: 29.625,
    status: "cancelled",
    cancelledReason: "Client asked to come to the office instead",
    title: t3(
      "Return original deeds",
      "Rendre les actes originaux",
      "Gusubiza inyandiko z'umwimerere",
    ),
    todo: t3(
      "Return the originals and get a return receipt signed.",
      "Rendre les originaux et faire signer un reçu de retour.",
      "Subiza inyandiko z'umwimerere, usinyishe inyemezabwishyu yo gusubiza.",
    ),
    address: "Muhoza, Musanze",
    client: "aline",
    caseRef: "HBZ-WMVX19",
    serviceId: "company-registration",
    collectsDocs: true,
    checklist: [
      [
        t3(
          "Originals returned",
          "Originaux rendus",
          "Inyandiko z'umwimerere zasubijwe",
        ),
        true,
      ],
    ],
    evidence: ["signature"],
  },
  {
    n: 120,
    purpose: "pickup",
    day: 1,
    from: "09:00",
    to: "09:45",
    lat: -1.43,
    lng: 29.69,
    title: t3(
      "Collect bank statements",
      "Récupérer des relevés bancaires",
      "Gufata raporo za banki",
    ),
    todo: t3(
      "Collect 6 months of bank statements (copies).",
      "Récupérer 6 mois de relevés (copies).",
      "Fata raporo za banki z'amezi 6 (kopi).",
    ),
    address: "Gakenke centre",
    client: "coop",
    caseRef: "HBZ-ACTN01",
    serviceId: "business-plan",
    collectsDocs: true,
    checklist: [
      [
        t3("Statements collected", "Relevés récupérés", "Raporo zafashwe"),
        true,
      ],
    ],
    evidence: ["signature", "scan"],
  },
  {
    n: 121,
    purpose: "institution_submission",
    day: 1,
    from: "11:00",
    to: "11:30",
    lat: -1.4985,
    lng: 29.6345,
    title: t3(
      "Submit VAT forms at RRA",
      "Déposer les formulaires TVA au RRA",
      "Gutanga impapuro za TVA kuri RRA",
    ),
    todo: t3(
      "Submit the forms and photograph the receipt.",
      "Déposer les formulaires et photographier le reçu.",
      "Tanga impapuro ufotore inyemezabwishyu.",
    ),
    address: "RRA office, Musanze",
    institution: "RRA Musanze",
    client: "coop",
    caseRef: "HBZ-ACTN01",
    serviceId: "vat-declaration",
    checklist: [
      [t3("Forms submitted", "Formulaires déposés", "Impapuro zatanzwe"), true],
    ],
    evidence: ["photo"],
  },
];

const year = new Date().getFullYear();
const vid = (n: number) => `fv-${n}`;
const vref = (n: number) => `FT-${year}-${String(n).padStart(4, "0")}`;

export async function seedField(db: PgDatabase<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>, deps: SeedFieldDeps) {
  await db
    .insert(fieldAgents)
    .values({
      userId: AGENT,
      agentRef: "ag-emmanuel",
      districts: ["Musanze", "Burera", "Gakenke"],
      managerId: SM,
      managerName: "Diane Mukamana",
    })
    .onConflictDoUpdate({
      target: fieldAgents.userId,
      set: { revokedAt: null },
    });
  await db
    .insert(fieldSettings)
    .values({ id: "default", value: {} })
    .onConflictDoNothing();

  const rows = VISITS.map((v) => ({
    id: vid(v.n),
    ref: vref(v.n),
    agentUserId: AGENT,
    caseRef: v.caseRef,
    serviceId: v.serviceId,
    purpose: v.purpose,
    status: v.status ?? "scheduled",
    version: 1,
    officeVersion: 0,
    titleI18n: v.title,
    todoI18n: v.todo,
    institution: v.institution ?? null,
    address: v.address,
    lat: v.lat,
    lng: v.lng,
    windowStart: at(v.day, v.from),
    windowEnd: at(v.day, v.to),
    priority: v.priority ?? "normal",
    checklist: v.checklist.map(([label_i18n, required], i) => ({
      id: `ck-${v.n}-${i}`,
      label_i18n,
      required,
      done: false,
    })),
    evidenceRequired: v.evidence,
    clientEnc: deps.encrypt(contactJson(C[v.client])),
    collectsDocs: !!v.collectsDocs,
    cancelledReason: v.cancelledReason ?? null,
    offerExpiresAt: v.offerH
      ? new Date(Date.now() + v.offerH * 3600_000).toISOString()
      : null,
    createdBy: SM,
  }));
  // History: 11 completed visits earlier this month (earnings count), clamped to the 1st of the month.
  const dom = Number(kigaliDay(0).slice(8, 10));
  for (let i = 0; i < 11; i++) {
    const back = Math.min(dom - 1, 1 + (i % 10));
    const n = 98 + i;
    rows.push({
      ...rows[1],
      id: vid(n),
      ref: vref(n),
      status: "completed",
      caseRef: i % 2 ? "HBZ-4K2M9Q" : "HBZ-K2M9QA",
      windowStart: at(-back, "10:00"),
      windowEnd: at(-back, "10:45"),
      offerExpiresAt: null,
      cancelledReason: null,
      checklist: rows[1].checklist.map((c) => ({
        ...c,
        id: `ck-${n}-${c.id.split("-").pop()}`,
        done: true,
      })),
    });
  }
  for (const r of rows)
    await db
      .insert(fieldVisits)
      .values(r)
      .onConflictDoUpdate({
        target: fieldVisits.id,
        set: {
          windowStart: r.windowStart,
          windowEnd: r.windowEnd,
          offerExpiresAt: r.offerExpiresAt,
          status: r.status,
          updatedAt: new Date().toISOString(),
        },
      });

  const trail = (steps: Record<string, unknown>[]) => steps;
  const EMM = "Emmanuel Mugabo",
    DIANE = "Diane Mukamana",
    PAT = "Patrick Niyonzima";
  const ex = (
    n: number,
    p: {
      category: string;
      amount: number;
      state: string;
      days: number;
      note: string;
      visitRef?: string;
      flags?: string[];
      noReceiptReason?: string;
      payoutBatch?: string;
      trail: Record<string, unknown>[];
    },
  ) => ({
    id: `ex-${year}-${String(n).padStart(4, "0")}`,
    ref: `EX-${year}-${String(n).padStart(4, "0")}`,
    localRef: `EX-${year}-${String(n).padStart(4, "0")}`,
    visitId: null,
    visitRef: p.visitRef ?? null,
    category: p.category,
    amountRwf: p.amount,
    receiptKey: null,
    noReceiptReason: p.noReceiptReason ?? null,
    note: p.note,
    state: p.state,
    flags: p.flags ?? [],
    trail: p.trail,
    payoutBatch: p.payoutBatch ?? null,
    claimantId: AGENT,
    claimantName: EMM,
    createdAt: ago(p.days),
  });
  await db
    .insert(fieldExpenses)
    .values([
      ex(41, {
        category: "moto",
        amount: 2_500,
        state: "paid",
        days: 12,
        note: "Moto taxi to RDB office",
        visitRef: vref(98),
        payoutBatch: `PB-${year}-11`,
        trail: trail([
          { step: "submitted", by: EMM, byId: AGENT, at: ago(12) },
          {
            step: "sm",
            by: DIANE,
            byId: SM,
            at: ago(11),
            decision: "approved",
          },
          {
            step: "finance",
            by: PAT,
            byId: "mock-finance",
            at: ago(10),
            decision: "approved",
          },
          { step: "paid", at: ago(5) },
        ]),
      }),
      ex(42, {
        category: "stationery",
        amount: 1_200,
        state: "finance_approved",
        days: 6,
        note: "Copies of statutes",
        trail: trail([
          { step: "submitted", by: EMM, byId: AGENT, at: ago(6) },
          { step: "sm", by: DIANE, byId: SM, at: ago(5), decision: "approved" },
          {
            step: "finance",
            by: PAT,
            byId: "mock-finance",
            at: ago(4),
            decision: "approved",
          },
        ]),
      }),
      ex(43, {
        category: "transport",
        amount: 3_000,
        state: "sm_approved",
        days: 3,
        note: "Bus Musanze–Burera",
        trail: trail([
          { step: "submitted", by: EMM, byId: AGENT, at: ago(3) },
          { step: "sm", by: DIANE, byId: SM, at: ago(2), decision: "approved" },
        ]),
      }),
      ex(44, {
        category: "moto",
        amount: 6_000,
        state: "submitted",
        days: 1,
        note: "Moto taxi Kinigi return trip",
        flags: ["over_cap"],
        noReceiptReason: "Driver had no receipt book",
        trail: trail([{ step: "submitted", by: EMM, byId: AGENT, at: ago(1) }]),
      }),
      ex(45, {
        category: "meal",
        amount: 1_000,
        state: "rejected",
        days: 8,
        note: "Lunch",
        trail: trail([
          { step: "submitted", by: EMM, byId: AGENT, at: ago(8) },
          {
            step: "sm",
            by: DIANE,
            byId: SM,
            at: ago(7),
            decision: "rejected",
            reason:
              "Meals are not reimbursed for same-district visits (PLACEHOLDER policy).",
          },
        ]),
      }),
    ])
    .onConflictDoNothing();

  const month = kigaliDay(0).slice(0, 7);
  await db
    .insert(fieldPoolShares)
    .values([
      {
        id: `fps-${month}-1`,
        agentUserId: AGENT,
        caseRef: "HBZ-K2M9QA",
        service: "Company registration (RDB)",
        poolRwf: 18_000,
        state: "approved",
        month,
      },
      {
        id: `fps-${month}-2`,
        agentUserId: AGENT,
        caseRef: "HBZ-ACTN01",
        service: "Business plan",
        poolRwf: 24_000,
        state: "allocated",
        month,
      },
    ])
    .onConflictDoNothing();

  for (const [name, value] of [
    ["visit", 121],
    ["receipt", 230],
    ["expense", 45],
    ["cash", 11],
    ["incident", 0],
  ] as const)
    await db
      .insert(fieldCounters)
      .values({ name, value })
      .onConflictDoUpdate({
        target: fieldCounters.name,
        set: { value: dsql`greatest(${fieldCounters.value}, ${value})` },
      });
}
