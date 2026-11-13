import { test } from "node:test";
import assert from "node:assert/strict";
import { admitPremises, aggregate, frameFor, type Premise } from "../src/agent/claims.ts";
import type { Evidence } from "../src/search/router.ts";

const ev = (url: string, title: string, publishedAt?: string, text = ""): Evidence => ({ url, title, publishedAt, text: text || title, provider: "exa", query: "q", fetchedAt: "2026-11-12T00:00:00Z" });
const L = (exact: number, contra: number, different: number) => ({ exact, contra, different });

test("admission: names and fragments aren't premises; claims must come from the message; max 2", () => {
  const msg = "why did the league scrap its playoffs after the merger with the rival league";
  const got = admitPremises(
    [
      { claim: "Playoffs", attribution: "presupposed" },
      { claim: "The league scrapped its playoffs", attribution: "presupposed" },
      { claim: "A volcano erupted in Iceland", attribution: "presupposed" },
      { claim: "The league merged with its rival league", attribution: "presupposed" },
      { claim: "The league scrapped its playoffs", attribution: "presupposed" },
    ],
    msg,
  );
  assert.deepEqual(got.map((p) => p.claim), ["The league scrapped its playoffs", "The league merged with its rival league"]);
});

test("aggregate: official exact → confirmed; contradiction → contradicted; near-miss → narrower; nothing → unconfirmed", () => {
  const p: Premise = { claim: "Fooco acquired Barco", attribution: "presupposed" };
  const pool = [ev("https://fooco.com/news/barco", "Fooco completes Barco acquisition"), ev("https://news.example.com/a", "Barco remains independent"), ev("https://blog.example.com/b", "Fooco partners with Barco")];
  const lab = (m: Record<number, ReturnType<typeof L>>) => new Map(Object.entries(m).map(([i, l]) => [`0_${i}`, l]));
  assert.equal(aggregate(p, pool, [0], lab({ 0: L(0.9, 0, 0) }), 0, "2026-11-12").status, "confirmed");
  assert.equal(aggregate(p, pool, [1], lab({ 1: L(0.1, 0.9, 0) }), 0, "2026-11-12").status, "contradicted");
  // "Only partly" needs clear near-misses from two different sites; one alone is just unconfirmed.
  const pool2 = [...pool, ev("https://other.example.org/c", "Barco and Fooco bundle deal")];
  assert.equal(aggregate(p, pool2, [2, 3], lab({ 2: L(0.2, 0.1, 0.8), 3: L(0.1, 0.1, 0.75) }), 0, "2026-11-12").status, "narrower");
  assert.equal(aggregate(p, pool, [2], lab({ 2: L(0.2, 0.1, 0.8) }), 0, "2026-11-12").status, "unconfirmed");
  assert.equal(aggregate(p, pool, [2], lab({ 2: L(0.1, 0.1, 0.1) }), 0, "2026-11-12").status, "unconfirmed");
  assert.equal(aggregate(p, pool, [0, 1], lab({ 0: L(0.9, 0, 0), 1: L(0, 0.9, 0) }), 0, "2026-11-12").status, "conflicting");
});

test("aggregate: time anchor turns an old exact report into an earlier occurrence; rumour wording doesn't establish", () => {
  const p: Premise = { claim: "Kim won the open championship", attribution: "presupposed", timeAnchor: "this year" };
  const pool = [ev("https://sport.example.com/2024", "Kim wins open championship", "2024-07-01"), ev("https://rumours.example.com/x", "Kim reportedly set to win open championship", "2026-06-01")];
  const lab = new Map([["0_0", L(0.95, 0, 0)], ["0_1", L(0.8, 0, 0)]]);
  const v = aggregate(p, pool, [0, 1], lab, 0, "2026-11-12");
  assert.equal(v.status, "narrower");
});

test("frame: code writes the opening; confirmed says nothing", () => {
  const p: Premise = { claim: "The app became free for all users", attribution: "third_party" };
  assert.equal(frameFor({ premise: p, status: "confirmed", exact: [0], contra: [], different: [] }, (i) => i + 1), null);
  assert.equal(frameFor({ premise: p, status: "unconfirmed", exact: [], contra: [], different: [] }, (i) => i + 1), "On that claim: I can't find any reliable report that the app became free for all users.");
  assert.match(frameFor({ premise: p, status: "contradicted", exact: [], contra: [2], different: [] }, (i) => i + 1)!, /doesn't hold up .*\[3\]\.$/);
});

test("aggregate: half-support with no contradiction stays silent (no over-correction of true premises)", () => {
  const p: Premise = { claim: "The chat service was shut down", attribution: "presupposed" };
  const pool = [ev("https://news.example.com/a", "Chat service retired, users moved to new app")];
  const v = aggregate(p, pool, [0], new Map([["0_0", L(0.45, 0.05, 0.7)]]), 0, "2026-11-12");
  assert.equal(v.status, "confirmed");
});

test("admission: claims about our conversation are references, not premises; 'the assistant said X' checks X", () => {
  const got = admitPremises(
    [
      { claim: "The user asked a gardening question yesterday", attribution: "user" },
      { claim: "The assistant previously said that the river festival moved to June", attribution: "assistant_past" },
    ],
    "yesterday i asked u a gardening question, and you said the river festival moved to June?",
  );
  assert.deepEqual(got.map((p) => p.claim), ["The river festival moved to June"]);
});

test("admission: placeholder 'premises' are not checkable", () => {
  assert.equal(admitPremises([{ claim: "Something about picking a mattress firmness (assuming the content exists)", attribution: "assistant_past" }], "what did you tell me about picking a mattress firmness").length, 0);
});

test("world window: 'a couple of weeks ago' opens about three weeks back", async () => {
  const { worldWindow } = await import("../src/agent/claims.ts");
  assert.equal(worldWindow("a couple of weeks ago", "2026-11-12")!.start, "2026-10-22");
  assert.equal(worldWindow("3 days ago", "2026-11-12")!.start, "2026-11-08");
});

test("admission: what users say about themselves is context, not a premise; their claims about the world still are", () => {
  const msg = "We're a 6-person B2B SaaS startup selling to mid-market companies in Europe. Since Acme acquired Zendo, is Zendo still independent?";
  const got = admitPremises(
    [
      { claim: "The company is a 6-person B2B SaaS startup", attribution: "user" },
      { claim: "The startup sells exclusively to mid-market companies in Europe", attribution: "user" },
      { claim: "Acme acquired Zendo", attribution: "presupposed" },
    ],
    msg,
  );
  assert.deepEqual(got.map((p) => p.claim), ["Acme acquired Zendo"]);
  // A user-stated world claim (not about themselves) is still checked.
  assert.equal(admitPremises([{ claim: "Acme acquired Zendo last month", attribution: "user" }], "Acme acquired Zendo last month, what changed?").length, 1);
});
