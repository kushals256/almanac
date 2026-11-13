import { test } from "node:test";
import assert from "node:assert/strict";
import { replayHistory, sentAt, type ReplayTurn } from "../src/agent/history.ts";
import { decideNeeds, type NeedSignals } from "../src/agent/needs.ts";
import { readSignals } from "../src/agent/signals.ts";
import { resolveTemporal } from "../src/memory/temporal.ts";
import { planRetrieval } from "../src/agent/routing.ts";

const turn = (id: number, role: "user" | "assistant", content: string, utc = "2026-11-03T14:02:00Z"): ReplayTurn => ({ id, role, content, created_at_utc: utc, local_date: utc.slice(0, 10), tz: "Europe/London" });

test("replay: user messages carry when they were sent; the latest reply is nearly whole; older ones shortened", () => {
  const long = "Neon is cheapest [1]. ".repeat(200);
  const out = replayHistory([turn(1, "user", "Compare Postgres hosts"), turn(2, "assistant", long), turn(3, "user", "And backups?", "2026-11-03T14:05:00Z"), turn(4, "assistant", long)], () => [{ url: "https://neon.tech/pricing" }], 100_000);
  assert.equal(out.length, 4);
  assert.match(out[0]!.content, /^\[sent Tue 3 Nov, 14:02\] Compare Postgres hosts/);
  assert.ok(out[3]!.content.length > 2_500, "latest reply kept nearly whole");
  assert.ok(out[1]!.content.length < 1_100, "older reply shortened");
});

test("replay: old [n] are removed (they'd clash with this turn's sources) and the reply names its sites instead", () => {
  const out = replayHistory([turn(1, "user", "Price of Neon?"), turn(2, "assistant", "Launch is $19/month [1].")], () => [{ url: "https://www.neon.tech/pricing" }], 10_000);
  assert.equal(out[1]!.content, "Launch is $19/month.\n(Sources I used then: neon.tech)");
  // On the reply route the evidence IS that reply's sources, in order: its [n] stay.
  const keep = replayHistory([turn(1, "user", "Price of Neon?"), turn(2, "assistant", "Launch is $19/month [1].")], () => [{ url: "https://neon.tech/pricing" }], 10_000, true);
  assert.equal(keep[1]!.content, "Launch is $19/month [1].");
});

test("replay: older turns drop first when over budget; the transcript always starts with the user", () => {
  const t = [turn(1, "user", "a".repeat(500)), turn(2, "assistant", "b".repeat(800)), turn(3, "user", "c".repeat(500)), turn(4, "assistant", "d".repeat(800))];
  const out = replayHistory(t, () => [], 1_500);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.role, "user");
  assert.match(out[0]!.content, /c{10}/);
});

test("sentAt uses the turn's own timezone", () => {
  assert.equal(sentAt("2026-11-03T23:30:00Z", "2026-11-04", "Asia/Kolkata"), "Wed 4 Nov, 05:00");
});

const base: NeedSignals = {
  plannerRead: true, plannerPastRef: "none", plannerWantsRecheck: false, plannerFactual: true, plannerRoute: "quick", entities: 2,
  explicitConversationCue: false, sessionCue: null, pastTimePhrase: false, recheckHint: false, premises: 0, assistantPastPremise: false,
  social: false, compute: false, worldHeuristic: true, admittedMemory: 0, jevRef: null, jevConvOnly: null,
};

test("reply need: a cue confirmed by the judge answers from the previous reply with no new search", () => {
  const n = decideNeeds({ ...base, replyAsk: true, jevReplyOnly: 0.9 });
  assert.deepEqual([n.reply, n.world], [true, false]);
});

test("reply need: no confirmation (judge says new facts, or judge down) keeps the search", () => {
  assert.deepEqual(Object.values((({ reply, world }) => ({ reply, world }))(decideNeeds({ ...base, replyAsk: true, jevReplyOnly: 0.3 }))), [false, true]);
  assert.deepEqual(Object.values((({ reply, world }) => ({ reply, world }))(decideNeeds({ ...base, replyAsk: true, jevReplyOnly: null }))), [false, true]);
  // A claim to check or an older conversation always keeps the normal legs.
  assert.equal(decideNeeds({ ...base, replyAsk: true, jevReplyOnly: 0.95, premises: 1 }).reply, false);
  assert.equal(decideNeeds({ ...base, replyAsk: true, jevReplyOnly: 0.95, explicitConversationCue: true }).reply, false);
});

test("reply need routes to 'reply' with no queries", () => {
  const p = { route: "quick" as const, queries: [{ q: "give me your recommendation in two lines", objective: "x" }], entities: [], volatility: "fast" as const, understanding: {} as any };
  const out = planRetrieval({ p, msg: "give me your recommendation in two lines", recent: [], sig: {} as any }, { premises: [] }, { conversation: false, world: false, recheck: false, premise: false, reply: true, why: [] }, { jev: null, admitted: [] }, [], () => []);
  assert.equal(out.plan.route, "reply");
  assert.equal(out.plan.queries.length, 0);
});

