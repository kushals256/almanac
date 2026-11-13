import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/memory/store.ts";

test("claims as data: recorded at write time, read by recheck, re-observations recorded, a change supersedes", () => {
  const st = new Store(":memory:");
  const q = st.insertTurn({ sessionId: "s", role: "user", content: "Shortlist CRM tools for a 20-person team", tz: "UTC", at: new Date("2026-11-09T10:00:00Z") });
  const a = st.insertTurn({ sessionId: "s", role: "assistant", content: "…", tz: "UTC", at: new Date("2026-11-09T10:00:05Z"), replyTo: q });
  const ids = st.recordValueClaims(q, a, [
    { entity: "Acme CRM Starter", attribute: "price", answerSpan: "$15 / seat / mo", sourceUrl: "https://acme.example/pricing" },
    { entity: "Beta CRM Lite", attribute: "price", answerSpan: "$14 / seat / mo" },
  ], "2026-11-09", new Date("2026-11-09T10:00:06Z"), "Shortlist CRM tools for a 20-person team");
  assert.equal(ids.length, 2);
  assert.deepEqual(st.entitiesForTurn(q), ["Acme CRM Starter", "Beta CRM Lite"]);
  assert.equal((st.db.prepare("SELECT count(*) AS n FROM collection_items").get() as { n: number }).n, 2); // the shortlist as data
  assert.equal(st.recall({ windows: [], text: "beta crm", excludeTurnId: -1, sessionId: "other" }).length, 1); // findable by entity
  const r = st.insertTurn({ sessionId: "s2", role: "assistant", content: "recheck", tz: "UTC", at: new Date("2026-11-12T10:00:00Z") });
  st.recordVerification(ids[0]!, { status: "changed", nowText: "$20 / seat / mo", recheckAnswerId: r }, new Date("2026-11-12T10:00:01Z"));
  st.recordVerification(ids[1]!, { status: "unchanged", nowText: "$14" }, new Date("2026-11-12T10:00:01Z"));
  // What was said then stays on the earlier answer (a later re-check reads it again); the changed one is MARKED superseded.
  assert.deepEqual(st.valueClaimsFor(a).map((c) => c.entity), ["Acme CRM Starter", "Beta CRM Lite"]);
  assert.equal((st.db.prepare("SELECT count(*) AS n FROM claims WHERE turn_id = ? AND superseded_by IS NOT NULL").get(a) as { n: number }).n, 1);
  assert.deepEqual(st.valueClaimsFor(r).map((c) => c.answerSpan), ["$20 / seat / mo"]); // the new value is a claim
  assert.equal((st.db.prepare("SELECT count(*) AS n FROM verifications").get() as { n: number }).n, 2);
});

test("owner scoping: recall across history never returns another owner's turns", () => {
  const st = new Store(":memory:");
  const at = new Date("2026-11-10T10:00:00Z");
  st.insertTurn({ sessionId: "a1", role: "user", content: "Which vector database for small RAG?", tz: "UTC", at, owner: "alice" });
  st.insertTurn({ sessionId: "b1", role: "user", content: "Which vector database is cheapest?", tz: "UTC", at, owner: "bob" });
  const win = [{ start: "2026-11-10", end: "2026-11-10", phrase: "Tuesday", label: "Tue 10 Nov" }];
  assert.deepEqual(st.recall({ windows: [], text: "vector database", owner: "alice" }).map((h) => h.question.session_id), ["a1"]);
  assert.deepEqual(st.recall({ windows: win, text: "", owner: "bob" }).map((h) => h.question.session_id), ["b1"]);
  assert.deepEqual(st.nearestDatesWithHistory("2026-11-12", 3, "carol"), []);
});

test("a question is recallable only once its answer is saved; claim recording is idempotent and keeps sources", () => {
  const st = new Store(":memory:");
  const at = new Date("2026-11-10T10:00:00Z");
  const q = st.insertTurn({ sessionId: "s", role: "user", content: "Compare Acme and Beta pricing", tz: "UTC", at, status: "pending" });
  assert.equal(st.recall({ windows: [], text: "acme pricing" }).length, 0); // failed/in-flight turns are invisible
  const a = st.insertTurn({ sessionId: "s", role: "assistant", content: "Acme is $20 [1]", tz: "UTC", at, replyTo: q });
  st.linkSources(a, [{ url: "https://acme.example/pricing", title: "Acme pricing", excerpt: "Acme Pro: $20/month" }], at);
  st.setTurnStatus(q, "complete");
  const hit = st.recall({ windows: [], text: "acme pricing" })[0]!;
  assert.equal(hit.sources[0]!.url, "https://acme.example/pricing"); // sources are linked before claims are extracted
  const rec = () => st.recordValueClaims(q, a, [{ entity: "Acme Pro", attribute: "price", answerSpan: "$20", sourceUrl: hit.sources[0]!.url }], "2026-11-10", at, "Compare");
  const first = rec();
  assert.deepEqual(rec(), first); // a second recording (background vs recheck) returns the same ids
  assert.equal(st.valueClaimsFor(a)[0]!.sourceUrl, "https://acme.example/pricing");
});
