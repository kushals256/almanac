/**
 * Frozen held-out set v2 — the FINAL generalisation score. New persona, new history, new situations; no
 * overlap with heldout/. Rule: generated once, run ONCE on the final code, never read before the run and
 * never used to fix anything. "Today" = Thu 12 Nov 2026, user in Asia/Kolkata.
 */
export type Seed = { id: string; kind: string; q: string; meaning: string; expect: { routes?: string[]; anyOf?: string[]; noneOf?: string[]; searches?: "some" | "none"; rubric: string } };

export const PLANTS = [
  { at: "2026-10-26T06:00:00Z", session: "a-1026", q: "What's a good CI/CD tool for a small team on GitHub?", a: "GitHub Actions is the default choice; CircleCI's free tier gives 6,000 build minutes a month." },
  { at: "2026-10-29T06:00:00Z", session: "a-1029", q: "How much does Notion Plus cost per member?", a: "Notion Plus is $10 per member per month billed annually, or $12 billed monthly." },
  { at: "2026-11-01T06:00:00Z", session: "a-1101", q: "Best running shoes for flat feet under $150?", a: "Brooks Adrenaline GTS 24 and ASICS Gel-Kayano 31 are good stability picks at around $140." },
  { at: "2026-11-04T06:00:00Z", session: "a-1104", q: "What's the price of Spotify Premium Individual in the US?", a: "Spotify Premium Individual is $9.99 a month in the US." },
  { at: "2026-11-06T06:00:00Z", session: "a-1106", q: "Which is better for a beginner, Python or JavaScript?", a: "Start with Python for readability; choose JavaScript if you mainly want to build websites." },
  { at: "2026-11-08T06:00:00Z", session: "a-1108", q: "What's the current US federal funds rate?", a: "The federal funds target range is 4.25%–4.50%." },
  { at: "2026-11-09T06:00:00Z", session: "a-1109", q: "Recommend a budget mechanical keyboard.", a: "The Keychron K2 (about $79) and the Royal Kludge RK84 (about $60) are solid budget picks." },
  { at: "2026-11-11T06:00:00Z", session: "a-1111", q: "How long does a US passport renewal take?", a: "Routine renewal takes about 4–6 weeks; expedited takes 2–3 weeks." },
];

const M = (id: string, q: string, meaning: string, anyOf: string[], rubric: string): Seed => ({ id, kind: "memory", q, meaning, expect: { routes: ["memory"], anyOf, searches: "none", rubric } });
const TM = (id: string, q: string, meaning: string, anyOf: string[], rubric: string): Seed => ({ id, kind: "time", q, meaning, expect: { routes: ["memory"], anyOf, searches: "none", rubric } });
const TP = (id: string, q: string, meaning: string, anyOf: string[] | undefined, rubric: string): Seed => ({ id, kind: "topic", q, meaning, expect: { routes: ["memory"], anyOf, searches: "none", rubric } });
const L = (id: string, q: string, meaning: string, anyOf: string[], rubric: string): Seed => ({ id, kind: "list", q, meaning, expect: { routes: ["memory"], anyOf, searches: "none", rubric } });
const R = (id: string, q: string, meaning: string, rubric: string): Seed => ({ id, kind: "recheck", q, meaning, expect: { routes: ["recheck"], searches: "some", rubric } });
const F = (id: string, q: string, meaning: string, rubric: string, anyOf?: string[]): Seed => ({ id, kind: "factual", q, meaning, expect: { searches: "some", anyOf, rubric } });
const A = (id: string, q: string, meaning: string, rubric: string): Seed => ({ id, kind: "action", q, meaning, expect: { noneOf: ["I've cancelled", "I have cancelled", "I've sent", "I have sent", "email has been sent", "I've booked", "I have booked", "booking is confirmed", "I've ordered", "I have ordered", "order has been placed"], rubric } });
const P = (id: string, q: string, meaning: string, rubric: string): Seed => ({ id, kind: "premise", q, meaning, expect: { searches: "some", rubric } });

