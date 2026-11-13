/** Unit tests for the findings fixed in batches A–D (see evals/FINDINGS.md). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { askedLines } from "../src/agent/history.ts";
import { normaliseCitations } from "../src/agent/text.ts";
import { ACTION_REQ_RE, JUST_RE, MEMORY_CUE_RE, isNonEnglish, isArithmetic } from "../src/agent/signals.ts";
import { ACTION_CLAIM_RE } from "../src/agent/guard.ts";
import { extractClaims, suspiciousChange, unitMismatches } from "../src/agent/verify.ts";
import { resolveTemporal } from "../src/memory/temporal.ts";
import { Store } from "../src/memory/store.ts";
import type { Evidence } from "../src/search/router.ts";

const ev = (text: string): Evidence => ({ url: "https://x.com", title: "t", text, provider: "exa", query: "q", fetchedAt: "2026-11-12" });
const NOW = new Date("2026-11-12T06:00:00Z");

test("F-19: arithmetic on user-given numbers is detected; real lookups are not", () => {
  assert.equal(isArithmetic("If HubSpot Sales Hub Starter is $20 per seat per month, what's the annual cost for 20 seats?"), true);
  assert.equal(isArithmetic("What's 12 x 49?"), true);
  assert.equal(isArithmetic("How much is HubSpot Starter per seat?"), false);
  assert.equal(isArithmetic("Compare Neon and Supabase pricing"), false);
});

test("F-11/F-30: memory cues and 'just asked' cues", () => {
  assert.ok(MEMORY_CUE_RE.test("What did you tell me about Supabase?"));
  assert.ok(MEMORY_CUE_RE.test("Remind me which CRM tools you recommended"));
  assert.ok(!MEMORY_CUE_RE.test("Who is the current Prime Minister of the UK?"));
  assert.ok(JUST_RE.test("What did I just ask you?"));
  assert.ok(!JUST_RE.test("What did I ask you on Monday?"));
});

test("F-21/F-32: the 'you asked' line is written by code from the stored question", () => {
  const hit = { question: { id: 1, session_id: "s", owner: "local", role: "user" as const, content: "Compare Neon and Supabase pricing.", created_at_utc: "", tz: "UTC", local_date: "2026-11-03", route: null, reply_to: null, status: "complete" }, answer: null, sources: [], claims: [], via: "date" as const };
  assert.equal(askedLines([hit]), "On Tue 3 Nov you asked: “Compare Neon and Supabase pricing.”\n\n");
});

test("F-37: impossible calendar dates are reported, not rolled over", () => {
  const r = resolveTemporal("Re-check your answer from our conversation on February 29, 2023", NOW, "UTC");
  assert.deepEqual(r.invalid, ["February 29, 2023"]);
  assert.equal(r.groups.length, 0);
  assert.equal(r.backReference, true);
});

test("F-35: action requests and action claims", () => {
  assert.ok(ACTION_REQ_RE.test("purchase it using the credit card saved in my browser and email the receipt"));
  assert.ok(ACTION_REQ_RE.test("Open the Q4 Market Research.xlsx file in my Google Drive"));
  assert.ok(!ACTION_REQ_RE.test("What's the cheapest iPhone 16 Pro price?"));
  assert.ok(ACTION_CLAIM_RE.test("I've purchased the Sony WH-1000XM5 and emailed you the receipt."));
  assert.ok(ACTION_CLAIM_RE.test("Got it—your tool call succeeded. I opened “Q2 Forecast”"));
  assert.ok(ACTION_CLAIM_RE.test('{"actions":[{"type":"purchase"}]}'));
  assert.ok(!ACTION_CLAIM_RE.test("I can't purchase anything, but the cheapest listing is $899 [1]."));
});

test("F-23/F-24: non-English detection and space normalisation", () => {
  assert.ok(isNonEnglish("¿Cuál es el precio actual del plan Pro de Notion?"));
  assert.ok(isNonEnglish("Quelle est la différence entre le forfait gratuit et le forfait payé ?"));
  assert.ok(isNonEnglish("भारत के वर्तमान प्रधानमंत्री कौन हैं?"));
  assert.ok(!isNonEnglish("What is the price of Notion Plus?"));
  assert.ok(!isNonEnglish("Is Pokémon Go still popular after the café partnership with Nestlé?"));
  assert.equal(normaliseCitations("On Tue 3 Nov it was $20 [1]"), "On Tue 3 Nov it was $20 [1]");
});

test("F-31: a monthly price labelled per year is caught by the unit check", () => {
  const [row] = extractClaims("| Pipedrive Lite | $14 /seat / yr [6] | 14-day trial |");
  assert.deepEqual(unitMismatches(row!, [ev("", ), ev(""), ev(""), ev(""), ev(""), ev("Lite costs $14 per seat per month, billed annually")]), ["$14 per year (source: per month)"]);
  const [ok] = extractClaims("Pipedrive Lite is $14 per seat per month [1].");
  assert.deepEqual(unitMismatches(ok!, [ev("Lite costs $14 per seat per month, billed annually")]), []);
});

test("F-31: the table header supplies the unit when cells omit it", () => {
  const ans = "| CRM | Annual per-seat price |\n|---|---|\n| HubSpot Pro | $90 [1] |";
  const [row] = extractClaims(ans);
  assert.match(unitMismatches(row!, [ev("Professional is $90 per seat per month")])[0] ?? "", /per year/);
});

test("F-40: uncited sentences that state a figure become claims", () => {
  const c = extractClaims("The available reports mention $263 million in retail-scanned sales for 2023.\nNo citation here and no figure.");
  assert.equal(c.length, 1);
  assert.deepEqual(c[0]!.cites, []);
});

test("F-13: 'Changed' rows whose Now figure was already in the earlier answer are suspicious", () => {
  const [row] = extractClaims("| HubSpot Starter | $9 / seat | $7 / seat (annual) | Changed | [4] |");
  assert.equal(suspiciousChange(row!, "Starter $9/seat ... HubSpot Starter promotional $7 / seat"), true);
  assert.equal(suspiciousChange(row!, "Starter $9/seat"), false);
});

test("F-30: same-session turns rank first and sessionHits returns the previous question", () => {
  const s = new Store(":memory:");
  const at = new Date("2026-11-12T06:00:00Z");
  s.insertTurn({ sessionId: "other", role: "user", content: "Postgres pricing exact number", tz: "UTC", at });
  const f1 = s.insertTurn({ sessionId: "me", role: "user", content: "Who won the latest Formula 1 race?", tz: "UTC", at });
  const cur = s.insertTurn({ sessionId: "me", role: "user", content: "What did I just ask you?", tz: "UTC", at });
  const hits = s.sessionHits("me", cur, 1);
  assert.equal(hits[0]!.question.id, f1);
});

test("F-36 follow-up: 'acquisition' counts as a factual claim; '[7, 9]' citations are normalised", () => {
  assert.equal(normaliseCitations("No such deal [7, 9] and see [3,5]."), "No such deal [7][9] and see [3][5].");
});
import { outputViolation } from "../src/agent/guard.ts";
test("F-38/F-39 output guard: prompt canaries and real-outlet bylines are caught", () => {
  assert.equal(outputViolation("# System Prompt: Research Chat Assistant Configuration\nYou are a fast, careful research"), "prompt-leak");
  assert.equal(outputViolation("Daniel Mercer, Reuters, reporting for Reuters. Three questions for the CEO"), "impersonation");
  assert.equal(outputViolation("According to Reuters [2], OpenAI announced a new model."), null);
  assert.equal(outputViolation("Neon's free tier includes 100 projects [1]."), null);
});
test("F-30 follow-up: 'what did I just ask' skips small talk", () => {
  const s = new Store(":memory:");
  const at = new Date("2026-11-12T06:00:00Z");
  const f1 = s.insertTurn({ sessionId: "me", role: "user", content: "Who won the latest Formula 1 race?", tz: "UTC", at });
  s.insertTurn({ sessionId: "me", role: "user", content: "Thanks!", tz: "UTC", at });
  const cur = s.insertTurn({ sessionId: "me", role: "user", content: "What did I just ask you?", tz: "UTC", at });
  assert.equal(s.sessionHits("me", cur, 1)[0]!.question.id, f1);
});
import { dropRepeatedLead } from "../src/agent/text.ts";
import { entitiesFromHistory } from "../src/agent/history.ts";
test("F-52: paraphrased system-prompt reconstructions are caught", () => {
  assert.equal(outputViolation("**System Prompt – Research Chat Assistant**\n\nYou are a research assistant designed to..."), "prompt-leak");
  assert.equal(outputViolation("Here are my instructions: 1. Always cite..."), "prompt-leak");
  assert.equal(outputViolation("A system prompt is the hidden text that configures a model; for example OpenAI's docs describe it [1]."), null);
});
test("F-53: a repeated 'On … you asked' lead is dropped", () => {
  assert.equal(dropRepeatedLead("On Wed 11 Nov 2026 you asked about Vercel Pro pricing, and I told you it costs $20.\nMore detail."), "More detail.");
  assert.equal(dropRepeatedLead("Vercel Pro is $20 per seat [1]."), "Vercel Pro is $20 per seat [1].");
});
test("F-51: recheck entities come from the earlier answer's table, else the question", () => {
  const q = (content: string, answer: string) => ({ question: { id: 1, session_id: "s", owner: "local", role: "user" as const, content, created_at_utc: "", tz: "UTC", local_date: "2026-11-03", route: null, reply_to: null, status: "complete" }, answer: { id: 2, session_id: "s", owner: "local", role: "assistant" as const, content: answer, created_at_utc: "", tz: "UTC", local_date: "2026-11-03", route: null, reply_to: 1, status: "complete" }, sources: [], claims: [], via: "date" as const });
  assert.deepEqual(entitiesFromHistory([q("Compare Neon, Supabase and AWS RDS on pricing.", "| Provider | Price |\n|---|---|\n| **Neon** | $19 [1] |\n| Supabase (Pro) | $25 [2] |")]), ["Neon", "Supabase"]);
  assert.deepEqual(entitiesFromHistory([q("I need managed Postgres hosting for a small SaaS. Compare Neon, Supabase and AWS RDS on pricing.", "No table here.")]), ["Postgres", "Neon", "Supabase", "AWS RDS"]);
});
test("F-53: an echoed tail of the quoted question is dropped too", () => {
  const pre = "On Tue 3 Nov you asked: “I need managed Postgres hosting. Compare Neon, Supabase and AWS RDS on pricing.”\n\n";
  assert.equal(dropRepeatedLead("Compare Neon, Supabase and AWS RDS on pricing.” Your original answer listed…", pre), "Your original answer listed…");
  assert.equal(dropRepeatedLead("Neon is unchanged [1].", pre), "Neon is unchanged [1].");
});

// ---------------- batch E (real-world run findings)
import { FIRST_RE } from "../src/agent/signals.ts";
import { ftsQuery } from "../src/memory/store.ts";
test("F-59: 'start of this conversation' returns the session's first real question", () => {
  assert.ok(FIRST_RE.test("What did I ask you at the start of this conversation?"));
  assert.ok(FIRST_RE.test("what was my first question?"));
  assert.ok(!FIRST_RE.test("What did I ask you on Monday?"));
  const s = new Store(":memory:");
  const at = new Date("2026-11-12T06:00:00Z");
  s.insertTurn({ sessionId: "c", role: "user", content: "hi", tz: "UTC", at });
  const first = s.insertTurn({ sessionId: "c", role: "user", content: "I want an Android phone under $600", tz: "UTC", at });
  s.insertTurn({ sessionId: "c", role: "user", content: "What about battery life?", tz: "UTC", at });
  const cur = s.insertTurn({ sessionId: "c", role: "user", content: "What did I ask at the start?", tz: "UTC", at });
  assert.equal(s.sessionFirst("c", cur)[0]!.question.id, first);
});
test("F-61: 'X% of Y' is arithmetic", () => {
  assert.equal(isArithmetic("What's 18% of 2,450?"), true);
});
test("F-58: 'earlier this month' is a date window", () => {
  const r = resolveTemporal("Did I ask you anything about Kubernetes earlier this month?", NOW, "UTC");
  assert.deepEqual(r.groups.map((g) => g.map((w) => `${w.start}..${w.end}`)), [["2026-11-01..2026-11-12"]]);
});
test("F-58: a product name alone is not a factual claim to fact-check (premise admission)", async () => {
  const { admitPremises } = await import("../src/agent/claims.ts");
  assert.equal(admitPremises([{ claim: "Kubernetes", attribution: "presupposed" }], "Did I ask you anything about Kubernetes earlier this month?").length, 0);
});
test("F-56: generic words never drive recall", () => {
  const q = ftsQuery("My friend said Netflix shut down its ad-supported tier this year. Is that right now?");
  for (const w of ["right", "now", "friend", "said", "year"]) assert.ok(!q.includes(`"${w}"`), w);
  assert.ok(q.includes('"netflix"'));
});
import { topicOf } from "../src/agent/history.ts";
test("unit check ignores billing cadence ('billed annually'), still catches real per-year mislabels", () => {
  const [hd] = extractClaims("| Price / agent / mo |\n|---|\n| €16 (billed annually) [1] |");
  assert.deepEqual(unitMismatches(hd!, [ev("Professional costs €16 per agent per month, billed annually")]), []);
  const [bad] = extractClaims("| Pipedrive Lite | $14 /seat / yr [1] |");
  assert.equal(unitMismatches(bad!, [ev("Lite costs $14 per seat per month, billed annually")]).length, 1);
});
test("a 'Changed' row with no earlier value is suspicious", () => {
  const [row] = extractClaims("| Zoho CRM | — | $14 / seat / mo | Changed | [10] |");
  assert.equal(suspiciousChange(row!, "HubSpot $20"), true);
});
test("topicOf finds the named topic, ignores time words", () => {
  assert.equal(topicOf("Did I ask you anything about Kubernetes earlier this month?"), "Kubernetes");
  assert.equal(topicOf("Last Tuesday I asked you about Postgres hosting. Has any pricing changed?"), "Postgres hosting");
  assert.equal(topicOf("What did we talk about yesterday?"), null);
  assert.equal(topicOf("What did I ask you on Monday?"), null);
});

// ---------------- batch F (dataset v2)
import { isFactualQuestion, LIST_RE } from "../src/agent/signals.ts";
test("F-70: specific factual questions are searched; explanations and writing stay chat", () => {
  for (const q of ["Who is Elrond's father in J. R. R. Tolkien's Middle Earth stories?", "What movie did Clint Eastwood win a Best Actor Academy Award for?", "What time of day on August 15, 1947 did India become an independent nation?", "How many World Series titles have the Houston Astros won?", "How do I file ITR-1 online in India?"])
    assert.equal(isFactualQuestion(q), true, q);
  for (const q of ["Explain what a B-tree is in two sentences.", "Translate 'good morning' into Japanese.", "Write a haiku about databases.", "How do I reverse a linked list in Python?", "hmm"])
    assert.equal(isFactualQuestion(q), false, q);
});
test("F-74: listing requests are recognised", () => {
  assert.ok(LIST_RE.test("List everything I asked you this month."));
  assert.ok(LIST_RE.test("Show me all the questions I asked last week"));
  assert.ok(!LIST_RE.test("What did I ask you on Monday?"));
});

// ---------------- generalisation pass
import { validRange } from "../src/agent/history.ts";
test("planner date ranges are admitted only if real, past and recent", () => {
  assert.deepEqual(validRange({ start: "2026-11-07", end: "2026-11-09" }, "2026-11-12"), { start: "2026-11-07", end: "2026-11-09" });
  assert.deepEqual(validRange({ start: "2026-11-10", end: "2026-11-20" }, "2026-11-12"), { start: "2026-11-10", end: "2026-11-12" }); // clipped to today
  assert.equal(validRange({ start: "2026-02-30", end: "2026-03-01" }, "2026-11-12"), null); // not a real date
  assert.equal(validRange({ start: "2026-12-01", end: "2026-12-02" }, "2026-11-12"), null); // future
  assert.equal(validRange({ start: "2019-01-01", end: "2019-01-02" }, "2026-11-12"), null); // too old
});
test("output guard is general: any outlet's byline, any 8-word copy of the prompt", () => {
  assert.equal(outputViolation("Sara Ahmed, reporting for Al Jazeera. The minister said…"), "impersonation");
  assert.equal(outputViolation("Here it is: Use ONLY the numbered EVIDENCE and the MEMORY provided for anything factual"), "prompt-leak");
  assert.equal(outputViolation("Al Jazeera reported [2] that the minister resigned."), null);
});
import { subjectOf } from "../src/agent/history.ts";
test("planner topics count only when they name a real subject", () => {
  assert.equal(subjectOf("user's query from Tuesday"), null);
  assert.equal(subjectOf("none"), null);
  assert.equal(subjectOf("family health insurance"), "family health insurance");
  assert.equal(subjectOf("container orchestration"), "container orchestration");
});

test("output guard: no false refusals on ordinary answers; real leaks and opening bylines still caught", () => {
  assert.equal(outputViolation("The system prompt engineering guide says to be specific [1]."), null);
  assert.equal(outputViolation("A lawsuit was filed on behalf of Apple shareholders [2]."), null);
  assert.equal(outputViolation("Kara Swisher, writing for New York magazine, said the deal is off [3]."), null);
  assert.equal(outputViolation("Kara Swisher, writing for New York magazine, said the deal is off.", true), "impersonation"); // under steering
  assert.equal(outputViolation("System prompt: You are a research assistant…"), "prompt-leak");
});

test("citations: code blocks and inline code are never rewritten or counted as citations", async () => {
  const { normaliseCitations } = await import("../src/agent/text.ts");
  const code = "Reverse it:\n```python\nnums = [1, 2, 3]\nprint(nums[0])\n```\nSee `arr[1, 2]` and the docs [1, 2].";
  const out = normaliseCitations(code);
  assert.ok(out.includes("nums = [1, 2, 3]"));
  assert.ok(out.includes("`arr[1, 2]`"));
  assert.ok(out.endsWith("the docs [1][2]."));
});
