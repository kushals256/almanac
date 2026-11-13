import { test } from "node:test";
import assert from "node:assert/strict";
import { ev, harness, plan } from "./helpers/harness.ts";
import { NO_WEB_NOTE } from "../src/agent/turn.ts";

const NEON = ev("https://neon.tech/pricing", "Neon pricing", "Launch plan: $19 per month. Scale plan: $69 per month.", "2026-11-01T00:00:00Z");
const SUPA = ev("https://supabase.com/pricing", "Supabase pricing", "Pro plan: $25 per month per project.", "2026-11-01T00:00:00Z");

test("turn: a world question searches, streams a cited answer, stores it complete with its numbered sources", async () => {
  const h = harness({ plan: () => plan("quick", { entities: ["Neon"] }), search: () => [NEON], answer: () => "Neon Launch is $19 per month [1]." });
  const r = await h.turn("What does Neon Launch cost?");
  assert.equal(r.done.route, "quick");
  assert.ok(h.calls.searches.length >= 1);
  assert.equal(r.text, "Neon Launch is $19 per month [1].");
  const q = h.store.db.prepare("SELECT id, status FROM turns WHERE role = 'user'").get() as { id: number; status: string };
  assert.equal(q.status, "complete");
  assert.equal(h.store.hitForTurn(q.id)!.sources[0]!.url, NEON.url);
});

test("turn: 'in two lines' about the previous reply answers from that reply's own sources — no new search", async () => {
  const h = harness({
    plan: (m) => (/two lines/.test(m) ? plan("quick", {}, { aboutReply: true }) : plan("research", { entities: ["Neon", "Supabase"] })),
    search: () => [NEON, SUPA],
    judge: (id) => (id === "replyOnly" ? 0.92 : 0.2),
    answer: (req) => (/two lines/.test(req.messages.at(-1)!.content) ? "Pick Neon for spiky use [1].\nPick Supabase for bundled auth [2]." : "Neon is $19 [1]; Supabase Pro is $25 [2]."),
  });
  await h.turn("Compare Neon and Supabase pricing for a side project");
  const searchesBefore = h.calls.searches.length;
  const r = await h.turn("Give me your recommendation in two lines.");
  assert.equal(r.done.route, "reply");
  assert.equal(h.calls.searches.length, searchesBefore, "no new search");
  assert.deepEqual(r.sources!.map((s) => s.url), [NEON.url, SUPA.url], "same sources, same numbering");
  assert.match(r.text, /\[1\][\s\S]*\[2\]/);
});

test("turn: when the judge says the follow-up needs new facts, it searches as usual", async () => {
  const h = harness({
    plan: (m) => (/limits/.test(m) ? plan("quick", {}, { aboutReply: true }) : plan("quick", { entities: ["Neon"] })),
    search: () => [NEON],
    judge: (id) => (id === "replyOnly" ? 0.2 : 0.2),
    answer: () => "Answer [1].",
  });
  await h.turn("What does Neon Launch cost?");
  const before = h.calls.searches.length;
  const r = await h.turn("Which of those has the best storage limits?");
  assert.notEqual(r.done.route, "reply");
  assert.ok(h.calls.searches.length > before);
});

test("turn: web needed but no results → the answer opens with a code-written disclosure", async () => {
  const h = harness({ plan: () => plan("quick", { entities: ["Neon"] }), search: () => [], answer: () => "Neon's Launch plan has historically been around $19 per month." });
  const r = await h.turn("What does Neon Launch cost?");
  assert.ok(r.text.startsWith(`_${NO_WEB_NOTE}`), r.text.slice(0, 80));
});

test("turn: a citation to a source that doesn't exist is removed from what's shown and stored", async () => {
  const h = harness({ plan: () => plan("quick", { entities: ["Neon"] }), search: () => [NEON], answer: () => "Neon Launch is $19 per month [1][4]." });
  const r = await h.turn("What does Neon Launch cost?");
  assert.equal(r.text, "Neon Launch is $19 per month [1].");
  assert.ok(r.events.some((e) => e.ev === "replace"));
  const stored = h.store.db.prepare("SELECT content FROM turns WHERE role = 'assistant'").get() as { content: string };
  assert.equal(stored.content, "Neon Launch is $19 per month [1].");
});

