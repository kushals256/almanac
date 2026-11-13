import { test } from "node:test";
import assert from "node:assert/strict";
import { decideNeeds, type NeedSignals } from "../src/agent/needs.ts";

const base: NeedSignals = {
  plannerRead: true,
  plannerPastRef: "none",
  plannerWantsRecheck: false,
  plannerFactual: false,
  plannerRoute: "quick",
  entities: 0,
  explicitConversationCue: false,
  sessionCue: null,
  pastTimePhrase: false,
  recheckHint: false,
  premises: 0,
  assistantPastPremise: false,
  social: false,
  compute: false,
  worldHeuristic: false,
  admittedMemory: 0,
  jevRef: null,
  jevConvOnly: null,
};
const N = (o: Partial<NeedSignals>) => decideNeeds({ ...base, ...o });

test("world is ON by default; only agreement turns it off", () => {
  assert.equal(N({}).world, true);
  assert.equal(N({ plannerPastRef: "date", explicitConversationCue: true, admittedMemory: 1, jevConvOnly: 0.9 }).world, false); // "what did I ask on Tuesday?"
  assert.equal(N({ plannerPastRef: "date", explicitConversationCue: true, admittedMemory: 1, jevConvOnly: null }).world, true); // Jev down → keep searching
  assert.equal(N({ plannerPastRef: "date", explicitConversationCue: true, plannerFactual: true, jevConvOnly: 0.75 }).world, true); // asks facts too, evidence only moderate
});

test("'you told me X' gets BOTH the conversation and the world/premise legs", () => {
  const n = N({ assistantPastPremise: true, premises: 1, explicitConversationCue: true, jevConvOnly: 0.9 });
  assert.deepEqual([n.conversation, n.world, n.premise], [true, true, true]);
});

test("monotone: a planner that misses the past reference doesn't drop the conversation leg when a rule sees it", () => {
  assert.equal(N({ plannerRead: false, plannerPastRef: "none", explicitConversationCue: true }).conversation, true);
  assert.equal(N({ plannerPastRef: "none", sessionCue: "first" }).conversation, true);
});

test("evidence demotes weak references: world time phrase, planner-only follow-up reading", () => {
  // "Since X came out last month…" with a premise: the time phrase doesn't make it a memory question.
  assert.equal(N({ pastTimePhrase: true, premises: 1 }).conversation, false);
  // Bare time phrase, Jev says it's not about our chat.
  assert.equal(N({ pastTimePhrase: true, jevRef: 0.1 }).conversation, false);
  // Planner read a follow-up as "last question"; Jev disagrees.
  assert.equal(N({ plannerPastRef: "last_question", jevRef: 0.4 }).conversation, false);
  // Explicit cue is immune to demotion.
  assert.equal(N({ explicitConversationCue: true, jevRef: 0.1 }).conversation, true);
});

test("small talk and arithmetic skip the web unless facts or claims are involved", () => {
  assert.equal(N({ social: true }).world, false);
  assert.equal(N({ compute: true }).world, false);
  assert.equal(N({ compute: true, worldHeuristic: true }).world, false); // "what's 17 times 23?" — code's arithmetic wins
  assert.equal(N({ compute: true, plannerFactual: true }).world, true); // arithmetic over facts that must be looked up
  assert.equal(N({ social: true, premises: 1 }).world, true);
});

test("recheck needs an admitted earlier answer", () => {
  assert.equal(N({ explicitConversationCue: true, plannerWantsRecheck: true, admittedMemory: 0 }).recheck, false);
  assert.equal(N({ explicitConversationCue: true, plannerWantsRecheck: true, admittedMemory: 1 }).recheck, true);
});

test("date ownership by evidence: a relevant conversation found in the window makes the date ours", () => {
  assert.equal(N({ pastTimePhrase: true, premises: 1, admittedMemory: 1 }).conversation, true); // "on Monday we shortlisted…"
  assert.equal(N({ pastTimePhrase: true, premises: 1, admittedMemory: 0 }).conversation, false); // "since X came out last month"
});

test("weak planner: recheck by rule; strong evidence overrides a weak 'factual' label for memory-only asks", () => {
  assert.equal(N({ plannerRead: true, plannerWantsRecheck: false, recheckHint: true, pastTimePhrase: true, admittedMemory: 1 }).recheck, true);
  assert.equal(N({ explicitConversationCue: true, plannerFactual: true, admittedMemory: 1, jevConvOnly: 0.9 }).world, false);
  assert.equal(N({ explicitConversationCue: true, plannerFactual: true, premises: 1, admittedMemory: 1, jevConvOnly: 0.95 }).world, true);
});

test("no record + no claim + no world question: the honest 'no record' is the whole answer (no search)", () => {
  assert.equal(N({ explicitConversationCue: true, admittedMemory: 0, jevConvOnly: 0.2 }).world, false);
  assert.equal(N({ explicitConversationCue: true, admittedMemory: 0, plannerFactual: true }).world, true); // "...and who won X?"
  assert.equal(N({ assistantPastPremise: true, premises: 1, admittedMemory: 0 }).world, true); // claim still checked
});

test("a found relevant conversation protects a planner-read reference from a borderline Jev score", () => {
  assert.equal(N({ plannerPastRef: "topic", admittedMemory: 1, jevRef: 0.48 }).conversation, true);
  assert.equal(N({ plannerPastRef: "topic", admittedMemory: 0, jevRef: 0.48 }).conversation, false);
  assert.equal(N({ plannerPastRef: "last_question", admittedMemory: 1, jevRef: 0.2 }).conversation, false); // follow-up
});

