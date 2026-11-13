/**
 * Reading and rendering past conversation, in code: date ranges proposed by the planner, the subject of a memory
 * question, product names from an earlier answer, the code-written "On <date> you asked" lines, and choosing
 * which reading of an ambiguous date has history.
 */
import type { RecallHit } from "../memory/store.ts";
import { resolveTemporal, type DateWindow } from "../memory/temporal.ts";
import { addDays, humanDate } from "../util/clock.ts";

/** Accept a planner-proposed date range only if it's real, in the past and within two years. */
export function validRange(r: { start: string; end: string }, today: string): { start: string; end: string } | null {
  const ok = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T12:00:00Z`)) && new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d;
  if (!ok(r.start) || !ok(r.end)) return null;
  const start = r.start <= r.end ? r.start : r.end;
  const end = (r.start <= r.end ? r.end : r.start) > today ? today : r.start <= r.end ? r.end : r.start;
  if (start > today || start < addDays(today, -730)) return null;
  return { start, end };
}

/** A planner topic counts only if it names a real subject (not "query", "what I asked", "Tuesday", "none"). */
export function subjectOf(topic: string | null | undefined): string | null {
  if (!topic) return null;
  const GENERIC = /^(none|null|n\/a|nothing|unknown|user|user's|my|me|i|query|queries|question|questions|ask|asked|asking|conversation|conversations|chat|talk|earlier|previous|before|thing|things|stuff|something|anything|what|that|this|from|on|the|a|of|about|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|yesterday|week|month|january|february|march|april|may|june|july|august|september|october|november|december|\d+(st|nd|rd|th)?)$/i;
  const words = topic.split(/[^A-Za-z0-9'+.-]+/).filter((w) => w && !GENERIC.test(w));
  return words.length ? topic.trim() : null;
}

/**
 * product/company names from the earlier conversation, for rechecks where the planner named none:
 * first-column cells of markdown tables in the earlier answer, then capitalised names in the question.
 */
export function entitiesFromHistory(hits: RecallHit[]): string[] {
  const out: string[] = [];
  const add = (x: string) => {
    const v = x.replace(/\*\*|__|`|\[\d+\]/g, "").replace(/\s*\(.*?\)\s*/g, " ").trim();
    if (v.length >= 2 && v.length <= 40 && !/^(item|tool|crm|provider|plan|feature|attribute|option|-+|—)$/i.test(v) && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
  };
  for (const h of hits) {
    const lines = (h.answer?.content ?? "").split("\n");
    let inTable = false;
    for (const l of lines) {
      if (!/^\s*\|.*\|\s*$/.test(l)) { inTable = false; continue; }
      if (/^\s*\|[\s:|-]+\|\s*$/.test(l)) { inTable = true; continue; }
      if (inTable) add(l.trim().replace(/^\|/, "").split("|")[0] ?? "");
    }
  }
  if (!out.length) {
    const STOP = /^(I|We|The|A|An|Compare|What|Which|How|Is|Are|Has|Have|Did|Do|On|In|For|And|Or|Our|My|Shortlist|SaaS|USD|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/;
    for (const h of hits)
      for (const frag of h.question.content.split(/[.,;:?!]\s|\s(?:and|or|vs\.?|versus)\s/))
        for (const m of frag.matchAll(/\b([A-Z][A-Za-z0-9+-]*(?:\s[A-Z][A-Za-z0-9+-]*)*)/g)) {
          const words = m[1]!.split(" ");
          while (words.length && STOP.test(words[0]!)) words.shift();
          if (words.length) add(words.join(" "));
        }
  }
  return out;
}

/** The topic in "did I ask you about <topic>" (not generic words like "yesterday" or "that"). */
export function topicOf(text: string): string | null {
  const m = text.match(/\b(?:ask(?:ed)?(?: you)?|talk(?:ed)?|discuss(?:ed)?|tell me|told me|mention(?:ed)?)\s+(?:anything\s+)?(?:about|regarding|on)\s+([A-Za-z0-9][\w+-]*(?: [A-Za-z0-9][\w+-]*){0,2})/i);
  if (!m) return null;
  // Time words are when, not what: "did I ask anything on 3 November?" has no topic.
  const words = m[1]!.split(/\s+/).filter((w) => !/^(earlier|this|last|yesterday|today|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|that|it|anything|something|before|ago|on|in|the|of|\d{1,4}(st|nd|rd|th)?|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)$/i.test(w));
  const t = words.join(" ").trim();
  return t.length >= 2 ? t : null;
}

