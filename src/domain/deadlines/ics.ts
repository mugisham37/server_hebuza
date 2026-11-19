// F-CAL-04: client compliance calendar as an iCalendar feed (all-day events). Pure.
export type CalItem = { id: string; title: string; dueDate: string; status: string };
const esc = (s: string) => s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, "\\n");
const day = (d: string) => d.replaceAll("-", "").slice(0, 8);
const nextDay = (d: string) => { const t = new Date(`${d.slice(0, 10)}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };

export function obligationsIcs(items: CalItem[], stamp = new Date()): string {
  const now = stamp.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const ev = items.map((o) => [
    "BEGIN:VEVENT", `UID:${o.id}@hebuza.rw`, `DTSTAMP:${now}`, `DTSTART;VALUE=DATE:${day(o.dueDate)}`, `DTEND;VALUE=DATE:${day(nextDay(o.dueDate))}`,
    `SUMMARY:${esc(o.title)}`, `STATUS:${o.status === "done" ? "CANCELLED" : "CONFIRMED"}`,
    "BEGIN:VALARM", "TRIGGER:-P3D", "ACTION:DISPLAY", `DESCRIPTION:${esc(o.title)}`, "END:VALARM", "END:VEVENT",
  ].join("\r\n"));
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//HEBUZA//Compliance calendar//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:HEBUZA deadlines", ...ev, "END:VCALENDAR", ""].join("\r\n");
}
