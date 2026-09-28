// Reminder times (DESIGN §6.6): the harness parses when_text in the owner's timezone.
// Code handles common phrasings; otherwise the model picks a date from a printed calendar.

import { config } from "../config.ts";
import { now } from "../db.ts";
import { llmJson } from "../llm/gateway.ts";
import { resolveWhen } from "../prompts/conversation.ts";

const TZ = () => config.owner.timezone;
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Wall-clock parts of an instant in the owner's timezone. */
export function zoned(d: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ(), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "long" })
      .formatToParts(d).map((x) => [x.type, x.value]),
  );
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, wd: DAYS.indexOf(p.weekday.toLowerCase()) };
}

/** Instant for a wall-clock time in the owner's timezone. */
export function fromZoned(y: number, m: number, d: number, h: number, min: number): Date {
  let t = Date.UTC(y, m - 1, d, h, min);
  for (let i = 0; i < 2; i++) {
    const z = zoned(new Date(t));
    const diff = Date.UTC(z.y, z.m - 1, z.d, z.h, z.min) - Date.UTC(y, m - 1, d, h, min);
    t -= diff;
  }
  return new Date(t);
}

function addDays(z: { y: number; m: number; d: number }, n: number) {
  const x = new Date(Date.UTC(z.y, z.m - 1, z.d + n));
  return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() };
}

function parseTime(t: string): { h: number; min: number } | null {
  let m = t.match(/\b(?:at\s+)?(\d{1,2})[:.](\d{2})\s*(am|pm)?\b/);
  if (m) {
    let h = +m[1];
    if (m[3] === "pm" && h < 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
    return { h, min: +m[2] };
  }
  m = t.match(/\b(?:at\s+)?(\d{1,2})\s*(am|pm|h|uhr|o'clock)\b/);
  if (m) {
    let h = +m[1];
    if (m[2] === "pm" && h < 12) h += 12;
    if (m[2] === "am" && h === 12) h = 0;
    return { h, min: 0 };
  }
  m = t.match(/\bat\s+(\d{1,2})\b/);
  if (m) {
    let h = +m[1];
    if (h < 8) h += 12; // "at 3" means 15:00
    return { h, min: 0 };
  }
  if (/\bnoon|midday\b/.test(t)) return { h: 12, min: 0 };
  if (/\btonight\b|\bthis evening\b|\bin the evening\b/.test(t)) return { h: 19, min: 0 };
  if (/\bafternoon\b/.test(t)) return { h: 15, min: 0 };
  if (/\bmorning\b/.test(t)) return { h: 9, min: 0 };
  return null;
}

/** Returns a Date, or null when code can't parse it. */
export function parseWhen(text: string, ref = now()): Date | null {
  const t = text.toLowerCase().trim();
  const z = zoned(ref);
  const rel = t.match(/\bin\s+(an?|\d+|one|two|three|half an)\s*(minutes?|mins?|hours?|days?|weeks?)\b/);
  if (rel) {
    const n = rel[1].startsWith("a") || rel[1] === "one" ? 1 : rel[1] === "two" ? 2 : rel[1] === "three" ? 3 : rel[1] === "half an" ? 0.5 : +rel[1];
    const unit = rel[2][0] === "m" ? 60e3 : rel[2][0] === "h" ? 3600e3 : rel[2][0] === "d" ? 86400e3 : 7 * 86400e3;
    return new Date(ref.getTime() + n * unit);
  }
  const time = parseTime(t);
  let day: { y: number; m: number; d: number } | null = null;
  if (/\btoday\b|\btonight\b|\bthis (evening|afternoon|morning)\b/.test(t)) day = z;
  else if (/\bday after tomorrow\b/.test(t)) day = addDays(z, 2);
  else if (/\btomorrow\b/.test(t)) day = addDays(z, 1);
  else if (/\bnext week\b/.test(t)) day = addDays(z, ((1 - z.wd + 7) % 7) || 7); // next Monday
  else {
    const wd = DAYS.findIndex((d) => new RegExp(`\\b${d}\\b`).test(t));
    if (wd >= 0) {
      let n = (wd - z.wd + 7) % 7;
      if (n === 0) n = 7;
      if (/\bnext\b/.test(t) && n < 7 && /\bnext week\b/.test(t)) n += 7;
      day = addDays(z, n);
    } else {
      const md = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3})[a-z]*\b/) ?? t.match(/\b([a-z]{3})[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
      if (md) {
        const [dd, mm] = /^\d/.test(md[1]) ? [+md[1], MONTHS.indexOf(md[2])] : [+md[2], MONTHS.indexOf(md[1])];
        if (mm >= 0) {
          let y = z.y;
          if (mm + 1 < z.m || (mm + 1 === z.m && dd < z.d)) y++;
          day = { y, m: mm + 1, d: dd };
        }
      }
      const dot = !day && t.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})?/);
      if (dot) {
        let y = dot[3] ? +dot[3] : z.y;
        if (!dot[3] && (+dot[2] < z.m || (+dot[2] === z.m && +dot[1] < z.d))) y++;
        day = { y, m: +dot[2], d: +dot[1] };
      }
    }
  }
  if (!day && time) {
    // time only: today if still ahead, else tomorrow
    const cand = fromZoned(z.y, z.m, z.d, time.h, time.min);
    return cand > ref ? cand : fromZoned(...Object.values(addDays(z, 1)) as [number, number, number], time.h, time.min);
  }
  if (!day) return null;
  const tt = time ?? { h: 9, min: 0 };
  return fromZoned(day.y, day.m, day.d, tt.h, tt.min);
}

export async function resolveReminderTime(when_text: string, opts: { topic_id?: string } = {}): Promise<{ at: Date; via: "code" | "model" }> {
  const c = parseWhen(when_text);
  if (c) return { at: c, via: "code" };
  const ref = now();
  const z = zoned(ref);
  const days: string[] = [];
  for (let i = 0; i < 21; i++) {
    const d = addDays(z, i);
    const wd = DAYS[(z.wd + i) % 7];
    days.push(`${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")} ${wd}${i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : ""}`);
  }
  const p = resolveWhen({ when_text, now: fmtNow(), days });
  const r = await llmJson<{ date: string; time: string | null }>("resolve_when", p.prompt, p.schema, { maxTokens: p.maxTokens, version: p.version, topic_id: opts.topic_id, priority: "interactive" });
  const [y, m, d] = r.date.split("-").map(Number);
  const tm = r.time?.match(/^(\d{1,2}):(\d{2})$/);
  return { at: fromZoned(y, m, d, tm ? +tm[1] : 9, tm ? +tm[2] : 0), via: "model" };
}

export function fmtWhen(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ(), weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d).replace(",", "");
}

/** Date only, e.g. "12 Sep 2026". */
export function fmtDate(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ(), day: "numeric", month: "short", year: "numeric" }).format(d);
}

export function fmtNow(): string {
  const d = now();
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ(), weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d) + ` (${TZ()})`;
}