/** Deterministic "On <date> you asked: “…”" lines, written by code from the ledger. */
export function askedLines(hits: RecallHit[], max = 3): string {
  const lines = hits.slice(0, max).map((h) => `On ${humanDate(h.question.local_date)} you asked: “${h.question.content.replace(/\s+/g, " ").slice(0, 220)}”`);
  return `${lines.join("\n")}\n\n`;
}

/** Pick one reading per ambiguous date phrase, using the data (SPEC §4). */
/** One ambiguous date phrase: the reading taken and the others (shown as a chip the user can switch with). */
export type DateChoice = { phrase: string; chosen: { label: string; start: string }; others: Array<{ label: string; start: string }> };

export function chooseInterpretation(groups: DateWindow[][], hits: RecallHit[], max = 5): { windows: DateWindow[]; notes: string[]; hits: RecallHit[]; choices: DateChoice[] } {
  const windows: DateWindow[] = [];
  const notes: string[] = [];
  const choices: DateChoice[] = [];
  const inWin = (h: RecallHit, w: DateWindow) => h.question.local_date >= w.start && h.question.local_date <= w.end;
  for (const g of groups) {
    if (g.length === 1) {
      windows.push(g[0]!);
      notes.push(`"${g[0]!.phrase}" = ${g[0]!.label}`);
      continue;
    }
    const withHits = g.filter((w) => hits.some((h) => inWin(h, w) && h.via !== "date")) ;
    const anyHits = g.filter((w) => hits.some((h) => inWin(h, w)));
    const pick = withHits[0] ?? anyHits[0] ?? g[0]!;
    windows.push(pick);
    const others = g.filter((w) => w !== pick).map((w) => w.label);
    const altWithHistory = g.filter((w) => w !== pick).map((w) => ({ w, h: hits.find((h) => inWin(h, w)) })).filter((x) => x.h);
    const alt = altWithHistory.length
      ? `; the other reading, ${altWithHistory[0]!.w.label}, also has a conversation (“${altWithHistory[0]!.h!.question.content.slice(0, 80)}”), so offer it in one short closing line`
      : "";
    notes.push(`"${pick.phrase}" taken as ${pick.label}${others.length ? ` (it could also mean ${others.join(", ")}${alt})` : ""}`);
    choices.push({ phrase: pick.phrase, chosen: { label: pick.label, start: pick.start }, others: g.filter((w) => w !== pick).map((w) => ({ label: w.label, start: w.start })) });
  }
  const kept = windows.length ? hits.filter((h) => windows.some((w) => inWin(h, w))) : hits;
  // Within the chosen windows, keep text-relevant turns first; fall back to all turns that day.
  const relevant = kept.filter((h) => h.via !== "date");
  return { windows, notes, hits: (relevant.length ? relevant : kept).slice(0, max), choices };
}

export function memoryLines(hits: RecallHit[]): string[] {
  return hits.map((h) => `- ${humanDate(h.question.local_date)} (${h.question.local_date}) user asked: "${h.question.content.slice(0, 200)}" | agent answered: "${(h.answer?.content ?? "(no answer recorded)").slice(0, 400).replace(/\s+/g, " ")}"`);
}

/**
 * The conversation so far, replayed to the answerer (newest first within a budget, returned in order):
 *   - every user message stamped with when it was sent ("[sent Tue 3 Nov, 14:02]"), so "since then" and "earlier
 *     today" have an anchor;
 *   - the latest reply nearly whole, older replies shortened;
 *   - each reply's sources named by site. Its [n] markers are removed (they'd clash with this turn's EVIDENCE
 *     numbering), except on the reply route, where EVIDENCE is that same reply's sources in the same order.
 * Only completed turns are stored, so a cut-off answer can never be replayed as if it were whole.
 */
export type ReplayTurn = { id: number; role: "user" | "assistant"; content: string; created_at_utc: string; local_date: string; tz: string };
export const REPLAY = { latestReplyChars: 3_000, olderReplyChars: 900, userChars: 800 } as const;

