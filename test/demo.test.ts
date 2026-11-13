import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/memory/store.ts";
import { loadDemo, redate } from "../src/demo/seed.ts";

test("re-dating keeps the weekday and the number of weeks back, relative to the new today", () => {
  // Recorded with today = Thu 12 Nov: Postgres Tue 3 Nov (the Tuesday before last), CRM Mon 9 Nov, Node Tue 10 Nov.
  assert.equal(redate("2026-11-09", "2026-11-12", "2026-11-12"), "2026-11-09");
  assert.equal(redate("2026-11-03", "2026-11-12", "2026-12-03"), "2026-11-24"); // Thu 3 Dec → Tue 24 Nov
  assert.equal(redate("2026-11-10", "2026-11-12", "2026-12-03"), "2026-12-01"); // last Tuesday
  assert.equal(redate("2026-11-09", "2026-11-12", "2026-12-01"), "2026-11-30"); // loaded on a Tuesday: Monday = yesterday
  assert.equal(redate("2026-11-10", "2026-11-12", "2026-12-01"), "2026-11-24"); // "Tuesday" strictly before today
});

test("loading the demo writes real recorded conversations once, with sources and shortlists, and no calls out", () => {
  const s = new Store(":memory:");
  const now = new Date("2026-12-03T10:00:00Z");
  const r = loadDemo(s, "u1", "Asia/Kolkata", now);
  assert.equal(r.added, true);
  assert.deepEqual(r.conversations.map((c) => c.date), ["2026-11-24", "2026-11-30", "2026-12-01", "2026-12-02"]);
  const qs = s.db.prepare("SELECT id, local_date, content FROM turns WHERE owner = 'u1' AND role = 'user' ORDER BY id").all() as Array<{ id: number; local_date: string; content: string }>;
  assert.equal(qs.length, 4);
  assert.deepEqual(qs.map((q) => q.local_date), ["2026-11-24", "2026-11-30", "2026-12-01", "2026-12-02"]);
  const crm = qs.find((q) => /CRM/.test(q.content))!;
  assert.ok(s.collectionItems(crm.id).length >= 4, "the CRM shortlist is recorded as data");
  const hit = s.hitForTurn(crm.id)!;
  assert.equal(hit.sources.length, 10);
  assert.equal(loadDemo(s, "u1", "Asia/Kolkata", now).added, false); // idempotent
  assert.equal(loadDemo(s, "u2", "UTC", now).added, true); // per owner
});
