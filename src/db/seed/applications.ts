// Dev/staging seed for the client core (port of .ref applications.seed, part 1): contract users, seed services, cases,
// status history, document requests, notifications and support tickets. Idempotent (fixed ids + ON CONFLICT DO NOTHING),
// relative dates, anonymised people. Never run in production. Documents/deliverables: seed/documents.ts (run after).
import { inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type * as schema from "../schema";
import {
  applicationStatusHistory,
  applications,
  servicePricingTiers,
  serviceStructureVersions,
  services,
  users,
} from "../schema/schema";
import { documentRequests, supportTicketMessages, supportTickets } from "../schema/schema-applications";
import { notifications } from "../schema/schema-notifications";

type Db = PgDatabase<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;
/** Contract personas sign as `mock-<persona key>` (tests/contract/runner.ts). */
export const SEED_CLIENT = "mock-client";
export const SEED_AGENT = "mock-agent";
export const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString();
// Unusable hash: seeded people sign in through P1's own seed/fixtures, never with a password from here.
const NO_LOGIN = "!seed-no-login";

const SERVICES = [
  ["company-registration", "Company registration", "rdb", 20_000],
  ["vat-registration", "VAT registration", "rra", 3_000],
  ["tax-clearance", "Tax clearance certificate", "rra", 10_000],
  ["trademark-search", "Trademark search", "rdb", 15_000],
  ["trademark-filing", "Trademark filing", "rdb", 20_000],
] as const;

type AppSeed = {
  code: string;
  slug: string;
  status: string;
  pay: string;
  amount: number;
  at: number;
  agent?: boolean;
  pi?: Record<string, unknown>;
};
// Newest first per screen, so each list leads with the same kind of row as its mock.
const APPS: AppSeed[] = [
  {
    code: "HBZ-K2M9QA",
    slug: "company-registration",
    status: "completed_delivered",
    pay: "paid",
    amount: 20_000,
    at: -1,
    agent: true,
  },
  {
    code: "HBZ-4K2M9Q",
    slug: "company-registration",
    status: "awaiting_client_documents",
    pay: "paid",
    amount: 20_000,
    at: -1.5,
    agent: true,
    pi: {},
  },
  {
    code: "HBZ-7PX31A",
    slug: "vat-registration",
    status: "awaiting_payment",
    pay: "pending",
    amount: 3_000,
    at: -2,
  },
  {
    code: "HBZ-WMVX19",
    slug: "vat-registration",
    status: "in_progress",
    pay: "pending", // c3 invoice INV-2026-00431 is due; payments.seed.ts keeps it unpaid too
    amount: 3_000,
    at: -7,
    agent: true,
    pi: {
      fullName: "Demo Client",
      phone: "+250788000000",
      email: "anne@example.rw",
    },
  },
  {
    code: "HBZ-ACTN01",
    slug: "trademark-filing",
    status: "in_progress",
    pay: "pending", // balance 5,000 locks its deliverable (c3) — same amount as payments.seed.ts
    amount: 5_000,
    at: -8,
    agent: true,
  },
  {
    code: "HBZ-9QW5ZE",
    slug: "trademark-search",
    status: "in_progress",
    pay: "paid",
    amount: 15_000,
    at: -12,
    agent: true,
  },
  {
    code: "HBZ-2RT8LM",
    slug: "tax-clearance",
    status: "completed_delivered",
    pay: "paid",
    amount: 10_000,
    at: -30,
    agent: true,
  },
];

export async function seedApplications(root: Db) {
  if (process.env.NODE_ENV === "production") throw new Error("refusing to seed production");
  // FORCE RLS binds the table owner too: the seed acts as `system` inside its own transaction.
  await root.transaction(async (db) => {
  await db.execute(sql`select set_config('app.roles', 'system', true)`);
  const now = new Date().toISOString();
  await db
    .insert(users)
    .values([
      {
        userId: SEED_CLIENT,
        name: "Demo Client",
        email: "client@example.test",
        phoneE164: "+250788000000", // the tracker mock's verifying contact
        passwordHash: NO_LOGIN,
        role: "client",
        isActive: true,
        isEmailVerified: true,
        language: "en",
        createdAt: day(-90),
        updatedAt: now,
      },
      {
        userId: "mock-client-b",
        name: "Demo Client B",
        email: "client-b@example.test",
        phoneE164: null,
        passwordHash: NO_LOGIN,
        role: "client",
        isActive: true,
        isEmailVerified: true,
        language: "en",
        createdAt: day(-60),
        updatedAt: now,
      },
      {
        userId: SEED_AGENT,
        name: "Eric Habimana",
        email: "eric.habimana@hebuza.example",
        phoneE164: null,
        passwordHash: NO_LOGIN,
        role: "staff:agent",
        isActive: true,
        isEmailVerified: true,
        language: "en",
        createdAt: day(-200),
        updatedAt: now,
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(services)
    .values(
      SERVICES.map(([slug, name, category]) => ({
        serviceId: `svc_seed_${slug}`,
        slug,
        name,
        category,
        status: "published",
        publishedVersion: 1,
        isFeatured: false,
        createdAt: now,
        updatedAt: now,
        handler: "agent",
        deadlineMode: "none",
        pricingMode: "fixed",
        planCovered: false,
      })),
    )
    .onConflictDoNothing();
  // P2 may already own these slugs under other ids: resolve by slug.
  const svc = new Map(
    (
      await db
        .select({ id: services.serviceId, slug: services.slug })
        .from(services)
        .where(
          inArray(
            services.slug,
            SERVICES.map((s) => s[0]),
          ),
        )
    ).map((r) => [r.slug, r.id]),
  );
  await db
    .insert(servicePricingTiers)
    .values(
      SERVICES.map(([slug, , , fee]) => ({
        id: `tier_seed_${slug}`,
        serviceId: svc.get(slug)!,
        tier: "standard",
        displayName: "Standard",
        platformFee: fee,
        governmentFee: 0,
        etaBusinessDays: 5,
        features: [],
        isAvailable: true,
      })),
    )
    .onConflictDoNothing();
  await db
    .insert(serviceStructureVersions)
    .values(
      SERVICES.map(([slug]) => ({
        id: `ssv_seed_${slug}`,
        serviceId: svc.get(slug)!,
        version: 1,
        status: "published",
        definition: { steps: [] },
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoNothing();
  const structure = new Map(
    (
      await db
        .select({
          id: serviceStructureVersions.id,
          s: serviceStructureVersions.serviceId,
        })
        .from(serviceStructureVersions)
        .where(inArray(serviceStructureVersions.serviceId, [...svc.values()]))
    ).map((r) => [r.s, r.id]),
  );

  const name = new Map<string, string>(SERVICES.map(([slug, n]) => [slug, n]));
  // Same id scheme as payments.seed.ts, so both seeds address the same rows whichever runs first.
  const id = (code: string) => `app_seed_${code.slice(4).toLowerCase()}`;
  await db
    .insert(applications)
    .values(
      APPS.map((a) => ({
        applicationId: id(a.code),
        code: a.code,
        serviceId: svc.get(a.slug)!,
        structureVersionId: structure.get(svc.get(a.slug)!)!,
        serviceSlug: a.slug,
        serviceName: name.get(a.slug)!,
        tier: "standard",
        status: a.status,
        handler: "agent",
        ending: "payable",
        clientId: SEED_CLIENT,
        assignedAgentId: a.agent ? SEED_AGENT : null,
        assignedAt: a.agent ? day(a.at + 0.5) : null,
        personalInfo: a.pi ?? {
          fullName: "Demo Client",
          phone: "+250788000001",
        },
        serviceData: a.pi ? {} : { company_name: "Example Trading Ltd" },
        paymentStatus: a.pay,
        paymentAmount: a.amount,
        slaDeadline: day(a.at + 9),
        dueAt: day(a.at + 11),
        dueSource: "sla",
        isUrgent: false,
        partnerClientLaneOpen: false,
        submittedAt: day(a.at),
        createdAt: day(a.at),
        updatedAt: day(a.at + 1),
        completedAt:
          a.status === "completed_delivered" ? day(a.at + 0.9) : null,
      })),
    )
    .onConflictDoNothing();
  await db
    .insert(applicationStatusHistory)
    .values(
      APPS.flatMap((a) => [
        {
          id: `ash_seed_${a.code}_0`,
          applicationId: id(a.code),
          status: "received",
          changedBy: SEED_CLIENT,
          changedByRole: "client",
          note: "Application submitted.",
          createdAt: day(a.at),
        },
        {
          id: `ash_seed_${a.code}_1`,
          applicationId: id(a.code),
          status: a.status,
          changedBy: SEED_AGENT,
          changedByRole: "staff:agent",
          note: null,
          createdAt: day(a.at + 0.8),
        },
      ]),
    )
    .onConflictDoNothing();

  // payments.seed.ts inserts some of the same cases without the case-side fields; fill what is missing (never overwrite).
  for (const a of APPS)
    await db.execute(sql`update applications set
      assigned_agent_id = coalesce(assigned_agent_id, ${a.agent ? SEED_AGENT : null}),
      assigned_at = coalesce(assigned_at, ${a.agent ? day(a.at + 0.5) : null}),
      sla_deadline = coalesce(sla_deadline, ${day(a.at + 9)}), due_at = coalesce(due_at, ${day(a.at + 11)})
      where application_id = ${id(a.code)}`);
  // payments.seed.ts may have created the contract users without contact details; the tracker verifies by phone.
  await db.execute(
    sql`update users set phone_e164 = '+250788000000' where user_id = ${SEED_CLIENT} and phone_e164 is null`,
  );

  await db
    .insert(documentRequests)
    .values([
      {
        id: "dreq_seed_4k2m9q",
        applicationId: id("HBZ-4K2M9Q"),
        requirementKey: "proof_of_address",
        label: "Proof of business address",
        dueAt: day(1),
        requestedBy: SEED_AGENT,
        createdAt: day(-1),
      },
      {
        id: "dreq_seed_actn01",
        applicationId: id("HBZ-ACTN01"),
        requirementKey: "proof_of_address",
        label: "Proof of business address",
        dueAt: day(2),
        requestedBy: SEED_AGENT,
        createdAt: day(-2),
      },
    ])
    .onConflictDoNothing();

  const h = (n: number) => new Date(Date.now() - n * 36e5).toISOString();
  await db
    .insert(notifications)
    .values([
      {
        // Booking notes carry typed vars so the bell can localise them (handlers-c4 + booking-notes.ts).
        id: "ntf_seed_booking",
        userId: SEED_CLIENT,
        channel: "whatsapp",
        kind: "booking",
        data: {
          type: "booking.reminder_24h",
          vars: {
            ref: "BK-2026-0042",
            type: "Intro call",
            type_en: "Intro call",
            type_fr: "Appel découverte",
            type_rw: "Ikiganiro cy'ibanze",
            when: day(1),
            name: "Demo Client",
          },
        },
        title: "Reminder: your intro call is tomorrow",
        body: "",
        href: "/bookings",
        createdAt: h(0.5),
      },
      {
        id: "ntf_seed_1",
        userId: SEED_CLIENT,
        channel: "email",
        kind: "document",
        title: "Your document is ready",
        body: "Your certificate is available to download.",
        href: "/documents",
        createdAt: h(1),
      },
      {
        id: "ntf_seed_2",
        userId: SEED_CLIENT,
        channel: "sms",
        kind: "doc_request",
        title: "Action needed: upload a missing document",
        body: "Upload your proof of address to continue request HBZ-4K2M9Q.",
        href: "/requests/HBZ-4K2M9Q",
        createdAt: h(2),
      },
      {
        id: "ntf_seed_3",
        userId: SEED_CLIENT,
        channel: "whatsapp",
        kind: "payment_request",
        title: "Payment received",
        body: "RWF 3,000 for VAT registration.",
        href: "/billing",
        readAt: h(20),
        createdAt: h(26),
      },
      {
        id: "ntf_seed_4",
        userId: SEED_CLIENT,
        channel: "email",
        kind: "message",
        title: "New message from your adviser",
        body: "Your request has been approved.",
        href: "/requests",
        readAt: h(40),
        createdAt: h(48),
      },
    ])
    .onConflictDoNothing();

  const y = new Date().getFullYear();
  const tickets = [
    {
      id: "tkt_seed_142",
      ref: `TKT-${y}-00142`,
      subject: "Refund not received",
      status: "open",
      at: 5,
      msgs: [
        ["me", "I asked for a refund last week and have not received it.", 5],
      ],
    },
    {
      id: "tkt_seed_141",
      ref: `TKT-${y}-00141`,
      subject: "Document not accepted",
      status: "waiting",
      at: 30,
      msgs: [
        ["me", "The office did not accept my document.", 30],
        [
          "support",
          "Sorry about that. Please upload a clearer scan of page 2.",
          20,
        ],
      ],
    },
    {
      id: "tkt_seed_137",
      ref: `TKT-${y}-00137`,
      subject: "General inquiry",
      status: "resolved",
      at: 80,
      msgs: [
        ["me", "Which documents do I need for a tax clearance?", 80],
        [
          "support",
          "Your ID and your TIN certificate. We have added the checklist to your request.",
          70,
        ],
      ],
    },
  ] as const;
  await db
    .insert(supportTickets)
    .values(
      tickets.map((t) => ({
        id: t.id,
        ref: t.ref,
        userId: SEED_CLIENT,
        subject: t.subject,
        status: t.status,
        createdAt: h(t.at),
        updatedAt: h(t.msgs.at(-1)![2]),
      })),
    )
    .onConflictDoNothing();
  await db
    .insert(supportTicketMessages)
    .values(
      tickets.flatMap((t) =>
        t.msgs.map(([side, body, at], i) => ({
          id: `${t.id}_m${i}`,
          ticketId: t.id,
          authorId: side === "me" ? SEED_CLIENT : SEED_AGENT,
          side,
          body,
          createdAt: h(at),
        })),
      ),
    )
    .onConflictDoNothing();

  });
}
