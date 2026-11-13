import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/memory/store.ts";
import { DECISION_RE, decisionNote, shortlistFrom } from "../src/agent/history.ts";

test("shortlistFrom: the planner's products the answer mentions, in order; else the answer table's first column", () => {
  assert.deepEqual(shortlistFrom(["Supabase", "Neon", "PlanetScale"], "Neon wins on price [1]; Supabase bundles auth [2]."), ["Neon", "Supabase"]);
  const table = "| Tool | Price |\n|---|---|\n| HubSpot | $20 |\n| Pipedrive | $14 |\n| Zoho CRM | $14 |";
  assert.deepEqual(shortlistFrom([], table), ["HubSpot", "Pipedrive", "Zoho CRM"]);
  assert.deepEqual(shortlistFrom(["Neon"], "Neon costs $19."), []);
});

test("one shortlist per question turn: price claims and the answer's list merge, nothing duplicated", () => {
  const s = new Store(":memory:");
  const at = new Date("2026-11-09T10:00:00Z");
  const q = s.insertTurn({ sessionId: "s", role: "user", content: "Shortlist CRMs for 20 reps", tz: "UTC", at, owner: "u1" });
  const a = s.insertTurn({ sessionId: "s", role: "assistant", content: "…", tz: "UTC", at, replyTo: q, owner: "u1" });
  s.recordShortlist(q, "Shortlist CRMs for 20 reps", ["HubSpot", "Pipedrive", "Zoho CRM"], at);
  s.recordValueClaims(q, a, [{ entity: "Pipedrive", attribute: "price", answerSpan: "$14/seat" }, { entity: "Close", attribute: "price", answerSpan: "$49/seat" }], "2026-11-09", at, "x");
  assert.deepEqual(s.collectionItems(q), ["HubSpot", "Pipedrive", "Zoho CRM", "Close"]);
  assert.equal(s.recentShortlists("u1", "2026-11-01").length, 1);
  assert.equal(s.recentShortlists("someone-else", "2026-11-01").length, 0);
});

test("decisions: only items on the list can be decided; the note reaches turns about the same products", () => {
  const s = new Store(":memory:");
  const at = new Date("2026-11-09T10:00:00Z");
  const q = s.insertTurn({ sessionId: "s", role: "user", content: "Shortlist CRMs for 20 reps", tz: "UTC", at, owner: "u1" });
  s.recordShortlist(q, "Shortlist CRMs for 20 reps", ["HubSpot", "Pipedrive", "Zoho CRM"], at);
  const [list] = s.recentShortlists("u1", "2026-11-01");
  assert.equal(s.recordDecision(list!.id, "Pipedrive", "chosen", null, at), true);
  assert.equal(s.recordDecision(list!.id, "zoho crm", "ruled_out", "too expensive for us", at), true);
  assert.equal(s.recordDecision(list!.id, "Salesforce", "chosen", null, at), false); // not on the list
  const lists = s.recentShortlists("u1", "2026-11-01");
  const note = decisionNote(lists, ["Pipedrive"]) ?? "";
  assert.match(note, /chose Pipedrive; ruled out Zoho CRM \(too expensive for us\)/);
  assert.equal(decisionNote(lists, ["Notion"]), null); // unrelated turn: no note
});

test("decision wording", () => {
  for (const m of ["We went with Pipedrive.", "Let's go with Neon", "Zoho is out, too expensive for us", "we decided against HubSpot", "I'm going with Supabase"]) assert.ok(DECISION_RE.test(m), m);
  for (const m of ["Which CRM should we go for?", "What does Pipedrive cost?"]) assert.ok(!DECISION_RE.test(m), m);
});

test("decision wording: a bare 'X it is.' counts; a question doesn't", () => {
  assert.ok(DECISION_RE.test("Pipedrive it is."));
  assert.ok(DECISION_RE.test("Zoho CRM it is!"));
  assert.ok(!DECISION_RE.test("What time is it is a question?"));
});
