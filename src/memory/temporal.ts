import * as chrono from "chrono-node";
import { addDays, humanDate, localDate, weekday } from "../util/clock.ts";

/**
 * Deterministic date resolution (SPEC §4). Models never invent date ranges.
 *
 * Known chrono-node pitfalls handled here:
 *  - "last Tuesday" is ambiguous (yesterday vs. the week before), so both candidates are returned
 *  - a bare "3 November" can resolve to the future, so we bias to the past
 *  - "last week"/"last month" are expanded to ranges
 *  - forwardDate is never used
 */
export type DateWindow = {
  /** Inclusive local dates, 'YYYY-MM-DD'. */
  start: string;
  end: string;
  /** The phrase that produced this window. */
  phrase: string;
  /** Human label, e.g. 'Tue 10 Nov' or '2–8 Nov'. */
  label: string;
};

export type TemporalResult = {
  /** Alternative readings of the same phrase (e.g. two candidates for "last Tuesday"), most recent first. */
  groups: DateWindow[][];
  /** The message refers back to earlier conversation or an earlier point in time. */
  backReference: boolean;
  today: string;
  /** Calendar dates that don't exist ("29 February 2023"), as written by the user. */
  invalid: string[];
};

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY_RE = "(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thu(?:rs?)?|fri|sat)";

function dayIndex(word: string): number {
  const w = word.toLowerCase();
  return DAYS.findIndex((d) => d.startsWith(w.slice(0, 3)));
}

/** Most recent date strictly before `today` that falls on weekday `wd`. */
function previousWeekday(today: string, wd: number): string {
  let d = addDays(today, -1);
  while (weekday(d) !== wd) d = addDays(d, -1);
  return d;
}

function single(ymd: string, phrase: string): DateWindow {
  return { start: ymd, end: ymd, phrase, label: humanDate(ymd) };
}

function range(start: string, end: string, phrase: string): DateWindow {
  return { start, end, phrase, label: start === end ? humanDate(start) : `${humanDate(start)} – ${humanDate(end)}` };
}

const BACKREF_RE =
  /\b(did i ask|i asked|you (told|said|recommended|suggested|answered)|we (talked|discussed|shortlisted|compared|looked)|earlier|previously|last time|still (correct|true|valid|accurate|right)|changed since|since (then|we|i|you|last|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d)|what did (i|we)|remind me what)\b/i;
// Not "your answer / your recommendation": inside a chat that is the PREVIOUS REPLY ("give me your recommendation in
// two lines"), handled by the reply need; a past-chat reference carries its own cue ("you recommended", a date).

