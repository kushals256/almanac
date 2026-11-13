# False premises: research and redesign proposal

Status: proposal. No source files were changed. Written 2026-11-12.
Companion: `docs/RECHECK_RESEARCH.md` covers re-checking earlier answers. §7 lists what the two designs should share.

---

## 0. TL;DR

The agent never makes an explicit, inspectable decision about the premise. Today the premise is checked, if at all, *inside* the streamed answer by a small model. That model is under a "lead with the answer in one line" shape, and its evidence was retrieved for the *loaded* question ("Apple discontinued iPhone"), so search returns the nearest real event. Post-display verification cannot catch the error either: the stretched sentence ("Netflix gave free ad-free accounts via T-Mobile [4]") *is* supported by its passage. The mistake sits between the question and the evidence, not between the answer and the evidence.

**Proposal: Premise Gate, a claims-first step before the answer.**

1. **Planner** emits each presupposition as a typed proposition: `claim`, `attribution` (user / third party / presupposed / "you told me"), `scope` (what exactly must be true), `timeAnchor`, a neutral **yes/no check query**, and a **truth query** (what is actually the case).
2. **Probe search** per proposition runs *in parallel* with the normal search. It costs 1–2 extra Exa calls and almost no extra wall-clock time.
3. **Stance in one Jev request:** a 4-way label for each (proposition, passage) pair: EXACT · CONTRADICTS · RELATED-BUT-DIFFERENT (narrower scope, other actor, partner offer, lab/animal study, rumour/plan/prediction, earlier time) · SILENT.
4. **Code aggregates** stance with passage dates (time-anchor window), domain diversity and rumour flags into a status: `confirmed | contradicted | narrower | unconfirmed | conflicting | unchecked`.
5. **Code writes the opening frame** for any non-confirmed status ("I can't find any report that Amazon acquired Spotify."). The model continues from it, filling in what *is* true with [n]. On `confirmed` nothing changes.
6. **Routing guard:** third-party claims ("my friend says…") can never make a turn memory-only. The date-window tie-break needs a *topical* hit, not just any history in "last month". Premises turn `chat` into `quick` and are carried into `recheck`/no-record paths.

Expected cost: ~80–120 extra planner output tokens, 1 Jev call (~0.5 s), and 1–2 Exa calls, on premise turns only (~10–20% of traffic). Added time to first token is about 0.4–0.9 s on those turns. The code-written frame streams the moment the status is known.

---

## 1. Evidence: what actually failed

Sources: `evals/realworld/results-heldout2-final/results.json` (16 rows whose label starts with "premise", 5 pass) and `results-v2/results.json` (20 FreshQA false-premise rows, 14 pass).

| # | Case | What happened | Mechanism |
|---|---|---|---|
| a | "why did appple stop makin iphones" / "what caused apple to cease production" | "Apple stopped making certain iPhone models because…"; the iPhone X, 12 mini, Air and 17 Pro retirements stitched into a "why" | evidence stretching (scope: one model → the whole line) |
| b | "at what point did netflix launch complimentary ad-free tiers" | "January 2007" (streaming included with the *paid* plan) | scope: included-with-paid → free |
| c | "when did netflix strt offering free accts w no ads" | T-Mobile "Netflix On Us", 23 Jan 2024 | scope: partner bundle → Netflix's own plan |
| d | "When was the permanent cure for cancer developed?" | a mouse study, Jan 2026 | scope: animal study → approved cure |
| e | "When did Tesla Model Z come out?" | "Mid-2025 (expected debut)" | rumour → release |
| f | "Who did Luke Humphries beat to win this year's PDC…" | the 2024 final presented as 2026 | stale evidence for a time-anchored premise |
| g | "friend says python 4 dropped last month" (3 variants) | route `memory`, 0 searches, unrelated "On Mon 26 Oct you asked…" | mis-routing |
| h | "…Python 4 supposedly got released last month…" (indirect) | route `recheck` with a CI/CD + Notion table | mis-routing |
| i | "with amazon having acquired spotify and all, whether the subscription costs have shifted since then" | route `recheck`, Spotify price diff, premise never mentioned | premise ignored (no slot in that route) |
| j | "What movie did Clint Eastwood win a Best Actor Academy Award for?" | route `chat`, "Unforgiven" (he won Best *Director*/Picture) | premise never checked because no search happened |

**Measurement caveat (important for §6).** At least 2 of the 4 Apple "fails" (x1-casual, x1-indirect) actually *did* correct the premise. The grader (`gpt-oss-20b`) marked them wrong because it believes "the iPhone 17 series hasn't been released as of Nov 2026", which is its own stale knowledge. Some FreshQA "false-premise" gold labels are also time-sensitive (Senate control after the 3 Nov 2026 election; the count of living NZ PMs). A fair evaluation must give the judge gold facts (§6). The true heldout score is closer to 7/16 than 5/16. The direction of the problem is unchanged.

---

## 2. Root causes, one level below the symptoms