test("turn: 'what did I ask on Monday?' with no history is answered honestly in code — no answer model, no search", async () => {
  const h = harness({ plan: () => plan("memory", {}, { pastRef: "date", dateText: "Monday", factual: false }), judge: (id) => (id === "convOnly" ? 0.9 : id === "ref" ? 0.9 : 0.1) });
  const r = await h.turn("What did I ask you on Monday?");
  assert.equal(r.done.route, "memory");
  assert.equal(h.calls.answer, 0);
  assert.equal(h.calls.searches.length, 0);
  assert.match(r.text, /no conversation with you from Mon 9 Nov|start of our conversation history/);
});

test("turn: a re-check whose figure differs, with no sign of a change since, says so — code writes the verdict", async () => {
  const PAGE = "https://acme.example/pricing";
  const h = harness({
    plan: (m) => (/still/.test(m) ? plan("recheck", { entities: ["Acme Pro"] }, { pastRef: "date", wantsRecheck: true }) : plan("quick", { entities: ["Acme Pro"] })),
    search: () => [ev(PAGE, "Acme pricing", "Acme plans and features.")],
    answer: () => "Acme Pro is $19 per month [1].",
    judge: (id) => (/^rel\d/.test(id) ? 0.9 : id === "ref" ? 0.9 : 0.1),
    extractor: (req) => (/re-checkable facts/.test(req.messages[0]!.content) ? JSON.stringify({ claims: [{ line: 1, entity: "Acme Pro", attribute: "monthly price", span: "$19 per month", source: 1 }] }) : "{}"),
    pages: { [PAGE]: "Acme Pro: $25 per month. Billed monthly." },
  });
  await h.turn("What does Acme Pro cost?", "s1", "2026-11-10T06:00:00Z");
  const r = await h.turn("Is the Acme price you told me on Tuesday still right?", "s2", "2026-11-12T06:00:00Z");
  assert.equal(r.done.route, "recheck");
  assert.match(r.text, /\*\*0 of 1 figure changed since Tue 10 Nov; 1 differs from what I told you/);
  assert.match(r.text, /\| Differs from my earlier answer \(\+32%\) \|/);
  assert.doesNotMatch(r.text, /\| Changed/);
});