export function replayHistory(
  turns: ReplayTurn[],
  sourcesFor: (answerId: number) => Array<{ url: string }>,
  budget: number,
  keepLatestCitations = false,
): Array<{ role: "user" | "assistant"; content: string }> {
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  let used = 0;
  let latestReply = true;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    let content: string;
    if (t.role === "user") content = `[sent ${sentAt(t.created_at_utc, t.local_date, t.tz)}] ${clip(t.content, REPLAY.userChars)}`;
    else {
      const keep = latestReply && keepLatestCitations;
      const body = clip(keep ? t.content : t.content.replace(/\s?\[\d{1,2}\]/g, ""), latestReply ? REPLAY.latestReplyChars : REPLAY.olderReplyChars);
      const sites = [...new Set(sourcesFor(t.id).map((s) => siteOf(s.url)))].slice(0, 6);
      content = sites.length && !keep ? `${body}\n(Sources I used then: ${sites.join(", ")})` : body;
      latestReply = false;
    }
    // Always keep the latest exchange; older turns only while they fit.
    if (out.length >= 2 && used + content.length > budget) break;
    used += content.length;
    out.unshift({ role: t.role, content });
  }
  // A transcript starts with the user.
  while (out[0]?.role === "assistant") out.shift();
  return out;
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, "")} …`);
const siteOf = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").split(/[/?#]/)[0]!;

/** "Tue 3 Nov, 14:02" in the turn's own timezone. */
export function sentAt(utc: string, localDate: string, tz: string): string {
  let time = "";
  try {
    time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }).format(new Date(utc));
  } catch {
    /* unknown timezone: date only */
  }
  return time ? `${humanDate(localDate)}, ${time}` : humanDate(localDate);
}

/**
 * A short reply that settles which reading of the PREVIOUS message's ambiguous date was meant ("no, the other one",
 * "the earlier one", "I meant the 10th"). Returns the previous question with that date fixed, so the turn runs as if
 * the user had asked it unambiguously; null when the message isn't such a reply. Code only.
 *   - "other": the reading the previous reply did NOT use (it names the date it took, "On Tue 3 Nov you asked…");
 *   - "earlier/first/older" and "later/second/more recent": by date;
 *   - a date in the reply itself ("the 10th", "3 Nov"): the reading it overlaps, else that date.
 */
// Only wording that picks between readings: "I meant…", "the other one", or a reply that is JUST "the earlier/later
// one". Ordinals ("explain the second one") and other short follow-ups are new requests, never clarifications.
const DAYWORD = "(one|day|date|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)";
const CLARIFY_RE = new RegExp(`^\\s*(no[,.!]?\\s+)?(i meant|i mean|i was asking about)\\b|\\bthe other ${DAYWORD}\\b|^\\s*(no[,.!]?\\s+)?(the )?(earlier|later|older|newer|more recent) ${DAYWORD}\\s*(please)?[.!?]*\\s*$`, "i");
export function clarifyDate(
  msg: string,
  prev: { message: string; at: Date; tz: string },
  prevReply: string,
  now: Date,
  tz: string,
): { message: string; groups: DateWindow[][]; chosen: DateWindow } | null {
  const words = msg.trim().split(/\s+/);
  if (words.length > 10) return null;
  const before = resolveTemporal(prev.message, prev.at, prev.tz);
  const amb = before.groups.findIndex((g) => g.length > 1);
  if (amb < 0) return null;
  const options = before.groups[amb]!;
  const named = resolveTemporal(msg, now, tz).groups.flat();
  // A named date counts only when it IS one of the readings ("I meant 3 Nov"); "Fed decision yesterday?" is a new question.
  const namedReading = options.find((w) => named.some((n) => n.start <= w.end && n.end >= w.start));
  if (!CLARIFY_RE.test(msg) && !(namedReading && words.length <= 4)) return null;
  let chosen: DateWindow | undefined;
  if (named.length) chosen = namedReading;
  else if (/\bother\b/i.test(msg)) {
    // The reading used is the one in the code-written "On <date> you asked" line (the closing line may name both).
    const said = [...prevReply.matchAll(/\bOn (\w{3} \d{1,2} \w{3}) you asked\b/g)].map((m) => m[1]);
    const used = options.filter((w) => said.includes(w.label));
    chosen = used.length === 1 ? options.find((w) => w !== used[0]) : undefined;
  } else if (/\b(earlier|first|older|previous)\b/i.test(msg)) chosen = [...options].sort((a, b) => a.start.localeCompare(b.start))[0];
  else if (/\b(later|second|newer|more recent)\b/i.test(msg)) chosen = [...options].sort((a, b) => b.start.localeCompare(a.start))[0];
  if (!chosen) return null;
  const groups = before.groups.map((g, i) => (i === amb ? [chosen!] : g));
  return { message: `${prev.message}\n(The user clarified which date they meant: "${msg.trim()}" — ${chosen.label}.)`, groups, chosen };
}

/**
 * The user named a day, but every matching conversation is from another day (people misremember dates): say so in
 * code before quoting it — "Nothing on Tue 10 Nov; the closest match is from Mon 9 Nov:". Null when any match is in
 * the window, or no window was named.
 */
export function dateMismatchLine(hits: RecallHit[], windows: DateWindow[]): string | null {
  if (!windows.length || !hits.length) return null;
  const inAny = (h: RecallHit) => windows.some((w) => h.question.local_date >= w.start && h.question.local_date <= w.end);
  if (hits.some(inAny)) return null;
  return `Nothing on ${windows.map((w) => w.label).join(" or ")}; the closest match is from ${humanDate(hits[0]!.question.local_date)}:`;
}

const brandOf = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2)[0] ?? "";

/**
 * The products an answer shortlisted: the planner's named entities that the answer itself mentions (in order of first
 * mention); without two of those, the first-column names of the answer's table. Code only.
 */
export function shortlistFrom(entities: string[], answer: string): string[] {
  const low = answer.toLowerCase();
  const at = (e: string) => {
    const b = brandOf(e);
    const m = b ? new RegExp(`(?<![a-z0-9])${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`).exec(low) : null;
    return m ? m.index : -1;
  };
  const named = [...new Set(entities)].map((e) => ({ e, i: at(e) })).filter((x) => x.i >= 0).sort((a, b) => a.i - b.i).map((x) => x.e);
  if (named.length >= 2) return named.slice(0, 8);
  const rows = entitiesFromHistory([{ answer: { content: answer }, question: { content: "" } } as unknown as RecallHit]);
  return rows.length >= 2 && rows.length <= 8 ? rows : [];
}

/** "We went with X", "X is out, too expensive", "let's go with Y": wording that states a decision about a shortlist. */
export const DECISION_RE = /\b(we('ve| have)? (went|gone|decided|picked|chosen|chose|settled|signed up)|we'?(ll| will) go with|(let'?s|i'?ll|i will|we'?re|i'?m) (go|going) with|decided (on|to go with|against)|rul(e|ed|ing) out|not going with|(is|are) out\b|too expensive for us|dropp(ed|ing) \w+|went with)\b|^\s*\S+(?:\s\S+)?\s+it is[.!]*\s*$/i;

/**
 * What the user decided earlier, for the answerer: only shortlists that share a product with this turn, and only
 * decided items. Written by code from the record; the answerer is told to respect it.
 */
export function decisionNote(shortlists: Array<{ label: string; date: string; items: Array<{ name: string; status: string; rationale: string | null }> }>, entities: string[]): string | null {
  const brands = new Set(entities.map(brandOf).filter(Boolean));
  const lines: string[] = [];
  for (const s of shortlists) {
    const decided = s.items.filter((i) => i.status !== "candidate");
    if (!decided.length || !s.items.some((i) => brands.has(brandOf(i.name)))) continue;
    const chosen = decided.filter((i) => i.status === "chosen").map((i) => `chose ${i.name}${i.rationale ? ` (${i.rationale})` : ""}`);
    const out = decided.filter((i) => i.status === "ruled_out").map((i) => `ruled out ${i.name}${i.rationale ? ` (${i.rationale})` : ""}`);
    lines.push(`From the shortlist of ${humanDate(s.date)} ("${s.label.slice(0, 80)}"): ${[...chosen, ...out].join("; ")}.`);
  }
  return lines.length ? `DECISIONS THE USER MADE EARLIER (from our record): ${lines.join(" ")} Respect them: build on what they chose, and don't recommend an option they ruled out unless they ask about it again.` : null;
}
