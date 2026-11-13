import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseInterpretation } from "../src/agent/history.ts";
import { normaliseCitations } from "../src/agent/text.ts";
import { rerank } from "../src/agent/retrieval.ts";
import type { RecallHit } from "../src/memory/store.ts";
import type { Evidence } from "../src/search/router.ts";

const hit = (date: string, via: RecallHit["via"]): RecallHit => ({
  question: { id: 1, session_id: "s", owner: "local", role: "user", content: "postgres hosting", created_at_utc: `${date}T05:00:00Z`, tz: "UTC", local_date: date, route: null, reply_to: null, status: "complete" },
  answer: null,
  sources: [],
  claims: [],
  via,
});

test("ambiguous 'last Tuesday' picks the window whose turns match the topic", () => {
  const groups = [[
    { start: "2026-11-10", end: "2026-11-10", phrase: "last tuesday", label: "Tue 10 Nov" },
    { start: "2026-11-03", end: "2026-11-03", phrase: "last tuesday", label: "Tue 3 Nov" },
  ]];
  const r = chooseInterpretation(groups, [hit("2026-11-10", "date"), hit("2026-11-03", "date+text")]);
  assert.equal(r.windows[0]!.start, "2026-11-03");
  assert.equal(r.hits.length, 1);
  assert.match(r.notes[0]!, /Tue 3 Nov/);
});

test("fullwidth citations are normalised", () => {
  assert.equal(normaliseCitations("Price is $19【1】 and $69【2†source】."), "Price is $19[1] and $69[2].");
});

const ev = (url: string, publishedAt?: string, text = "neon pricing launch plan compute storage"): Evidence => ({ url, title: "t", publishedAt, text, provider: "exa", query: "q", fetchedAt: "2026-11-12T00:00:00Z" });

test("rerank prefers official domains, drops duplicates, demotes stale pages, orders oldest→newest", () => {
  const plan = { route: "quick" as const, queries: [{ q: "Neon pricing plans", objective: "x" }], entities: ["Neon"], volatility: "fast" as const, understanding: { pastRef: "none" as const, recallTerms: [], wantsRecheck: false, actionRequest: false, steering: false, claims: [], premises: [], factual: false, aboutReply: false } };
  const out = rerank([ev("https://blog.example.com/neon", "2022-01-01"), ev("https://neon.com/pricing"), ev("https://www.neon.com/pricing/?utm_source=x"), ev("https://news.example.com/a", "2026-11-05")], plan, 2, "2026-11-12");
  assert.equal(out.length, 2);
  assert.ok(out.some((e) => e.url.includes("neon.com/pricing")));
  assert.ok(!out.some((e) => e.publishedAt === "2022-01-01"));
});

test("follow-up round: only entities no fetched page covers are searched again", async () => {
  const { uncoveredEntities } = await import("../src/agent/retrieval.ts");
  const ev = [{ url: "https://acme.example/pricing", title: "Acme pricing", text: "Acme Pro costs $20", provider: "exa" as const, query: "q", fetchedAt: "x" }];
  assert.deepEqual(uncoveredEntities(["Acme", "Zentrix Cloud", "Acme"], ev), ["Zentrix Cloud"]);
  assert.deepEqual(uncoveredEntities([], ev), []);
});

test("recheck covers the whole shortlist: products with no checkable figure are listed, not dropped", async () => {
  const { entitiesFromHistory } = await import("../src/agent/history.ts");
  const { uncheckedEntities } = await import("../src/agent/routing.ts");
  const ans = "| CRM | Per-seat price |\n|---|---|\n| HubSpot Starter | $15 / seat / mo [1] |\n| Pipedrive Lite | $14 / seat / mo [2] |\n| Freshsales | contact sales |\n| Attio | (price not listed) |";
  const hit = { question: { id: 1, content: "Shortlist CRMs" }, answer: { id: 2, content: ans }, sources: [], claims: [], via: "date" } as any;
  assert.deepEqual(uncheckedEntities(entitiesFromHistory([hit]), [{ entity: "HubSpot Starter" }, { entity: "Pipedrive Lite" }]), ["Freshsales", "Attio"]);
});

test("bestPassages keeps the paragraphs that match the question, in page order, within budget", async () => {
  const { bestPassages } = await import("../src/agent/text.ts");
  const page = "Welcome to Acme, the leading tool for teams everywhere.\n\nAcme Help Desk includes email and chat support with a knowledge base, from €29 per agent.\n\nOur offices are in Berlin and we love coffee and long walks.\n\nData residency: all Acme help desk data can be hosted in the EU (Frankfurt region).";
  const out = bestPassages(page, "EU help desk with email chat knowledge base data residency", 400);
  assert.match(out, /email and chat support/);
  assert.match(out, /hosted in the EU/);
  assert.doesNotMatch(out, /coffee/);
  assert.ok(out.indexOf("email and chat") < out.indexOf("hosted in the EU"));
});
