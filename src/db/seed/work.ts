// Dev/staging seed (port of .ref work.seed): Jean-Paul (mock-ext) is firm admin of the fictional Ingabo Advisory Ltd with
// member Chantal (mock-ext-member) and a pending invite; three live offers on unassigned intake cases; one /join application
// waiting on more information; the workforce extras' users/profiles (their wf_worker facts are seedWorkforce's).
// Idempotent (fixed ids, insert-if-missing). Run after seedAuth + seedCatalogue + seedOps + seedWorkforce.
// PII in onboarding is encrypted with `deps.encrypt` (FIELD_KEY) when given, else left empty.
import { and, asc, eq, isNull } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type * as schema from "../schema";
import { agentProfiles, applications, opsRecords, services, users } from "../schema";

type Db = PgDatabase<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
const JP = "mock-ext";
const CH = "mock-ext-member";
const SM = "mock-sm";
const FIRM = "firm_ingabo";
const H = 3600_000;
const D = 24 * H;
const LICENCE = 500; // POLICY.licenceFeeMonthly
const DEFAULT_BPS = 3000; // POLICY.defaultAgentBps
const at = (h: number) => new Date(Date.now() + h * H).toISOString();
const day = (d: number) =>
  new Date(Date.now() + d * D).toISOString().slice(0, 10);
const month = (offset: number) => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + offset);
  return d.toISOString().slice(0, 7);
};
const NO_LOGIN = "!seed-no-login";

type Kind = "service_agreement" | "nda" | "sla";
const TERMS: Record<Kind, string[]> = {
  service_agreement: [
    "You deliver the services listed in your rate card to HEBUZA's standards and deadlines.",
    "You are paid your agreed share of the eligible fee once the client's payment is confirmed and the job is completed.",
    "Withholding tax is deducted from every payout; the monthly licence fee is netted after withholding tax.",
    "Either side may end the agreement with written notice; open jobs are reassigned.",
  ],
  nda: [
    "Client information is used only for the job it was shared for.",
    "You do not copy, forward or keep client documents after a job closes.",
    "Downloads are watermarked with your name and logged.",
  ],
  sla: [
    "Respond to offers within the offer window.",
    "Reply to the team lane within one business day.",
    "Ask for an extension before a deadline, not after.",
  ],
};
const TITLE: Record<Kind, string> = {
  service_agreement: "Service agreement",
  nda: "Non-disclosure agreement",
  sla: "Service level agreement",
};
const doc = (kind: Kind, start: string) => ({
  id: `doc-${kind === "service_agreement" ? "sa" : kind}`,
  kind,
  title: TITLE[kind],
  version: 1,
  status: "pending_signature",
  start,
  end:
    kind === "service_agreement"
      ? new Date(Date.parse(start) + 365 * D).toISOString().slice(0, 10)
      : null,
  noticeDays: kind === "service_agreement" ? 30 : 0,
  terms: TERMS[kind],
});
const signed = (
  d: ReturnType<typeof doc>,
  signedAt: string,
  typedName: string,
  sha256: string,
) => ({
  ...d,
  status: "active",
  signedAt,
  evidence: { ip: "127.0.0.1", sha256, typedName },
});
const fresh = () => ({
  status: "onboarding",
  firmId: null as string | null,
  firmRole: null as string | null,
  services: [] as unknown[],
  contract: (["nda", "sla", "service_agreement"] as const).map((k) =>
    doc(k, day(0)),
  ) as unknown[],
  licence: [] as unknown[],
  credentials: [] as unknown[],
  notice: null,
  onboarding: {} as Record<string, unknown>,
  payoutDest: null as unknown,
  history: [] as unknown[],
  invoices: [] as unknown[],
  seq: 0,
});

