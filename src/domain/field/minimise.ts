// F-DOC-06 / privacy: the phone caches only what the job needs — name, phone (to call), language. Never national ID,
// TIN, email or home address (plan §10.2).
import type { L3, MinimalContact } from "@/domain/field/types";

export function maskPhone(phone: string) {
  const d = phone.replace(/\D/g, "");
  return d.length < 6 ? "•••" : `+${d.slice(0, 3)} ${d.slice(3, 4)}•• ••• ${d.slice(-3)}`;
}
export function minimiseContact(c: { name: string; phone: string; language?: string } & Record<string, unknown>): MinimalContact {
  const language = (["rw", "en", "fr"].includes(c.language ?? "") ? c.language : "rw") as L3;
  return { name: c.name, phone: c.phone, phoneMasked: maskPhone(c.phone), language };
}

if (process.env.NODE_ENV !== "production") {
  const m = minimiseContact({ name: "A", phone: "+250788000214", language: "rw", nationalId: "1199", email: "a@x" });
  console.assert(!("nationalId" in m) && !("email" in m) && m.phoneMasked.endsWith("214"), "field minimise: no ID/email cached");
}
