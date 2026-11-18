// Gateway adapters (port of .ref payments.provider): MTN MoMo collection, Airtel Money collection, Flutterwave hosted
// checkout. A method whose gateway has no keys answers through the dev `stub` driver (settles at once); production
// refuses (503) — nothing is ever faked there.
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../../core/config/env";
import { randomUUID } from "node:crypto";
import { AppError } from "../../core/http/errors";

export type PayStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "insufficient_funds"
  | "expired"
  | "pending_verification"
  | "refunded";
export const TERMINAL = new Set<string>([
  "succeeded",
  "failed",
  "insufficient_funds",
  "expired",
  "refunded",
]);
export type Kind =
  "mtn-momo" | "airtel-money" | "card" | "bank-transfer" | "other";
export type Initiated = {
  status: PayStatus;
  sessionToken?: string | null;
  providerReference?: string | null;
};
export type InitiateArgs = {
  transactionId: string;
  amountRwf: number;
  phone?: string | null;
  callbackUrl: string;
  returnUrl: string;
  email?: string | null;
};

/** One gateway. `fetchStatus` null = unknown (leave the row as is). */
export interface PaymentDriver {
  readonly name: string;
  enabled(): boolean;
  initiate(a: InitiateArgs): Promise<Initiated>;
  fetchStatus(
    providerReference: string,
    expectedRwf: number,
  ): Promise<PayStatus | null>;
  /** Gateway refund of our transaction id; absent = the gateway has no refund API (manual payout). */
  refund?(transactionId: string, amountRwf: number, ref: string): Promise<void>;
}

/** UI sends "mobile_money" + operator "mtn"|"airtel"; legacy callers send "mtn_momo"/"momo-mtn". */
export function normalizeMethod(
  method: string,
  operator?: string | null,
): Kind {
  const m = method.trim().toLowerCase().replace(/_/g, "-");
  const op = operator?.trim().toLowerCase();
  if (
    m === "mtn-momo" ||
    m === "momo-mtn" ||
    ((m === "mobile-money" || m === "momo") && (op ?? "mtn") === "mtn")
  )
    return "mtn-momo";
  if (
    m === "airtel-money" ||
    ((m === "mobile-money" || m === "momo") && op === "airtel")
  )
    return "airtel-money";
  if (m === "card") return "card";
  if (m === "bank-transfer" || m === "bank") return "bank-transfer";
  return "other";
}
export const methodLabel = (stored: string) =>
  ({
    "mtn-momo": "MTN MoMo",
    "airtel-money": "Airtel Money",
    card: "Card",
    "bank-transfer": "Bank transfer",
    other: stored,
  })[normalizeMethod(stored)];

export function mapMomo(status?: string, reason?: string): PayStatus {
  switch (String(status ?? "").toUpperCase()) {
    case "SUCCESSFUL":
      return "succeeded";
    case "FAILED":
      return /NOT_ENOUGH_FUNDS|LOW_BALANCE/i.test(reason ?? "")
        ? "insufficient_funds"
        : "failed";
    case "TIMEOUT":
    case "EXPIRED":
      return "expired";
    default:
      return "pending";
  }
}
export function mapFlutterwave(status?: string): PayStatus {
  const s = String(status ?? "").toLowerCase();
  return s === "successful"
    ? "succeeded"
    : s === "failed" || s === "cancelled"
      ? "failed"
      : "pending";
}
/** Airtel transaction status: TS success, TF failed, TIP/TA in progress, TE expired. */
export function mapAirtel(status?: string): PayStatus {
  const s = String(status ?? "").toUpperCase();
  return s === "TS"
    ? "succeeded"
    : s === "TF"
      ? "failed"
      : s === "TE"
        ? "expired"
        : "pending";
}

const TIMEOUT = 30_000;
async function call(url: string, init: RequestInit) {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res;
}
const phoneRequired = () =>
  new AppError(
    422,
    "validation",
    "A phone number is required for mobile money.",
    { phone_number: "required" },
  );

@Injectable()
export class PaymentsProvider {
  private readonly log = new Logger("payments.provider");
  /** PAYMENTS_STUB=true: methods without keys settle at once and unsigned MoMo callbacks pass (never set in production). */
  readonly stub: boolean;
  private readonly drivers: Record<
    "mtn-momo" | "airtel-money" | "card",
    PaymentDriver
  >;