test("wording cues: reshape and format asks; 'your recommendation' is the previous reply, not a past conversation", () => {
  const s = readSignals("Give me your recommendation in two lines.", []);
  assert.deepEqual([s.reshapeCue, s.formatAsk], [true, true]);
  assert.equal(readSignals("Which one would you pick for a 3-person team?", []).reshapeCue, true);
  assert.equal(readSignals("What is the current price of Notion Plus?", []).reshapeCue, false);
  assert.equal(resolveTemporal("Give me your recommendation in two lines.", new Date("2026-11-12T10:00:00Z"), "UTC").backReference, false);
  assert.equal(resolveTemporal("What did you recommend on Monday?", new Date("2026-11-12T10:00:00Z"), "UTC").backReference, true);
});

test("clarifying reply: 'the other one' takes the reading the previous reply did NOT use; dates and order words work too", async () => {
  const { clarifyDate } = await import("../src/agent/history.ts");
  // Thu 12 Nov 2026: "last Tuesday" can mean Tue 10 Nov or Tue 3 Nov.
  const prev = { message: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", at: new Date("2026-11-12T06:00:00Z"), tz: "UTC" };
  const now = new Date("2026-11-12T06:02:00Z");
  const reply = "On Tue 10 Nov you asked: “Which laptop…”";
  const other = clarifyDate("No, the other one", prev, reply, now, "UTC");
  assert.equal(other?.chosen.start, "2026-11-03");
  assert.match(other!.message, /^Last Tuesday I asked you about Postgres hosting/);
  assert.equal(clarifyDate("the earlier one", prev, reply, now, "UTC")?.chosen.start, "2026-11-03");
  assert.equal(clarifyDate("the more recent one", prev, reply, now, "UTC")?.chosen.start, "2026-11-10");
  assert.equal(clarifyDate("I meant 3 Nov", prev, reply, now, "UTC")?.chosen.start, "2026-11-03");
  // Not a clarification: a new question, or a previous message with no ambiguous date.
  assert.equal(clarifyDate("What does Neon cost now for a team of five engineers and two analysts?", prev, reply, now, "UTC"), null);
  assert.equal(clarifyDate("the other one", { ...prev, message: "What does Neon cost?" }, reply, now, "UTC"), null);
});

test("wrong day: every match is from another day → code says so before quoting it", async () => {
  const { dateMismatchLine } = await import("../src/agent/history.ts");
  const hit = (d: string) => ({ question: { local_date: d } }) as any;
  const tue = [{ start: "2026-11-10", end: "2026-11-10", phrase: "last Tuesday", label: "Tue 10 Nov" }];
  assert.equal(dateMismatchLine([hit("2026-11-09")], tue), "Nothing on Tue 10 Nov; the closest match is from Mon 9 Nov:");
  assert.equal(dateMismatchLine([hit("2026-11-10"), hit("2026-11-09")], tue), null);
  assert.equal(dateMismatchLine([hit("2026-11-09")], []), null);
});

test("the date chip's message ('I meant Tue 3 Nov') settles the reading through the same clarification path", async () => {
  const { clarifyDate } = await import("../src/agent/history.ts");
  const prev = { message: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", at: new Date("2026-11-12T06:00:00Z"), tz: "UTC" };
  assert.equal(clarifyDate("I meant Tue 3 Nov", prev, "On Tue 10 Nov you asked…", new Date("2026-11-12T06:02:00Z"), "UTC")?.chosen.start, "2026-11-03");
});

test("review-found: short follow-ups after an ambiguous date are NOT clarifications; 'the other one' reads the code-written line", async () => {
  const { clarifyDate } = await import("../src/agent/history.ts");
  const prev = { message: "What did I ask you last Tuesday?", at: new Date("2026-11-12T06:00:00Z"), tz: "UTC" };
  const now = new Date("2026-11-12T06:02:00Z");
  const reply = "On Tue 10 Nov you asked: “Which laptop…”\n\nI took last Tuesday as Tue 10 Nov; you also chatted on Tue 3 Nov — want that one?";
  for (const m of ["explain the second one", "tell me more about the first one", "Fed decision yesterday?", "Apple news from Monday?"]) assert.equal(clarifyDate(m, prev, reply, now, "UTC"), null, m);
  assert.equal(clarifyDate("No, the other one please", prev, reply, now, "UTC")?.chosen.start, "2026-11-03");
  assert.equal(clarifyDate("the earlier one", prev, reply, now, "UTC")?.chosen.start, "2026-11-03");
});
