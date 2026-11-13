import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTemporal } from "../src/memory/temporal.ts";

const NOW = new Date("2026-11-12T06:00:00Z"); // Thursday 12 Nov 2026
const TZ = "Asia/Kolkata";
const starts = (text: string, now = NOW) => resolveTemporal(text, now, TZ).groups.map((g) => g.map((w) => `${w.start}..${w.end}`));

test("last Tuesday returns both candidates, most recent first", () => {
  assert.deepEqual(starts("Last Tuesday I asked you about Postgres hosting."), [["2026-11-10..2026-11-10", "2026-11-03..2026-11-03"]]);
});

test("On Monday → this week's Monday", () => {
  assert.deepEqual(starts("On Monday we shortlisted 5 CRM tools"), [["2026-11-09..2026-11-09"]]);
});

test("3 November resolves to the past, and is a back-reference", () => {
  const r = resolveTemporal("What did I ask you on 3 November? Is your answer still correct today?", NOW, TZ);
  assert.equal(r.groups[0]![0]!.start, "2026-11-03");
  assert.equal(r.backReference, true);
});

test("bare date in the future is biased to the previous year", () => {
  assert.deepEqual(starts("what did I ask on 3 November", new Date("2026-11-02T06:00:00Z")), [["2025-11-03..2025-11-03"]]);
});

test("last week expands to Monday–Sunday", () => {
  assert.deepEqual(starts("what did we discuss last week"), [["2026-11-02..2026-11-08"]]);
});

test("yesterday and N days ago", () => {
  assert.deepEqual(starts("yesterday"), [["2026-11-11..2026-11-11"]]);
  assert.deepEqual(starts("4 days ago"), [["2026-11-08..2026-11-08"]]);
});

test("no dates, no back-reference for a plain question", () => {
  const r = resolveTemporal("What is the cheapest Postgres hosting right now?", NOW, TZ);
  assert.deepEqual(r.groups, []);
  assert.equal(r.backReference, false);
});

test("abbreviations need a cue word", () => {
  assert.deepEqual(starts("I sat down to compare tools"), []);
  assert.deepEqual(starts("since wed"), [["2026-11-11..2026-11-11"]]);
});

test("timezone decides 'today' (late evening UTC is next day in IST)", () => {
  const r = resolveTemporal("today", new Date("2026-11-11T20:00:00Z"), TZ);
  assert.equal(r.today, "2026-11-12");
});

// ---- F-72 / F-73 (dataset v2): Thursday 12 Nov 2026
test("named days: Halloween is the most recent 31 Oct", () => {
  assert.deepEqual(starts("What did we discuss on Halloween?"), [["2026-10-31..2026-10-31"]]);
  assert.deepEqual(starts("what did I ask on Christmas?"), [["2025-12-25..2025-12-25"]]);
});
test("'the Monday before last' is one week before last Monday", () => {
  assert.deepEqual(starts("What did I ask you the Monday before last?"), [["2026-11-02..2026-11-02"]]);
});
test("'on the 5th' (no month) is the most recent 5th; 'the 20th' is last month", () => {
  assert.deepEqual(starts("What did I ask you on the 5th?"), [["2026-11-05..2026-11-05"]]);
  assert.deepEqual(starts("what did I ask on the 20th"), [["2026-10-20..2026-10-20"]]);
});
test("last weekend is Sat 7 – Sun 8 Nov", () => {
  assert.deepEqual(starts("What did I ask last weekend?"), [["2026-11-07..2026-11-08"]]);
});
test("'day before yesterday' wins over 'yesterday'; word numbers work", () => {
  assert.deepEqual(starts("And the day before yesterday?"), [["2026-11-10..2026-11-10"]]);
  assert.deepEqual(starts("What did I ask you three days ago?"), [["2026-11-09..2026-11-09"]]);
});

test("future phrases and non-date ordinals never become past windows", async () => {
  const { resolveTemporal } = await import("../src/memory/temporal.ts");
  const at = new Date("2026-11-13T10:00:00Z");
  const starts = (s: string) => resolveTemporal(s, at, "UTC").groups.flat().map((w) => w.start);
  assert.deepEqual(starts("is the store open next Friday"), []);
  assert.deepEqual(starts("is the store open on Saturday?"), []);
  assert.deepEqual(starts("what's the weather on 20 November?"), []);
  assert.deepEqual(starts("should I pick the 2nd or the 3rd option"), []);
  assert.deepEqual(starts("remind me tomorrow"), []);
  // Past readings still work.
  assert.deepEqual(starts("What did I ask you on Tuesday?"), ["2026-11-10"]);
  assert.deepEqual(starts("What did I ask you on 3 November?"), ["2026-11-03"]);
  assert.deepEqual(starts("what did I ask on the 5th?"), ["2026-11-05"]);
  assert.equal(resolveTemporal("is the store open next Friday", at, "UTC").backReference, false);
});
