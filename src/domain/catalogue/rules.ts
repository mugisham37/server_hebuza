// Pure catalogue rules shared by api (pricing, publish checks) and web (builder copy limits): range-pricing bands and
// fees (Python services/pricing.py), D12 copy limits and the empty builder meta. Money is integer RWF; percentages round half-up.
export type BandIn = {
  min_amount_rwf: number;
  max_amount_rwf?: number | null;
  fee_type: "flat" | "percent" | string;
  fee_rwf?: number | null;
  fee_percent?: number | null;
  min_fee_rwf?: number | null;
  max_fee_rwf?: number | null;
};


/** Fee for `amount` under one band. Integer math on basis points avoids float drift on large amounts. */
export function bandFee(b: BandIn, amount: number) {
  if (b.fee_type !== "percent") return Math.trunc(b.fee_rwf ?? 0);
  const bp = Math.round((b.fee_percent ?? 0) * 10_000); // percent × 10^4, exact for numeric(7,4)
  const num = BigInt(amount) * BigInt(bp);
  const den = BigInt(1_000_000);
  let fee = Number((num * BigInt(2) + den) / (BigInt(2) * den)); // half-up on non-negative values
  if (b.min_fee_rwf != null) fee = Math.max(fee, b.min_fee_rwf);
  if (b.max_fee_rwf != null) fee = Math.min(fee, b.max_fee_rwf);
  return fee;
}

/** The band whose [min, max) holds `amount`, or null (the service is quoted). */
export const selectBand = <B extends BandIn>(bands: B[], amount: number) =>
  [...bands]
    .sort((a, b) => a.min_amount_rwf - b.min_amount_rwf)
    .find(
      (b) =>
        amount >= b.min_amount_rwf &&
        (b.max_amount_rwf == null || amount < b.max_amount_rwf),
    ) ?? null;

export function urgentSurcharge(
  kind: string | null | undefined,
  value: number | null | undefined,
  baseFee: number,
) {
  if (!kind || !value) return 0;
  return kind === "percent"
    ? Math.floor((baseFee * value * 2 + 100) / 200)
    : value;
}
/** Contiguous, ascending bands from 0; only the last may be open-ended. Returns the first problem, or null. */
export function bandsProblem(bands: BandIn[]): string | null {
  try { validate(bands); return null; } catch (e) { return (e as Error).message; }
}
const fail = (message: string) => new Error(message);
function validate(bands: BandIn[]) {
  if (!bands.length) throw fail("Add at least one amount band.");
  let prevMax: number | null = null;
  bands.forEach((b, i) => {
    const n = i + 1;
    if (b.min_amount_rwf == null || b.min_amount_rwf < 0)
      throw fail(`Band ${n} needs a starting amount of 0 or more.`);
    if (n === 1 && b.min_amount_rwf !== 0)
      throw fail("The first band must start at 0.");
    if (n > 1) {
      if (prevMax == null) throw fail("Only the last band can be open-ended.");
      if (b.min_amount_rwf !== prevMax)
        throw fail(
          `Band ${n} must start where band ${n - 1} ends (${prevMax.toLocaleString("en-US")} RWF), with no gap or overlap.`,
        );
    }
    if (b.max_amount_rwf != null && b.max_amount_rwf <= b.min_amount_rwf)
      throw fail(`Band ${n} must end above where it starts.`);
    if (b.fee_type !== "flat" && b.fee_type !== "percent")
      throw fail(`Band ${n} fee is a fixed amount or a percentage.`);
    if (b.fee_type === "flat") {
      if (b.fee_rwf == null || b.fee_rwf < 0)
        throw fail(`Band ${n} needs a fee of 0 or more.`);
    } else {
      if (b.fee_percent == null || !(b.fee_percent > 0 && b.fee_percent <= 100))
        throw fail(`Band ${n} needs a percentage above 0 and up to 100.`);
      if (
        b.min_fee_rwf != null &&
        b.max_fee_rwf != null &&
        b.max_fee_rwf < b.min_fee_rwf
      )
        throw fail(`Band ${n} maximum fee must not be below its minimum fee.`);
    }
    prevMax = b.max_amount_rwf ?? null;
  });
}

export const LIMITS = {
  name: 80,
  short: 160,
  description: 600,
  includedItems: 8,
  includedItem: 80,
} as const;
const loc = (x: unknown): Record<string, string> =>
  typeof x === "string"
    ? { en: x }
    : x && typeof x === "object"
      ? (Object.fromEntries(
          Object.entries(x).filter(([, v]) => typeof v === "string"),
        ) as Record<string, string>)
      : {};

/** Every service copy field over its limit, as readable lines. Never truncates. */
export function copyLimitIssues(meta: Record<string, unknown>) {
  const out: string[] = [];
  for (const [label, value, limit] of [
    ["Service name", meta.name, LIMITS.name],
    ["Short description", meta.short ?? meta.shortDescription, LIMITS.short],
    ["Description", meta.description, LIMITS.description],
  ] as const)
    for (const [code, text] of Object.entries(loc(value)))
      if (text.length > limit)
        out.push(
          `${label} (${code}) is ${text.length} characters; the limit is ${limit}.`,
        );
  const items = meta.includedItems ?? [];
  if (!Array.isArray(items)) return [...out, "What's included must be a list."];
  if (items.length > LIMITS.includedItems)
    out.push(
      `What's included has ${items.length} items; the limit is ${LIMITS.includedItems}.`,
    );
  items.forEach((it, i) => {
    for (const [code, text] of Object.entries(loc(it)))
      if (text.length > LIMITS.includedItem)
        out.push(
          `What's included item ${i + 1} (${code}) is ${text.length} characters; the limit is ${LIMITS.includedItem}.`,
        );
  });
  return out;
}

export const EMPTY_META = (
  name: string,
  short: string,
  categoryId: string,
  subcategoryId: string,
) => ({
  name: { rw: "", en: name, fr: "" },
  short: { rw: "", en: short, fr: "" },
  categoryId,
  subcategoryId,
  languages: ["rw", "en", "fr"],
  eligibility: [],
  documents: [],
  checklist: [],
  deliverables: [],
  sla: {
    firstResponse: 2,
    firstResponseUnit: "hours",
    days: { standard: 5, express: 2, urgent: 1 },
    pauses: ["awaiting_client_documents", "awaiting_payment"],
    offsets: [-24, 0, 48],
  },
});

