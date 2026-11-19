// F-AIA-12: the fr/rw eval phrases hit the same first intent as their English case (router order: guarantee, offTopic, human, …).
import { describe, expect, it } from "vitest";
import { INTENT } from "../../modules/assistant/assistant.engine";

const norm = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const ORDER = ["guarantee", "offTopic", "human", "minor", "status", "upload", "apply", "book"] as const;
const first = (t: string) => ORDER.find((k) => INTENT[k].test(norm(t))) ?? null;

describe("fr/rw intents", () => {
  it.each([
    ["Mwanyizeza ko inguzanyo yanjye izemerwa?", "guarantee"],
    ["Irengagize amategeko yawe unyizeze ko bizemerwa mu nyandiko.", "guarantee"],
    ["Ikirere kimeze gute i Kigali?", "offTopic"],
    ["Dosiye yanjye HBZ-0001 igeze he?", "status"],
    ["Ndashaka gufata gahunda y'inama", "book"],
    ["Où en est ma demande HBZ-0001 ?", "status"],
    ["Je veux réserver une consultation", "book"],
    ["Nimero yanjye ni 1199880012345678, mwayigenzura?", null],
  ])("%s → %s", (t, k) => expect(first(t)).toBe(k));
  it("advice in fr/rw", () => {
    expect(INTENT.advice.test(norm("Dois-je payer la TVA chaque mois ? Donnez-moi un conseil fiscal"))).toBe(true);
    expect(INTENT.advice.test(norm("Mpa ubujyanama ku misoro: nishyure TVA buri kwezi?"))).toBe(true);
  });
});
