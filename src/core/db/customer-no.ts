// CRM-01/IAM-24: assign the next HBC number (gapless per year: the row lock on customer_sequences serialises callers).
import { and, eq, isNull, sql } from "drizzle-orm";
import { customerSequences, users } from "@/db/schema";
import { customerNo } from "@/domain/marketing/customer-no";
import type { Db, Tx } from "./db";

export async function assignCustomerNo(tx: Tx | Db, userId: string): Promise<string> {
  const [u] = await tx.select({ c: users.customerNo }).from(users).where(eq(users.userId, userId));
  if (u?.c) return u.c;
  const year = new Date().getUTCFullYear();
  const [r] = await tx
    .insert(customerSequences)
    .values({ year, n: 1 })
    .onConflictDoUpdate({ target: customerSequences.year, set: { n: sql`${customerSequences.n} + 1` } })
    .returning({ n: customerSequences.n });
  const no = customerNo(year, r.n);
  await tx.update(users).set({ customerNo: no }).where(and(eq(users.userId, userId), isNull(users.customerNo)));
  return no;
}
