# Final plan

## Status (13 Nov)

Done, each with tests (170 offline tests pass; typecheck now covers src, test, scripts and evals):

- **Phase 1:**
  - Changed / Differs / Not comparable decided in code.
  - Comparator fixes ($10.19, month↔year, €1.299,00, $0.001).
  - The review bugs: topicOf dates, "We shortlisted…" premises, proper-noun casing, quoted foreign titles, value claims shown as flagged, owner filter on session recall, the no-web disclosure, history reload citations.
  - Unbacked [n] and links removed.
  - Expected values stripped from recheck queries.
  - Old articles never used as "now".
- **Phase 2:**
  - Timestamped history replay.
  - The reply route (checked live).
  - The user's format wins.
  - Clarifying replies.
  - The wrong-date line.
  - Shortlists and decisions as data.
- **Phase 3:** hedged planner and recheck calls, with whole-call caps.
- **Phase 4:**
  - Relative-date demo history from real recorded answers, with a button and prompt chips.
  - "How I answered" panel.
  - Date chip.
- **Phase 5:**
  - pipeline.ts split into stages.
  - Layer test.
  - Brief-scenario examples removed from prompts.
  - URL helpers moved to util.
  - Dead code removed.
- **Phase 6:**
  - Whole-turn tests with fakes.
  - Search record/replay (`SEARCH_TAPE`).

Checked and left out, because they add code without adding behaviour:

- **Mark pending turns "interrupted" at startup.** Recall and history already show only completed turns, and answers are stored only when complete.
- **Persist model skip-times across restarts.** The first call after a restart fails fast with a 429, then the model is skipped. It isn't worth a table and a migration.
- **Hash the cited span to skip the comparison call.** Quote survival already does this, and more precisely.
- **Run the news search alongside page re-reads.** Already parallel.
- **One per-turn budget with an answer reserve.** Already in place: route deadlines, retrieval stops 4 s early, and the recheck budget counts from the start of the turn.
- **"Pretend today is" clock.** Relative re-dating of the demo makes it unnecessary.
- **Quote deep links (`#:~:text=`).** Our evidence is search snippets, not word-for-word page text, so the links would often highlight nothing.
- **Multi-target recheck** (a separate "then" date per claim). Rare. A hasty version would bring back the "since 26 Oct" bug. Every product in the target answer is already listed.

Still open:

- **6.3 ablation table.** Each arm is a full run on Groq quota; search can now be replayed for free.
- **6.4 one fresh frozen set.** Needs your go-ahead, since you stopped it earlier.
- README / DESIGN.md.
- Key rotation.

Goal: the most correct agent of the set, as fast as the fastest, the best to talk to, and a design a reviewer can see.

Rules for every change:
- A general rule plus a unit test. No tuning against eval cases.
- Check each change carefully before starting the next.
- Phases 1–2 matter most. If time runs short, Phases 5–6 shrink, not 1–2.

Inputs: our own reviews (deep review 7.5/10, external reviews 75 and 78/100) and a read-only study of 23 competitor repos, out of 119 cloned and 100+ researched.

---

## Phase 1: Get things right (correctness)

### 1.1 Separate "Changed" from "my earlier answer was wrong"
Files: `src/recheck/values.ts`, `src/recheck/v2.ts`.
Comes from: HUN-sp (differs), GAURAV (Corrected), Suraj (timing-aware statuses), FrustratedBoy420 (not comparable). adiikj's own grader failed answers on exactly this.

| Verdict | When (decided in code) |
|---|---|
| Changed | One of three things holds. (a) The old quote was on the page when we read it and is gone now. (b) The source gives an effective date after the original answer. (c) A dated news item since then shows the new value. |
| Differs | The value is different, but nothing shows it changed after the original answer. The answer says "I may have been wrong then". |
| Not comparable | A different plan, unit, currency or billing period. The reason is stated. |
| Unchanged / Unverifiable / Source gone | As today. |

- The summary sentence is written in code. It counts each verdict separately and never says "nothing changed" above rows we couldn't check.
- Done when: unit tests cover each verdict path, plus a Differs case where the source is older than the original answer.

### 1.2 Bugs left from the deep review
- **Comparator:**
  - $10 → $10.19 is reported as Unchanged;
  - monthly and yearly prices are never converted to each other;
  - €1.299,00 is read as 1.299.
- **Premise check:** presupposed statements like "We shortlisted…" are still admitted.
- **Signals:**
  - `lower1` lowercases proper nouns;
  - "la vie en rose" is detected as non-English.
