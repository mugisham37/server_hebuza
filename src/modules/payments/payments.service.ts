// Payments (port of .ref payments.service + rates): initiate (case, plan, field MoMo), status, webhooks, reconcile,
// bank transfer, refunds, client billing reads. Provider calls never run inside a DB transaction:
// reserve (tx) → gateway → settle (tx). Every money write runs in one SERIALIZABLE tx (`money`) that posts the
// ledger journal, audits and adds the outbox event together; `settle` is the only payment status writer.
import { settingOf } from "../../core/db/system-records";
import { ownOr404 } from "../../core/auth/authorize";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../../core/config/env";
import { createHmac, randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  agentSettings,
  bkgBookings,
  bkgPayments,
  applications,
  clientPaymentMethods,
  clientSubscriptions,
  fieldMomo,
  paymentSplits,
  paymentWebhookEvents,
  payments,
  platformSettings,
  servicePricingTiers,
  users,
} from "@/db/schema";
import { splitVat } from "@/domain/money";
import { POLICY } from "@/domain/policy";
import { DB, type Db, type Tx } from "../../core/db/db";
import { TxService } from "../../core/db/tx";
import { AuditService } from "../../core/db/audit";
import { OutboxService } from "../../core/db/outbox";
import { QueueService } from "../../core/queue/queues";
import { safeEqual } from "../../core/crypto/crypto.service";
import {
  AppError,
  conflict,
  forbidden,
  notFound,
} from "../../core/http/errors";
import type { SessionUser } from "../../core/http/context";
import { checkoutAmount, getPlan, iso } from "../subscriptions/subscriptions.service";
import {
  ACCOUNTS,
  cashAccount,
  LedgerService,
  type Line,
} from "../ledger/ledger.service";
import {
  PaymentsProvider,
  TERMINAL,
  mapFlutterwave,
  methodLabel,
  normalizeMethod,
  type Kind,
  type PayStatus,
} from "./payments.provider";
import type { BankTransferDto, InitiateDto } from "./payments.dto";
import { put } from "../finance/finance.store";
import { clientCredit, clientInvoices, invoiceDocPdf, sellerOf, labelOf } from "../finance/finance.billing";
import { textPdf } from "../chat/chat.service";

type Payment = typeof payments.$inferSelect;
type App = typeof applications.$inferSelect;
type Split = typeof paymentSplits.$inferSelect;

export const PLAN_PREFIX = "PLAN:";
/** PLACEHOLDER(momo-prompt-minutes): how long a MoMo prompt stays payable before we call it expired. */
const MOMO_PROMPT_MS = 5 * 60_000;
/** PLACEHOLDER(card-checkout-minutes) */
const CARD_CHECKOUT_MS = 30 * 60_000;
/** PLACEHOLDER(invoice-due-days) */
const INVOICE_DUE_DAYS = 7;
/** A status poll re-asks the gateway at most this often per payment. */
const SYNC_EVERY_MS = 5_000;
/** Webhook events older than this (provider timestamp) are refused as replays. */
const WEBHOOK_WINDOW_MS = 72 * 3_600_000;
const FALLBACK_PERCENT = 30;

const genId = (p: string) => `${p}_${randomUUID().replace(/-/g, "")}`;
const nowIso = () => new Date().toISOString();
/** Polling clients expect the Python alias "paid". */
const apiStatus = (s: string) => (s === "succeeded" ? "paid" : s);
const VAT_RATE = (POLICY.vatBps / 10_000).toFixed(3);
/** VAT is inside our fee only; the government fee is a pass-through disbursement. */
export const vatOf = (amount: number, governmentFee: number) =>
  splitVat(Math.max(0, amount - governmentFee), POLICY.vatBps).vat;
export const maskPhone = (phone?: string | null) => {
  const d = (phone ?? "").replace(/\D/g, "");
  return !phone
    ? null
    : d.length < 4
      ? phone
      : `${"*".repeat(d.length - 4)}${d.slice(-4)}`;
};
const receiptNo = (txId: string) => `RCPT-${txId.slice(-8).toUpperCase()}`;
const invoiceNo = (code: string) => `INV-${code.replace(/^PLAN:/, "PLAN-")}`;
export const clampPercent = (v: number | null | undefined) =>
  v == null ? null : Math.max(0, Math.min(100, Math.trunc(v)));
/** Hebuza keeps round(base × rate%), the worker the rest; never drifts a franc. */
export function splitAmounts(base: number, ratePercent: number) {
  const hebuza = Math.round((base * ratePercent) / 100);
  return { hebuza, worker: base - hebuza };
}

/** The journal for one landed payment: cash in; government fee, VAT and revenue out; an allocated worker share accrued. */
export function paymentLines(
  p: Pick<Payment, "amountRwf" | "governmentFeeRwf" | "method" | "planId">,
  split: Pick<Split, "workerId" | "workerAmountRwf"> | null,
): Line[] {
  const vat = vatOf(p.amountRwf, p.governmentFeeRwf);
  const revenue = p.amountRwf - p.governmentFeeRwf - vat;
  if (revenue < 0)
    throw new RangeError("government fee exceeds the amount paid");
  const lines: Line[] = [
    { account: cashAccount(p.method), debit: p.amountRwf },
    {
      account: ACCOUNTS.governmentFeesPayable.code,
      credit: p.governmentFeeRwf,
    },
    { account: ACCOUNTS.vatPayable.code, credit: vat },
    {
      account: (p.planId
        ? ACCOUNTS.subscriptionRevenue
        : ACCOUNTS.serviceRevenue
      ).code,
      credit: revenue,
    },
  ];
  if (split?.workerId && split.workerAmountRwf > 0)
    lines.push(
      {
        account: ACCOUNTS.workerShareExpense.code,
        debit: split.workerAmountRwf,
      },
      { account: ACCOUNTS.workerPayable.code, credit: split.workerAmountRwf },
    );
  return lines;
}

/** Outbox `payment.settled` payload (consumed by PaymentsJobs → booking / subscriptions). */
export type Settled = {
  transactionId: string;
  paymentId?: string;
  applicationCode?: string;
  planId?: string | null;
  clientId?: string | null;
  organizationId?: string | null;
  paidAt?: string;
  booking?: boolean;
};

