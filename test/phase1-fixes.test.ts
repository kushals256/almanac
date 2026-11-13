import { test } from "node:test";
import assert from "node:assert/strict";
import { topicOf } from "../src/agent/history.ts";
import { admitPremises, frameFor } from "../src/agent/claims.ts";
import { isNonEnglish } from "../src/agent/signals.ts";
import { dropUnbackedCitations } from "../src/agent/text.ts";
import { withoutValues } from "../src/recheck/v2.ts";
import { Store } from "../src/memory/store.ts";

test("topicOf: a date is when, not what", () => {
  assert.equal(topicOf("Did I ask you anything about 3 November?"), null);
  assert.equal(topicOf("what did we talk about on the 3rd of November"), null);
  assert.equal(topicOf("Did I ask you about Kubernetes earlier this month?"), "Kubernetes");
});

test("premises: a claim whose subject is the user is context whatever the planner labelled it; a reported claim stays", () => {
  const msg = "On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?";
  assert.equal(admitPremises([{ claim: "We shortlisted 5 CRM tools", attribution: "presupposed" } as any], msg).length, 0);
  const told = "My colleague says Zoho raised its CRM prices last week.";
  assert.equal(admitPremises([{ claim: "Zoho raised its CRM prices", attribution: "third_party" } as any], told).length, 1);
});

test("premise frame keeps a name's capital mid-sentence; a leading article is lowercased", () => {
  const v = (claim: string) => ({ premise: { claim, attribution: "user" }, status: "unconfirmed", exact: [], contra: [], different: [] }) as any;
  assert.equal(frameFor(v("Zoho raised CRM prices"), () => 1), "I can't find any reliable report that Zoho raised CRM prices.");
  assert.equal(frameFor(v("The app went free for everyone."), () => 1), "I can't find any reliable report that the app went free for everyone.");
});

test("language: an English question about a foreign title stays English; a foreign question doesn't", () => {
  assert.equal(isNonEnglish("Who sang la vie en rose?"), false);
  assert.equal(isNonEnglish("What does 'la vie en rose' mean?"), false);
  assert.equal(isNonEnglish("What's the price of Zoho's Standard plan?"), false);
  assert.equal(isNonEnglish("Quel est le prix de Notion ?"), true);
  assert.equal(isNonEnglish("Qual é o preço do Notion?"), true);
});

test("citations: [n] beyond the sources and links to unknown URLs are removed; code and identifiers are untouched", () => {
  const urls = ["https://www.notion.com/pricing"];
  assert.equal(dropUnbackedCitations("Plus is $10 [1][9].", urls), "Plus is $10 [1].");
  assert.equal(dropUnbackedCitations("See [pricing](https://notion.com/pricing/) and [blog](https://made.up/x).", urls), "See [pricing](https://notion.com/pricing/) and blog.");
  assert.equal(dropUnbackedCitations("Pro costs $25 per seat[9].", urls), "Pro costs $25 per seat."); // stuck to a word: still a citation
  assert.equal(dropUnbackedCitations("`arr[3]` and\n```\nx[7]\n```", urls), "`arr[3]` and\n```\nx[7]\n```"); // code untouched
});

test("recheck queries never carry the figure we expect to find; names with numbers stay", () => {
  assert.equal(withoutValues("Notion Plus $10/month"), "Notion Plus");
  assert.equal(withoutValues("HubSpot Starter US$20 per seat"), "HubSpot Starter per seat");
  assert.equal(withoutValues("iPhone 17 price"), "iPhone 17 price");
  assert.equal(withoutValues("mortgage rate 6.5% today"), "mortgage rate today");
});

test("recall: value claims never show up as earlier flagged sentences; session recall is owner-scoped", () => {
  const s = new Store(":memory:");
  const at = new Date("2026-11-03T10:00:00Z");
  const q = s.insertTurn({ sessionId: "s1", role: "user", content: "What does Notion Plus cost?", tz: "UTC", at, owner: "alice" });
  s.setTurnStatus(q, "complete");
  const a = s.insertTurn({ sessionId: "s1", role: "assistant", content: "Notion Plus is $10 per seat per month.", tz: "UTC", at, replyTo: q, owner: "alice" });
  s.recordValueClaims(q, a, [{ entity: "Notion Plus", attribute: "price", answerSpan: "$10 per seat per month" }], "2026-11-03", at, "q");
  assert.equal(s.claimsFor(a).length, 0);
  assert.equal(s.valueClaimsFor(a).length, 1);
  assert.equal(s.sessionHits("s1", q + 10, 1, "alice").length, 1);
  assert.equal(s.sessionHits("s1", q + 10, 1, "mallory").length, 0);
  assert.equal(s.sessionFirst("s1", q + 10, "mallory").length, 0);
});
