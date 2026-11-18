// F-CAL-01 compliance rules + public holidays (spec 05-modules/deadlines-and-compliance-calendar §8, §11, §12).
// Service managers configure; executives read. Occurrences roll past weekends and compliance_holidays.
import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gte, ne } from "drizzle-orm";
import { complianceHolidays, complianceRules } from "@/db/schema";
import { DB, type Db, type Tx } from "../../core/db/db";
import { TxService } from "../../core/db/tx";
import { AuditService } from "../../core/db/audit";
import { AppError, conflict, notFound } from "../../core/http/errors";
import { nextDates, validateRule, type RuleInput } from "@/domain/ops/rules";

type Row = typeof complianceRules.$inferSelect;
const today = () => new Date().toISOString().slice(0, 10);

const out = (r: Row, hol: ReadonlySet<string>) => {
  // jsonb columns are untyped in the schema; the DTO validated their shape on write.
  const rule = {
    id: r.id,
    code: r.code,
    authority: r.authority,
    label: r.label,
    recurrence: r.recurrence,
    dueRule: r.dueRule,
    leadDays: r.leadDays,
    remindOffsets: r.remindOffsets,
    serviceSlug: r.serviceSlug,
    active: r.active,
    verified: r.verified,
    updatedAt: r.updatedAt,
  } as RuleInput & { id: string; verified: boolean; updatedAt: string };
  return { ...rule, nextDates: nextDates(rule, today(), 12, hol) };
};

function check(r: RuleInput) {
  const e = validateRule(r);
  if (Object.keys(e).length)
    throw new AppError(
      422,
      "validation",
      "Check the highlighted fields.",
      Object.fromEntries(Object.keys(e).map((k) => [k, "invalid"])),
    );
}

@Injectable()
export class ComplianceService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly txs: TxService,
    private readonly audit: AuditService,
  ) {}

  private async holidays(db: Db | Tx) {
    const rows = await db
      .select({ day: complianceHolidays.day })
      .from(complianceHolidays)
      .where(
        gte(complianceHolidays.day, `${new Date().getUTCFullYear() - 1}-01-01`),
      );
    return new Set(rows.map((r) => r.day));
  }

  private async codeFree(tx: Tx, code: string, id?: string) {
    const [dup] = await tx
      .select({ id: complianceRules.id })
      .from(complianceRules)
      .where(
        id
          ? and(eq(complianceRules.code, code), ne(complianceRules.id, id))
          : eq(complianceRules.code, code),
      );
    if (dup) throw conflict("A rule with this code already exists.");
  }

  async list() {
    const [rows, hol] = await Promise.all([
      this.db.select().from(complianceRules).orderBy(asc(complianceRules.code)),
      this.holidays(this.db),
    ]);
    return { items: rows.map((r) => out(r, hol)) };
  }

  create(b: RuleInput, userId: string) {
    check(b);
    return this.txs.run(async (tx) => {
      await this.codeFree(tx, b.code);
      const [r] = await tx
        .insert(complianceRules)
        .values({
          ...b,
          id: `cr_${randomBytes(16).toString("base64url")}`,
          verified: false,
          updatedBy: userId,
        })
        .returning();
      await this.audit.record(tx, {
        action: "compliance_rule.created",
        entity: "compliance_rule",
        entityId: r.id,
        after: b,
      });
      return out(r, await this.holidays(tx));
    });
  }

  patch(id: string, b: Partial<RuleInput>, userId: string) {
    return this.txs.run(async (tx) => {
      const [r] = await tx
        .select()
        .from(complianceRules)
        .where(eq(complianceRules.id, id))
        .for("update");
      if (!r) throw notFound("Rule");
      const next = { ...out(r, new Set()), ...b };
      check(next);
      await this.codeFree(tx, next.code, id);
      const {
        code,
        authority,
        label,
        recurrence,
        dueRule,
        leadDays,
        remindOffsets,
        serviceSlug,
        active,
      } = next;
      const [u] = await tx
        .update(complianceRules)
        .set({
          code,
          authority,
          label,
          recurrence,
          dueRule,
          leadDays,
          remindOffsets,
          serviceSlug,
          active,
          updatedBy: userId,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(complianceRules.id, id))
        .returning();
      const action =
        r.active !== u.active
          ? u.active
            ? "compliance_rule.enabled"
            : "compliance_rule.disabled"
          : "compliance_rule.updated";
      await this.audit.record(tx, {
        action,
        entity: "compliance_rule",
        entityId: id,
        before: out(r, new Set()),
        after: b,
      });
      return out(u, await this.holidays(tx));
    });
  }

  async publicHolidays() {
    return {
      holidays: await this.db
        .select({ day: complianceHolidays.day, name: complianceHolidays.name })
        .from(complianceHolidays)
        .orderBy(asc(complianceHolidays.day)),
    };
  }
}
