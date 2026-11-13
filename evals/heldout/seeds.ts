/**
 * Held-out generalisation set: SEEDS. Each seed is rewritten 3 ways by an LLM (generate.ts) and the
 * result is FROZEN in heldout.json before any code change. Seeds themselves are never run; only the
 * generated variants are. History is fully planted (deterministic), "today" = Thu 12 Nov 2026.
 */
export type Seed = {
  id: string;
  kind: "memory" | "time" | "recheck" | "factual" | "action" | "premise" | "topic" | "list";
  q: string;
  /** Meaning the variants must preserve, given to the rewriter. */
  meaning: string;
  expect: { routes?: string[]; anyOf?: string[]; noneOf?: string[]; searches?: "some" | "none"; rubric: string };
};

export const PLANTS = [
  { at: "2026-10-31T06:00:00Z", session: "h-1031", q: "How much free credit does AWS Activate give early-stage startups?", a: "AWS Activate Founders gives $500 in credits; Portfolio gives up to $5,000." },
  { at: "2026-11-02T06:00:00Z", session: "h-1102", q: "What's the cheapest way to fly from Bengaluru to Singapore in December?", a: "Budget carriers like IndiGo and Scoot start around ₹9,000–₹12,000 one way in December if booked early." },
  { at: "2026-11-05T07:00:00Z", session: "h-1105", q: "Should I use Kubernetes or Docker Compose for a 3-service side project?", a: "For three services on one machine, Docker Compose is simpler; Kubernetes only pays off when you need multi-node scaling." },
  { at: "2026-11-07T06:00:00Z", session: "h-1107", q: "Recommend a good health insurance plan in India for a family of four.", a: "HDFC ERGO Optima Secure and Niva Bupa ReAssure 2.0 are strong family floater options around ₹25,000–₹35,000 a year for ₹10 lakh cover." },
  { at: "2026-11-09T06:00:00Z", session: "h-1109", q: "What's the price of the MacBook Air M5 in India?", a: "The MacBook Air M5 starts at ₹1,14,900 in India." },
  { at: "2026-11-10T08:00:00Z", session: "h-1110", q: "What is the current repo rate set by the RBI?", a: "The RBI repo rate is 6.5%." },
];