@Injectable()
export class PaymentsService {
  private readonly log = new Logger("payments");
  private readonly webhookSecret?: string;
  private readonly fwSecret?: string;
  private readonly apiBase: string;
  private readonly webBase: string;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly txs: TxService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly queue: QueueService,
    private readonly ledger: LedgerService,
    private readonly provider: PaymentsProvider,
    config: ConfigService<Env, true>,
  ) {
    this.webhookSecret =
      config.get("PAYMENTS_WEBHOOK_SECRET", { infer: true }) || undefined;
    this.fwSecret =
      config.get("FLUTTERWAVE_WEBHOOK_SECRET", { infer: true }) || undefined;
    this.webBase = config
      .get("WEB_ORIGIN", { infer: true })
      .split(",")[0]
      .trim()
      .replace(/\/$/, "");
    this.apiBase = (
      config.get("API_PUBLIC_URL", { infer: true }) || this.webBase
    ).replace(/\/$/, "");
  }

  /** Money tx: SERIALIZABLE as role `system` (payments RLS); every caller is authorised in code before writing. */
  private money<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.txs.runMoney(fn);
  }

  // ── rates ──────────────────────────────────────────────────────────────────────────────────────
  private async houseRates(tx: Tx) {
    const [r] = await tx
      .select({
        m: platformSettings.defaultMonthlyPercent,
        o: platformSettings.defaultOneOffPercent,
      })
      .from(platformSettings)
      .where(eq(platformSettings.id, "global"));
    return {
      monthly: r?.m ?? FALLBACK_PERCENT,
      oneOff: r?.o ?? FALLBACK_PERCENT,
    };
  }
  /** Hebuza's share of this agent's money: their own rate wins, else the house default. */
  private async agentRate(tx: Tx, agentId: string | null, monthly: boolean) {
    const house = await this.houseRates(tx);
    const fallback = monthly ? house.monthly : house.oneOff;
    if (!agentId) return fallback;
    const [r] = await tx
      .select({
        m: agentSettings.monthlyPercent,
        o: agentSettings.oneOffPercent,
      })
      .from(agentSettings)
      .where(eq(agentSettings.userId, agentId));
    return (monthly ? r?.m : r?.o) ?? fallback;
  }

  // ── guards ─────────────────────────────────────────────────────────────────────────────────────
  private async ensureEnabled(tx: Tx) {
    // Off by default: with no gateway the stub would mark payments paid.
    const [r] = await tx
      .select({ on: platformSettings.paymentsEnabled })
      .from(platformSettings)
      .where(eq(platformSettings.id, "global"));
    if (!r?.on) throw conflict("Payments are not available yet.");
  }
  private async assertVerified(tx: Tx, me: SessionUser | null) {
    if (!me) return;
    const [u] = await tx
      .select({ v: users.isEmailVerified })
      .from(users)
      .where(eq(users.userId, me.id));
    if (!u?.v)
      throw new AppError(403, "unverified", "Verify your account first.");
  }
  /** Same invoice while a prompt is live → 409 payment_pending (F-FIN-16); the same Idempotency-Key replays in core. */
  private async assertNoLivePayment(tx: Tx, code: string) {
    const [live] = await tx
      .select({ id: payments.paymentId })
      .from(payments)
      .where(
        and(
          eq(payments.applicationCode, code),
          or(
            and(
              eq(payments.status, "pending"),
              gt(payments.expiresAt, nowIso()),
            ),
            eq(payments.status, "pending_verification"),
          ),
        ),
      )
      .limit(1);
    if (live)
      throw new AppError(
        409,
        "payment_pending",
        "A payment for this invoice is already in progress.",
      );
  }
  private async feesFor(tx: Tx, app: App) {
    const [tier] = await tx
      .select()
      .from(servicePricingTiers)
      .where(
        and(
          eq(servicePricingTiers.serviceId, app.serviceId),
          eq(servicePricingTiers.tier, app.tier),
        ),
      );
    let platform = tier?.platformFee ?? 0,
      government = tier?.governmentFee ?? 0;
    const snap = app.priceBandSnapshot as {
      platform_fee_rwf?: number;
      government_fee_rwf?: number;
    } | null;
    if (snap) {
      platform = Math.trunc(snap.platform_fee_rwf ?? 0);
      government = Math.trunc(snap.government_fee_rwf ?? 0);
    } else if (app.ending === "quote" && app.paymentAmount) {
      platform = app.paymentAmount;
      government = 0;
    }
    return {
      platform,
      government,
      amount: app.paymentAmount ?? platform + government,
    };
  }
  private async insertPending(
    tx: Tx,
    a: {
      code: string;
      amount: number;
      government: number;
      platform: number;
      clientId: string | null;
      planId: string | null;
      organizationId?: string | null;
      kind: Kind;
      method: string;
      phone?: string | null;
      status?: string;
    },
  ) {
    if (!Number.isSafeInteger(a.amount) || a.amount <= 0)
      throw conflict("Nothing is due on this invoice.");
    const now = Date.now();
    const [p] = await tx
      .insert(payments)
      .values({
        paymentId: genId("pay"),
        applicationCode: a.code,
        transactionId: genId("txn"),
        amountRwf: a.amount,
        governmentFeeRwf: a.government,
        platformFeeRwf: a.platform,
        vatRate: VAT_RATE,
        currency: "RWF",
        method: a.kind === "other" ? a.method.slice(0, 32) : a.kind,
        maskedPhone: maskPhone(a.phone),
        status: a.status ?? "pending",
        expiresAt: a.status
          ? null
          : new Date(
              now + (a.kind === "card" ? CARD_CHECKOUT_MS : MOMO_PROMPT_MS),
            ).toISOString(),
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        clientId: a.clientId,
        planId: a.planId,
        organizationId: a.organizationId ?? null,
      })
      .returning();
    return p;
  }

  // ── initiate ───────────────────────────────────────────────────────────────────────────────────
  /** F-SET-08: a method the console switched off is refused before any gateway call. */
  private async assertMethodOn(kind: Kind) {
    if (kind !== "other" && (await settingOf<boolean>(this.db, `payments.method.${kind}`)) === false)
      throw new AppError(422, "method_disabled", "This payment method is not available right now. Choose another one.");
  }

  async initiate(me: SessionUser | null, body: InitiateDto) {
    const kind = normalizeMethod(body.method, body.operator);
    await this.assertMethodOn(kind);
    if (kind === "bank-transfer")
      throw new AppError(
        422,
        "validation",
        "Use the bank transfer option for transfers.",
      );
    const reserved = await this.money(async (tx) => {
      await this.assertVerified(tx, me);
      if (body.plan_id) {
        // Who may buy a plan is answered before whether payments are on.
        if (!me) throw new AppError(401, "unauthenticated", "Sign in");
        if (!me.roles.includes("client"))
          throw new AppError(
            403,
            "forbidden",
            "Plans are for client accounts. Open a client account with the same email to buy a plan.",
          );
        await this.ensureEnabled(tx);
        const plan = await getPlan(tx, body.plan_id.trim());
        if (!plan) throw notFound("Plan");
        if (plan.archivedAt || !plan.isActive)
          throw conflict(
            "This plan is no longer available. Choose another plan.",
          );
        if (plan.kind === "trial")
          throw new AppError(
            422,
            "validation",
            "Trial plans cannot be purchased.",
          );
        if (plan.amountRwf <= 0)
          throw new AppError(
            422,
            "validation",
            "This plan has no payable amount.",
          );
        // SUB-10: company plans need an owner/admin seat; the subscription then belongs to the company.
        const orgId = body.organization_id?.trim() || null;
        if (orgId) {
          const [m] = (await tx.execute(sql`select role from organization_members where organization_id = ${orgId} and user_id = ${me.id} and status = 'active'`)) as unknown as { role: string }[]; // cast: execute() rows are untyped
          if (!m) throw notFound("Organisation");
          if (m.role === "viewer") throw forbidden();
        }
        const code = `${PLAN_PREFIX}${plan.planId}`.slice(0, 64);
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`pay:${orgId ?? me.id}:${code}`}))`,
        );
        await this.assertNoLivePayment(tx, code);
        return this.insertPending(tx, {
          code,
          amount: orgId ? plan.amountRwf : await checkoutAmount(tx, me.id, plan), // F-SUB-08 prorated upgrade (personal plans)
          government: 0,
          platform: 0,
          clientId: me.id,
          planId: plan.planId,
          organizationId: orgId,
          kind,
          method: body.method,
          phone: body.phone_number,
        });
      }
      await this.ensureEnabled(tx);
      const code = (body.application_code ?? "").trim().toUpperCase();
      const [app] = await tx
        .select()
        .from(applications)
        .where(eq(applications.code, code))
        .for("update");
      if (!app) throw notFound("Application");
      if (!me ? !!app.clientId : app.clientId !== me.id)
        throw me
          ? forbidden()
          : new AppError(401, "unauthenticated", "Sign in");
      if (app.handler === "partner" && app.quoteStatus !== "awaiting_payment")
        throw new AppError(
          422,
          "validation",
          "This job has no agreed price yet. We will tell you when it is ready to pay.",
        );
      if (app.paymentStatus === "paid")
        throw conflict("Nothing is due on this invoice.");
      await this.assertNoLivePayment(tx, app.code);
      const f = await this.feesFor(tx, app);
      const p = await this.insertPending(tx, {
        code: app.code,
        amount: f.amount,
        government: f.government,
        platform: f.platform,
        clientId: app.clientId,
        planId: null,
        kind,
        method: body.method,
        phone: body.phone_number,
      });
      await tx
        .update(applications)
        .set({
          paymentAmount: f.amount,
          paymentStatus: "pending",
          updatedAt: nowIso(),
        })
        .where(eq(applications.code, app.code));
      return p;
    });
    const [client] = reserved.clientId
      ? await this.db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.userId, reserved.clientId))
      : [];
    const res = await this.callGateway(
      reserved,
      kind,
      body.phone_number,
      `${this.webBase}/pay/return?tx=${reserved.transactionId}`,
      client?.email,
    );
    const final =
      res.status === "pending"
        ? reserved
        : await this.settle(reserved.transactionId, res.status, null);
    return {
      paymentId: final.paymentId,
      transactionId: final.transactionId,
      status: apiStatus(final.status),
      expiresAt: iso(final.expiresAt),
      sessionToken: res.sessionToken ?? null,
    };
  }

  /** Gateway call outside any tx; a failure settles the reservation as failed (nothing charged). */
  private async callGateway(
    p: Payment,
    kind: Kind,
    phone: string | null | undefined,
    returnUrl: string,
    email?: string | null,
  ) {
    let res;
    try {
      res = await this.provider.initiate(kind, {
        transactionId: p.transactionId,
        amountRwf: p.amountRwf,
        phone,
        callbackUrl: this.callbackUrl(kind, p.transactionId),
        returnUrl,
        email,
      });
    } catch (e) {
      await this.settle(p.transactionId, "failed", null);
      if (e instanceof AppError) throw e;
      this.log.error(
        `payment_provider_initiate_failed ${p.transactionId}: ${String(e)}`,
      );
      throw new AppError(
        503,
        "unavailable",
        "The payment provider didn't answer. Nothing was charged; try again.",
      );
    }
    await this.money((tx) =>
      tx
        .update(payments)
        .set({
          providerTransactionId: res.providerReference ?? null,
          sessionToken: res.sessionToken ?? null,
          updatedAt: nowIso(),
        })
        .where(eq(payments.transactionId, p.transactionId)),
    );
    if (res.status === "pending")
      await this.queue
        .add(
          "critical",
          "payments.reconcile",
          { transactionId: p.transactionId },
          { delay: 120_000, jobId: `rec_${p.transactionId}` },
        )
        .catch((e: unknown) =>
          this.log.warn(
            `payment_reconcile_not_queued ${p.transactionId}: ${String(e)}`,
          ),
        ); // the sweep still catches it
    return res;
  }

  /** MoMo callbacks are unsigned: our callback URL carries HMAC(PAYMENTS_WEBHOOK_SECRET, transactionId). */
  private sig = (txId: string) =>
    createHmac("sha256", this.webhookSecret ?? "")
      .update(txId)
      .digest("hex");
  private callbackUrl(kind: Kind, txId: string) {
    return kind === "card"
      ? `${this.apiBase}/api/payments/webhooks/flutterwave`
      : `${this.apiBase}/api/payments/webhooks/momo?sig=${this.sig(txId)}`;
  }

  /**
   * Booking gateway leg (`bkp…` ids): booking owns its bkg_payments row and the settle; this only talks to the gateway
   * (same drivers, callback URLs and dev stub as client payments). A gateway error surfaces as 503, nothing charged.
   */
  async initiateBooking(a: { transactionId: string; kind: Kind; amountRwf: number; phone: string | null; returnUrl: string }) {
    try {
      return await this.provider.initiate(a.kind, { ...a, callbackUrl: this.callbackUrl(a.kind, a.transactionId) });
    } catch (e) {
      if (e instanceof AppError) throw e;
      this.log.error(`booking_payment_initiate_failed ${a.transactionId}: ${String(e)}`);
      throw new AppError(503, "unavailable", "The payment provider didn't answer. Nothing was charged; try again.");
    }
  }
  /** Gateway status of a booking payment; null = unknown / stub (leave the row as is). */
  bookingStatus(kind: Kind, providerRef: string, amountRwf: number) {
    return this.provider.fetchStatus(kind, providerRef, amountRwf);
  }

  /** Field agent MoMo at a visit (field.service validates the visit/invoice/amount; this reserves, prompts and returns its state). */
  async initiateField(a: {
    agentId: string;
    visitId: string;
    code: string;
    invoiceNo: string;
    phone: string;
    amount: number;
  }) {
    const kind: Kind = /^2507[23]/.test(a.phone) ? "airtel-money" : "mtn-momo"; // phone 2507…: 072/073 Airtel, 078/079 MTN
    const reserved = await this.money(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`fieldmomo:${a.code}`}))`,
      );
      const [open] = await tx
        .select({ tx: fieldMomo.transactionId })
        .from(fieldMomo)
        .innerJoin(
          payments,
          eq(payments.transactionId, fieldMomo.transactionId),
        )
        .where(
          and(
            eq(fieldMomo.invoiceNo, a.invoiceNo),
            isNull(fieldMomo.cancelledAt),
            inArray(payments.status, ["pending", "pending_verification"]),
          ),
        );
      if (open)
        throw new AppError(
          409,
          "payment_in_progress",
          "A payment is already in progress",
          undefined,
          { id: open.tx, state: "pending_provider" },
        );
      const [app] = await tx
        .select()
        .from(applications)
        .where(eq(applications.code, a.code))
        .for("update");
      if (!app) throw notFound("Invoice");
      if (
        app.paymentStatus === "paid" ||
        !(app.paymentAmount && app.paymentAmount > 0)
      )
        throw conflict("Nothing is due on this invoice.");
      if (a.amount > app.paymentAmount)
        throw new AppError(
          422,
          "validation",
          "Amount is more than the balance due.",
        );
      const p = await this.insertPending(tx, {
        code: a.code,
        amount: a.amount,
        government: 0,
        platform: a.amount,
        clientId: app.clientId,
        planId: null,
        kind,
        method: kind,
        phone: a.phone,
      });
      await tx
        .insert(fieldMomo)
        .values({
          transactionId: p.transactionId,
          idemKey: null,
          visitId: a.visitId,
          invoiceNo: a.invoiceNo,
          agentUserId: a.agentId,
        });
      await this.audit.record(tx, {
        action: "field.momo.requested",
        entity: "payment",
        entityId: p.paymentId,
        after: { visitId: a.visitId, invoice: a.invoiceNo, amount: a.amount },
      });
      return p;
    });
    const res = await this.callGateway(
      reserved,
      kind,
      a.phone,
      `${this.webBase}/field`,
    );
    const s =
      res.status === "pending"
        ? "pending"
        : (await this.settle(reserved.transactionId, res.status, a.agentId))
            .status;
    return {
      id: reserved.transactionId,
      state:
        s === "succeeded"
          ? "confirmed"
          : s === "pending"
            ? "pending_provider"
            : s === "expired"
              ? "expired"
              : "failed",
    };
  }

  // ── settle (the only payment status writer) ────────────────────────────────────────────────────
  /**
   * Moves a payment to `status` exactly once (row lock; terminal rows never change again, except a late success on an
   * expired prompt), then updates the case, freezes the split, posts the journal, audits and emits `payment.settled`.
   */
  settle(
    transactionId: string,
    status: PayStatus,
    actorId: string | null,
    from?: string,
  ) {
    return this.money(async (tx) => {
      const [p] = await tx
        .select()
        .from(payments)
        .where(eq(payments.transactionId, transactionId))
        .for("update");
      if (!p) throw notFound("Payment");
      if (from && p.status !== from)
        throw conflict("This transfer was already decided.");
      // expired → succeeded stays open: the client can still approve on the phone after we stopped waiting.
      const late = p.status === "expired" && status === "succeeded";
      if ((TERMINAL.has(p.status) && !late) || p.status === status) return p;
      const now = nowIso();
      const paid = status === "succeeded";
      const [np] = await tx
        .update(payments)
        .set({
          status,
          updatedAt: now,
          ...(paid
            ? {
                paidAt: now,
                receiptNumber: p.receiptNumber ?? receiptNo(p.transactionId),
              }
            : {}),
        })
        .where(eq(payments.paymentId, p.paymentId))
        .returning();
      let duplicate = false;
      if (!np.planId) {
        const [app] = await tx
          .select()
          .from(applications)
          .where(eq(applications.code, np.applicationCode))
          .for("update");
        duplicate = paid && app?.paymentStatus === "paid";
        if (duplicate) {
          // Invoice already settled by another payment: hold the cash as a refund due, never as revenue.
          this.log.error(
            `payment_duplicate_refund_due ${np.transactionId} ${np.applicationCode}`,
          );
          await this.ledger.post(tx, {
            sourceType: "payment",
            sourceId: np.paymentId,
            memo: `Duplicate payment ${np.transactionId} for ${np.applicationCode} (refund due)`,
            occurredAt: new Date(now),
            lines: [
              { account: cashAccount(np.method), debit: np.amountRwf },
              { account: ACCOUNTS.clientRefundDue.code, credit: np.amountRwf },
            ],
          });
        } else if (app) {
          // A partial (field) payment lowers the balance due; the invoice is paid once nothing is left.
          const left = paid
            ? Math.max(0, (app.paymentAmount ?? 0) - np.amountRwf)
            : app.paymentAmount;
          // A failed/expired attempt never moves a partly paid case (earlier field partial) away from its status.
          const partly =
            !paid &&
            (
              await tx
                .select({ id: payments.paymentId })
                .from(payments)
                .where(
                  and(
                    eq(payments.applicationCode, app.code),
                    eq(payments.status, "succeeded"),
                  ),
                )
                .limit(1)
            ).length > 0;
          const ps = paid
            ? left
              ? "pending"
              : "paid"
            : partly
              ? app.paymentStatus
              : status === "expired"
                ? "pending"
                : "failed";
          await tx
            .update(applications)
            .set({
              paymentStatus: ps,
              paymentAmount: left || app.paymentAmount,
              updatedAt: now,
              ...(paid && !left && app.handler === "partner"
                ? { quoteStatus: "paid" }
                : {}),
            })
            .where(eq(applications.code, app.code));
        }
      }
      if (paid && !duplicate) {
        const split = await this.freezeSplit(tx, np);
        await this.ledger.post(tx, {
          sourceType: "payment",
          sourceId: np.paymentId,
          memo: `Payment ${np.transactionId} for ${np.applicationCode}`,
          occurredAt: new Date(now),
          lines: paymentLines(np, split),
        });
        await this.rememberMethod(tx, np);
        const ev: Settled = {
          transactionId,
          paymentId: np.paymentId,
          applicationCode: np.applicationCode,
          planId: np.planId,
          clientId: np.clientId,
          organizationId: np.organizationId,
          paidAt: now,
        };
        await this.outbox.add(tx, {
          type: "finance.payment.settled",
          payload: { applicationCode: np.applicationCode, planId: np.planId, clientId: np.clientId, paymentId: np.paymentId, amount: np.amountRwf },
        });
        await this.outbox.add(tx, {
          type: "payment.settled",
          queue: "critical",
          payload: {
            ...ev,
            realtime: np.clientId ? { userId: np.clientId } : undefined,
          },
        });
      }
      await this.audit.record(tx, {
        action: "payment.status_update",
        entity: "payment",
        entityId: np.paymentId,
        before: { status: p.status },
        after: {
          status,
          transactionId,
          actorId,
          refundDue: duplicate || undefined,
        },
      });
      return np;
    });
  }

  /** Freeze how a landed payment divides (written once; nothing is paid out here). */
  private async freezeSplit(tx: Tx, p: Payment): Promise<Split | null> {
    const [have] = await tx
      .select()
      .from(paymentSplits)
      .where(eq(paymentSplits.paymentId, p.paymentId));
    if (have) return have;
    let source: "plan" | "service" | "partner", base: number, rate: number;
    let government = 0,
      applicationCode: string | null = null,
      workerId: string | null = null,
      workerRole: string | null = null;
    if (p.planId) {
      source = "plan";
      base = p.amountRwf;
      const [s] = p.clientId
        ? await tx
            .select({ a: clientSubscriptions.dedicatedAgentId })
            .from(clientSubscriptions)
            .where(eq(clientSubscriptions.clientId, p.clientId))
        : [];
      workerId = s?.a ?? null;
      workerRole = workerId ? "agent" : null;
      rate = workerId
        ? await this.agentRate(tx, workerId, true)
        : (await this.houseRates(tx)).monthly;
    } else {
      const [app] = await tx
        .select()
        .from(applications)
        .where(eq(applications.code, p.applicationCode));
      if (!app) return null;
      applicationCode = app.code;
      government = p.governmentFeeRwf;
      if (app.handler === "partner") {
        if (app.hebuzaPercent == null) return null; // no agreed share: nothing honest to freeze
        source = "partner";
        base = app.agreedAmountRwf ?? p.amountRwf;
        workerId = app.assignedPartnerId;
        workerRole = workerId ? "partner" : null;
        rate = app.hebuzaPercent;
      } else {
        source = "service";
        base = Math.max(p.amountRwf - government, 0); // only our fee is shared, never the government's cut
        workerId = app.assignedAgentId;
        workerRole = workerId ? "agent" : null;
        rate = workerId
          ? await this.agentRate(tx, workerId, false)
          : (await this.houseRates(tx)).oneOff;
      }
    }
    const ratePercent = clampPercent(rate) ?? 0;
    const { hebuza, worker } = splitAmounts(base, ratePercent);
    const [row] = await tx
      .insert(paymentSplits)
      .values({
        id: genId("split"),
        paymentId: p.paymentId,
        source,
        applicationCode,
        workerId,
        workerRole,
        ratePercent,
        baseAmountRwf: base,
        hebuzaAmountRwf: hebuza,
        workerAmountRwf: worker,
        governmentFeeRwf: government,
        frozenAt: p.paidAt ?? nowIso(),
      })
      .returning();
    return row;
  }

  /** A landed MoMo payment becomes a saved method (masked: last 4 digits only). */
  private async rememberMethod(tx: Tx, p: Payment) {
    const kind = normalizeMethod(p.method);
    const last4 = p.maskedPhone?.replace(/\D/g, "").slice(-4);
    if (
      !p.clientId ||
      (kind !== "mtn-momo" && kind !== "airtel-money") ||
      !last4 ||
      last4.length !== 4
    )
      return;
    const [any] = await tx
      .select({ id: clientPaymentMethods.id })
      .from(clientPaymentMethods)
      .where(eq(clientPaymentMethods.clientId, p.clientId))
      .limit(1);
    await tx
      .insert(clientPaymentMethods)
      .values({
        id: genId("pm"),
        clientId: p.clientId,
        kind: "momo",
        label: methodLabel(kind),
        last4,
        isPrimary: !any,
      })
      .onConflictDoNothing();
  }

  // ── status, reconcile, webhooks ────────────────────────────────────────────────────────────────
  private byTx = (txId: string) =>
    this.money(
      async (tx) =>
        (
          await tx
            .select()
            .from(payments)
            .where(eq(payments.transactionId, txId))
        )[0],
    );

  async status(transactionId: string) {
    let p = await this.byTx(transactionId);
    if (!p) throw notFound("Payment");
    if (
      p.status === "pending" &&
      Date.now() - Date.parse(p.updatedAt) > SYNC_EVERY_MS
    )
      p = (await this.reconcile(transactionId)) ?? p;
    return {
      transactionId: p.transactionId,
      status: apiStatus(p.status),
      paidAt: iso(p.paidAt),
    };
  }

  /** Ask the gateway (authenticated) for the truth; a prompt past its expiry with no answer becomes expired. */
  async reconcile(transactionId: string) {
    const p = await this.byTx(transactionId);
    if (!p || (p.status !== "pending" && p.status !== "expired")) return p;
    let s: PayStatus | null = null;
    try {
      if (p.providerTransactionId)
        s = await this.provider.fetchStatus(
          normalizeMethod(p.method),
          p.providerTransactionId,
          p.amountRwf,
        );
    } catch (e) {
      this.log.warn(
        `payment_status_fetch_failed ${transactionId}: ${String(e)}`,
      );
    }
    if (p.status === "expired")
      return s === "succeeded" ? this.settle(transactionId, s, null) : p;
    if (
      (!s || s === "pending") &&
      p.expiresAt &&
      Date.parse(p.expiresAt) < Date.now()
    )
      s = "expired";
    if (s && s !== "pending") return this.settle(transactionId, s, null);
    await this.money((tx) =>
      tx
        .update(payments)
        .set({ updatedAt: nowIso() })
        .where(eq(payments.paymentId, p.paymentId)),
    );
    return p;
  }

  /** Cron safety net: every pending prompt older than two minutes is re-checked. */
  async reconcileSweep() {
    const rows = await this.money((tx) =>
      tx
        .select({ t: payments.transactionId })
        .from(payments)
        .where(
          and(
            eq(payments.status, "pending"),
            lt(
              payments.createdAt,
              new Date(Date.now() - 120_000).toISOString(),
            ),
          ),
        )
        .limit(200),
    );
    for (const r of rows)
      await this.reconcile(r.t).catch((e: unknown) =>
        this.log.error(`payment_reconcile_failed ${r.t}: ${String(e)}`),
      );
    return rows.length;
  }

  /** Daily: a healthy ledger has debits = credits. */
  async checkLedger() {
    const tb = await this.money((tx) => this.ledger.trialBalance(tx));
    if (tb.debits !== tb.credits)
      this.log.error(
        `ledger_unbalanced debits=${tb.debits} credits=${tb.credits}`,
      );
    return tb;
  }

  /** First sight of (provider, event key) → true; a replay → false. Booking (`bkp…`) nudges go to the outbox here. */
  private firstSeen(
    provider: string,
    eventKey: string,
    transactionId: string,
    booking = false,
  ) {
    return this.money(async (tx) => {
      const r = await tx
        .insert(paymentWebhookEvents)
        .values({
          id: genId("whe"),
          provider,
          eventKey: eventKey.slice(0, 128),
          transactionId,
        })
        .onConflictDoNothing()
        .returning({ id: paymentWebhookEvents.id });
      if (r.length && booking)
        await this.outbox.add(tx, {
          type: "payment.settled",
          queue: "critical",
          payload: { transactionId, booking: true } satisfies Settled,
        });
      return r.length > 0;
    });
  }

  /** MTN callback = nudge only: verify our URL signature, dedupe, then re-read the status from MTN's API. */
  async momoWebhook(payload: Record<string, unknown>, sig: string | undefined) {
    const ext = String(payload.externalId ?? "");
    const ref = String(
      payload.referenceId ?? payload.financialTransactionId ?? "",
    );
    if (
      !this.webhookSecret
        ? !this.provider.stub
        : !sig || !ext || !safeEqual(sig, this.sig(ext))
    )
      throw new AppError(401, "unauthenticated", "Invalid webhook signature.");
    const key = `${ref || ext}:${String(payload.status ?? "")}`;
    if (ext.startsWith("bkp"))
      return void (await this.firstSeen("momo", key, ext, true));
    const p = ext ? await this.byTx(ext) : undefined;
    if (!p || !(await this.firstSeen("momo", key, p.transactionId))) return;
    await this.reconcile(p.transactionId);
  }

  /** Flutterwave signs with the shared `verif-hash` (fail closed); event age ≤ 72 h; amount/currency must cover the payment. */
  async flutterwaveWebhook(
    payload: Record<string, unknown>,
    signature: string | undefined,
  ) {
    if (!this.fwSecret || !signature || !safeEqual(signature, this.fwSecret))
      throw new AppError(401, "unauthenticated", "Invalid webhook signature.");
    const d = (payload.data ?? {}) as {
      id?: unknown;
      tx_ref?: unknown;
      status?: unknown;
      amount?: unknown;
      currency?: unknown;
      created_at?: unknown;
    };
    const at = Date.parse(String(d.created_at ?? ""));
    if (
      Number.isNaN(at) ||
      Date.now() - at > WEBHOOK_WINDOW_MS ||
      at - Date.now() > 5 * 60_000
    )
      throw new AppError(401, "unauthenticated", "Stale webhook.");
    const txRef = String(d.tx_ref ?? "");
    const status = mapFlutterwave(String(d.status ?? ""));
    const key = `${String(d.id ?? txRef)}:${status}`;
    if (txRef.startsWith("bkp"))
      return void (await this.firstSeen("flutterwave", key, txRef, true));
    const p = await this.byTx(txRef);
    if (
      !p ||
      status === "pending" ||
      !(await this.firstSeen("flutterwave", key, p.transactionId))
    )
      return;
    if (
      status === "succeeded" &&
      (!this.provider.covers(p.transactionId, d.amount, d.currency, p.amountRwf) ||
        // The shared hash is weak auth: a success settles only once Flutterwave's API confirms it (amount + RWF).
        (await this.provider.fetchStatus("card", String(d.id ?? ""), p.amountRwf)) !== "succeeded")
    )
      return;
    await this.settle(p.transactionId, status, null);
  }

  // ── bank transfer ──────────────────────────────────────────────────────────────────────────────
  async declareBankTransfer(me: SessionUser, body: BankTransferDto) {
    await this.assertMethodOn("bank-transfer");
    return this.money(async (tx) => {
      await this.assertVerified(tx, me);
      await this.ensureEnabled(tx);
      const [app] = await tx
        .select()
        .from(applications)
        .where(
          eq(applications.code, body.application_code.trim().toUpperCase()),
        )
        .for("update");
      if (!app) throw notFound("Application");
      ownOr404(me, app, (x) => x.clientId, "Application");
      if (app.paymentStatus === "paid")
        throw conflict("Nothing is due on this invoice.");
      // A second declaration for the same case is the same declaration.
      const [open] = await tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.applicationCode, app.code),
            eq(payments.status, "pending_verification"),
          ),
        );
      if (open)
        return {
          status: "pending_verification" as const,
          paymentId: open.paymentId,
        };
      await this.assertNoLivePayment(tx, app.code);
      const f = await this.feesFor(tx, app);
      const p = await this.insertPending(tx, {
        code: app.code,
        amount: f.amount,
        government: f.government,
        platform: f.platform,
        clientId: app.clientId,
        planId: null,
        kind: "bank-transfer",
        method: "bank-transfer",
        status: "pending_verification",
      });
      if (body.reference?.trim())
        await tx
          .update(payments)
          .set({ providerTransactionId: body.reference.trim() })
          .where(eq(payments.paymentId, p.paymentId));
      // Finance 4-eyes queue item (workflow only, never posts): its last signature calls decideBankTransfer.
      await put(tx, "payment", p.paymentId, {
        id: p.paymentId,
        gatewayPaymentId: p.paymentId,
        invoiceNo: app.code,
        caseRef: app.code,
        clientId: app.clientId,
        method: "bank_transfer",
        state: "proof_submitted",
        amountExpected: f.amount,
        bankReference: body.reference?.trim() || undefined,
        makerId: me.id,
        events: [{ at: nowIso(), kind: "recorded", source: "client" }],
        at: nowIso(),
        rev: 1,
      }, app.code);
      await this.audit.record(tx, {
        action: "payment.bank_transfer_declared",
        entity: "payment",
        entityId: p.paymentId,
        after: { applicationCode: app.code },
      });
      return {
        status: "pending_verification" as const,
        paymentId: p.paymentId,
      };
    });
  }

  /** Finance confirm/reject (maker-checker lives in finance); settles through the same path, 409 on a racing decision. */
  async decideBankTransfer(
    paymentId: string,
    approve: boolean,
    actorId: string,
    makerId?: string,
  ) {
    if (makerId && makerId === actorId) throw forbidden();
    const p = await this.money(
      async (tx) =>
        (
          await tx
            .select()
            .from(payments)
            .where(eq(payments.paymentId, paymentId))
        )[0],
    );
    if (!p || p.method !== "bank-transfer") throw notFound("Payment");
    if (p.status === (approve ? "succeeded" : "failed")) return p; // job retry after a committed decision
    return this.settle(
      p.transactionId,
      approve ? "succeeded" : "failed",
      actorId,
      "pending_verification",
    );
  }

  // ── refunds (finance.refunds owns approval + ledger; this only moves money) ─────────────────────
  /**
   * Finance refund disbursement: pays `amount` back through the gateway of the case's (or booking's) latest settled
   * payment when that gateway has a refund API. Ledger posting stays with finance (postRefund) — this moves money only.
   * Anything else answers `manual` with a reason; finance keeps the refund open for a bank payout with proof.
   */
  async disburseRefund(a: { ref: string; caseRef: string; amount: number; refunded: number }): Promise<
    { status: "refunded"; transactionId: string; kind: string } | { status: "manual"; reason: string }
  > {
    const p = await this.money(async (tx) => {
      const [app] = await tx
        .select({ t: payments.transactionId, kind: payments.method, amount: payments.amountRwf })
        .from(payments)
        .where(and(eq(payments.applicationCode, a.caseRef), eq(payments.status, "succeeded")))
        .orderBy(desc(payments.createdAt))
        .limit(1);
      if (app) return app;
      const [bk] = await tx
        .select({ t: bkgPayments.id, kind: bkgPayments.kind, amount: bkgPayments.amount })
        .from(bkgPayments)
        .innerJoin(bkgBookings, eq(bkgBookings.id, bkgPayments.bookingId))
        .where(and(eq(bkgBookings.reference, a.caseRef), eq(bkgPayments.status, "succeeded")))
        .orderBy(desc(bkgPayments.createdAt))
        .limit(1);
      return bk;
    });
    if (!p) return { status: "manual", reason: "No settled gateway payment found for this case. Pay out by bank with a proof." };
    if (!(a.amount > 0) || a.amount > p.amount - a.refunded)
      return { status: "manual", reason: "Refund exceeds what is left on the settled payment. Check earlier refunds before paying out." };
    try {
      const r = await this.provider.refund(p.kind as Kind, p.t, a.amount, a.ref);
      if (r === "unsupported")
        return { status: "manual", reason: `Gateway refund is not available for ${methodLabel(p.kind)}. Pay out manually with a proof.` };
    } catch (e) {
      this.log.error(`refund_gateway_failed ${a.ref} ${p.t}: ${String(e)}`);
      return { status: "manual", reason: "The gateway refused the refund. No money moved; pay out manually with a proof." };
    }
    this.log.log(`refund_gateway_ok ${a.ref} ${p.t} ${a.amount}`);
    return { status: "refunded", transactionId: p.t, kind: p.kind };
  }

  /** F-REV-07 payout leg (no tx): MoMo disbursement transfer + status poll; "unsupported" while dormant. */
  payoutTransfer(a: { phone: string; amountRwf: number; ref: string }) {
    return this.provider.payoutTransfer(a);
  }
  payoutStatus(id: string) {
    return this.provider.payoutStatus(id);
  }

  // ── receipts and client billing reads (owner RLS via TxService.run) ────────────────────────────
  receipt(me: SessionUser, rawCode: string) {
    return this.txs.run(async (tx) => {
      const code = rawCode.trim();
      const isPlan = code.toUpperCase().startsWith(PLAN_PREFIX);
      const key = isPlan
        ? PLAN_PREFIX + code.slice(PLAN_PREFIX.length)
        : code.toUpperCase();
      let serviceName = "Membership plan",
        tracking = key;
      if (!isPlan) {
        const [app] = await tx
          .select()
          .from(applications)
          .where(eq(applications.code, key));
        ownOr404(me, app, (x) => x.clientId, "Application");
        serviceName = app.serviceName;
      }
      const [p] = await tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.applicationCode, key),
            eq(payments.status, "succeeded"),
            eq(payments.clientId, me.id),
          ),
        )
        .orderBy(desc(payments.paidAt))
        .limit(1);
      if (!p)
        throw new AppError(
          404,
          "not_found",
          isPlan
            ? "No payment record for this plan."
            : "No payment record for this application.",
        );
      if (isPlan && p.planId) {
        serviceName = (await getPlan(tx, p.planId))?.name ?? serviceName;
        tracking = p.planId;
      }
      // The frozen split (agent, rate) is internal: never on the client's receipt.
      return {
        serviceName,
        trackingCode: tracking,
        amount: p.amountRwf,
        governmentFee: p.governmentFeeRwf,
        vatAmount: vatOf(p.amountRwf, p.governmentFeeRwf),
        method: methodLabel(p.method),
        transactionId: p.transactionId,
        receiptNumber: p.receiptNumber ?? receiptNo(p.transactionId),
        paidAt: iso(p.paidAt ?? p.createdAt),
        applicationCode: p.applicationCode,
      };
    });
  }

  /** Finance invoices of the client (G0) + client credit; a payable case the finance sweep has not invoiced yet still shows. */
  myInvoices(clientId: string) {
    return this.txs.run(async (tx) => {
      const docs = await clientInvoices(tx, clientId);
      const invoiced = new Set(docs.map((d) => d.caseRef).filter(Boolean));
      const rows = await tx
        .select({
          code: applications.code,
          service: applications.serviceName,
          submittedAt: applications.submittedAt,
          amount: applications.paymentAmount,
          status: applications.paymentStatus,
        })
        .from(applications)
        .where(
          and(
            eq(applications.clientId, clientId),
            eq(applications.paymentStatus, "pending"),
            gt(applications.paymentAmount, 0),
          ),
        )
        .orderBy(desc(applications.submittedAt));
      const now = Date.now();
      const due = (_d: string, over: boolean) => (over ? "overdue" : "due") as "overdue" | "due";
      const fin = docs.map((i) => ({ ...i, dueAt: i.dueAt ?? i.issuedAt ?? nowIso() })).map((i) => ({
        number: i.no!,
        service: labelOf(i.lines[0]?.label),
        requestCode: i.caseRef ?? null,
        issuedAt: iso(i.issuedAt ?? i.dueAt) as string,
        dueAt: iso(i.dueAt),
        amount: i.status === "paid" || i.status === "paid_by_plan" ? i.totals.total : i.balanceDue,
        currency: "RWF",
        status:
          i.status === "paid" || i.status === "paid_by_plan"
            ? ("paid" as const)
            : i.status === "credited"
              ? ("refunded" as const)
              : due(i.dueAt, Date.parse(i.dueAt) < now),
      }));
      const pending = rows
        .filter((r) => !invoiced.has(r.code))
        .map((r) => {
          const dueAt = new Date(Date.parse(r.submittedAt) + INVOICE_DUE_DAYS * 86_400_000).toISOString();
          return {
            number: invoiceNo(r.code),
            service: r.service,
            requestCode: r.code,
            issuedAt: iso(r.submittedAt),
            dueAt,
            amount: r.amount ?? 0,
            currency: "RWF",
            status: due(dueAt, Date.parse(dueAt) < now),
          };
        });
      return {
        invoices: [...pending, ...fin].sort((x, y) => y.issuedAt.localeCompare(x.issuedAt)),
        creditBalance: await clientCredit(tx, clientId),
      };
    });
  }

  /** Client statement for [from, to): invoices issued (+), payments received (−), credit notes (−), with the opening
   *  balance carried from before `from` and the closing balance (balance of record = finance documents). */
  async myStatement(clientId: string, from: string, to: string) {
    const [invs, rec] = await Promise.all([this.txs.run((tx) => clientInvoices(tx, clientId)), this.myReceipts(clientId)]);
    const cns = await this.txs.run(async (tx) =>
      invs.length
        ? ((await tx.execute(sql`select data from finance_records where kind = 'credit_note' and ref in (${sql.join(invs.map((i) => sql`${i.no!}`), sql`, `)})`)) as unknown as { data: { no: string; invoiceNo: string; issuedAt: string; totals: { total: number } } }[]).map((r) => r.data) // cast: execute() rows are untyped
        : [],
    );
    type Row = { date: string; type: "invoice" | "payment" | "credit_note"; number: string; detail: string; amount: number };
    const all: Row[] = [
      ...invs.map((i) => ({ date: (i.issuedAt ?? i.dueAt ?? "").slice(0, 10), type: "invoice" as const, number: i.no!, detail: labelOf(i.lines[0]?.label), amount: i.totals.total })),
      ...rec.receipts.map((r) => ({ date: r.paidAt.slice(0, 10), type: "payment" as const, number: r.number, detail: r.invoiceNumber, amount: -r.amount })),
      ...cns.map((cn) => ({ date: cn.issuedAt.slice(0, 10), type: "credit_note" as const, number: cn.no, detail: cn.invoiceNo, amount: -Math.abs(cn.totals.total) })),
    ].sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
    const opening = all.filter((r) => r.date < from).reduce((t, r) => t + r.amount, 0);
    const rows = all.filter((r) => r.date >= from && r.date < to);
    return { from, to, currency: "RWF", opening, closing: opening + rows.reduce((t, r) => t + r.amount, 0), rows };
  }

  /** Text PDF of one of the client's invoices (F-FIN-04). */
  invoicePdf(clientId: string, no: string) {
    return this.txs.run(async (tx) => {
      const i = (await clientInvoices(tx, clientId)).find((x) => x.no === no);
      if (!i) throw notFound("Invoice");
      return invoiceDocPdf("Invoice", i.no!, { ...i, seller: await sellerOf(tx) });
    });
  }
  /** Text PDF of one of the client's receipts (F-FIN-06). */
  async receiptPdf(clientId: string, no: string) {
    const r = (await this.myReceipts(clientId)).receipts.find((x) => x.number === no);
    if (!r) throw notFound("Receipt");
    return textPdf(`Receipt ${r.number}`, [
      `Invoice: ${r.invoiceNumber}`,
      `Paid: ${r.paidAt.slice(0, 10)}`,
      `Amount: ${r.amount} ${r.currency}`,
      `Method: ${r.method}`,
      "",
      "HEBUZA · thank you for your payment.",
    ]);
  }

  myReceipts(clientId: string) {
    return this.txs.run(async (tx) => {
      const rows = await tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.clientId, clientId),
            eq(payments.status, "succeeded"),
          ),
        )
        .orderBy(desc(payments.paidAt));
      return {
        receipts: rows.map((p) => ({
          number: p.receiptNumber ?? receiptNo(p.transactionId),
          invoiceNumber: invoiceNo(p.applicationCode),
          paidAt: iso(p.paidAt ?? p.createdAt),
          amount: p.amountRwf,
          currency: p.currency,
          method: methodLabel(p.method),
        })),
      };
    });
  }

  myMethods(clientId: string) {
    return this.txs.run(async (tx) => {
      const rows = await tx
        .select()
        .from(clientPaymentMethods)
        .where(eq(clientPaymentMethods.clientId, clientId))
        .orderBy(
          desc(clientPaymentMethods.isPrimary),
          desc(clientPaymentMethods.createdAt),
        );
      return {
        methods: rows.map((m) => ({
          id: m.id,
          kind: m.kind,
          label: m.label,
          last4: m.last4,
          primary: m.isPrimary,
        })),
      };
    });
  }

  deleteMethod(clientId: string, id: string) {
    return this.txs.run(async (tx) => {
      const [gone] = await tx
        .delete(clientPaymentMethods)
        .where(
          and(
            eq(clientPaymentMethods.id, id),
            eq(clientPaymentMethods.clientId, clientId),
          ),
        )
        .returning();
      if (!gone) throw notFound("Payment method");
      if (gone.isPrimary) {
        // Keep exactly one primary while any method is left.
        const [next] = await tx
          .select({ id: clientPaymentMethods.id })
          .from(clientPaymentMethods)
          .where(eq(clientPaymentMethods.clientId, clientId))
          .orderBy(desc(clientPaymentMethods.createdAt))
          .limit(1);
        if (next)
          await tx
            .update(clientPaymentMethods)
            .set({ isPrimary: true })
            .where(eq(clientPaymentMethods.id, next.id));
      }
      await this.audit.record(tx, {
        action: "payment_method.deleted",
        entity: "payment_method",
        entityId: id,
      });
      return { deleted: true };
    });
  }

}
