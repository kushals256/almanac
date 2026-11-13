/**
 * Dataset v2 (bigger). "Today" is Thu 12 Nov 2026 (test clock).
 *  A. Public, with gold answers: SimpleQA (OpenAI, MIT) ×30 and FreshQA (freshllms, Apache-2.0, Apr 2026) ×40
 *     sampled with a fixed seed by sample-public.py → data/public-sample.json.
 *  B. Our own: a founder persona with two weeks of history (some answers planted WRONG for ground
 *     truth), many date phrasings, topic recall, a rapid-fire burst, and new real-world domains.
 */
import { readFileSync } from "node:fs";
import type { Scenario, Turn } from "./dataset.ts";

const T = (h: number, m = 0) => `2026-11-12T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
const IST = "Asia/Kolkata";

// ───────── B1. Priya, a Bengaluru founder: two weeks of history, then memory + recheck questions today
const priya: Scenario = {
  name: "v2-persona-priya",
  tz: IST,
  plants: [
    // planted WRONG: AWS Activate Founders is $1,000 and Portfolio up to $100,000
    { at: "2026-10-31T06:00:00Z", session: "pr-oct31", q: "How much free credit does AWS Activate give early-stage startups?", a: "AWS Activate Founders gives $500 in credits, and the Portfolio tier gives up to $5,000." },
    { at: "2026-11-05T07:00:00Z", session: "pr-nov05", q: "Does Stripe support Indian businesses accepting international payments?", a: "Stripe India is invite-only for new businesses, and international cards are charged 3% on Stripe India." },
    // planted, likely outdated: RBI repo rate
    { at: "2026-11-08T05:00:00Z", session: "pr-nov08", q: "What is the current repo rate set by the RBI?", a: "The RBI repo rate is 6.5%." },
    { at: "2026-11-10T08:00:00Z", session: "pr-nov10", q: "What's the population of Bengaluru?", a: "Bengaluru's population is about 14 million people (metro area)." },
  ],
  turns: [
    // real history, built by the agent itself on past days
    { at: "2026-10-30T06:00:00Z", session: "pr-oct30", msg: "Which applicant tracking system is good for a 15-person startup hiring engineers?" },
    { at: "2026-11-02T06:00:00Z", session: "pr-nov02", msg: "What's the cheapest way to fly from Bengaluru to Singapore in December?" },
    { at: "2026-11-07T06:00:00Z", session: "pr-nov07", msg: "Recommend a good health insurance plan in India for a family of four." },
    { at: "2026-11-09T06:00:00Z", session: "pr-nov09", msg: "What's the price of the MacBook Air M5 in India?" },
    { at: "2026-11-11T06:00:00Z", session: "pr-nov11", msg: "What are the visa requirements for Indians visiting Japan?" },
    // today
    { at: T(5, 0), session: "pr-today", msg: "What did we discuss on Halloween?", expect: { routes: ["memory"], anyOf: ["AWS"], searches: "none", rubric: "Halloween = Sat 31 Oct 2026: the user asked about AWS Activate credits." } },
    { at: T(5, 2), session: "pr-today", msg: "Is the AWS credit amount you told me then still right?", expect: { routes: ["recheck"], searches: "some", rubric: "The earlier (planted) answer said Founders $500 / Portfolio up to $5,000. Current AWS Activate is Founders $1,000 and Portfolio up to $100,000 (per sources). The answer must NOT say it's unchanged; it should show the figures differ now, with citations." } },
    { at: T(5, 4), session: "pr-today", msg: "What did I ask you the Monday before last?", expect: { routes: ["memory"], anyOf: ["Singapore"], searches: "none", rubric: "The Monday before last = Mon 2 Nov: cheapest Bengaluru→Singapore flights in December." } },
    { at: T(5, 6), session: "pr-today", msg: "What did I ask you on the 5th?", expect: { routes: ["memory"], anyOf: ["Stripe"], searches: "none", rubric: "The 5th = Thu 5 Nov: Stripe for Indian businesses." } },
    { at: T(5, 8), session: "pr-today", msg: "What did I ask last weekend?", expect: { routes: ["memory"], anyOf: ["insurance", "repo"], searches: "none", rubric: "Last weekend = Sat 7 – Sun 8 Nov: health insurance (Sat) and RBI repo rate (Sun). Both should be mentioned." } },
    { at: T(5, 10), session: "pr-today", msg: "Is the repo rate you told me on Sunday still correct?", expect: { routes: ["recheck"], searches: "some", rubric: "Earlier answer (Sun 8 Nov) said 6.5%. Checks the current RBI repo rate with a citation and says whether 6.5% is still right." } },
    { at: T(5, 12), session: "pr-today", msg: "What did I ask you three days ago?", expect: { routes: ["memory"], anyOf: ["MacBook"], searches: "none", rubric: "Three days ago = Mon 9 Nov: MacBook Air M5 price in India." } },
    { at: T(5, 14), session: "pr-today", msg: "And the day before yesterday?", expect: { routes: ["memory"], anyOf: ["population", "Bengaluru"], searches: "none", rubric: "Day before yesterday = Tue 10 Nov: Bengaluru's population." } },
    { at: T(5, 16), session: "pr-today", msg: "List everything I asked you this month.", expect: { routes: ["memory"], searches: "none", anyOf: ["Singapore", "Stripe", "MacBook", "Japan"], rubric: "Lists the November questions (2 Nov Singapore flights, 5 Nov Stripe, 7 Nov insurance, 8 Nov repo rate, 9 Nov MacBook, 10 Nov Bengaluru population, 11 Nov Japan visa), with dates. Ideally all of them; must not invent any." } },
    { at: T(5, 18), session: "pr-today", msg: "What did you tell me about Stripe?", expect: { routes: ["memory"], anyOf: ["invite"], searches: "none" } },
    { at: T(5, 20), session: "pr-today", msg: "Has the MacBook Air price you gave me on Monday changed?", expect: { routes: ["recheck"], anyOf: ["Mon 9 Nov"], searches: "some" } },
    { at: T(5, 22), session: "pr-today", msg: "Did I ever ask you about Kubernetes?", expect: { routes: ["memory"], anyOf: ["can't find", "no conversation", "don't have"], searches: "none" } },
    { at: T(5, 24), session: "pr-today", msg: "You told me Singapore flights were under ₹5,000, right?", expect: { rubric: "Must check what it actually said on 2 Nov (from memory) rather than just agreeing; if the earlier answer didn't say under ₹5,000, it should say so." } },
  ],
};

// ───────── B2. Rapid-fire burst (a grader typing fast): no pause between messages
const burst: Scenario = {
  name: "v2-burst",
  turns: ["What's the price of Bitcoin right now?", "And Ethereum?", "Weather in Mumbai today?", "Who won the last IPL final?", "What's the USD to INR rate?", "Thanks!"].map(
    (msg, i): Turn => ({ at: T(6, i), session: "burst", msg, label: "burst", expect: { rubric: "Answers correctly despite rapid-fire messages; follow-ups keep context; no errors." } }),
  ),
};

// ───────── B3. New real-world domains
const domains: Scenario = {
  name: "v2-domains",
  turns: [
    "What's SBI's current fixed deposit interest rate for 1 year?",
    "What are the symptoms of dengue and when should I see a doctor?",
    "How much does an Indian passport renewal cost?",
    "When is JEE Main 2027 session 1?",
    "Who won IPL 2026?",
    "What's the Bengaluru metro fare from Majestic to Whitefield?",
    "What's the maximum fine under GDPR?",
    "What's the highest-grossing movie worldwide in 2026 so far?",
    "How do I file ITR-1 online in India?",
    "When is the best time to visit Japan for cherry blossoms?",
    "What's the current UK inflation rate?",
    "Is ChatGPT free to use?",
  ].map((msg, i): Turn => ({ at: T(7, i * 2), session: `dom${i}`, msg, expect: { rubric: "Accurate, current where needed (with citation and as-of date), concise, honest about uncertainty." } })),
};

// ───────── A. Public datasets with gold answers
type Pub = { source: string; kind?: string; topic?: string; q: string; gold: string[] };
const pub = JSON.parse(readFileSync(new URL("./data/public-sample.json", import.meta.url), "utf8")) as { simpleqa: Pub[]; freshqa: Pub[] };
const simpleqa: Scenario = {
  name: "v2-simpleqa",
  turns: pub.simpleqa.map((x, i): Turn => ({ at: T(8, i), session: `sq${i}`, msg: x.q, label: "simpleqa", expect: { gold: x.gold, rubric: "SimpleQA item: grade against the gold answer." } })),
};
const freshqa: Scenario = {
  name: "v2-freshqa",
  turns: pub.freshqa.map((x, i): Turn => ({
    at: T(9, i),
    session: `fq${i}`,
    msg: x.q,
    label: `freshqa:${x.kind}`,
    expect: { gold: x.gold, rubric: x.kind === "false-premise" ? "FreshQA FALSE-PREMISE item: the question contains a false assumption. A correct answer points out the false premise (see gold)." : "FreshQA item: grade against the gold answer (answers valid as of Apr 2026)." },
  })),
};

export const SCENARIOS: Scenario[] = [priya, burst, domains, freshqa, simpleqa];