- **Memory:**
  - `topicOf` returns "3 November" (affects brief prompt #2);
  - `claimsFor` doesn't filter by kind, so value claims show up as flagged_then;
  - recheck only targets one stored hit;
  - `sessionHits` and `sessionFirst` don't filter by owner.
- **Answer:**
  - when search is down, the answer comes back with no sources and no warning; it must say search was unavailable;
  - reloading history breaks citations.

### 1.3 Small fixes
- While the answer streams, drop `[n]` numbers that point at no source and links to unknown URLs (Harshdip, Harsh-karn).
- Strip expected values from recheck and news queries ("Pro $25/month" becomes "Pro pricing") (adiikj).
- An article published before the original answer can't be used as today's value (HUN-sp).
- On startup, mark `pending` turns as interrupted (Mino).
- Keep model rate-limit skip times across restarts (HARSHAVARDHAN).

---

## Phase 2: Good to talk to

### 2.1 Real conversation history
Files: `src/agent/pipeline.ts:164`, `src/agent/answer-input.ts`.
Today, earlier turns are cut to 600 characters each, and research turns keep only 2 of them.
- Replay earlier turns in full, and stamp each user message with when it was sent (Satyam, Mino).
- Keep each answer's source list, so "what did [2] say?" works without a new search (Divyendra).
- Replace a cut-off or failed answer with a note saying so (Satyam).
- Keep it inside a size budget: drop old search excerpts first, then old history, and the newest excerpts last (HUN-sp `fitToBudget`).

### 2.2 Follow-ups about the conversation itself
"Give me your recommendation in two lines" or "make it shorter" restates the previous answer with no search. The format the user asks for wins over the default format. (This closes the dev-set failure where we searched that literal text.)

### 2.3 Short clarifying replies
When we offered two dates, a reply like "the 3rd", "3 Nov", "the earlier one" or "the first" resolves back into the pending question before planning. The candidate dates are stored with the assistant turn (HUN-sp `clarify.ts`).

### 2.4 Wrong-date hint
When a date has nothing on record, look the topic up on other dates. "Nothing on Tuesday 10 Nov, but you asked about Postgres hosting on Monday 9 Nov. Want me to check that one?" (MORYASSHAN). This extends `noRecordReply`.

### 2.5 Shortlists and decisions stored as data
One background extraction after each answer records:
- shortlists (items, criteria, version);
- decisions, with the options ruled out and why.

The recheck reads shortlist items directly instead of re-parsing old tables (`entitiesFromHistory`). The answerer is told what was ruled out, so it doesn't suggest it again. (HARSHAVARDHAN, ashusnapx, aprv10. This maps directly to assistant's product.)

---

## Phase 3: Answer fast

1. Put a deadline of about 2.5 s on the whole planner call, not only its first token. Rule-based searches start alongside it; the plan is used only if it arrives in time (jasleenkdev). File: `src/agent/planner.ts`.
2. If the planner or Jev is still running after about 2.5 s, send the same request to a second provider and take whichever answers first. Never do this for a stream after its first piece of text (recalliq). Files: `src/llm/client.ts`, `src/llm/judge.ts`.
3. Skip the recheck model call when the relevant part of the cited page hasn't changed. This uses the `content_hash` we already save and never read (ameyg11).
4. Run the news search at the same time as re-reading the cited pages, not after it.
5. Give each turn one time budget, with time held back for the answer. If a step is cut short, the answer says what wasn't checked (HUN-sp `deadline.ts`).

---

## Phase 4: Make the design visible

1. A "Load demo" button that writes demo history with no API calls, dated relative to today. It includes:
   - real prices, one of them deliberately out of date;
   - an unrelated chat on the other possible "last Tuesday";
   - two chats on the same day;
   - one failed answer.

   (HUN-sp, Divyendra, recalliq. Note: recalliq's demo had no prices, so its recheck never ran.)
2. A per-request "pretend today is…" clock, behind a flag and with a visible banner (ashusnapx).
3. A "why?" panel on each answer showing:
   - which needs fired, and the Jev scores;
   - the premise verdicts;
   - the searches;
   - the number proofs;
   - per-step timings.

   (Suraj, adiikj)
4. A date chip: "Read 'last Tuesday' as Tue 3 Nov · Use Tue 10 Nov instead" (adiikj).
5. Quotes linked to the exact sentence on the source page (`#:~:text=`), built from the number proofs we already compute (Bhavesh).

---

## Phase 5: Simple, clean architecture

1. Split `src/agent/pipeline.ts` into one module per stage.
2. Keep all decision rules in named tables.
3. Remove product names from code and comments, and delete dead code.
4. Add a test that blocks forbidden imports: the comparator, date resolution and number proofs must never import the model layer, and the search layer must never import the agent (saksham).

---

## Phase 6: Proof, run once

1. Tests of the whole turn with fake models.
2. Record and replay search results so eval runs cost nothing (adiikj, Satyam).
3. One table showing what each part adds: search only, then + memory, + Jev, + premise check, + recheck v2 (adiikj).
4. One fresh frozen test set, run once, with results committed as `evals/RESULTS.md` (pass, time to first token, searches) (vaibhav).

---

## What we won't do

- Regex routers (our needs model is stronger).
- One long 60 s deadline per turn.
- Holding answers back until they're checked (it costs streaming).
- A second memory tool (it bends the one-tool rule).
- Placeholder tokens across all answers.
- Re-running evals and tuning over and over.

---

## Later: README and DESIGN.md

Lead with what no competitor has together:
- **Jev, a calibrated decision layer.** None of the 119 cloned repos uses Jev in code; one considered it and rejected it. Code decides from probabilities, and evidence only removes a need. The fallback chain runs from the breaker, to an LLM judge, to a cautious default. Health is shown in `/health` and in every `done` event.
- **Recheck at the source the old answer cited**, with values compared in code and the Changed / Differs split.
- **Every number checked against its source** after the answer is shown.
- **A premise check.**
- **Embedding-based memory recall.**
- **2.2 s median time to first token**, where competitors take 4–26 s.

Also add:
- a "what the code guarantees / doesn't" list (HUN-sp);
- a DECISIONS section with a "what I got wrong" part (GAURAV);
- the table of what each part adds.

Before going public:
- rotate every API key pasted in chat;
- remove the unsourced quote from `docs/ARCHITECTURE_RESEARCH.md`;
- mark `docs/SPEC.md` as out of date or delete it.
