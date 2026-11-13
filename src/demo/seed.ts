/**
 * Demo history: real conversations this agent answered on 3–11 Nov 2026 (live search, real sources; history.json),
 * re-dated to the SAME WEEKDAYS relative to today, so "on Monday we shortlisted…" and the two readings of "last
 * Tuesday" work whenever it's loaded. Nothing is invented: questions, answers (mistakes included) and source
 * excerpts are as recorded; only the conversation's own timestamp moves. Dates inside the text are world facts
 * ("released 10 Nov 2026") and are never rewritten. Writes directly to the store: no model or search calls.
 */
import { readFileSync } from "node:fs";
import { shortlistFrom } from "../agent/history.ts";
import type { Store } from "../memory/store.ts";
import { addDays, localDate } from "../util/clock.ts";

type Conversation = {
  recordedOn: string;
  question: string;
  questionAtUtc: string;
  answer: string;
  route: string;
  sources: Array<{ url: string; title: string | null; published_at: string | null; excerpt: string | null; provider: string | null; query: string | null }>;
};
type Fixture = { recordedToday: string; conversations: Conversation[] };

const DEMO_PREFIX = "demo-";

const weekday = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
/** The most recent date strictly before `today` that falls on weekday `wd`. */
function lastBefore(today: string, wd: number): string {
  let d = addDays(today, -1);
  while (weekday(d) !== wd) d = addDays(d, -1);
  return d;
}

/** Same weekday, same number of weeks back, relative to the new "today". */
export function redate(recordedOn: string, recordedToday: string, today: string): string {
  const wd = weekday(recordedOn);
  const weeksBack = Math.round((Date.parse(lastBefore(recordedToday, wd)) - Date.parse(recordedOn)) / (7 * 86_400_000));
  return addDays(lastBefore(today, wd), -7 * weeksBack);
}

/** An instant on local date `ymd` in `tz`, keeping the recorded time of day when it falls on that date. */
function instantOn(ymd: string, recordedUtc: string, tz: string): Date {
  for (const hhmm of [recordedUtc.slice(11, 16), "12:00", "06:00", "18:00", "00:30", "23:30"]) {
    const at = new Date(`${ymd}T${hhmm}:00Z`);
    if (localDate(at, tz) === ymd) return at;
  }
  return new Date(`${ymd}T12:00:00Z`);
}

export function demoFixture(): Fixture {
  return JSON.parse(readFileSync(new URL("./history.json", import.meta.url), "utf8")) as Fixture;
}

/** Load the demo for one owner (idempotent). Returns the conversations as dated in this owner's history. */
export function loadDemo(store: Store, owner: string, tz: string, now: Date): { added: boolean; conversations: Array<{ date: string; question: string }> } {
  const fx = demoFixture();
  const today = localDate(now, tz);
  const existing = store.db.prepare("SELECT COUNT(*) AS n FROM turns WHERE owner = ? AND session_id LIKE ?").get(owner, `${DEMO_PREFIX}%`) as { n: number };
  const dated = fx.conversations.map((c) => ({ c, date: redate(c.recordedOn, fx.recordedToday, today) }));
  const listing = dated.map(({ c, date }) => ({ date, question: c.question }));
  if (existing.n > 0) return { added: false, conversations: listing };
  dated.forEach(({ c, date }, i) => {
    const at = instantOn(date, c.questionAtUtc, tz);
    const session = `${DEMO_PREFIX}${date}-${i}`;
    const q = store.insertTurn({ sessionId: session, role: "user", content: c.question, tz, at, owner });
    const answerAt = new Date(at.getTime() + 20_000);
    const a = store.insertTurn({ sessionId: session, role: "assistant", content: c.answer, tz, at: answerAt, route: c.route, replyTo: q, owner });
    store.linkSources(a, c.sources.map((s) => ({ url: s.url, title: s.title ?? undefined, publishedAt: s.published_at ?? undefined, excerpt: s.excerpt ?? undefined, provider: s.provider ?? undefined, query: s.query ?? undefined })), answerAt);
    store.recordShortlist(q, c.question, shortlistFrom([], c.answer), answerAt);
  });
  return { added: true, conversations: listing };
}