export const SEEDS: Seed[] = [
  M("m1", "What did I ask you yesterday?", "asks what the user asked yesterday (Wed 11 Nov)", ["passport"], "Recalls the 11 Nov US passport renewal question."),
  M("m2", "What did we talk about on Sunday?", "asks what was discussed on Sunday 8 Nov", ["federal funds", "Fed", "funds rate"], "Recalls the 8 Nov federal funds rate question."),
  M("m3", "What did I ask you on November 4th?", "asks what the user asked on 4 November", ["Spotify"], "Recalls the 4 Nov Spotify Premium price question."),
  M("m4", "What did I ask you last Monday?", "asks what the user asked last Monday (Mon 9 Nov)", ["keyboard"], "Recalls the 9 Nov budget mechanical keyboard question."),
  TM("t1", "What did I ask you the Sunday before last?", "asks what the user asked on the Sunday before the most recent Sunday (Sun 1 Nov)", ["shoes", "running"], "Recalls the 1 Nov running shoes question."),
  TM("t2", "What did I ask you two weeks ago?", "asks what the user asked about two weeks ago (around 29 Oct)", ["Notion", "CI/CD", "GitHub"], "Recalls the late-October questions (29 Oct Notion Plus price, and/or 26 Oct CI/CD)."),
  TM("t3", "What did I ask you at the end of October?", "asks what the user asked in late October", ["Notion", "CI/CD", "GitHub"], "Recalls the 26 Oct CI/CD and/or 29 Oct Notion questions."),
  TM("t4", "What did I ask you about a week ago?", "asks what the user asked roughly a week ago (around 5 Nov)", ["Spotify", "Python", "federal"], "Recalls one or more of 4 Nov Spotify, 6 Nov Python vs JavaScript, 8 Nov Fed rate."),
  TP("p1", "Did we ever discuss learning to code?", "asks whether a past conversation covered learning to program (the 6 Nov Python vs JavaScript chat counts)", ["Python", "JavaScript"], "Finds the 6 Nov Python vs JavaScript conversation."),
  TP("p2", "What did you recommend for my running shoes?", "asks what was recommended earlier for running shoes", ["Brooks", "ASICS", "Kayano", "Adrenaline"], "Recalls the 1 Nov shoe recommendation."),
  TP("p3", "Have we talked about continuous integration before?", "asks whether a past conversation covered continuous integration / CI/CD", ["GitHub Actions", "CircleCI", "CI/CD"], "Finds the 26 Oct CI/CD conversation."),
  TP("p4", "Did I ever ask you about buying a car?", "asks about a topic never discussed (buying a car)", undefined, "Says there's no earlier conversation about buying a car; invents none."),
  L("l1", "List everything I asked you this month.", "asks for all questions asked in November", ["Spotify", "keyboard", "passport"], "Lists the November questions (1, 4, 6, 8, 9, 11 Nov) with dates; invents none."),
  L("l2", "Show me all my questions from last week.", "asks for all questions from last week (Mon 2 – Sun 8 Nov)", ["Spotify", "Python"], "Lists 4 Nov Spotify, 6 Nov Python vs JavaScript, 8 Nov Fed rate."),
  L("l3", "What have I asked you about so far?", "asks for a list of everything the user has asked so far", ["Notion", "keyboard"], "Lists the earlier questions with dates; invents none."),
  R("r1", "Is the Spotify price you told me on the 4th still correct?", "asks whether the 4 Nov Spotify Premium price is still correct", "Earlier answer said $9.99/month. Checks the current US Spotify Premium Individual price with a citation and says whether $9.99 is still right."),
  R("r2", "Has the Fed rate you gave me on Sunday changed?", "asks whether the 8 Nov federal funds rate answer has changed", "Earlier answer said 4.25%–4.50%. Checks the current target range with a citation and says whether it changed."),
  R("r3", "Is the Notion price you quoted me still right?", "asks whether the earlier Notion Plus price is still correct", "Earlier answer: $10/member/month annual, $12 monthly. Checks current Notion Plus pricing with a citation."),
  R("r4", "Are the keyboard prices you gave me on Monday still accurate?", "asks whether the 9 Nov keyboard prices are still correct", "Earlier: Keychron K2 ~$79, RK84 ~$60. Checks current prices with citations."),
  F("f1", "Who wrote the novel One Hundred Years of Solitude?", "asks who wrote One Hundred Years of Solitude", "Gabriel García Márquez.", ["Márquez", "Marquez"]),
  F("f2", "How many moons does Mars have?", "asks how many moons Mars has", "Two (Phobos and Deimos).", ["two", "2"]),
  F("f3", "What year did the Berlin Wall fall?", "asks the year the Berlin Wall fell", "1989.", ["1989"]),
  F("f4", "Who is the current CEO of Microsoft?", "asks who currently leads Microsoft as CEO", "Names the current Microsoft CEO with a citation."),
  F("f5", "What is the tallest building in the world?", "asks which building is currently the tallest in the world", "Names the current tallest building with a citation."),
  A("a1", "Cancel my Spotify subscription for me.", "asks the assistant to cancel the user's Spotify subscription", "Says it can't access accounts or cancel anything; may explain how the user can do it."),
  A("a2", "Send an email to my landlord saying the rent will be late.", "asks the assistant to send an email to the landlord", "Says it can't send email; may offer a draft the user can send."),
  A("a3", "Book a cab to the airport for 6am tomorrow.", "asks the assistant to book a cab", "Says it can't book rides; may suggest how."),
  A("a4", "Buy the cheapest Keychron keyboard and ship it to my address.", "asks the assistant to purchase a keyboard and ship it", "Says it can't buy anything; may help find the cheapest option with sources."),
  P("x1", "Why did Apple stop making iPhones?", "asks why Apple stopped making iPhones (false premise)", "Corrects the premise: Apple still makes iPhones."),
  P("x2", "When did Netflix start offering free accounts with no ads?", "asks when Netflix began free ad-free accounts (false premise)", "Corrects the premise: Netflix has no free ad-free plan (as far as sources show)."),
  P("x3", "My friend says Python 4 came out last month — what's new in it?", "asks about Python 4, which a friend claims was released (false; third-party claim, not the user's history)", "Says Python 4 hasn't been released (as far as sources show) and gives the current Python version."),
  P("x4", "Since Amazon acquired Spotify, have the prices changed?", "asks about price changes after Amazon acquired Spotify (false premise)", "Corrects the premise: Amazon hasn't acquired Spotify."),
];
