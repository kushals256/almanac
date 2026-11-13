import { test } from "node:test";
import assert from "node:assert/strict";
import { compareValues, parseMoney, parseValues } from "../src/recheck/values.ts";
import { attributeChanges, renderV2, type ObsResult } from "../src/recheck/v2.ts";
import type { Evidence } from "../src/search/router.ts";

const cmp = (a: string, b: string) => compareValues(parseValues(a), parseValues(b));

test("comparator precision: a different cent amount is a change; charm pricing and float noise are not", () => {
  assert.equal(cmp("$10 per month", "$10.19 per month").verdict, "Changed");
  assert.equal(cmp("$10 per month", "$10.00 per month").verdict, "Unchanged");
  assert.equal(cmp("$60 per month", "$59.99 per month").verdict, "Unchanged");
  assert.equal(cmp("$0.001 per request", "$0.002 per request").verdict, "Changed");
  assert.equal(cmp("$0.106 per CU-hour", "$0.1060 per CU-hour").verdict, "Unchanged");
  assert.equal(cmp("100 users", "101 users").verdict, "Changed");
});

test("comparator periods: month vs year compare after conversion; an unconvertible pair is not comparable, not a change", () => {
  assert.equal(cmp("$25 per month", "$300 per year").verdict, "Unchanged");
  assert.equal(cmp("$300 per year", "$25 per month").verdict, "Unchanged");
  assert.equal(cmp("$25 per month", "$240 per year").verdict, "Not comparable");
});

test("European grouping: €1.299,00 is 1299, not 1.299", () => {
  assert.equal(parseMoney("€1.299,00")[0]!.amount, 1299);
  assert.equal(parseMoney("€37,50")[0]!.amount, 37.5);
  assert.equal(parseMoney("$1,299.00")[0]!.amount, 1299);
  assert.equal(cmp("€1.299,00 per year", "€1.299,00 per year").verdict, "Unchanged");
});

// --- Changed vs Differs (timing evidence decided in code) ---
const SRC = "https://vendor.example/pricing";
const base = (o: Partial<ObsResult>): ObsResult => {
  const thenValues = parseValues("$19 per month");
  const now = parseValues("$25 per month");
  return { entity: "Acme Pro", attribute: "monthly price", answerSpan: "$19 per month", thenValues, cmp: compareValues(thenValues, now), nowSpan: "$25 per month", evidenceIdx: 1, ...o };
};
const news = (title: string, date: string, text = ""): Evidence => ({ url: `https://news.example/${date}`, title, text, provider: "exa", query: "q", fetchedAt: "2026-11-12T00:00:00Z", publishedAt: `${date}T00:00:00Z`, status: "ok" });

test("a different figure on the SAME page that showed our figure then (stored quote) is a change since then", () => {
  const [r] = attributeChanges([base({ quote: "Pro: $19 per month", sourceUrl: SRC, observedUrl: SRC })], [], 1, "2026-11-03");
  assert.equal(r!.cmp.verdict, "Changed");
});

test("a different figure with no quote, or read from another page, differs: no evidence it changed after the earlier answer", () => {
  assert.equal(attributeChanges([base({ sourceUrl: SRC, observedUrl: SRC })], [], 1, "2026-11-03")[0]!.cmp.verdict, "Differs");
  assert.equal(attributeChanges([base({ quote: "Pro: $19 per month", sourceUrl: SRC, observedUrl: "https://other.example/pricing" })], [], 1, "2026-11-03")[0]!.cmp.verdict, "Differs");
});

test("a dated item since then that names the brand and the new value makes it a change; an older or unrelated item doesn't", () => {
  const after = news("Acme raises Pro plan price", "2026-11-06", "Acme Pro now costs $25 per month.");
  const r = attributeChanges([base({})], [after], 1, "2026-11-03")[0]!;
  assert.equal(r.cmp.verdict, "Changed");
  assert.match(r.cmp.note!, /announced 2026-11-06 \[2\]/);
  assert.equal(attributeChanges([base({})], [news("Acme raises Pro plan price", "2026-10-20", "Acme Pro now costs $25 per month.")], 1, "2026-11-03")[0]!.cmp.verdict, "Differs");
  assert.equal(attributeChanges([base({})], [news("Acme ships a new editor", "2026-11-06", "Free for everyone.")], 1, "2026-11-03")[0]!.cmp.verdict, "Differs");
  assert.equal(attributeChanges([base({})], [news("Globex raises prices", "2026-11-06", "Now $25 per month.")], 1, "2026-11-03")[0]!.cmp.verdict, "Differs");
});

test("a version bump announced in a dated release item is a change", () => {
  const thenValues = parseValues("Node.js 22.11.0");
  const r: ObsResult = { entity: "Node.js", attribute: "latest LTS", answerSpan: "22.11.0", thenValues, cmp: compareValues(thenValues, parseValues("v22.12.0")), nowSpan: "v22.12.0", evidenceIdx: 1 };
  assert.equal(attributeChanges([r], [news("Node.js v22.12.0 (LTS) released", "2026-11-05")], 1, "2026-11-03")[0]!.cmp.verdict, "Changed");
});

