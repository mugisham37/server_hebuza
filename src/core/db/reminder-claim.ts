// F-CAL-11: shared "send each reminder once" claim (deadline_notifications unique target + offset), used by every
// module's expiry/renewal cron so a rerun or a second worker never double-sends.
import { deadlineNotifications } from "@/db/schema";
import { generateId } from "./ids";
import type { Tx } from "./db";

export async function claimReminder(tx: Pick<Tx, "insert">, targetType: string, targetId: string, offsetDays: number) {
  const [r] = await tx.insert(deadlineNotifications)
    .values({ id: generateId("dln"), targetType: targetType.slice(0, 32), targetId: targetId.slice(0, 128), offsetDays, sentAt: new Date().toISOString() })
    .onConflictDoNothing().returning({ id: deadlineNotifications.id });
  return !!r;
}
