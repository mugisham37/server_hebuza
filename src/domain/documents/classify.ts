// F-DOC-12: document kind suggestion from OCR text (provider-agnostic). Suggestions only; staff QC decides.
export type DocKindGuess = { kind: "identity" | "tax" | "company" | "bank" | "other"; confidence: number };
const RULES: [DocKindGuess["kind"], RegExp][] = [
  ["identity", /indangamuntu|national id|carte d'identit[eé]|\b1\d{15}\b|passport|pasiporo/i],
  ["tax", /\b(rra|rwanda revenue|tin\b|tax clearance|vat|ebm|imisoro)\b/i],
  ["company", /\b(rdb|rwanda development board|certificate of (domestic )?company registration|memorandum|articles of association)\b/i],
  ["bank", /\b(bank statement|account statement|iban|swift|bk |equity bank|i&m bank|cogebanque)\b/i],
];
export function classifyText(text: string): DocKindGuess {
  const t = text.slice(0, 20_000);
  const hits = RULES.map(([kind, re]) => ({ kind, n: (t.match(new RegExp(re, "gi")) ?? []).length })).filter((h) => h.n > 0).sort((a, b) => b.n - a.n);
  if (!hits.length) return { kind: "other", confidence: 0 };
  const total = hits.reduce((s, h) => s + h.n, 0);
  return { kind: hits[0].kind, confidence: Math.round((hits[0].n / total) * 100) / 100 };
}