### RC1. Evidence stretching: the premise is never a separate object, so "related" passes as "same"
- The retrieval queries are *loaded*. The planner rule says "need a query that checks the event itself (e.g. 'MacBook Air discontinued 2026')". That query is the premise in keyword form. A relevance engine (Exa/Tavily) returns the **nearest real event that matches the words**: one model discontinued, a T-Mobile "free Netflix" bundle, "cancer cure in mice". Search engines rank on relevance, not truth. Given a false premise, the top results are near-misses by construction. CREPE's authors found that the hard part is exactly this: models detect presuppositions but fail to *verify* them, mostly because retrieving the right evidence is hard ([Yu et al., ACL 2023](https://arxiv.org/abs/2211.17257)).
- **Question-shaped slot filling.** "When did…?" and "Why did…?" demand a date or a reason, and the quick shape says "One-line answer first". The model fills the slot with whatever evidence fits it best. This is presupposition *accommodation*: answering with any name or year endorses the presupposition ([Kim et al., "Which Linguist Invented the Lightbulb?", ACL 2021](https://arxiv.org/abs/2101.00391)).
- **Our verifier checks the wrong relation.** `verify.ts` asks Jev "is this CLAIM supported by the cited passage?" The stretched claim "T-Mobile customers got Netflix Standard free [4]" *is* supported. Nothing asks "does passage [4] establish the **question's** presupposition?" The failure lives in the question↔evidence relation, which no component evaluates. Attribution checks (RARR, [Gao et al. 2022](https://arxiv.org/abs/2210.08726); AIS) are necessary but structurally blind here.
- **No vocabulary for "partly true".** FEVER's three labels ([Thorne et al. 2018](https://arxiv.org/abs/1803.05355)) treat "related but different" as NOT ENOUGH INFO, which a small answerer turns into "close enough". AVeriTeC added a fourth label, *Conflicting evidence / Cherry-picking*, precisely because partial truths mislead. Its baseline scored F1 0.10 on that class even with gold evidence ([Schlichtkrull et al., NeurIPS 2023](https://arxiv.org/abs/2305.13117)). Our scope mismatches belong to this class, and they need to be an **explicit option** in the judgement, not something a model is expected to infer.

### RC2. Stale evidence: time is known in code but enforced only in prose
- Code knows every passage's `publishedAt` and labels older ones "OLDER THAN THIS YEAR". It does not know the premise's **time anchor** ("this year", "last month"). So it can't say "a 2024 page cannot support a 2026 event".
- `rerank` only demotes pages more than one year old (`-3`), and a lexically perfect 2024 match still wins ("Humphries beat Littler 7-4").
- The decision is left to the answerer, which has to cross-reference date metadata against the question. Small models do this unreliably, and Jev is documented as weak at dates. **Date logic belongs to code** (SPEC principle 1). Here it is in a prompt rule.

### RC3. Mis-routing: the "data tie-break" tests whether any history exists, not whether it is relevant
`pipeline.ts`:
```ts
const pastRef = !plannerRead ? rulePastRef
  : u.pastRef === "none" && rulePastRef !== "none" && preHits.length > 0 ? rulePastRef : u.pastRef;
```
- `resolveTemporal` sets `backReference` for **any** past date phrase (`groups.some(g => g.every(w => w.end < today))`). "last month" in "Python 4 came out last month" describes *the world's* past, not the conversation's past.
- So `rule.memoryCue` → `rulePastRef = "date"` → pre-planner recall over the last-month window → `preHits` holds **date-only** hits (`via: "date"`, any turn from October) → the tie-break overrides the planner's correct `pastRef: "none"`. The planner even put the friend's claim into `claims`, and was told that "something a friend said is NOT a past reference".
- Then `memory` is a **terminal, search-free route**. The `hasClaims` rescue only runs when `hits.length === 0` (no-record). With unrelated hits present, the claim is never searched.
- Deeper: **one route per turn**, chosen by a vote between regex and model. A message carrying a past-time phrase, a third-party claim *and* a world question has three intents, and the router must drop two. Premise checking should be orthogonal to routing, not a route.

### RC4. Premise ignored: only the quick prompt has a premise rule, and no route has a premise slot
- The Spotify indirect variant went to `recheck` (via the same tie-break: "since then" plus a Spotify turn from 4 Nov). The recheck shape is a table with no premise slot, so the acquisition claim had nowhere to go.
- Even on `quick`, the premise correction competes with the shape and the few-shot example (`EX.quick` leads with a fact). Small models copy the **form** of the example more reliably than they follow rules (our own comment in `prompts.ts`).
- `isFactualQuestion`/`WORLD_RE` let "What movie did Clint Eastwood win Best Actor for?" stay on `chat`, so no evidence existed to check the premise against.

### RC5. Prompt rules alone fail on small models, for structural reasons
1. **Multi-hop in one pass.** "Extract the presupposition → find evidence for it → compare scope and time → decide → then answer" is a 4-step compositional task. Self-ask shows a ~40% compositionality gap that does not shrink with scale ([Press et al. 2022](https://arxiv.org/abs/2210.03350)). Decomposing into explicit sub-questions is what closes it.
2. **Streaming commits early.** The first sentence is generated before the model has "read" the evidence for contradictions. CoVe's main finding is that verification questions answered **independently** of the draft (factored) beat joint verification, because the draft biases the check ([Dhuliawala et al. 2023](https://arxiv.org/abs/2309.11495)).
3. **Instructions to "check the premise" are a weak lever, even for GPT-4.** In FreshPrompt's own table, adding "check if the question contains a valid premise" *lowered* GPT-4's false-premise accuracy (59.2 → 56.8 strict) and valid-premise accuracy (77.1 → 74.2) ([Vu et al., FreshLLMs](https://arxiv.org/abs/2310.03214), ablation table; the paper's text claims the opposite, so trust the table). More and better-ordered evidence was the strong lever: 1 → 10 snippets took strict accuracy from 61.4 to 75.6, and time order beat random order.
4. **The cost of over-correction is real.** Telling a model to doubt premises makes it doubt *true* premises too. A gate decided by code can stay silent on confirmed premises. A prompt rule can't.

**One sentence:** today the premise is an implicit sub-step of generation. It should be an explicit proposition, retrieved for neutrally, judged per passage by a classifier with a "related but different" option, aggregated with dates in code, and enforced by a code-written frame.

---

## 3. What the research and products say (and what to borrow)

| Work | Finding | Borrow |
|---|---|---|
| Kim et al. 2021, presupposition verification ([arXiv 2101.00391](https://arxiv.org/abs/2101.00391)) | Generate presupposition → verify → explain. ~21% of unanswerable NQ questions come from failed presuppositions. **Verification is the weakest step**; off-the-shelf NLI transfer falls short. | The 3-step pipeline, with verification done *with retrieval* rather than by NLI alone. |
| (QA)² ([Kim et al., ACL 2023](https://arxiv.org/abs/2212.10003), data: github.com/najoungkim/QAQA) | Real search-engine queries, some with questionable assumptions. Models must handle both kinds. Still unsolved. | Fresh eval items (§6), and a balanced design (valid + questionable). |
| CREPE ([Yu et al., ACL 2023](https://arxiv.org/abs/2211.17257)) | 8.4k Reddit questions, ~25% with false presuppositions. Detection is fine, *verification fails because of retrieval*. | Retrieval aimed at the presupposition itself. Output = presupposition + correction. |
| FalseQA, "Won't Get Fooled Again" ([Hu et al., ACL 2023](https://arxiv.org/abs/2307.02394)) | 2.4k false-premise questions. Models learn to *detect* them from ~256 examples. Replaying normal questions avoids over-flagging. | Detection is cheap and learnable, so the planner can do it. Pair every false item with a true one. |
| FreshQA / FreshPrompt ([Vu et al. 2023](https://arxiv.org/abs/2310.03214)) | All models struggle on false premises. Evidence count and date order matter more than the instruction. | Give the stance step dated, ordered passages. Don't rely on a premise *instruction*. |
| KG-FPQ ([arXiv 2407.05868](https://arxiv.org/abs/2407.05868)) | 178k false-premise questions from edited KG triples, with graded "confusability". | Confusability levels give the test set *near-miss* premises (same entity, wrong relation). |
| Premise verification via retrieval-augmented logical forms ([Qin et al., TMLR 2026 / arXiv 2504.06438](https://arxiv.org/abs/2504.06438)) | Rewrite the query as a logical form (`Acquired(Amazon, Spotify)`), retrieve against it, ask a Yes/No "conflicts with evidence?" question, and tell the answerer. FEVER detection 58 → ~86–89%. About +0.6 s, no fine-tuning, black-box. | The closest published analogue to this design. A typed proposition beats the raw query for retrieval *and* for verification. The approach is cheap. |
| PAVE ([arXiv 2603.20673](https://arxiv.org/abs/2603.20673), ICLR'26 workshop) | Atomic facts from retrieved context, draft, premise-support score, gated revision. Up to +32.7 pts. | Gating on a support score. We gate *before* drafting, to avoid streamed retractions. |
| CoVe ([arXiv 2309.11495](https://arxiv.org/abs/2309.11495)) | Factored verification questions, answered without seeing the draft, cut hallucination. | Run the premise check independently of the answer, before it. |
| RARR ([arXiv 2210.08726](https://arxiv.org/abs/2210.08726)) | Post-hoc research-and-revise for attribution. | Only as a backstop (§5.7). Post-hoc fixes can't un-stream a wrong lead. |
| FActScore ([arXiv 2305.14251](https://arxiv.org/abs/2305.14251)), SAFE ([arXiv 2403.18802](https://arxiv.org/abs/2403.18802)), VeriScore critique | Atomic-claim decomposition + per-claim search + per-claim verdict. VeriScore: extract only *verifiable* claims. | Atomic, verifiable propositions only. Never "Spotify exists". |
| FEVER ([arXiv 1803.05355](https://arxiv.org/abs/1803.05355)), AVeriTeC ([arXiv 2305.13117](https://arxiv.org/abs/2305.13117)) | 3-way SUPPORTS/REFUTES/NEI, then a 4th "conflicting/cherry-picking" class for misleading partial truths. | Our 4-way stance, with RELATED-BUT-DIFFERENT as a first-class label. |
| MiniCheck ([Tang et al., EMNLP 2024](https://arxiv.org/abs/2404.10774)) | A 770M Flan-T5 grounding checker matches GPT-4 on LLM-AggreFact at ~400× lower cost. | Evidence that **grounding is a small-model task**. Supports using Jev (a decision model), and a local checker as an optional cross-check. |
| Production: web-search assistants ([arXiv 2510.13749](https://arxiv.org/abs/2510.13749)) | GPT-4o/GPT-5/Perplexity/Qwen with search, believer vs fact-checker framing. Framing effects are small. **A response can be well grounded in its citations and still be wrong** (unreliable sources). Reasoning modes raise credibility. | Groundedness ≠ correctness, which confirms RC1. Source quality belongs in aggregation. |
| Production: news questions ([Suzgun et al. 2026, arXiv 2605.22785](https://arxiv.org/abs/2605.22785)) | Six commercial chatbots on emerging news (Feb 2026). The most vulnerable accepted fabricated premises 64% of the time. **Premise detection and answer recovery are partly independent abilities.** (From the search summary; the PDF body could not be parsed.) | Separate detection (planner) from verification (probe+stance) and from recovery (frame + truth query). |
| Google AI Mode "query fan-out" (Google developer docs, Dec 2025; summarised [here](https://hartzer.it.com/query-fan-out/)) | Production engines issue several sub-queries per question. Perplexity shows them; none publish premise-handling internals. | A parallel probe query is standard practice, not exotic. No vendor publishes a premise algorithm, so this design is our own. |

**On production assistants, honestly:** none of Perplexity, ChatGPT search, Gemini or Bing has published a design note on premise handling (I searched; only fan-out is documented). Their observable behaviour, a frequent opening of "Actually, X didn't happen, but…", comes from much larger models with RL on these behaviours. That is not available to us on 8k TPM free tiers. The published mechanisms that *do* transfer to small models are decomposition, targeted retrieval, and a separate verifier.

---

## 4. Candidate architectures

All three are general: they act on *propositions* and *stance categories*, never on question wording.

### A. Structured self-check by the answerer (minimal change)
**Flow:** the answerer first emits a hidden JSON line `{"premise": "...", "status": "true|false|partly|unknown", "evidence": [n]}`. Code parses it, then streams the rest, or rewrites the lead.
- **Model:** the same small answerer does detection, verification and answering. **Code:** parse, enforce.
- **Budget:** +40 output tokens, no extra calls, +0.3–0.6 s to the visible first token (the line is held).
- **Failure modes:** the same model that stretches evidence now grades its own stretch. The evidence is still retrieved by loaded queries. FreshPrompt's table suggests self-check instructions don't help. Fails RC1 and RC2.
- **Verdict:** cheap, but treats the symptom. Use only as the fallback when the gate is `unchecked`.

### B. Premise Gate: claims-first probe + stance + code verdict (recommended, §5)
**Flow:** the planner proposes propositions → a parallel probe search → one Jev request with a 4-way stance per (proposition, passage) → code aggregates with dates, domains and rumour flags → status → a code-written frame plus PREMISE notes → the answer. A post-display backstop sits in `verify.ts`.
- **Model:** the planner *proposes* (detection is easy for small models: FalseQA, Kim 2021), Jev *classifies* (grounding is a small-model task: MiniCheck), the answerer *phrases*. **Code:** windows, aggregation, status, frame, routing.
- **Budget:** planner +80–120 output tokens (Groq TPM is fine), 1 Jev request, 1–2 Exa searches, on premise turns only. Latency +0.4–0.9 s TTFT on those turns. The probe overlaps the main search, so the Jev call is most of the added time.
- **Failure modes:** the planner misses a presupposition (it falls back to today's behaviour, no worse); probe recall misses the contradicting page (gives `unconfirmed`, so the frame is softer but still not stretched); Jev mislabels near-misses (the catch-all label and the code rules limit the damage); over-flagging true premises (§5.5 rules plus the balanced eval).

### C. Answer first, audit and revise (RARR/PAVE style)
**Flow:** answer as today → after the stream, extract the answer's implied premise → probe → if contradicted, append a correction or retract (we already have `retract`).
- **Budget:** no TTFT cost. +1–2 s after the stream.
- **Failure modes:** a wrong lead is already on screen. "Actually, ignore that" is bad to talk to and looks broken in a demo. It also doubles the tokens on failing turns.
- **Verdict:** keep a **cheap slice of it as a backstop** inside B (§5.7). Don't use it as the primary mechanism.

| | A self-check | **B Premise Gate** | C audit+revise |
|---|---|---|---|
| Fixes RC1 (scope) | weak | **yes** (explicit option) | yes, late |
| Fixes RC2 (time) | no | **yes** (code window) | yes, late |
| Fixes RC3 (routing) | no | **yes** (guard + orthogonal gate) | no |
| Fixes RC4 (ignored) | partly | **yes** (frame on every route) | partly |
| Model-agnostic | no | **yes** | mostly |
| TTFT on premise turns | +0.3–0.6 s | +0.4–0.9 s | 0 |
| UX on false premise | ok | **best (correct from token 1)** | poor (retract) |

---

## 5. Recommended design: Premise Gate

### 5.1 Data model (planner output; replaces `understanding.claims`)
```ts
type Premise = {
  claim: string;            // declarative, self-contained: "Amazon acquired Spotify"
  attribution: "presupposed" | "user" | "third_party" | "assistant_past";
                            // presupposed: carried by the question ("why did X stop…")
                            // third_party: "my friend says", "I read that"
                            // assistant_past: "you told me X" (memory + fact-check)
  scope: string;            // what exactly must be true: "Amazon owns Spotify as a company (not a partnership or bundle)"
  timeAnchor: string | null;// the user's words: "last month", "this year", "in 2023"
  check: string;            // neutral yes/no search query: "did Amazon acquire Spotify"
  truth: string;            // what IS the case: "Spotify owner company 2026" / "latest Python version"
};
// understanding.premises: Premise[] (max 3); understanding.claims stays = premises.map(p => p.claim) for back-compat.
```
Planner instructions (general, wording-independent):
- Include only **checkable event or state claims** that the answer depends on and that could plausibly be false: acquisitions, launches or releases, discontinuations, policy or price changes, people in roles, wins and awards, records, scientific results. **Never** existence presuppositions ("Spotify has prices") or opinions. (This follows the VeriScore critique: only verifiable claims.)
- `scope` names the *whole* of what the question assumes: the entire product line vs one model, the company's own offer vs a partner's, an approved treatment vs a study, released vs announced.
- `check` must be **neutral** (as a yes/no question, or "X acquisition Spotify owner"), never the loaded phrasing. `truth` asks for the current state, which is what the correction needs.
- Two short *form* examples with neutral domains (food delivery, a sports league), never the eval topics.

Code validates: drop premises whose `claim` contains no verb, is under 3 words, or is just the entity's name. Cap at 2 checked (a third only on `research`).

### 5.2 Routing guard (fixes RC3, independent of the rest; ship first)
In `pipeline.ts`, at the pastRef fusion:
1. **Third-party attribution never makes a turn memory-only.** If every premise is `third_party` or `presupposed` and the message has no assistant-directed memory cue (`MEMORY_CUE_RE`: "you told me", "did I ask"), set `pastRef = "none"`, whatever the date phrases say.
2. **The data tie-break needs topical support:** replace `preHits.length > 0` with `preHits.some(h => h.via !== "date")`, i.e. the history matches the message's *words*, not merely its *month*. (One line. This alone fixes 4 of the 16 heldout2 premise rows: g, h, and probably i.)
3. **`backReference` from a bare world-time phrase** ("came out last month") should not count as a memory cue when the planner read the message and said `none`. Keep it as a pre-planner recall hint only.
4. **Premises make search mandatory:** `chat` → `quick` if `premises.length` (fixes j).
5. **Mixed intent is allowed:** memory/recheck with premises *and* hits now also runs the gate (today only the no-record branch fact-checks). The `assistant_past` attribution ("you told me OpenAI bought Anthropic") gets both the code-written memory lines *and* the premise frame.

### 5.3 Probe retrieval (in parallel with the main search)
In `retrieveSearch` (and `retrieveRecheck`), add per premise:
- `check` query → Exa `/search` with `highlights`, `ttl` = fast, objective: *"Find authoritative reports that confirm OR deny that <claim>. Prefer the company's own newsroom, regulators, and major news. Include pages that state the current situation."*
- `truth` query → same, objective: *"Find the current, authoritative state of: <truth>."* (This yields the facts for the correction: "Spotify is independent, listed on NYSE"; "latest Python is 3.15.x".)
- **Time window from code:** `resolveTemporal(timeAnchor)`. For anchored premises the `check` query also gets `startPublishedDate = window.start − 7 d`. Probe pages keep their `publishedAt` for aggregation.
- Budget: ≤ 2 premises × 2 queries = ≤ 4 Exa calls (10 QPS), deduped against the main queries, all started immediately after the plan. Exa `lite` is acceptable for `truth` if quota is tight.
- Probe results are **merged into the evidence pool** (deduped by canonical URL) so the answer can cite them. Rerank reserves up to 2 slots per premise for its top stance-EXACT/CONTRADICTS passages.

### 5.4 Stance: one Jev request, 4-way per (premise, passage)
State = the top ≤ 5 probe passages per premise (title, domain, **published date**, ≤ 700 chars; total < 32 KB to stay out of long-context mode). For each (premise *p*, passage *k*), one question:

> Does PASSAGE [k] establish that **exactly this** happened or is true: "<claim>" (scope: "<scope>")?
> Options:
> **EXACT** — the passage reports this event or state itself, as having happened.
> **CONTRADICTS** — the passage says it did not happen, or states facts incompatible with it (e.g. a different owner, a different winner, still in progress, never offered).
> **DIFFERENT** — the passage describes a related but different or narrower thing: only part of the scope (one model, one region, one plan), a different actor (a partner or reseller), a plan, rumour, leak, prediction or expectation, an early or animal/lab study, or an earlier/later occurrence.
> **SILENT** — the passage doesn't address it.

- Use Jev's **`choice`** type, which returns a probability per option. Check the exact options field in the Decisions API reference; `verify.ts` currently only uses `noul`. If `choice` misbehaves, fall back to 2 `noul` questions per pair, `establishes_exactly` and `contradicts`, with DIFFERENT inferred as "topical (lexical overlap ≥ 2) but neither". That is weaker but works on the existing code path.
- 2 premises × 5 passages = 10 questions in one request, ~0.5 s. **Numbers and dates are masked** as in `maskNumbers` (Jev is weak at them). Dates are code's job (§5.5).
- **Fallback chain:** Jev → planner-chain LLM with the same labels in JSON (background priority, 300 tokens) → `unchecked`. `unchecked` reverts to today's prompt rule, so a failure is never worse than now.
- **Optional cross-check (not required):** a local NLI or grounding model (e.g. a DeBERTa-v3 MNLI or MiniCheck export run in Node through ONNX) would give a free, offline 3-way second opinion at ~50–200 ms/pair on CPU. I found **no hosted NLI model on NVIDIA NIM** (only safety and reward models). It adds a ~0.3–1 GB dependency, and NLI is known to transfer poorly to noisy web passages (Kim 2021). Evaluate it offline against Jev on the §6 set before considering it.

### 5.5 Aggregation in code (the decision)
For each premise, over the passages *k* with label probabilities `P(k, label)`:
1. **Time filter.** If `timeAnchor` resolved to a window `W`: an EXACT passage counts only if `publishedAt ∈ [W.start − 7 d, today]`, and **an EXACT passage published before W is reclassified as DIFFERENT (earlier occurrence)**. This deterministically fixes f: the 2024 Humphries final can't support "this year's". An undated page counts as in-window only from official domains (entity-token domain match, as `rerank` already does).
2. **Rumour/low-authority filter.** EXACT from a single domain that is not official and not in a small "major outlet" allowlist (it already exists implicitly in rerank scoring; make it a set), *and* with a title or snippet matching `/(rumou?r|leak|expected|could|might|concept|reportedly|plans? to)/`, counts as DIFFERENT. (This is a general source-reliability rule, not tied to any topic.)
3. **Status:**
   - `confirmed`: ≥ 1 EXACT with p ≥ 0.6 from an official domain, or ≥ 2 EXACT from distinct domains; and no CONTRADICTS ≥ 0.6.
   - `contradicted`: ≥ 1 CONTRADICTS ≥ 0.6 and no surviving EXACT.
   - `narrower`: ≥ 1 DIFFERENT ≥ 0.5 and no surviving EXACT / CONTRADICTS.
   - `conflicting`: surviving EXACT and CONTRADICTS both ≥ 0.6, so the answer presents both.
   - `unconfirmed`: none of the above (nothing on-topic was found).
   - `unchecked`: the gate failed or timed out.
4. **Absence as evidence (bounded).** For high-salience events (an acquisition of a listed company, discontinuing a flagship product line), `unconfirmed` is phrased as "I can't find any report that…". Code never asserts "X never happened" without a CONTRADICTS passage. This keeps the "fail open, never to a confident guess" principle.

Thresholds are tuned **only** on a dev split (§6), never on the frozen test set.

### 5.6 Enforcement: a code-written frame plus notes (fixes RC4, RC5)
- `confirmed` → nothing is added. The answer is normal. This protects true premises, the failure FreshPrompt's table warns about.
- Otherwise code writes the opening clause as the **preamble**, using the existing preamble/`preambleWritten`/`dropRepeatedLead` machinery. It streams as soon as the status is known, so TTFT *improves* on these turns:

| status | code frame (claim text from the planner, lightly normalised) |
|---|---|
| contradicted | "That premise doesn't hold up: sources don't show that {claim}." |
| narrower | "Only partly: I can't find that {claim}. What sources show is narrower:" |
| unconfirmed | "I can't find any reliable report that {claim}." |
| conflicting | "Sources disagree on whether {claim}." |
| (third_party / assistant_past prefix) | "On what your friend said:" / "I have no record of telling you that, and…" (the last only when there are no hits) |

- `extraNotes` gets a compact, structured block, not a rule:
  `PREMISE CHECK (decided by code; follow it): "<claim>": NARROWER. Passages [3][6] describe something different: <label reason>. Passage [8] states the current situation. Continue the opening sentence by stating what IS true with [n], then answer the part of the question that still makes sense (e.g. current prices). Do not describe the different event as if it were the premise.`
- Recheck route: the frame goes before the recheck summary line, so the table still renders.
- Per-shape few-shot gets one "partly true" *form* example (neutral topic), because small models copy form.

### 5.7 Backstop after display (cheap slice of candidate C)
In `verify.ts`, when the status ≠ confirmed, add one Jev `noul` per answer: *"Does the ANSWER present '<claim>' as true?"* If p ≥ 0.6, emit `verification` with `reason: "contradicts premise check"` and mark that line `unsupported`. It never edits text (the current policy), and the ledger records it for the next turn. Cost is +1 question in the existing Jev request.

### 5.8 Latency and token budget (free tiers)
| Step | Time | Tokens / calls |
|---|---|---|
| Planner (already on the critical path) | +50–150 ms for longer JSON | +80–120 out-tokens on premise turns; ~+150 prompt tokens on all turns (the new field spec) |
| Probe searches | parallel with the main search (~0.8–1.5 s) → ~+0–0.3 s | +2–4 Exa calls on premise turns |
| Jev stance | ~0.5 s (8 s timeout; cap the gate at 2.5 s after probe start, then `unchecked`) | 1 request, ~3–5k input tokens (Jev bills input tokens; check its OpenRouter cost) |
| Frame | 0 ms, streamed immediately | 0 |
| **Net TTFT, premise turns** | **+0.4–0.9 s** (today ~1.8–3.3 s on these rows → ~2.5–3.8 s; the frame is the first token) | — |
| Non-premise turns | ~0 (+150 prompt tokens) | — |

Groq: no extra Groq calls unless Jev fails (then +1 planner-chain call at background priority, ~600 tokens). That stays well inside 8k TPM and 200k/day.

### 5.9 Why this generalises (and where it might not)
- Every mechanism keys on **semantic structure**: a proposition, its scope, its time anchor, and the stance categories from FEVER/AVeriTeC. None key on phrasings or topics. The DIFFERENT option lists *epistemic kinds* of near-miss (partial scope, other actor, plan or rumour, preliminary study, other time), which recur across domains. They were not built from our five failures.
- Detection is done by the model, which suits it (it reads intent in any language). Verification is done by a classifier, which suits it. Time and source rules are done by code, which suits it.
- **Risks:** (1) planner recall on subtle presuppositions ("Who are the *six* living former NZ PMs?" carries a numeric presupposition Jev can't judge). Numeric presuppositions should route to the existing quote-anchored number check, otherwise they stay `unchecked`. (2) Over-triggering on everyday questions costs latency, not correctness, because `confirmed` is silent. (3) Category-list overfitting: the catch-all phrase "related but different" must stay in the option text, and the eval must include premise *types* absent from development.

---

## 6. Implementation plan and fair measurement

### 6.1 Steps (mapped to files)
| # | Change | File / function | Est. |
|---|---|---|---|
| 1 | Routing guard: topical tie-break (`via !== "date"`), third-party never memory-only, premises force search, gate runs on memory/recheck with hits | `pipeline.ts` `handle()` (pastRef fusion, route guards, the no-record branch) | 2 h + tests |
| 2 | `Premise` schema + planner prompt fields + validation; keep `claims` derived | `planner.ts` `PlanSchema`, `SYSTEM`, fail-open plan | 2 h |
| 3 | New shared module: `probe(premises, ctx)`, `stance(pairs)` (Jev choice, then the noul fallback, then the LLM fallback), `aggregate()`, `frame()` | **new** `src/agent/claims.ts` | 5 h |
| 4 | Start probes right after the plan, alongside `retrieveSearch` / `retrieveRecheck`; await the gate with a 2.5 s cap; merge evidence; reserve rerank slots; emit SSE `premise` {claim, status, passages} | `pipeline.ts` `handle()`, `retrieveSearch`, `rerank` | 3 h |
| 5 | Preamble frame + PREMISE CHECK notes; replace the prose premise rule; one "partly true" form example; recheck preamble ordering | `prompts.ts` `ANSWER_SYSTEM`, `EX`, `shapeFor`; `pipeline.ts` `buildAnswerInput` | 2 h |
| 6 | Backstop noul and ledger rows for premise verdicts (support `unsupported` + note "premise refuted") | `verify.ts` `verify()`/`jev()`; `store.insertClaims` | 2 h |
| 7 | Unit tests: aggregate truth table (time filter, rumour filter, conflicts), frame grammar, routing guard cases (third-party + date phrase + unrelated history) | `test/` (node:test) | 2 h |
| 8 | UI: a small "premise checked" chip from the `premise` event | static page | 1 h |

Total **≈ 2–2.5 days** including the eval. Ship step 1 alone first: it is one-line-scale, carries zero risk to true premises, and fixes ~25% of the observed premise failures.

### 6.2 Fair measurement without overfitting (the frozen sets are used up)
1. **Build a new frozen set, `heldout3-premise`, before writing code.**
   - **Seeds by *type*, not wording:** 8 premise types (acquisition/merger, launch/release, discontinuation, price or policy change, person in role, winner/award with a time anchor, scientific/medical claim, rumoured product) × 3 polarities: **false**, **true** (a real event checked as of 12 Nov 2026), and **narrower** (true for a part only: one model, one country, a partner offer). That gives 24 seeds × 3 attributions (presupposed in question / "my friend says" / "you told me") ≈ 72 seeds. Topics must be disjoint from every earlier set (no Apple/Netflix/Spotify/Python/Tesla/Meta).
   - **Paraphrase** each seed with a *different* model family from the one used during development (the existing generator uses Nemotron Ultra; use gpt-oss-120b, or the reverse), into 4 styles, as `heldout2/generate.ts` does. Print counts only. Never read the wording before the single run.
   - **History noise condition:** run every item against a seeded DB that *does* have turns inside any time window the item mentions ("last month"). This is what exposed RC3.
   - Add ~40 items sampled fresh from the **(QA)² test split** and **CREPE dev**, which have not been used here. Re-verify their gold against today's world, since FreshQA showed that labels drift.
2. **Gold = verdict + facts, written before the run.** Each seed carries `premiseStatus` (false / true / narrower) plus 1–2 gold facts with URLs, collected by a person or a separate research pass. The judge prompt receives the gold facts and is told *not to use its own knowledge of recent events*. This removes the "iPhone 17 isn't out" judge error.
3. **Primary metric is deterministic, not judged:** the `premise` SSE status vs gold (a 3×6 confusion matrix). Secondary (judged with gold): "the first sentence corrects or qualifies the premise" on false/narrower items, and "no spurious correction" on true items. Report both: a false-alarm rate on true premises above ~10% is a regression even if false-premise accuracy rises.
4. **Split discipline:** 30% dev (used to tune thresholds in §5.5 and the prompt), 70% test (run **once** at the end). Report 95% CIs: with n ≈ 200 test rows, ±~7 pts.
5. **Latency:** p50/p95 TTFT and total time, separately for premise and non-premise turns, against the same harness run on the current build (A/B on the same frozen set, same day, same quotas).
6. **Ablations (one run each, test split):** guard only; guard + gate with a 2-way noul fallback; full 4-way; without the time filter; without the frame (notes only). These show which part does the work and keep us honest about complexity.

---

## 7. Shared "claims-first" mechanism with recheck

`RECHECK_RESEARCH.md` proposes **Claim Re-observation**: typed, quote-anchored claims, a per-claim re-observation ladder, code-first location, and a typed comparator, with Jev used only for non-numeric semantic support. Premise checking is the same problem from the other side: *a proposition we didn't produce, observed for the first time*. Shared pieces:

| Shared piece | Premise use | Recheck use |
|---|---|---|
| `Claim` record (subject, predicate/attribute, scope/qualifier key, time anchor, origin = `presupposed|user|third_party|assistant_past|our_answer`) | from the planner | from the ledger (or backfill) |
| Targeted probe (per-claim query + objective; a window from code) | `check` + `truth` queries | the news leg / the ladder's "one targeted search" rung |
| **Stance classifier** (`claims.ts` `stance()`: Jev choice EXACT/CONTRADICTS/DIFFERENT/SILENT, numbers masked; LLM fallback) | the premise verdict | non-numeric "still supported?" (EXACT → Unchanged, CONTRADICTS → Changed, SILENT → Unverifiable, DIFFERENT → *qualifier changed*, e.g. a plan renamed or restricted) |
| Code aggregator (time window, domain diversity, rumour filter) | premise status | verdict per row |
| Ledger write (append-only, with verdict + date) | stores "user premise refuted" so a later "but you said Amazon bought Spotify" recalls the correction | the bitemporal observation |

Concretely, `src/agent/claims.ts` should own `Claim`, `stance()` and the time/source rules. `recheck.ts` uses the numeric comparator for money/version claims and `stance()` for the rest. One Jev request per turn can carry both kinds of question. The two agents' proposals should agree on the `Claim` field names before either ships.

---

## 8. Honest trade-offs

- **Gain vs complexity:** step 1 (the routing guard) is nearly free and fixes the most embarrassing failures. The full gate adds one module, one Jev call and ~0.5 s on ~15% of turns. If the §6 ablation shows the 4-way stance is no better than the 2-way noul fallback, ship the simpler one.
- **Jev dependency:** OpenRouter's alpha API is billed per input token and has no stated SLA. The LLM fallback keeps the design model-agnostic, but it is weaker at near-miss discrimination. The `unchecked` state guarantees we're never worse than today.
- **Recall ceiling:** if search never surfaces a contradicting page, the best result is `unconfirmed`. That is honest, but less satisfying than "Spotify is independent, NYSE: SPOT". The `truth` query exists to close that gap.
- **Over-correction:** the main risk of any premise work (FreshPrompt's table, FalseQA's replay finding). Mitigated by a silent `confirmed` and measured explicitly with the true-premise false-alarm rate.
- **What isn't solved:** numeric presuppositions ("the *six* living PMs"), and opinion presuppositions ("why is X the best…"). Both are left to the existing number checks and to normal answering.