export function resolveTemporal(text: string, nowInstant: Date, tz: string): TemporalResult {
  const today = localDate(nowInstant, tz);
  const found: Array<{ at: number; w: DateWindow[] }> = [];
  const invalid: string[] = [];
  const consumed: Array<[number, number]> = [];
  const lower = text.toLowerCase();

  // A bare weekday / undated calendar date is a PAST window only when the message reads as past (a past-tense
  // cue, or since/from). "What did I ask on Tuesday?" yes; "is the store open on Saturday?" no.
  const pastCue = /\b(did|was|were|had|asked|told|said|talked|discussed|chatted|mentioned|recommended|suggested|gave|shortlisted|compared|went|got|since|from|ago|last)\b|\b[a-z]{3,}ed\b/.test(lower);
  // Future phrases are set aside (consumed) before anything else, so they can never become past windows.
  const skip = (re: RegExp) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower))) consumed.push([m.index, m.index + m[0].length]);
  };
  skip(new RegExp(`\\b(?:next|coming|upcoming|this coming|following)\\s+(?:${DAY_RE}|week|weekend|month|year)\\b`, "g"));
  skip(/\b(tomorrow|day after tomorrow|tonight|later (?:today|this week|this month)|in (?:\d+|a|one|two|three|a few|a couple of) (?:days?|weeks?|months?))\b/g);
  const take = (re: RegExp, fn: (m: RegExpExecArray) => DateWindow[] | null) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower))) {
      const span: [number, number] = [m.index, m.index + m[0].length];
      if (consumed.some(([a, b]) => span[0] < b && span[1] > a)) continue;
      const w = fn(m);
      if (w && w.length) {
        found.push({ at: span[0], w });
        consumed.push(span);
      }
    }
  };

  // Order matters: longer phrases are taken before the shorter ones they contain.
  // "the Monday before last" → the occurrence one week before the most recent past Monday.
  take(new RegExp(`\\b(?:the\\s+)?${DAY_RE}\\s+before\\s+last\\b`, "g"), (m) => {
    const wd = dayIndex(m[1]!);
    return [single(addDays(previousWeekday(today, wd), -7), m[0])];
  });
  take(/\b(?:the\s+)?day before yesterday\b/g, (m) => [single(addDays(today, -2), m[0])]);
  // "last weekend": the most recent Saturday–Sunday strictly before today.
  take(/\b(last|past|previous)\s+weekend\b/g, (m) => {
    const sun = previousWeekday(today, 0);
    return [range(addDays(sun, -1), sun, m[0])];
  });
  // Named days, most recent past occurrence.
  take(/\b(halloween|christmas eve|christmas(?: day)?|new year'?s eve|new year'?s(?: day)?|valentine'?s(?: day)?)\b/g, (m) => {
    const name = m[1]!.toLowerCase();
    const md = name.startsWith("halloween") ? "10-31" : name.startsWith("christmas eve") ? "12-24" : name.startsWith("christmas") ? "12-25" : /eve$/.test(name) ? "12-31" : name.startsWith("new year") ? "01-01" : "02-14";
    let y = Number(today.slice(0, 4));
    if (`${y}-${md}` > today) y -= 1;
    return [single(`${y}-${md}`, m[0])];
  });
  // "on the 5th" (no month): the most recent past 5th. "the 5th of November" is left to chrono.
  // ...only in a date position: "on the 5th", or "the 5th" ending a clause — not "the 3rd option".
  take(/\b(?:on\s+the\s+(\d{1,2})(?:st|nd|rd|th)\b(?!\s+of\b)(?!\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))|the\s+(\d{1,2})(?:st|nd|rd|th)(?=\s*(?:[?.!,;]|$)))/g, (m) => {
    const d = Number(m[1] ?? m[2]);
    if (d < 1 || d > 31) return null;
    const [y, mo, td] = today.split("-").map(Number) as [number, number, number];
    let yy = y, mm = mo;
    if (d > td) { mm -= 1; if (mm === 0) { mm = 12; yy -= 1; } }
    const ymd = `${yy}-${String(mm).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const back = new Date(`${ymd}T12:00:00Z`);
    if (back.getUTCDate() !== d) return null; // e.g. "the 31st" in a 30-day month
    return [single(ymd, m[0])];
  });
  // "last Tuesday" → both candidates (the most recent past Tuesday, and the one before).
  take(new RegExp(`\\blast\\s+${DAY_RE}\\b`, "g"), (m) => {
    const wd = dayIndex(m[1]!);
    const a = previousWeekday(today, wd);
    return [single(a, m[0]), single(addDays(a, -7), m[0])];
  });
  // "this Monday" / "on Monday" / bare "Monday" in a past-tense question → most recent past occurrence.
  // Abbreviations ("sat", "wed") only count after a cue word, so "I sat down" isn't a date.
  take(new RegExp(`\\b(?:(?:this|on|since|from)\\s+${DAY_RE}|(sunday|monday|tuesday|wednesday|thursday|friday|saturday))\\b`, "g"), (m) => {
    const wd = dayIndex((m[1] ?? m[2])!);
    if (wd < 0) return null;
    if (!pastCue && !/^(since|from)\b/.test(m[0].trim())) return null; // "open on Saturday": not a past window
    const d = weekday(today) === wd && /\bthis\b/.test(m[0]) ? today : previousWeekday(today, wd);
    return [single(d, m[0].trim())];
  });
  // Plain "today" / "now" means the present, not a recall window ("is it still correct today?").
  take(/\b(earlier today|this morning|this afternoon)\b/g, (m) => [single(today, m[0])]);
  take(/\byesterday\b/g, (m) => [single(addDays(today, -1), m[0])]);
  take(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+days?\s+ago\b/g, (m) => {
    const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    return [single(addDays(today, -(words[m[1]!.toLowerCase()] ?? Number(m[1]))), m[0])];
  });
  take(/\b(a|one|two|three|\d)\s+weeks?\s+ago\b/g, (m) => {
    const n = ({ a: 1, one: 1, two: 2, three: 3 } as Record<string, number>)[m[1]!] ?? Number(m[1]);
    const c = addDays(today, -7 * n);
    return [range(addDays(c, -3), addDays(c, 3), m[0])];
  });
  take(/\blast\s+week\b/g, (m) => {
    // Previous Monday–Sunday week.
    const thisMon = addDays(today, -((weekday(today) + 6) % 7));
    return [range(addDays(thisMon, -7), addDays(thisMon, -1), m[0])];
  });
  take(/\bthis\s+week\b/g, (m) => [range(addDays(today, -((weekday(today) + 6) % 7)), today, m[0])]);
  take(/\b(earlier\s+)?this\s+month\b/g, (m) => [range(`${today.slice(0, 8)}01`, today, m[0])]);
  take(/\blast\s+month\b/g, (m) => {
    const [y, mo] = today.split("-").map(Number) as [number, number];
    const py = mo === 1 ? y - 1 : y;
    const pm = mo === 1 ? 12 : mo - 1;
    const start = `${py}-${String(pm).padStart(2, "0")}-01`;
    const end = addDays(`${y}-${String(mo).padStart(2, "0")}-01`, -1);
    return [range(start, end, m[0])];
  });
  take(/\b(the other day|recently|a few days ago|a couple of days ago)\b/g, (m) => [range(addDays(today, -7), addDays(today, -1), m[0])]);

  // Explicit calendar dates ("3 November", "Nov 3", "2026-11-03") via chrono, with a past bias.
  const ref = new Date(`${today}T12:00:00Z`);
  // chrono silently rolls impossible dates over ("29 Feb 2023" → 1 Mar), so check them first.
  for (const m of text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi)) {
    const day = Number(m[1] ?? m[5]);
    const mon = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf((m[2] ?? m[4])!.toLowerCase().slice(0, 3)) + 1;
    const year = Number(m[3] ?? m[6]);
    const d = new Date(Date.UTC(year, mon - 1, day));
    if (d.getUTCMonth() !== mon - 1 || d.getUTCDate() !== day) {
      invalid.push(m[0].trim());
      consumed.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    }
  }
  for (const r of chrono.parse(text, { instant: ref, timezone: "UTC" })) {
    const span: [number, number] = [r.index, r.index + r.text.length];
    if (consumed.some(([a, b]) => span[0] < b && span[1] > a)) continue;
    if (!r.start.isCertain("day") || !r.start.isCertain("month")) continue;
    if (/^(now|today|tonight|right now)$/i.test(r.text.trim())) continue;
    let y = r.start.get("year")!;
    const mo = r.start.get("month")!;
    const d = r.start.get("day")!;
    let ymd = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (!r.start.isCertain("year") && ymd > today) {
      if (!pastCue) continue; // "weather on 20 November": a future date, not last year's
      y -= 1;
      ymd = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
    let end = ymd;
    if (r.end && r.end.isCertain("day")) {
      const e = `${r.end.get("year")}-${String(r.end.get("month")).padStart(2, "0")}-${String(r.end.get("day")).padStart(2, "0")}`;
      if (e >= ymd) end = e;
    }
    found.push({ at: span[0], w: [range(ymd, end, r.text)] });
    consumed.push(span);
  }

  const groups = found.sort((a, b) => a.at - b.at).map((f) => f.w);
  const backReference = BACKREF_RE.test(text) || groups.some((g) => g.every((w) => w.end < today));
  return { groups, backReference: backReference || invalid.length > 0, today, invalid };
}