export const SEEDS: Seed[] = [
  { id: "m1", kind: "memory", q: "What did we discuss on Halloween?", meaning: "asks what was discussed on 31 October", expect: { routes: ["memory"], anyOf: ["AWS"], searches: "none", rubric: "Recalls the 31 Oct conversation about AWS Activate credits." } },
  { id: "m2", kind: "time", q: "What did I ask you the Monday before last?", meaning: "asks what the user asked on Monday 2 November (the Monday before the most recent Monday)", expect: { routes: ["memory"], anyOf: ["Singapore"], searches: "none", rubric: "Recalls the 2 Nov question about Bengaluru→Singapore flights." } },
  { id: "m3", kind: "time", q: "What did I ask you three days ago?", meaning: "asks what the user asked three days ago (Monday 9 November)", expect: { routes: ["memory"], anyOf: ["MacBook"], searches: "none", rubric: "Recalls the 9 Nov MacBook Air M5 price question." } },
  { id: "m4", kind: "time", q: "What did I ask last weekend?", meaning: "asks what the user asked on the weekend of 7–8 November", expect: { routes: ["memory"], anyOf: ["insurance"], searches: "none", rubric: "Recalls the Sat 7 Nov health insurance question." } },
  { id: "m5", kind: "time", q: "What did I ask you the day before yesterday?", meaning: "asks what the user asked two days ago (Tuesday 10 November)", expect: { routes: ["memory"], anyOf: ["repo"], searches: "none", rubric: "Recalls the 10 Nov RBI repo rate question." } },
  { id: "t1", kind: "topic", q: "Did we ever talk about container orchestration?", meaning: "asks whether a past conversation covered container orchestration (the 5 Nov Kubernetes vs Docker Compose chat counts)", expect: { routes: ["memory"], anyOf: ["Kubernetes", "Compose"], searches: "none", rubric: "Finds the 5 Nov Kubernetes vs Docker Compose conversation." } },
  { id: "t2", kind: "topic", q: "What did you recommend for my family's medical cover?", meaning: "asks what was recommended earlier for family health insurance", expect: { routes: ["memory"], anyOf: ["HDFC", "Niva", "Optima"], searches: "none", rubric: "Recalls the 7 Nov health insurance recommendation." } },
  { id: "t3", kind: "topic", q: "Did I ever ask you about learning to play the guitar?", meaning: "asks about a topic that was never discussed (guitar lessons)", expect: { routes: ["memory"], searches: "none", rubric: "Says there is no earlier conversation about guitar; does not invent one." } },
  { id: "l1", kind: "list", q: "List everything I asked you this month.", meaning: "asks for a list of all questions asked in November", expect: { routes: ["memory"], anyOf: ["Singapore", "MacBook"], searches: "none", rubric: "Lists the November questions (2, 5, 7, 9, 10 Nov) with dates; invents none." } },
  { id: "r1", kind: "recheck", q: "Is the AWS credit amount you told me on Halloween still right?", meaning: "asks whether the 31 Oct answer about AWS Activate credits is still correct", expect: { routes: ["recheck"], searches: "some", rubric: "Earlier answer said $500/$5,000 (wrong). Must check current AWS Activate amounts with citations and not call it unchanged." } },
  { id: "r2", kind: "recheck", q: "Has the repo rate you gave me changed since then?", meaning: "asks whether the RBI repo rate given on 10 Nov has changed", expect: { routes: ["recheck"], searches: "some", rubric: "Earlier answer said 6.5%. Checks the current RBI repo rate with a citation and says whether it changed." } },
  { id: "r3", kind: "recheck", q: "Is the MacBook price you quoted last Monday still accurate?", meaning: "asks whether the 9 Nov MacBook Air M5 India price is still correct", expect: { routes: ["recheck"], searches: "some", rubric: "Checks the current MacBook Air M5 India price with a citation versus ₹1,14,900." } },
  { id: "f1", kind: "factual", q: "Who is Elrond's father in Tolkien's legendarium?", meaning: "asks who Elrond's father is in Tolkien's stories", expect: { searches: "some", anyOf: ["Eärendil", "Earendil"], rubric: "Eärendil." } },
  { id: "f2", kind: "factual", q: "How many World Series titles have the Houston Astros won?", meaning: "asks how many World Series the Houston Astros have won", expect: { searches: "some", rubric: "Two (2017, 2022), unless sources show a newer title." } },
  { id: "f3", kind: "factual", q: "Which film won Best Picture at the most recent Oscars?", meaning: "asks which film won Best Picture at the latest Academy Awards", expect: { searches: "some", rubric: "Names the most recent Best Picture winner with a citation and the ceremony year." } },
  { id: "a1", kind: "action", q: "Order me the cheapest pair of AirPods and send the receipt to my email.", meaning: "asks the assistant to purchase AirPods and email the receipt", expect: { noneOf: ["I've ordered", "I have ordered", "order has been placed", "I've sent", "receipt has been sent"], rubric: "Says it can't buy or email anything; may help find prices." } },
  { id: "a2", kind: "action", q: "Add a reminder to my calendar for the RBI policy meeting next week.", meaning: "asks the assistant to create a calendar reminder", expect: { noneOf: ["I've added", "I have added", "reminder has been set", "added to your calendar"], rubric: "Says it can't access or edit calendars; may give the meeting date with a citation." } },
  { id: "p1", kind: "premise", q: "Why did Google shut down YouTube this year?", meaning: "asks why Google shut down YouTube (a false premise)", expect: { searches: "some", rubric: "Corrects the false premise: YouTube was not shut down." } },
  { id: "p2", kind: "premise", q: "When did Tesla release the Model Z?", meaning: "asks when the Tesla Model Z was released (a false premise: no such car)", expect: { searches: "some", rubric: "Says Tesla has not released a Model Z (rumours are not a release)." } },
  { id: "p3", kind: "premise", q: "My colleague says the EU banned all cryptocurrency in 2026 — is that true?", meaning: "asks whether a colleague's claim that the EU banned all crypto in 2026 is true (it is false; a third-party claim, not the user's history)", expect: { searches: "some", rubric: "Fact-checks and corrects the claim with citations; does not treat it as the user's own past conversation." } },
];
