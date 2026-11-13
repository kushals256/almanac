import { test } from "node:test";
import assert from "node:assert/strict";
import { checkNumbers, claimNumbers, extractClaims, normNum } from "../src/agent/verify.ts";
import type { Evidence } from "../src/search/router.ts";

const ev = (text: string): Evidence => ({ url: "https://x.com", title: "t", text, provider: "exa", query: "q", fetchedAt: "2026-11-12" });

test("only cited lines become claims; table separator rows are skipped", () => {
  const a = [
    "Neon Launch costs $19/month as of 12 Nov [1]. It scales to zero.",
    "",
    "| Item | Then | Now | Verdict | Evidence |",
    "|---|---|---|---|---|",
    "| Neon | $19 | $19 | Unchanged | [1] |",
    "- Supabase Pro is $25/mo [2]",
  ].join("\n");
  const c = extractClaims(a);
  assert.equal(c.length, 3);
  assert.deepEqual(c.map((x) => x.kind), ["sentence", "row", "sentence"]);
  assert.deepEqual(c[0]!.cites, [1]);
  assert.equal(c[1]!.line, 4);
});

test("numbers worth proving: money and decimals, not years, days or small counts", () => {
  assert.deepEqual(claimNumbers("Launch is $0.106 per CU-hour and 20 GB storage as of 12 Nov 2026, 2 of 5 changed"), ["0.106", "20"]);
  assert.deepEqual(claimNumbers("Starter is $1,200/yr or US$15 per seat"), ["1200", "15"]);
  assert.equal(normNum("$1,000.50"), "1000.5");
});

test("code proves numbers against cited evidence (and earlier answer for Then values)", () => {
  const [claim] = extractClaims("| HubSpot | $7 | $20 | Changed | [1] |");
  assert.deepEqual(checkNumbers(claim!, [ev("Starter now costs $20 per seat per month")], ""), ["7"]);
  assert.deepEqual(checkNumbers(claim!, [ev("Starter now costs $20 per seat per month")], "Earlier: HubSpot Starter $7/seat"), []);
});

import { splitSentences } from "../src/agent/verify.ts";

test("sentence split survives decimals, versions, money and abbreviations", () => {
  assert.deepEqual(splitSentences("The latest release is 3.15.2 [3][5] (as of 2026-11-12). It shipped in October."), ["The latest release is 3.15.2 [3][5] (as of 2026-11-12).", "It shipped in October."]);
  assert.deepEqual(splitSentences("The U.S. Federal Reserve range is 3.75 %–4.00 % [5]. It was set in October."), ["The U.S. Federal Reserve range is 3.75 %–4.00 % [5].", "It was set in October."]);
  assert.equal(splitSentences("iPhone 17 Pro is $1,099.99 as of today [1].").length, 1);
});

test("derived figures (a×b, a+b, ×12) count as proven; invented ones don't", () => {
  const [row] = extractClaims("| Jira | Standard | ≈ $81.50 | $8.15 per user/mo (10 users) | [1] |");
  assert.deepEqual(checkNumbers(row!, [ev("Standard costs $8.15 per user per month")], "", "a 10-person startup"), []);
  const [annual] = extractClaims("20 seats cost $4,800 per year [1].");
  assert.deepEqual(checkNumbers(annual!, [ev("Starter is $20 per seat per month")], "", "20 seats"), []);
  const [bad] = extractClaims("Monthly billing is $16.60 per user [1].");
  assert.deepEqual(checkNumbers(bad!, [ev("Starter is $13.49 per user per month billed annually")], "", ""), ["16.6"]);
});

test("number proof: invented figures don't pass as accidental products of page numbers; shown/user arithmetic does", async () => {
  const { checkNumbers } = await import("../src/agent/verify.ts");
  const ev = [{ url: "u", title: "t", text: "Plans: $20, $25, $10, $15 and $100 per seat per month.", provider: "exa" as const, query: "q", fetchedAt: "x" }];
  const c = (text: string, numbers: string[]) => ({ id: "c", text, cites: [1], numbers, line: 0 }) as any;
  assert.deepEqual(checkNumbers(c("Pro costs $45 per seat [1].", ["45"]), ev, "", ""), ["45"]);
  assert.deepEqual(checkNumbers(c("Pro costs $250 per seat [1].", ["250"]), ev, "", ""), ["250"]);
  assert.deepEqual(checkNumbers(c("For your 20 seats that's $500 a month [1].", ["20", "500"]), ev, "", "We're 20 people, what would Pro cost?"), []);
  assert.deepEqual(checkNumbers(c("10 seats × $25 = $250 a month [1].", ["10", "25", "250"]), ev, "", ""), []);
  assert.deepEqual(checkNumbers(c("That's $300 a year on the $25 plan [1].", ["300", "25"]), ev, "", ""), []);
});

test("number proof: a % change between two figures the claim states is derived; headline numbers count as source", async () => {
  const { checkNumbers } = await import("../src/agent/verify.ts");
  const ev = [{ url: "u", title: "Acme raises its onboarding fee to $3,500", text: "Onboarding is now $3,500 per account.", provider: "exa" as const, query: "q", fetchedAt: "x" }];
  const c = (text: string, numbers: string[]) => ({ id: "c", text, cites: [1], numbers, line: 0 }) as any;
  assert.deepEqual(checkNumbers(c("Onboarding fee | $1,500 | $3,500 | Changed (+133%) [1]", ["1500", "3500", "133"]), ev, "$1,500 onboarding fee", ""), []);
  assert.deepEqual(checkNumbers(c("Acme raises its onboarding fee to $3,500 [1]", ["3500"]), [{ ...ev[0]!, text: "" }], "", ""), []);
  assert.deepEqual(checkNumbers(c("Fee rose 90% [1]", ["90"]), ev, "", ""), ["90"]); // no two stated figures → not derived
});

test("code-written recheck rows are not re-judged by the judge; their figures are still checked in code", async () => {
  const { Verifier } = await import("../src/agent/verify.ts");
  let asked: string[] = [];
  const judge = { ask: async (_s: string, q: Record<string, unknown>) => ((asked = Object.keys(q)), { probs: Object.fromEntries(Object.keys(q).map((k) => [k, 0.05])), via: "jev" }), health: () => ({ lastError: null }) } as any;
  const ev = [{ url: "https://nodejs.org", title: "Node.js", text: "Latest LTS: v26.13.1", provider: "exa" as const, query: "q", fetchedAt: "x" }];
  const table = "| Item | Then | Now | Verdict | Evidence |\n|---|---|---|---|---|\n| Node.js — version | Node.js 26.13.1 | v26.13.1 | Unchanged | [1] |";
  const out = await new Verifier(judge).verify(table, ev, "Node.js 26.13.1", new AbortController().signal, "", { recheck: true, codeWritten: true });
  assert.equal(asked.length, 0);
  assert.equal(out.results[0]!.status, "verified");
});
