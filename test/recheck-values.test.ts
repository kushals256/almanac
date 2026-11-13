import { test } from "node:test";
import assert from "node:assert/strict";
import { compareValues, parseMoney, parseValues } from "../src/recheck/values.ts";

test("money parsing: period, per-seat, billing, approx, promo, usage", () => {
  const [a] = parseMoney("Plus is $10 per member / month, billed annually");
  assert.deepEqual([a!.amount, a!.period, a!.perUnit, a!.billing], [10, "month", "seat", "annual"]);
  const [b] = parseMoney("about $60");
  assert.equal(b!.approx, true);
  const [c] = parseMoney("$0.99 for 3 months, then $12.99/month");
  assert.equal(c!.promo, true);
  const [u] = parseMoney("Launch: $0.106 per CU-hour, no monthly minimum");
  assert.deepEqual([u!.period, u!.usageUnit], ["usage", "cu-hour"]);
  const [r] = parseMoney("₹1,14,900 in India");
  assert.equal(r!.currency, "INR");
});

test("comparator: real change, rounding, cadence, promo, pricing model, currency", () => {
  const cmp = (a: string, b: string) => compareValues(parseValues(a), parseValues(b));
  assert.equal(cmp("$9.99 a month", "Premium Individual $12.99/month").verdict, "Changed");
  assert.match(cmp("$9.99 a month", "$12.99/month").note!, /\+30%/);
  assert.equal(cmp("about $60", "$59.99").verdict, "Unchanged");
  assert.equal(cmp("$10 per member per month billed annually, $12 billed monthly", "$10 per member/month billed annually").verdict, "Unchanged");
  assert.equal(cmp("$9.99 a month", "Try 3 months for $0 promo, limited time").verdict, "Unverifiable");
  assert.equal(cmp("flat $5 per month", "$0.106 per CU-hour").verdict, "Changed");
  assert.equal(cmp("$9.99 a month", "₹119 per month").verdict, "Not comparable"); // different currency → not like-for-like
  assert.equal(cmp("4.25%–4.50%", "3.75–4.00%").verdict, "Changed");
  assert.equal(cmp("Node.js 26.13.1", "v26.13.1 (LTS)").verdict, "Unchanged");
});

test("usage units: per-token prices parse and compare like-for-like", () => {
  const [a] = parseMoney("$3 per million input tokens");
  assert.deepEqual([a!.period, a!.usageUnit], ["usage", "1m-input-token"]);
  const [b] = parseMoney("$3 / 1M input tokens");
  assert.equal(b!.usageUnit, "1m-input-token");
  const cmp = (x: string, y: string) => compareValues(parseValues(x), parseValues(y));
  assert.equal(cmp("$3 per million input tokens", "$0.10 per 1M input tokens").verdict, "Changed");
  assert.equal(cmp("$3 per million input tokens", "$3 / 1M input tokens").verdict, "Unchanged");
  assert.equal(cmp("$3 per million input tokens", "$15 per 1M output tokens").verdict, "Not comparable");
});

test("locator: flat price preferred over a nearby usage add-on; unit kept for display", async () => {
  const { locateValue, withUnit } = await import("../src/recheck/v2.ts");
  const page = "Supabase pricing. Free $0/month. Pro plan $25/month includes 8 GB. Then $0.00325 per MAU over 100,000. Team $599/month.";
  const claim = { entity: "Supabase Pro", attribute: "monthly price", answerSpan: "$15 per month", thenValues: parseValues("$15 per month") };
  assert.equal(locateValue(page, claim)!.value.raw, "$25");
  assert.equal(withUnit("Launch: $0.106 per CU-hour, no minimum", "$0.106"), "$0.106 per CU-hour");
});

test("locator: plan word beats brand word; estimates and credits lose to list prices; grids read by row × column", async () => {
  const { locateValue, locateInTable } = await import("../src/recheck/v2.ts");
  const mk = (entity: string, attribute: string, span: string) => ({ entity, attribute, answerSpan: span, thenValues: parseValues(span) });
  const page = "Acme pricing: typical spend $15/month. Acme Console: buy prepaid credits ($5 minimum).\n\nCompute:\n- Starter plan: $0.12 per CU-hour\n- Growth plan: $0.25 per CU-hour";
  assert.equal(locateValue(page, mk("Acme Starter plan", "price", "$5 per month"))!.value.raw, "$0.12");
  const grid = "| Model | Input | Output |\n| --- | --- | --- |\n| Widget Max 2 | $4 / MTok | $20 / MTok |\n| Widget Mini 2 | $1 / MTok | $5 / MTok |";
  const t = locateInTable(grid, mk("Widget Mini", "output price", "$4 per million output tokens"));
  assert.equal(t!.value.raw, "$5");
  assert.match(t!.label, /Widget Mini 2 · Output/);
});