  constructor(private readonly config: ConfigService<Env, true>) {
    this.stub = config.get("PAYMENTS_STUB", { infer: true }) === true;
    this.drivers = {
      "mtn-momo": this.momo(),
      "airtel-money": this.airtel(),
      card: this.flutterwave(),
    };
  }
  private env = (k: keyof Env) => String(this.config.get(k, { infer: true }) ?? "") || undefined;

  /** True when the method reaches a real gateway; false means the stub answers (dev only). */
  isLive = (kind: Kind) =>
    kind in this.drivers &&
    this.drivers[kind as keyof typeof this.drivers].enabled();

  async initiate(kind: Kind, a: InitiateArgs): Promise<Initiated> {
    if (this.isLive(kind))
      return this.drivers[kind as keyof typeof this.drivers].initiate(a);
    if (!this.stub)
      throw new AppError(
        503,
        "unavailable",
        "This payment method is not available yet.",
      );
    this.log.warn(`payment_stub_settled ${kind} ${a.transactionId}`);
    return { status: "succeeded", providerReference: a.transactionId };
  }

  fetchStatus(kind: Kind, ref: string, expectedRwf: number) {
    return this.isLive(kind)
      ? this.drivers[kind as keyof typeof this.drivers].fetchStatus(
          ref,
          expectedRwf,
        )
      : Promise.resolve(null);
  }

  /** "refunded" when the gateway took the refund; "unsupported" = no live gateway refund for this method (pay out manually). */
  async refund(kind: Kind, transactionId: string, amountRwf: number, ref: string): Promise<"refunded" | "unsupported"> {
    const d = this.isLive(kind) ? this.drivers[kind as keyof typeof this.drivers] : null;
    if (!d?.refund) return "unsupported";
    await d.refund(transactionId, amountRwf, ref);
    return "refunded";
  }