export async function seedWork(
  db: Db,
  deps: { encrypt?: (plain: string) => string } = {},
) {
  const enc = (v: string) => (deps.encrypt ? deps.encrypt(v) : "");
  const now = new Date().toISOString();
  const svc = new Map((await db.select({ slug: services.slug, name: services.name }).from(services)).map((r) => [r.slug, r.name]));
  const name = (slug: string) => svc.get(slug) ?? slug;
  const put = (
    id: string,
    kind: string,
    data: unknown,
    x: { ownerId?: string; ref?: string; state?: string } = {},
  ) =>
    db
      .insert(opsRecords)
      .values({
        id,
        kind,
        ownerId: x.ownerId ?? null,
        ref: x.ref ?? null,
        state: x.state ?? null,
        data: data as object,
      })
      .onConflictDoNothing();

  // ── people ──
  const person = (
    userId: string,
    n: string,
    email: string,
    phone: string,
    role: string,
    active: boolean,
    pw = NO_LOGIN,
  ) => ({
    userId,
    name: n,
    email,
    phoneE164: phone,
    passwordHash: pw,
    role,
    isActive: active,
    isEmailVerified: active,
    language: "en",
    createdAt: now,
    updatedAt: now,
  });
  await db
    .insert(users)
    .values([
      person(
        CH,
        "Chantal Mukamana",
        "chantal.mukamana@ingabo.example",
        "+250788100304",
        "ext:agent",
        true,
      ),
      person(
        "mock-field",
        "Patrick Niyonzima",
        "patrick.niyonzima@hebuza.example",
        "+250788100301",
        "staff:agent",
        true,
      ),
      person(
        "wk-new",
        "Solange Iradukunda",
        "solange.iradukunda@hebuza.example",
        "+250788100302",
        "staff:agent",
        true,
        "!invited",
      ),
      person(
        "wk-old",
        "Yves Habineza",
        "yves.habineza@example.test",
        "+250788100303",
        "ext:agent",
        false,
      ),
    ])
    .onConflictDoNothing();
  await db
    .insert(agentProfiles)
    .values([
      {
        userId: CH,
        title: "Tax adviser",
        external: true,
        cap: 4,
        managerId: SM,
        languages: ["rw", "fr"],
        services: ["vat-declaration", "paye-monthly-filing"],
        skillsLabel: ["VAT", "PAYE"],
        clearance: "cleared",
      },
      {
        userId: "mock-field",
        title: "Field agent",
        external: false,
        cap: 6,
        managerId: SM,
        languages: ["rw", "en"],
        services: ["company-registration"],
        skillsLabel: ["Field visits", "RDB"],
        onTimeBps: 9100,
        ratingX10: 45,
        clearance: "cleared",
      },
      {
        userId: "wk-new",
        title: "Agent",
        external: false,
        cap: 5,
        managerId: SM,
        languages: ["rw", "fr"],
        clearance: "new",
      },
      {
        userId: "wk-old",
        title: "Agent",
        external: true,
        cap: 4,
        managerId: SM,
        languages: ["rw", "en"],
        services: ["vat-declaration"],
        skillsLabel: ["Tax filing"],
        onTimeBps: 6200,
        ratingX10: 31,
        clearance: "submitted",
      },
    ])
    .onConflictDoNothing();

  // ── firm + rate card ──
  const jpSvcs = [
    "vat-declaration",
    "paye-monthly-filing",
    "tax-clearance-certificate",
    "business-plan",
  ];
  await put(
    FIRM,
    "work_firm",
    {
      name: "Ingabo Advisory Ltd",
      account: "Bank •••• 4821",
      adminId: JP,
      members: [
        {
          id: JP,
          name: "Jean-Paul Nkurunziza",
          email: "jean-paul.nkurunziza@ingabo.example",
          role: "admin",
          services: jpSvcs,
        },
        {
          id: CH,
          name: "Chantal Mukamana",
          email: "chantal.mukamana@ingabo.example",
          role: "member",
          services: ["vat-declaration", "paye-monthly-filing"],
        },
        {
          id: "inv_olivier",
          name: "Olivier Habineza",
          email: "olivier.habineza@ingabo.example",
          role: "member",
          services: ["business-plan"],
          invited: true,
        },
      ],
      removals: {},
    },
    { ownerId: JP },
  );
  const rate = (serviceId: string, r: { bps?: number; flat?: number }) => ({
    serviceId,
    serviceName: name(serviceId),
    ...r,
    from: "2026-08-01",
    status: "approved",
  });
  await put(
    `wr:${FIRM}`,
    "work_rates",
    {
      rows: [
        rate("vat-declaration", { flat: 4_500 }),
        rate("paye-monthly-filing", { flat: 4_000 }),
        rate("tax-clearance-certificate", { bps: DEFAULT_BPS }),
        rate("business-plan", { bps: 3500 }),
        rate("company-registration", { bps: 3500 }),
      ],
    },
    { ownerId: FIRM },
  );

  // ── external workers ──
  const creds = [
    {
      id: "cr-icpar",
      kind: "professional_body",
      title: "iCPAR membership",
      issuer: "iCPAR",
      number: "ICPAR-•••• 2231",
      issuedOn: "2024-01-15",
      expiresOn: day(45),
      status: "verified",
      fileName: "icpar-membership.pdf",
      services: [
        "vat-declaration",
        "paye-monthly-filing",
        "tax-clearance-certificate",
      ],
    },
    {
      id: "cr-bl",
      kind: "license",
      title: "Business licence",
      issuer: "RDB",
      number: "BL-•••• 7781",
      issuedOn: "2025-03-02",
      expiresOn: "2027-03-01",
      status: "pending",
      fileName: "business-licence.pdf",
      services: ["business-plan"],
    },
    {
      id: "cr-ta",
      kind: "certificate",
      title: "Tax adviser certificate",
      issuer: "RRA",
      number: "TA-•••• 0912",
      issuedOn: "2023-11-01",
      expiresOn: day(-3),
      status: "expired",
      note: "Expired — upload the renewed certificate to be cleared again for company registration.",
      fileName: "tax-adviser.pdf",
      services: ["company-registration"],
    },
  ];
  const lic = (offset: number, n: string, status: string) => ({
    number: `INV-${month(offset).slice(0, 4)}-${n}`,
    period: month(offset),
    amount: LICENCE,
    due: `${month(offset)}-05`,
    status,
  });
  const complete = (slugs: string[], payName: string) => ({
    identity: {
      idType: "national_id",
      idEnc: enc("1198780012344821"),
      slots: {
        id_front: { status: "uploaded", fileName: "id-front.jpg" },
        id_back: { status: "uploaded", fileName: "id-back.jpg" },
        selfie: { status: "uploaded", fileName: "selfie.jpg" },
      },
    },
    payout: {
      method: "bank",
      bank: "Commercial bank (text)",
      accountEnc: enc("00040004821"),
      name: payName,
      tinEnc: "",
    },
    services: { slugs, maxJobs: 5, days: ["mon", "tue", "wed", "thu", "fri"] },
    savedAt: "2026-07-28T09:00:00Z",
    submittedAt: "2026-07-28T09:20:00Z",
    changes: null,
  });
  const cleared = (s: string) => ({ slug: s, name: name(s), state: "cleared" });
  const jp = {
    ...fresh(),
    status: "cleared",
    firmId: FIRM,
    firmRole: "admin",
    services: [
      ...jpSvcs.map(cleared),
      {
        slug: "company-registration",
        name: name("company-registration"),
        state: "not_cleared",
        reason: "credentialExpired",
      },
    ],
    contract: [
      signed(
        doc("nda", "2026-08-01"),
        "2026-07-28T09:05:00Z",
        "Jean-Paul Nkurunziza",
        "1b3d5f7a9c0e2f4a6b8d0c1e3f5a7b9d1c3e5f7a9b0d2c4e6f8a0b1c3d5e7f9a",
      ),
      { ...doc("sla", day(15)), version: 2 },
      signed(
        { ...doc("service_agreement", "2026-08-01"), version: 2, end: day(28) },
        "2026-07-28T09:12:00Z",
        "Jean-Paul Nkurunziza",
        "9f2c4e1ab07d5c3e88a1f0b2d6e4c9a7b3f5d1e0c2a4b6d8e0f1a3c5e7b9d2f4",
      ),
    ],
    licence: [
      lic(-1, "L0412", "netted"),
      lic(0, "L0518", "paid"),
      lic(1, "L0631", "due"),
    ],
    credentials: creds,
    onboarding: complete(jpSvcs, "Jean-Paul Nkurunziza"),
    payoutDest: {
      method: "bank",
      label: "Bank transfer",
      last4: "4821",
      status: "verified",
      coolingUntil: null,
    },
    history: [
      {
        id: "h4",
        at: "2026-09-10T08:45:00Z",
        kind: "rate",
        text: "Business plan rate set to 35% — approved by Finance",
        by: "Diane Mukamana",
      },
      {
        id: "h3",
        at: "2026-09-02T14:20:00Z",
        kind: "version",
        text: "Service agreement v2 issued (notice clause clarified)",
        by: "Diane Mukamana",
      },
      {
        id: "h2",
        at: "2026-07-28T09:12:00Z",
        kind: "signed",
        text: "Service agreement v1 signed",
        by: "Jean-Paul Nkurunziza",
      },
      {
        id: "h1",
        at: "2026-07-28T09:05:00Z",
        kind: "signed",
        text: "Non-disclosure agreement v1 signed",
        by: "Jean-Paul Nkurunziza",
      },
    ],
    invoices: [
      {
        id: "inv-2",
        number: "IA-2026-031",
        period: month(-1),
        amount: 42_000,
        fileName: "ingabo-2026-031.pdf",
        status: "accepted",
        at: at(-24 * 14),
      },
      {
        id: "inv-1",
        number: "IA-2026-024",
        period: month(-2),
        amount: 38_500,
        fileName: "ingabo-2026-024.pdf",
        status: "rejected",
        note: "TIN missing on the invoice — please reissue.",
        at: at(-24 * 44),
      },
    ],
    seq: 4,
  };
  const ch = {
    ...fresh(),
    status: "cleared",
    firmId: FIRM,
    firmRole: "member",
    services: ["vat-declaration", "paye-monthly-filing"].map(cleared),
    contract: [
      signed(
        doc("nda", "2026-08-01"),
        "2026-08-05T10:00:00Z",
        "Chantal Mukamana",
        "3c5e7a9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c",
      ),
    ],
    credentials: [creds[0]],
    onboarding: complete(
      ["vat-declaration", "paye-monthly-filing"],
      "Chantal Mukamana",
    ),
    history: [
      {
        id: "h1",
        at: "2026-08-05T10:00:00Z",
        kind: "signed",
        text: "Non-disclosure agreement v1 signed",
        by: "Chantal Mukamana",
      },
    ],
    seq: 1,
  };
  const yves = {
    ...fresh(),
    status: "suspended",
    services: [cleared("vat-declaration")],
  };
  for (const [uid, st] of [
    [JP, jp],
    [CH, ch],
    ["wk-old", yves],
  ] as const)
    await put(`wx:${uid}`, "work_ext", st, {
      ownerId: uid,
      state: st.status,
      ref: st.firmId ?? undefined,
    });

  // ── offers to Jean-Paul + Chantal's own job (unassigned intake cases, so /ops and /work agree) ──
  const intake = await db
    .select()
    .from(applications)
    .where(
      and(
        eq(applications.status, "received"),
        isNull(applications.assignedAgentId),
      ),
    )
    .orderBy(asc(applications.code));
  const taken: string[] = [];
  const pick = (slug: string) => {
    const c =
      intake.find((x) => x.serviceSlug === slug && !taken.includes(x.code)) ??
      intake.find((x) => !taken.includes(x.code));
    if (c) taken.push(c.code);
    return c;
  };
  const OFFERS: [
    string,
    string,
    number,
    number,
    number,
    [number, number],
    string[],
  ][] = [
    [
      "vat-declaration",
      "Prepare and file the monthly VAT declaration on RRA e-Tax.",
      -0.5,
      50,
      3,
      [4, 7],
      ["VAT", "RRA e-Tax"],
    ],
    [
      "business-plan",
      "Draft a bankable business plan for a loan application.",
      -1,
      120,
      10,
      [3, 6],
      ["Business plan"],
    ],
    [
      "paye-monthly-filing",
      "File the monthly PAYE return for 12 employees.",
      -0.2,
      40,
      2,
      [3, 5],
      ["PAYE"],
    ],
  ];
  for (const [slug, summary, sentH, dueH, effortH, shared, skills] of OFFERS) {
    const c = pick(slug);
    if (!c) continue;
    await put(
      `of-x-${c.code}`,
      "offer",
      {
        agentId: JP,
        agentName: "Jean-Paul Nkurunziza",
        state: "sent",
        sentAt: at(sentH),
        expiresAt: at(Math.max(4 + sentH, 2)), // PLACEHOLDER(offer-ttl): never already past on seed
        summary,
        dueAt: at(dueH),
        effortH,
        eligible: c.agreedAmountRwf ?? c.paymentAmount ?? 50_000,
        shared,
        skills,
      },
      { ownerId: JP, ref: c.code, state: "sent" },
    );
  }
  const chJob = pick("vat-declaration");
  if (chJob)
    await db
      .update(applications)
      .set({
        assignedAgentId: CH,
        assignedAt: now,
        status: "in_progress",
        updatedAt: now,
      })
      .where(
        and(
          eq(applications.code, chJob.code),
          isNull(applications.assignedAgentId),
        ),
      );

  // ── /join: one firm application waiting on more information ──
  const y = new Date().getFullYear();
  const ref = `APP-${y}-0088`;
  await put(
    ref,
    "work_app",
    {
      app: {
        ref,
        status: "info_requested",
        kind: "firm",
        name: "Ingabo Advisory Ltd",
        submittedAt: at(-72),
        flaggedFields: ["regNumber", "expertise"],
        decisionNote:
          "Please add your iCPAR registration number and describe your VAT experience.",
      },
      email: "apply@ingabo.example",
      draft: {
        kind: "firm",
        name: "Aline Ingabire",
        email: "apply@ingabo.example",
        firmName: "Ingabo Advisory Ltd",
        services: ["vat-declaration"],
        regNumber: "",
        expertise: "",
      },
      ops: [],
    },
    { ownerId: "apply@ingabo.example", state: "info_requested" },
  );
  await put(`work_join_seq:${y}`, "work_seq", { n: 88 });
}
