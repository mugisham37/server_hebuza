// Dev/staging seed runner: `pnpm db:seed` (DATABASE_URL, FIELD_KEY, BLIND_INDEX_KEY). Every seed is idempotent.
// Runs in one transaction as `system` (FORCE RLS binds the table owner too). Never in production.
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { hash } from "@node-rs/argon2";
import { blindIndex, encrypt as enc, key32 } from "@/domain/crypto";
import * as schema from "../schema";
import { seedAuth } from "./auth";
import { seedSystem, seedCompliance } from "./system";
import { seedCatalogue, seedPlans } from "./catalogue";
import { seedApplications } from "./applications";
import { seedDocuments } from "./documents";
import { seedBooking } from "./booking";
import { seedOps } from "./ops";
import { seedChat } from "./chat";
import { seedWorkforce } from "./workforce";
import { seedCms } from "./cms";
import { seedAssistant } from "./assistant";
import { seedField } from "./field";
import { seedWork } from "./work";
import { seedAgent } from "./agent";
import { seedPayments } from "./payments";
import { seedFinance } from "./finance";
import { seedProcurement } from "./procurement";
import { seedMarketing } from "./marketing";

if (process.env.NODE_ENV === "production") throw new Error("refusing to seed production");
const url = process.env.DATABASE_URL;
const fieldKey = process.env.FIELD_KEY;
const blindKey = process.env.BLIND_INDEX_KEY;
if (!url || !fieldKey || !blindKey) throw new Error("DATABASE_URL, FIELD_KEY and BLIND_INDEX_KEY are required");

const key = key32(fieldKey, "FIELD_KEY");
const encrypt = (plain: string) => enc(key, plain);
const bKey = key32(blindKey, "BLIND_INDEX_KEY");
const blind = (v: string) => blindIndex(bKey, v);
// Same argon2id params as server PasswordService.
const hashPw = (pw: string) => hash(pw, { memoryCost: 65536, timeCost: 3, parallelism: 1 });

const client = postgres(url, { max: 1 });
const db = drizzle(client, { schema });
try {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.roles', 'system', true)`);
    const step = async (name: string, fn: () => Promise<unknown>) => (await fn(), console.log(`seeded ${name}`));
    await step("auth", () => seedAuth(tx, { hash: hashPw, encrypt }));
    await step("system", () => seedSystem(tx));
    await step("compliance", () => seedCompliance(tx));
    await step("catalogue", () => seedCatalogue(tx));
    await step("plans", () => seedPlans(tx));
    await step("applications", () => seedApplications(tx));
    // shortcut: no S3 `put` here, seeded deliverables have rows but no objects; pass a StorageService put when demos need downloads.
    await step("documents", () => seedDocuments(tx));
    await step("booking", () => seedBooking(tx, { encrypt }));
    await step("ops", () => seedOps(tx));
    await step("chat", () => seedChat(tx));
    await step("workforce", () => seedWorkforce(tx, { encrypt }));
    await step("cms", () => seedCms(tx));
    await step("assistant", () => seedAssistant(tx));
    await step("field", () => seedField(tx, { encrypt }));
    await step("work", () => seedWork(tx, { encrypt }));
    await step("agent", () => seedAgent(tx));
    await step("payments", () => seedPayments(tx));
    await step("finance", () => seedFinance(tx, { encrypt }));
    await step("procurement", () => seedProcurement(tx, { encrypt, blind }));
    await step("marketing", () => seedMarketing(tx));
  });
} finally {
  await client.end();
}
