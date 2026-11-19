// F-CRM-11 next-service recommendations: editor-managed rules "used X → suggest Y", first matching rules win.
export type RecRule = { id: string; ifUsed: string; recommend: string[]; active: boolean };
/** Suggestions for a customer: union of active rules whose `ifUsed` they have, minus services already used; max 3. */
export function recommend(used: string[], rules: RecRule[], fallback: string[] = []): string[] {
  const has = new Set(used);
  const out = rules.filter((r) => r.active && (r.ifUsed === "*" || has.has(r.ifUsed))).flatMap((r) => r.recommend);
  return [...new Set(out.length ? out : fallback)].filter((s) => !has.has(s)).slice(0, 3);
}