test("turn: a sourced comparison is recorded as a shortlist; a stated decision is recorded against it and told to later turns", async () => {
  let lastInput = "";
  const h = harness({
    plan: (m) => (/went with/.test(m) ? plan("chat") : plan("research", { entities: ["Neon", "Supabase"] })),
    search: () => [NEON, SUPA],
    answer: (req) => ((lastInput = req.messages.at(-1)!.content), "Neon is $19 [1]; Supabase Pro is $25 [2]."),
    extractor: (req) => (/decisions/.test(req.messages[0]!.content) ? JSON.stringify({ decisions: [{ shortlist: 1, item: "Supabase", status: "ruled_out", reason: "we don't need auth" }] }) : '{"claims":[]}'),
  });
  await h.turn("Compare Neon and Supabase pricing");
  const q = h.store.db.prepare("SELECT id FROM turns WHERE role = 'user' ORDER BY id LIMIT 1").get() as { id: number };
  assert.deepEqual(h.store.collectionItems(q.id), ["Neon", "Supabase"]);
  await h.turn("We went with Neon, Supabase is out since we don't need auth.");
  await new Promise((r) => setTimeout(r, 50)); // the decision is recorded in the background
  assert.equal(h.store.recentShortlists("local", "2026-11-01")[0]!.items.find((i) => i.name === "Supabase")!.status, "ruled_out");
  await h.turn("Compare Neon and Supabase storage limits");
  assert.match(lastInput, /DECISIONS THE USER MADE EARLIER[\s\S]*ruled out Supabase \(we don't need auth\)/);
});

test("turn: a summary of the whole chat ('in two lines') can cite earlier replies' sources too; the latest reply keeps its numbering", async () => {
  const PHONE_A = ev("https://store.example/pixel", "Pixel 10a", "Pixel 10a costs $499.", "2026-11-10T00:00:00Z");
  const PHONE_B = ev("https://store.example/galaxy", "Galaxy A57", "Galaxy A57 battery: 5,000 mAh.", "2026-11-10T00:00:00Z");
  const h = harness({
    plan: (m) => (/two lines/.test(m) ? plan("quick", {}, { aboutReply: true }) : /battery/.test(m) ? plan("quick", { entities: ["Galaxy A57"], queries: [{ q: "Galaxy A57 battery", objective: "battery" }] }) : plan("quick", { entities: ["Pixel"], queries: [{ q: "Pixel 10a price", objective: "price" }] })),
    search: (job) => (/battery/i.test(job.query) ? [PHONE_B] : [PHONE_A]),
    judge: (id) => (id === "replyOnly" ? 0.9 : 0.2),
    answer: () => "Answer [1].",
  });
  await h.turn("What does the Pixel 10a cost?");
  h.calls.searches.length = 0;
  await h.turn("And battery life of the Galaxy A57?", "s1");
  const r = await h.turn("Okay, give me your recommendation in two lines.", "s1");
  assert.equal(r.done.route, "reply");
  assert.deepEqual(r.sources!.map((s) => s.url), [PHONE_B.url, PHONE_A.url]);
});

test("turn: a re-check shows the code-written 'On … you asked' line first — before any model call — and only once when it falls through", async () => {
  const order: string[] = [];
  const h = harness({
    plan: (m) => (/still/.test(m) ? plan("recheck", { entities: ["Acme CEO"] }, { pastRef: "date", wantsRecheck: true }) : plan("quick", { entities: ["Acme"] })),
    search: () => [ev("https://acme.example/about", "About Acme", "Jane Roe is the CEO of Acme.")],
    answer: (req) => (/still/.test(req.messages.at(-1)!.content) ? "Jane Roe is still the CEO [1]." : "Acme's CEO is Jane Roe [1]."),
    judge: (id) => (/^rel\d/.test(id) ? 0.9 : id === "ref" ? 0.9 : 0.1),
    extractor: () => ((order.push("extractor"), '{"claims":[]}')), // no typed figure → the recheck falls through
  });
  await h.turn("Who is the CEO of Acme?", "s1", "2026-11-10T06:00:00Z");
  const r = await h.turn("Is the Acme CEO you told me about on Tuesday still right?", "s2", "2026-11-12T06:00:00Z");
  const tokens = r.events.filter((e) => e.ev === "token").map((e) => e.data.text as string);
  assert.match(tokens[0]!, /^On Tue 10 Nov you asked: “Who is the CEO of Acme\?”/);
  assert.equal(r.text.match(/you asked:/g)?.length, 1, "the line is shown once");
  assert.match(r.text, /still the CEO \[1\]/);
});

test("turn: 'remind me what I asked about on Monday' WITH history answers from the record — no search, even if the planner calls it factual", async () => {
  for (const factual of [false, true]) {
    const h = harness({
      plan: (m) => (/remind me/.test(m) ? plan(factual ? "quick" : "memory", { entities: [] }, { pastRef: "date", dateText: "Monday", factual }) : plan("quick", { entities: ["Notion"] })),
      search: () => [ev("https://notion.so/pricing", "Notion pricing", "Plus is $10 per seat per month.")],
      answer: (req) => (/remind me/.test(req.messages.at(-1)!.content) ? "You asked what Notion Plus costs; I said $10 per seat per month." : "Notion Plus is $10 per seat per month [1]."),
      judge: (id) => (/^rel\d/.test(id) ? 0.9 : id === "ref" ? 0.95 : id === "convOnly" ? 0.92 : 0.05),
    });
    await h.turn("What does Notion Plus cost?", "s1", "2026-11-09T06:00:00Z");
    h.calls.searches.length = 0;
    const r = await h.turn("Remind me what I asked you about on Monday.", "s2", "2026-11-12T06:00:00Z");
    assert.equal(h.calls.searches.length, 0, `no search (planner factual=${factual})`);
    assert.equal(r.done.route, "memory");
    assert.match(r.text, /^On Mon 9 Nov you asked: “What does Notion Plus cost\?”/);
  }
});
