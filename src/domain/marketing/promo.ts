// F-CRM-20 promotions: a promo code gives a % or fixed RWF discount on service fees, within dates and a use cap.
export type Promo = { code: string; kind: "percent" | "amount"; value: number; from?: string; to?: string; maxUses?: number; uses: number; active: boolean; services?: string[] };
export type PromoCheck = { ok: true } | { ok: false; why: "inactive" | "not_started" | "expired" | "used_up" | "not_applicable" };

export function checkPromo(p: Promo, day: string, service?: string): PromoCheck {
  if (!p.active) return { ok: false, why: "inactive" };
  if (p.from && day < p.from) return { ok: false, why: "not_started" };
  if (p.to && day > p.to) return { ok: false, why: "expired" };
  if (p.maxUses != null && p.uses >= p.maxUses) return { ok: false, why: "used_up" };
  if (p.services?.length && (!service || !p.services.includes(service))) return { ok: false, why: "not_applicable" };
  return { ok: true };
}
/** Discount in RWF on the given service-fee base (never more than the base). */
export const promoDiscount = (p: Promo, base: number) =>
  Math.min(base, p.kind === "percent" ? Math.round((base * Math.min(100, p.value)) / 100) : p.value);