test("other verdicts pass through untouched", () => {
  const u = base({ cmp: { verdict: "Unchanged" } });
  assert.equal(attributeChanges([u], [], 1, "2026-11-03")[0], u);
});

test("the code-written summary counts differs separately and never says 'still match' above unchecked or differing rows", () => {
  const differs = attributeChanges([base({})], [], 1, "2026-11-03");
  const text = renderV2(differs, [], 1, "2026-11-03", "2026-11-12");
  assert.match(text, /\*\*0 of 1 figure changed since .*; 1 differs from what I told you/);
  assert.match(text, /my earlier figure may have been wrong/);
  assert.match(text, /\| Differs from my earlier answer \(\+32%\) \|/);
  assert.doesNotMatch(text, /still match/);
  const mixed = renderV2([base({ cmp: { verdict: "Unchanged" } }), base({ cmp: { verdict: "Not comparable", note: "different unit" } })], [], 1, "2026-11-03", "2026-11-12");
  assert.match(mixed, /1 is now stated in a way I can't compare like-for-like/);
  assert.doesNotMatch(mixed, /still match/);
  const clean = renderV2([base({ cmp: { verdict: "Unchanged" } })], [], 1, "2026-11-03", "2026-11-12");
  assert.match(clean, /still match what I told you/);
});

test("live-found: a dated article that only STATES today's price is not timing evidence; one that reports the change is", () => {
  const listing = news("HubSpot vs Pipedrive: Which Is Better?", "2026-11-12", "Acme Pro costs $25 per month, Globex $14.");
  assert.equal(attributeChanges([base({})], [listing], 1, "2026-11-03")[0]!.cmp.verdict, "Differs");
  const report = news("Acme updates its plans", "2026-11-12", "Acme raised the Pro plan from $19 to $25 per month this week.");
  assert.equal(attributeChanges([base({})], [report], 1, "2026-11-03")[0]!.cmp.verdict, "Changed");
});

test("live-found: the same amount at the plan's label without a period is unchanged; another amount, or a marked minimum, can't tell", () => {
  assert.equal(cmp("$39/user/mo", "US$39").verdict, "Unchanged");
  assert.equal(cmp("$39/user/mo", "US$45").verdict, "Unverifiable");
  assert.equal(cmp("$5 per month", "credits ($5 minimum)").verdict, "Unverifiable");
});

test("live-found: a flat price 20× away is another figure, not a change", async () => {
  const { farOff } = await import("../src/recheck/values.ts");
  const [t] = parseValues("$450/user/mo");
  const [n] = parseValues("$7/mo/seat");
  assert.equal(farOff(t, n), true);
  assert.equal(farOff(t, parseValues("$100/user/mo")[0]), false);
  assert.equal(farOff(parseValues("$0.10 per 1M tokens")[0], parseValues("$3 per 1M tokens")[0]), false); // usage prices move a lot
});

test("live-found: the extractor naming one plan twice with the same value yields one row", async () => {
  const { claimsFromAnswer } = await import("../src/recheck/v2.ts");
  const answer = "| CRM | Price |\n|---|---|\n| Salesforce Sales Cloud Professional | $100/user/mo |\n| Copper Professional | $69/user/mo |";
  const llm = { complete: async () => ({ text: JSON.stringify({ claims: [
    { line: 3, entity: "Salesforce Sales Cloud Professional", attribute: "price", span: "$100/user/mo", source: null },
    { line: 3, entity: "Salesforce Sales Cloud Professional Suite", attribute: "price", span: "$100/user/mo", source: null },
    { line: 4, entity: "Copper Professional", attribute: "price", span: "$69/user/mo", source: null },
  ] }) }) } as any;
  const hit = { question: { content: "Shortlist CRMs" }, answer: { content: answer }, sources: [] } as any;
  const claims = await claimsFromAnswer(llm, hit, new AbortController().signal, "background");
  assert.deepEqual(claims.map((c) => c.entity), ["Salesforce Sales Cloud Professional", "Copper Professional"]);
});

test("news: same name, different thing — an item must share a word with the conversation (or be on the brand's domain)", async () => {
  const { newsSince } = await import("../src/recheck/v2.ts");
  const ev = (title: string, url: string, text = ""): Evidence => ({ url, title, text, provider: "exa", query: "q", fetchedAt: "2026-11-13T00:00:00Z", publishedAt: "2026-11-12T00:00:00Z", status: "ok" });
  const search = {
    search: async () => [ev("A shortage of ore is causing a pricing revolution in copper", "https://mining.com/a", "Copper prices for miners and smelters."), ev("Copper CRM launches AI assistant for sales teams", "https://techcrunch.com/b", "The CRM adds an AI assistant.")],
    releases: async () => [ev("Copper ships new pipeline view", "https://www.copper.com/blog/c")],
  } as any;
  const items = await newsSince(search, ["Copper"], "2026-11-09", new AbortController().signal, { calls: 0, byProvider: {}, cacheHits: 0, costUsd: 0 }, undefined, "We're a 20-person sales team. Shortlist 5 CRM tools for us.");
  assert.deepEqual(items.map((e) => e.url).sort(), ["https://techcrunch.com/b", "https://www.copper.com/blog/c"]);
});