  // ── MTN MoMo collection ──
  private momo(): PaymentDriver {
    const base = () =>
      (this.env("MTN_MOMO_TARGET_ENVIRONMENT") ?? "sandbox").toLowerCase() ===
      "sandbox"
        ? "https://sandbox.momodeveloper.mtn.com"
        : "https://proxy.momoapi.mtn.com";
    const headers = async () => {
      const basic = Buffer.from(
        `${this.env("MTN_MOMO_API_USER")}:${this.env("MTN_MOMO_API_KEY")}`,
      ).toString("base64");
      const sub = this.env("MTN_MOMO_SUBSCRIPTION_KEY")!;
      const res = await call(`${base()}/collection/token/`, {
        method: "POST",
        headers: {
          authorization: `Basic ${basic}`,
          "ocp-apim-subscription-key": sub,
        },
      });
      const token = String(
        ((await res!.json()) as { access_token: string }).access_token,
      );
      return {
        authorization: `Bearer ${token}`,
        "x-target-environment":
          this.env("MTN_MOMO_TARGET_ENVIRONMENT") ?? "sandbox",
        "ocp-apim-subscription-key": sub,
      };
    };
    return {
      name: "momo",
      enabled: () =>
        !!(
          this.env("MTN_MOMO_SUBSCRIPTION_KEY") &&
          this.env("MTN_MOMO_API_USER") &&
          this.env("MTN_MOMO_API_KEY")
        ),
      initiate: async (a) => {
        if (!a.phone) throw phoneRequired();
        const ref = randomUUID();
        await call(`${base()}/collection/v1_0/requesttopay`, {
          method: "POST",
          headers: {
            ...(await headers()),
            "x-reference-id": ref,
            "x-callback-url": a.callbackUrl,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            amount: String(a.amountRwf),
            currency: "RWF",
            externalId: a.transactionId,
            payer: {
              partyIdType: "MSISDN",
              partyId: a.phone.replace(/\D/g, ""),
            },
            payerMessage: "Hebuza service payment",
            payeeNote: a.transactionId,
          }),
        });
        return { status: "pending", providerReference: ref };
      },
      fetchStatus: async (ref, expected) => {
        const res = await call(
          `${base()}/collection/v1_0/requesttopay/${encodeURIComponent(ref)}`,
          { headers: await headers() },
        );
        if (!res) return null;
        const b = (await res.json()) as {
          status?: string;
          amount?: string;
          currency?: string;
          reason?: string | { code?: string };
        };
        const s = mapMomo(
          b.status,
          typeof b.reason === "string" ? b.reason : b.reason?.code,
        );
        return s === "succeeded" &&
          !this.covers(ref, b.amount, b.currency, expected)
          ? null
          : s;
      },
    };
  }

  // ── Airtel Money collection (Airtel Africa Open API) ──
  private airtel(): PaymentDriver {
    const base = () =>
      this.env("AIRTEL_BASE_URL") ?? "https://openapiuat.airtel.africa";
    const headers = async () => {
      const res = await call(`${base()}/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: this.env("AIRTEL_CLIENT_ID"),
          client_secret: this.env("AIRTEL_CLIENT_SECRET"),
          grant_type: "client_credentials",
        }),
      });
      const token = String(
        ((await res!.json()) as { access_token: string }).access_token,
      );
      return {
        authorization: `Bearer ${token}`,
        "x-country": "RW",
        "x-currency": "RWF",
        "content-type": "application/json",
      };
    };
    return {
      name: "airtel",
      enabled: () =>
        !!(this.env("AIRTEL_CLIENT_ID") && this.env("AIRTEL_CLIENT_SECRET")),
      initiate: async (a) => {
        if (!a.phone) throw phoneRequired();
        await call(`${base()}/merchant/v1/payments/`, {
          method: "POST",
          headers: await headers(),
          body: JSON.stringify({
            reference: "Hebuza service payment",
            subscriber: {
              country: "RW",
              currency: "RWF",
              msisdn: a.phone.replace(/\D/g, "").replace(/^250/, ""),
            },
            transaction: {
              amount: a.amountRwf,
              country: "RW",
              currency: "RWF",
              id: a.transactionId,
            },
          }),
        });
        return { status: "pending", providerReference: a.transactionId };
      },
      fetchStatus: async (ref) => {
        const res = await call(
          `${base()}/standard/v1/payments/${encodeURIComponent(ref)}`,
          { headers: await headers() },
        );
        if (!res) return null;
        return mapAirtel(
          (
            (await res.json()) as {
              data?: { transaction?: { status?: string } };
            }
          ).data?.transaction?.status,
        );
      },
    };
  }

  // ── Flutterwave hosted checkout (card details never touch this server) ──
  private flutterwave(): PaymentDriver {
    const auth = () => ({
      authorization: `Bearer ${this.env("FLUTTERWAVE_SECRET_KEY")}`,
    });
    return {
      name: "flutterwave",
      enabled: () => !!this.env("FLUTTERWAVE_SECRET_KEY"),
      initiate: async (a) => {
        const res = await call("https://api.flutterwave.com/v3/payments", {
          method: "POST",
          headers: { ...auth(), "content-type": "application/json" },
          body: JSON.stringify({
            tx_ref: a.transactionId,
            amount: a.amountRwf,
            currency: "RWF",
            redirect_url: a.returnUrl,
            payment_options: "card",
            customer: { email: a.email || "client@hebuza.rw" },
            customizations: { title: "Hebuza", description: "Service payment" },
          }),
        });
        const d =
          (
            (await res!.json()) as {
              data?: { link?: string; id?: number | string };
            }
          ).data ?? {};
        return {
          status: "pending",
          sessionToken: d.link ?? null,
          providerReference: String(d.id ?? a.transactionId),
        };
      },
      fetchStatus: async (ref, expected) => {
        const res = await call(
          `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(ref)}/verify`,
          { headers: auth() },
        );
        if (!res) return null;
        const d =
          (
            (await res.json()) as {
              data?: { status?: string; amount?: number; currency?: string };
            }
          ).data ?? {};
        const s = mapFlutterwave(d.status);
        return s === "succeeded" &&
          !this.covers(ref, d.amount, d.currency, expected)
          ? null
          : s;
      },
      refund: async (txRef, amountRwf, ref) => {
        const v = await call(
          `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`,
          { headers: auth() },
        );
        const id = v && ((await v.json()) as { data?: { id?: number | string } }).data?.id;
        if (!id) throw new Error(`flutterwave transaction ${txRef} not found`);
        // Our refund no doubles as the gateway idempotency key: a retried claim can't refund twice.
        const r = await call(`https://api.flutterwave.com/v3/transactions/${encodeURIComponent(String(id))}/refund`, {
          method: "POST",
          headers: { ...auth(), "content-type": "application/json", "X-Idempotency-Key": ref },
          body: JSON.stringify({ amount: amountRwf, comments: ref }),
        });
        if (!r) throw new Error(`flutterwave refund ${txRef} not found`);
      },
    };
  }

  /** A short or non-RWF charge never settles as paid. */
  covers(ref: string, amount: unknown, currency: unknown, expected: number) {
    const ok =
      Number(amount) >= expected &&
      String(currency ?? "").toUpperCase() === "RWF";
    if (!ok)
      this.log.error(
        `payment_amount_mismatch ${ref} ${String(amount)} ${String(currency)}`,
      );
    return ok;
  }
}