test("names aren't quantities; units must match; one-off vs monthly price isn't like-for-like", () => {
  assert.equal(parseValues("Ryzen AI 7 445").length, 0);
  assert.equal(parseValues("dual SO-DIMM & M.2 slots").filter((v) => v.kind === "number").length, 0);
  const cmp = (a: string, b: string) => compareValues(parseValues(a), parseValues(b));
  assert.equal(cmp("16 GB RAM", "32 GB").verdict, "Changed");
  assert.equal(cmp("16 GB RAM", "5 hours").verdict, "Not comparable");
  assert.equal(cmp("≈ $1,150", "$108.25/mo").verdict, "Not comparable");
  assert.equal(cmp("$999", "$1,099").verdict, "Changed");
});

test("display unit is a unit phrase only; billing cadence prefers like-for-like", async () => {
  const { withUnit, locateValue } = await import("../src/recheck/v2.ts");
  assert.equal(withUnit("$7/mo Buy now Loading", "$7"), "$7/mo");
  assert.equal(withUnit("$14 per seat / month", "$14"), "$14 per seat / month");
  const page = "Standard plan: $20 per user/month billed monthly. Standard plan: $14 per user/month billed annually.";
  const c = { entity: "Zoho CRM Standard", attribute: "per-seat price", answerSpan: "$14 / seat / month (billed annually)", thenValues: parseValues("$14 / seat / month (billed annually)") };
  assert.equal(locateValue(page, c)!.value.raw, "$14");
});

test("specs: product row must match fully; RAM vs storage by label; worked examples aren't prices", async () => {
  const { locateValue, locateInTable } = await import("../src/recheck/v2.ts");
  const mk = (entity: string, attribute: string, span: string) => ({ entity, attribute, answerSpan: span, thenValues: parseValues(span) });
  const grid = "| Model | RAM | Storage |\n| --- | --- | --- |\n| Laptop Air 13 | 16GB | 512GB |";
  assert.equal(locateInTable(grid, mk("Laptop Neo", "RAM", "8 GB unified")), null);
  const spec = "Gamer 15 specs: Storage: 512GB SSD. Memory (RAM): 16GB DDR5. Display 15.6 inch.";
  assert.equal(locateValue(spec, mk("Gamer 15", "RAM", "16 GB DDR5"))!.value.raw.replace(/\s/g, ""), "16GB");
  const [ex] = parseMoney("For example, 100 tenant databases on Starter use about 750 CU-hours: roughly $85 a month in total.");
  assert.equal(ex!.estimate, true);
});

test("CRM tiers: European decimal comma, tier word decides, Indian grouping", async () => {
  const { locateValue } = await import("../src/recheck/v2.ts");
  assert.equal(parseMoney("Smart: €37,50 per user/month")[0]!.amount, 37.5);
  assert.equal(parseMoney("₹1,14,900")[0]!.amount, 114900);
  assert.equal(parseMoney("$1,299")[0]!.amount, 1299);
  const page = "Sales Hub Starter: $15/seat/month. Sales Hub Professional: $90/seat/month. Everything in Starter, plus forecasting. Sales Hub Enterprise: $150/seat/month.";
  const c = { entity: "HubSpot Sales Hub Starter", attribute: "per-seat price", answerSpan: "$15 / seat / month", thenValues: parseValues("$15 / seat / month") };
  assert.equal(locateValue(page, c)!.value.raw, "$15");
  const c2 = { ...c, entity: "HubSpot Sales Hub Professional", answerSpan: "$100 / seat / month", thenValues: parseValues("$100 / seat / month") };
  assert.equal(locateValue(page, c2)!.value.raw, "$90");
});

test("a cadence-less figure can't confirm or contradict a monthly price", () => {
  const cmp = (a: string, b: string) => compareValues(parseValues(a), parseValues(b));
  assert.equal(cmp("$5 per month", "credits ($5 minimum)").verdict, "Unverifiable");
  assert.equal(cmp("$5 per month", "$5/month").verdict, "Unchanged");
  assert.equal(cmp("$7 / seat", "$7").verdict, "Unchanged");
});

test("versions: a pre-release on the page doesn't count as the latest release", async () => {
  const { locateValue } = await import("../src/recheck/v2.ts");
  const page = "Node.js downloads. Node.js 27 alpha: v27.0.0 nightly builds for testing. Latest LTS: v26.13.1 (recommended for most users).";
  const c = { entity: "Node.js", attribute: "latest stable version", answerSpan: "Node.js 26.13.1", thenValues: parseValues("Node.js 26.13.1") };
  assert.equal(locateValue(page, c)!.value.raw.replace(/^v/, ""), "26.13.1");
});

test("a model-picked line is judged like code's own locates: an estimate never stands in for a list price", async () => {
  const { judgePick } = await import("../src/recheck/v2.ts");
  const then = parseValues("$5 per month");
  assert.equal(judgePick(then, "Neon Pricing: Free Plan With 100 Projects, Typical Spend $15/Month", "$15/Month").cmp.verdict, "Unverifiable");
  assert.equal(judgePick(then, "Launch plan: $19 per month, billed monthly", "$19 per month").cmp.verdict, "Changed");
});