test("F-101: a memory ask with no record still searches when the message also asks about the world (Jev)", () => {
  assert.equal(N({ explicitConversationCue: true, admittedMemory: 0, jevWorldAsk: 0.9 }).world, true); // "…and who was MVP?"
  assert.equal(N({ explicitConversationCue: true, admittedMemory: 0, jevWorldAsk: 0.1 }).world, false); // "what did I ask on Tuesday?"
});

test("F-101: a time phrase alone needs Jev to confirm a reference; related history stays quiet context", () => {
  assert.equal(N({ pastTimePhrase: true, admittedMemory: 1, jevRef: 0.4 }).conversation, false);
  assert.equal(N({ pastTimePhrase: true, admittedMemory: 1, jevRef: 0.8 }).conversation, true);
});

test("F-106: a planner-only 'last question' reading needs Jev agreement even when a related turn was found", () => {
  assert.equal(N({ plannerPastRef: "last_question", admittedMemory: 1, jevRef: 0.45 }).conversation, false); // follow-up
  assert.equal(N({ plannerPastRef: "topic", admittedMemory: 1, jevRef: 0.45 }).conversation, true); // found topic stays
  assert.equal(N({ plannerPastRef: "last_question", sessionCue: "last", admittedMemory: 1, jevRef: 0.45 }).conversation, true); // rule-backed
});

test("a question in another language is a world question even though English heuristics stay silent", async () => {
  const { readSignals } = await import("../src/agent/signals.ts");
  assert.equal(readSignals("भारत के वर्तमान प्रधानमंत्री कौन हैं?").worldShape, true);
  assert.equal(readSignals("Translate 'where is the train station' into French.").worldShape, false);
});

test("the planner choosing the recheck route counts as a planner-read past reference (brief: 'On Monday we shortlisted…')", () => {
  const n = N({ plannerRoute: "recheck", plannerPastRef: "none", pastTimePhrase: true, recheckHint: true, admittedMemory: 1, jevRef: 0.49 });
  assert.equal(n.conversation, true);
  assert.equal(n.recheck, true);
  // A world question with a time phrase and no planner recheck reading is still demoted on a weak Jev score.
  assert.equal(N({ plannerRoute: "quick", pastTimePhrase: true, admittedMemory: 1, jevRef: 0.4 }).conversation, false);
});

test("a planner-only recheck reading is vetoed when evidence says our record alone answers it", () => {
  const recall = N({ explicitConversationCue: true, plannerPastRef: "date", plannerWantsRecheck: true, recheckHint: false, admittedMemory: 1, jevConvOnly: 0.84 });
  assert.equal(recall.recheck, false); // "Two weeks ago I asked about X. What did you recommend?"
  assert.equal(recall.world, false);
  const wording = N({ explicitConversationCue: true, plannerWantsRecheck: true, recheckHint: true, admittedMemory: 1, jevConvOnly: 0.84 });
  assert.equal(wording.recheck, true); // "...is that still correct?" — the wording itself asks
});

test("planRetrieval returns a NEW plan (the planner's output is never mutated) and covers every need", async () => {
  const { planRetrieval } = await import("../src/agent/routing.ts");
  const p = Object.freeze({ route: "quick" as const, queries: Object.freeze([]) as any, entities: Object.freeze([]) as any, volatility: "fast" as const, understanding: {} as any });
  const t = { p, msg: "compare Acme vs Beta pricing", recent: [], sig: { compareShape: true } as any };
  const needs = { conversation: false, world: true, recheck: false, premise: false, reply: false, why: [] };
  const out = planRetrieval(t as any, { premises: [] }, needs, { jev: null, admitted: [] }, [], () => []);
  assert.equal(out.plan.route, "research");
  assert.equal(out.plan.queries.length, 1);
  assert.notEqual(out.plan, p);
  assert.equal(p.route, "quick"); // frozen original untouched
  // Recheck + "also asks something else" → one streamed answer that covers both (with a note saying so).
  const both = planRetrieval(t as any, { premises: [] }, { ...needs, conversation: true, recheck: true }, { jev: { alsoNew: 0.9 }, admitted: [] }, [], () => []);
  assert.equal(both.plan.route, "research");
  assert.equal(both.notes.length, 1);
  const alone = planRetrieval(t as any, { premises: [] }, { ...needs, conversation: true, recheck: true }, { jev: { alsoNew: 0.1 }, admitted: [] }, [], () => []);
  assert.equal(alone.plan.route, "recheck");
});

test("a planner-only 'list' reading of a message that names a subject is a topic question, not 'list everything'", async () => {
  const { readReferences } = await import("../src/agent/routing.ts");
  const base = { sig: { memoryCue: true } as any, rule: { first: false, just: false, list: false, memoryCue: true, action: false }, plannerRead: true, temporal: { backReference: true } as any };
  const u = (topic: string | null) => ({ pastRef: "list", topic, premises: [], claims: [], recallTerms: [], actionRequest: false, steering: false }) as any;
  assert.equal(readReferences({ ...base, u: u("Kubernetes"), msg: "Did I ask you anything about Kubernetes earlier this month?" }).listMode, false);
  assert.equal(readReferences({ ...base, u: u(null), msg: "What did I ask you this month?" }).listMode, true);
});

test("the planner's recheck route counts toward the recheck need, not only toward the conversation need", () => {
  // "Is the Node.js version you told me on Tuesday still the latest?" — route recheck, wantsRecheck false.
  const n = N({ plannerRoute: "recheck", plannerWantsRecheck: false, explicitConversationCue: true, pastTimePhrase: true, admittedMemory: 1, jevRef: 0.86, jevConvOnly: 0.11 });
  assert.equal(n.recheck, true);
  // Still vetoed when evidence says our record alone answers it.
  assert.equal(N({ plannerRoute: "recheck", explicitConversationCue: true, admittedMemory: 1, jevConvOnly: 0.9 }).recheck, false);
});
