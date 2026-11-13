# Routing: from one route per turn to a set of needs

Status: research and proposal (2026-11-12). No source files were changed. This builds on `docs/PREMISE_RESEARCH.md` (RC3) and `docs/RECHECK_RESEARCH.md`. It reads `src/agent/pipeline.ts`, `src/agent/planner.ts`, `src/agent/claims.ts`, `src/memory/semantic.ts` and `evals/FINDINGS.md` as they are today.

---

## 0. TL;DR

- **Root cause.** `handle()` turns a message that can carry several intents (conversation reference, world question, embedded claim, recheck) into one label from `chat | memory | quick | research | recheck`. The label then decides which evidence is fetched at all, and `memory` fetches no web evidence. Once a label is wrong, nothing downstream can recover the dropped intent, because its evidence was never collected. Most routing findings (F-1, F-10, F-36, F-56, F-58, F-88, F-89, F-90, F-97, F-99, and 3 of the 20 F-100 misses) are patches on that one lossy step.
- **What the field does.** Multi-intent work treats intent as a **set**. Retrieval-heavy systems such as Google AI Mode's query fan-out, LLMCompiler and ReWOO **decompose and run legs in parallel**. Robust RAG work (CRAG, Self-RAG, Sufficient Context, Yoran et al.) decides what to *use* **after** retrieval, using an evaluator over the evidence, rather than deciding what to *fetch* from one label up front. Routers that collapse compound queries into one class are a known, named failure mode.
- **Recommendation: "Needs, legs, admit, compose".**
  1. The turn becomes a **set of needs**: `conversation`, `world`, `premise[]`, `recheck`, `compute`, `social`. Each need gets an evidence requirement and its own status.
  2. Needs are collected as a **monotone union** of the planner, the phrase rules and the cues in the evidence. A weak planner can fail to *add* a need, but it can never *remove* one that another signal raised.
  3. Both cheap legs **always run**. Memory candidates come from local SQLite plus optional embeddings, and the speculative web search already fires on most turns. Each leg's output is **admitted by evidence**: Jev decides relevance per candidate, and only the web leg can be skipped, and only for a conversation-only message that a second signal confirms.
  4. A **code composer** writes one section per need, in a fixed order. A **coverage invariant** says every need ends as `answered`, `no_record` or `unchecked`, stated to the user. No need can be dropped silently.
- Of the routing guards in `handle()`, about 10 become deletable (§4.6). The premise gate becomes a leg that runs on every turn that has premises, which is what PREMISE_RESEARCH RC3 asked for. Recheck v2 becomes the renderer for the `recheck` need.
- **Cost.** No new Groq calls. There is one Jev call per turn that has memory candidates (about 0.5 s, overlapped with the planner), and about one more Exa call on turns that carry a memory cue. Expected first token is unchanged on world turns and about +0.3–0.6 s on mixed turns, which currently produce wrong answers fast.
- **Measurement.** Build a new frozen set stratified by **intent combination × history condition**. Add a **planner-degradation arm** (force the small fallback planner), because robustness to a thin reading is the property being bought. Run A/B on the same day with interleaved order.

---

## 1. Root-cause analysis in this codebase

### 1.1 Where the single route is chosen

| Step | Code | What it does |
|---|---|---|
| Schema | `planner.ts:5,9` | `route: RouteSchema`, exactly one of 5. The `understanding` block (`:20-48`) is *already* multi-label: `pastRef`, `premises[]`, `factual`, `wantsRecheck`, `actionRequest`. It is then collapsed into one route. |
| Prompt | `planner.ts:82-91` | The routes are defined as mutually exclusive ("memory: the user **only** wants to know what was said"). A message with two intents forces the model to choose one. |
| Fail-open | `planner.ts:146-157` | If the planner fails, the plan is `quick` with `pastRef: "none"`, so memory intent is dropped on every planner failure (in the opposite direction to the F-100 misses). |
| Fusion | `pipeline.ts:206-241` | pastRef is decided by a vote between regex (`rulePastRef`) and the model, then patched by 5 successive overrides: the tie-break (`:212`, F-89), date-beats-session (`:215`, F-88), the Jev check on first/last (`:218-227`, F-90), "premise without memory cue → none" (`:238`, F-97), and "assistant_past premise → topic/date" (`:241`, F-97). |
| Route from meaning | `pipeline.ts:334-350` | `pastRef !== "none"` → `memory`/`recheck`, whatever else the message asks (`:340`). Otherwise memory/recheck → quick/research (`:341-348`, F-1/F-56). chat → quick if factual (`:350`, F-2/F-70). |
| Terminal memory | `pipeline.ts:382`, `:400`, `:425-429`, `:925` | `memory` aborts the speculative search (`retrieveCtl.abort`). `retrieveSearch` is never called. `buildAnswerInput` omits the EVIDENCE block on memory. |
| Rescue paths | `pipeline.ts:358-374`, `:394-409` | Claims are fact-checked only when memory found **zero** hits (F-36). With hits, only the premise gate's own probe search runs (`earlyGate`, with an empty pool and one search), and only for premises the planner filled in. |

### 1.2 Why the failures belong to one class

The pipeline makes a **lossy, irreversible decision before it has evidence**. The label at `:340` is chosen from text alone, and it decides which legs run. On a two-intent message:

- If the label is `memory`, the world intent has no evidence. The answerer is given MEMORY and no EVIDENCE (`:925`), so it can only answer from unrelated chat history or from model knowledge. This is the F-100 residue: "3 'you told me / presupposed' items still answered from unrelated memory with no search (planner variance)".
- If the label is `quick`, the memory intent is dropped. `hits` are computed, but with `pastRef === "none"` they are empty, so the answer never says what we told them (F-10/F-11 in reverse, and the fail-open plan at `planner.ts:152`).
- The evidence that *would* show the label was wrong is never collected. Examples are Jev saying the recalled turn is about a different subject, or the speculative search returning pages on exactly the asked fact. So no later stage can self-correct. Every fix has therefore been a pre-label guard keyed on wording or on planner fields: `MEMORY_CUE_RE`, `WORLD_RE`, `isFactualQuestion`, the tie-break, the `premises.every(...)` rule. Each guard repairs one direction and risks the other (F-89's first fix regressed "What did I ask you on 2 November?").

**Dependence on planner richness.** The quality of the route depends on how completely the planner fills `understanding`. F-95 and F-99 show the small NVIDIA planner leaving `premises` empty and putting claims in the wrong field. Under one route, a *thinner* reading isn't just less information: it can push the turn onto a route that runs fewer legs. The design should make a thin reading cost **detail**, not **legs**.

### 1.3 Worked examples

| Message | Intents | Today | Why |
|---|---|---|---|
| "You told me Skype was shut down — when exactly, and what replaced it?" | conversation (what did we say) + world (date, successor) + premise (Skype shut down) | `memory` if the planner fills `assistant_past` (`:241`). The early gate runs one probe (`:396-401`), the main search is aborted (`:400`), and "what replaced it" is answered with no evidence. | One route, and memory is terminal |
| "Since Windows 12 came out last month, what's new?" | world + presupposed premise; "last month" is world time | `resolveTemporal` sets `backReference` → `rule.memoryCue` → preHits from last month → tie-break (`:212`) → memory, unless `:238` fires. `:238` fires only if the planner filled `premises`. | The guard depends on the planner field it is meant to backstop |
| "you said the new pope is from Chicago, is that right?" | conversation + premise (true) | Memory or recheck. A false alarm was seen in F-100. | The premise verdict depends on which route's evidence pool it sees (`:442` vs `:396`) |
| "my friend says X last month" | third-party premise + world | Same path as Windows 12 | — |

---

## 2. What the literature and production systems do

| Work | Finding | What to borrow |
|---|---|---|
| Multi-intent SLU: AGIF and MixATIS/MixSNIPS ([Qin et al. 2020, arXiv 2004.10087](https://arxiv.org/abs/2004.10087)); survey ([arXiv 2512.11258](https://arxiv.org/abs/2512.11258)) | Real utterances carry several intents, so intent detection is framed as **multi-label** (a set plus a slot interaction). Even on synthetic "A and B" concatenations, overall accuracy is only ~41–51% on MixATIS, so getting the full set exactly right is hard. | Represent the turn as a *set*. Don't rely on the model producing the full set exactly: union it with other signals. |
| Task-oriented semantic parsing, TOP ([Gupta et al. 2018, arXiv 1810.07942](https://arxiv.org/abs/1810.07942)); MultiWOZ dialogue acts ([Budzianowski et al. 2018, arXiv 1810.00278](https://arxiv.org/abs/1810.00278)) | Compositional and nested intents. MultiWOZ annotates **multiple dialogue acts per turn**, and dialogue-state tracking is per slot and cumulative, not one label per turn. | One record per need, with its own slots (topic, date, claim) and its own status. |
| Self-Ask ([Press et al. 2022, arXiv 2210.03350](https://arxiv.org/abs/2210.03350)); Least-to-Most ([Zhou et al. 2022, arXiv 2205.10625](https://arxiv.org/abs/2205.10625)); DSP ([Khattab et al. 2022, arXiv 2212.14024](https://arxiv.org/abs/2212.14024)) | Explicit decomposition into sub-questions closes the "compositionality gap", and the gap does not shrink with scale. DSP composes retrieval and LM calls as a program. | Decompose into needs in code-visible form. Keep the decomposition shallow: small models are the bottleneck. |
| ReWOO ([Xu et al. 2023, arXiv 2305.18323](https://arxiv.org/abs/2305.18323)); LLMCompiler ([Kim et al. 2023, arXiv 2312.04511](https://arxiv.org/abs/2312.04511)); Plan-and-Solve ([Wang et al. 2023, arXiv 2305.04091](https://arxiv.org/abs/2305.04091)) | One planner call emits all tool calls up front (ReWOO: ~5× fewer tokens than ReAct). LLMCompiler runs independent calls **in parallel** with a DAG, reporting up to 3.7× lower latency. | One planner call, then parallel legs. No ReAct loop, which suits a 2–3 s first-token target. |
| Google AI Mode / AI Overviews "query fan-out" ([Google Search Central: AI features](https://developers.google.com/search/docs/appearance/ai-features); coverage in [SEJ](https://www.searchenginejournal.com/query-fan-out-technique-in-ai-mode-new-details-from-google/)) | Google says AI Mode breaks a question into subtopics and issues many queries at once across data sources. The number and type of sub-queries are not published. | Production evidence that **fan-out beats a single route** for compound questions. Evidence is thin on internals, so this supports the direction, not the numbers. |
| Perplexity, ChatGPT search | No primary technical source describes their routing. ChatGPT's memory ([OpenAI help: memory & past chats](https://help.openai.com/en/articles/10303002-how-does-memory-use-pastconversations)) has two layers: saved memories, and "reference chat history" used *as context* when useful. | Treat relevant history as **context available to any answer**, not as a separate mode. *Thin evidence:* the mechanism is not documented. |
| Adaptive-RAG ([Jeong et al., NAACL 2024, arXiv 2403.14403](https://arxiv.org/abs/2403.14403)) | A small classifier routes no-retrieval, single-step or multi-step by complexity. The authors note label noise and room to improve the classifier. A misroute costs accuracy on the queries it under-serves. | Routing by **depth/budget** is fine (it only changes how much is spent). Routing by **which evidence exists** is what hurts. Keep depth as a budget, not a gate. |
| Self-RAG ([Asai et al. 2023, arXiv 2310.11511](https://arxiv.org/abs/2310.11511)); FLARE ([Jiang et al. 2023, arXiv 2305.06983](https://arxiv.org/abs/2305.06983)) | Retrieval decided **during** generation (reflection tokens; retrieve when confidence is low), with ISREL/ISSUP critique of retrieved passages. Needs a fine-tuned model or token probabilities. | Borrow the **critique of retrieved evidence** (relevance and support), not the decide-before-generation gate. Free Groq models don't expose a trained retrieve token. |
| CRAG, corrective RAG ([Yan et al. 2024, arXiv 2401.15884](https://arxiv.org/abs/2401.15884)) | A lightweight retrieval evaluator labels retrieved docs Correct / Incorrect / Ambiguous, and actions follow: use, discard and web-search, or both. | **The core pattern:** retrieve cheaply first, then an evaluator decides what to use and whether to search more. Jev is our evaluator. |
| Sufficient Context ([Joren et al., ICLR 2025, arXiv 2411.06037](https://arxiv.org/abs/2411.06037)) | Models rarely abstain when context is insufficient. A sufficiency signal used for **selective generation** raises accuracy-when-answering by 2–10%. | Per-need sufficiency → status `unchecked`/`no_record`, rendered by code, instead of letting the model fill the gap. |
| Irrelevant context: Yoran et al. ([ICLR 2024, arXiv 2310.01558](https://arxiv.org/abs/2310.01558)); "Power of Noise" ([Cuconasu et al. 2024, arXiv 2401.14887](https://arxiv.org/abs/2401.14887)) | Irrelevant retrieved context can mislead models. An NLI filter prevents the harm but drops some relevant passages. | Always-retrieve is only safe **with an admission filter**. This is why F-56 happened (unrelated turns quoted) and why the memory leg must be Jev-admitted. Accept some recall loss. |
| When to retrieve: Mallen et al. ([ACL 2023, arXiv 2212.10511](https://arxiv.org/abs/2212.10511)); SKR ([Wang et al. 2023, arXiv 2310.05002](https://arxiv.org/abs/2310.05002)) | Adaptive retrieval saves cost mainly on popular, stable facts. For long-tail or recent facts, retrieval nearly always helps. | For a "current world" agent the prior should be **retrieve**. Skipping is the exception that has to be justified (F-70 measured this: chat 4/11 vs search 47/55). |
| MemGPT/Letta ([Packer et al. 2023, arXiv 2310.08560](https://arxiv.org/abs/2310.08560)) | Memory is a set of tools the agent pages in and out. Memory search is one capability among others, not a terminal mode. | Memory is a leg, composable with web. |
| Mem0 ([Chhikara et al. 2025, arXiv 2504.19413](https://arxiv.org/abs/2504.19413)); Zep/Graphiti ([Rasmussen et al. 2025, arXiv 2501.13956](https://arxiv.org/abs/2501.13956)) | Production memory layers retrieve memory **on every turn** (cheap vector/graph lookup) and inject what is relevant. Zep's bi-temporal edges separate *event time* from *ingestion time*. The reported LongMemEval gains are vendor-reported. | Cheap always-on memory candidates. Keep the **world time ≠ conversation time** distinction explicit in the data model ("last month" belongs to a claim or to a conversation). |
| LongMemEval ([Wu et al., ICLR 2025, arXiv 2410.10813](https://arxiv.org/abs/2410.10813)) | Temporal reasoning, knowledge updates and **abstention** are the hard categories. Time-aware query expansion improves recall by 7–11%. ~30% drop for commercial assistants over sustained interactions. | Abstention as a first-class status (our `no_record`). Time handling stays in code (`resolveTemporal`, `worldWindow`). |
| Semantic routers ([aurelio-labs/semantic-router](https://github.com/aurelio-labs/semantic-router)); practitioner reports ([OrchestraBench, arXiv 2608.05263](https://arxiv.org/abs/2608.05263); [Red Hat on vLLM semantic router](https://developers.redhat.com/articles/2026/06/02/improve-vllm-semantic-router-accuracy-fine-tuning)) | Embedding routers pick one nearest route. Commonly reported failures: compound/multi-intent queries collapse to one route, small top-2 margins, routers that match surface cues collapse on adversarial inputs. *Evidence is mostly practitioner-grade.* | Don't move to a semantic router. It is the same single-label structure. If a router is kept, make it **multi-label with an explicit "both" outcome**. |
| Selective prediction ([Kamath et al., ACL 2020, arXiv 2006.09462](https://arxiv.org/abs/2006.09462)); self-consistency ([Wang et al. 2022, arXiv 2203.11171](https://arxiv.org/abs/2203.11171)) | Calibrated abstention beats forced answers. Voting over samples improves reliability at N× cost. | Use calibrated Jev scores to *admit*. Don't vote the router N times on free tiers (8k TPM). The union of independent signals is a cheap ensemble with an OR rule, which suits the asymmetric cost: a missed leg is S1, an extra leg is S3. |
| RouteLLM ([Ong et al. 2024, arXiv 2406.18665](https://arxiv.org/abs/2406.18665)) | Learned routers between strong and weak *models* are trained on preference data and are calibrated against a cost threshold. | Applies to choosing the answer model or budget, not evidence legs. Not needed here. |

**Overall reading of the evidence.** There is strong evidence that (a) intents in real messages are sets, (b) parallel decomposition is cheap with one planner call, and (c) post-retrieval evaluators beat pre-retrieval labels for deciding what to use. The evidence is thin, or vendor-only, on the internals of production assistants (Perplexity, ChatGPT, AI Mode) and on semantic routers' failure rates. No paper I found studies the specific combination of *conversation-memory reference + world fact + embedded claim*. The closest are LongMemEval (memory only) and the premise work in PREMISE_RESEARCH.

---

## 3. Candidate architectures

Shared constraints: Groq has 8k TPM and 200k TPD per model, three models. Exa allows 10 QPS. Jev takes about 0.3–0.7 s per call. Local SQLite recall takes about 1 ms. NVIDIA embeddings take about 0.2–0.5 s; the free-tier rate limit is not documented and should be measured.

### A. Intent set → parallel capability legs → code composer ("planner proposes needs")
- **Flow:** the planner emits `needs[]` instead of `route`. Code unions them with rule cues and runs one leg per need type in parallel (memory recall, web search, premise gate, recheck v2). A code composer writes sections in a fixed order.
- **Model vs code:** the model reads which needs exist and their slots. Code decides legs, order, statuses and the section text for memory, premise and no-record lines.
- **Budget:** same Groq calls as today (planner + answerer). Exa calls are the union of the legs, usually equal to today's on world turns and +1–3 on mixed turns. First token is about today's.
- **Failure modes:** legs depend on the *proposal*. If both the planner and the rules miss a need, it is dropped, as today but less often. Thin planner readings still lose legs, just fewer.

### B. Always cheap-retrieve both, then evaluators decide ("evidence disposes", CRAG-style)
- **Flow:** on every non-social turn, run memory candidate recall (lexical + semantic) **and** the web search, no planner label needed. Jev evaluators then decide: "Is candidate c about what the user asks?" (relevance), "Does the message refer to our earlier conversation?" (reference), and per web passage relevance/sufficiency. The composer uses what was admitted.
- **Model vs code:** the planner only writes queries, entities and premises. All *use* decisions are evaluator scores with code thresholds.
- **Budget:** +1 Jev call on every turn with memory candidates. Embedding call on every turn, or only when lexical recall is empty. Exa +1 on memory-cue turns, which today skip speculation (`pipeline.ts:185`).
- **Failure modes:** (1) relevant history with no reference ("what about battery life?" while an old turn mentions batteries) risks F-56-style noise unless *relevance* and *reference* are kept separate. (2) Searching pure conversation questions ("what did I ask on Tuesday?") wastes a call and can add off-topic citations. (3) Jev-dependence: if Jev is down, admission must fall back to strict cut-offs (`semantic.ts:16`).

### C. Sub-question DAG (Self-Ask / LLMCompiler)
- **Flow:** the planner rewrites the message into 1–4 atomic sub-questions, each tagged with a tool (`memory`, `web`, `none`) and dependencies. An executor runs the DAG and the answerer composes.
- **Model vs code:** the model does all decomposition and tool choice. Code executes.
- **Budget:** the planner output roughly doubles (≈ +200–300 out-tokens), which is risky under 8k TPM during bursts (F-43). Dependent steps such as "what did you tell me → then check it" add a sequential hop (+1–1.5 s).
- **Failure modes:** it moves the single point of failure from "one label" to "one decomposition". A small fallback planner that misses a sub-question drops it silently, which is the same class of failure. The best fit for genuinely dependent multi-hop questions, but these are rare in this product.

### Comparison

| | A: needs | B: always-retrieve + evaluate | C: DAG |
|---|---|---|---|
| A thin planner reading drops a leg | less often (union) | **no** (legs don't depend on labels) | yes |
| Unrelated history injected | low | **medium** unless relevance ≠ reference | low |
| Extra cost | ~0 | small (Jev + embeddings + 1 Exa on memory turns) | planner tokens + a sequential hop |
| Deletes guards | many | most | many, but adds decomposition prompts |
| Small-model friendly | yes | **most** (classifier decisions, not generation) | least |

---

## 4. Recommended design: "Needs, legs, admit, compose" (A + B)

Take A's explicit **needs and code-written sections**, and B's **always-run legs and evidence admission**. The asymmetry that drives the design: a missed leg causes an S1 failure (wrong or unsearched answer), while an extra leg costs about 1 s and one search. So leg *activation* is a monotone OR over cheap signals, and leg *use* is decided by evidence.

### 4.1 Data model

```ts
type NeedKind = "conversation" | "world" | "premise" | "recheck" | "compute" | "social";
type Need = {
  kind: NeedKind;
  why: Array<"planner" | "rule" | "evidence" | "default">;   // provenance, logged
  // slots (only those relevant to the kind)
  ref?: { mode: "date" | "topic" | "first" | "last" | "list"; topic?: string; windows?: DateWindow[]; recallTerms?: string[] };
  premise?: Premise;                    // claims.ts type, attribution kept
  queries?: Array<{ q: string; objective: string }>;
  status: "pending" | "answered" | "no_record" | "unchecked" | "declined";
  evidence: { memory: RecallHit[]; web: number[] /* indices into the turn pool */ };
};
type Turn = {
  needs: Need[];                        // ≥1; "world" is present unless proven conversation-only
  depth: "light" | "deep";              // budget only (Adaptive-RAG idea): answer model, deadline, query count
  context: { relevantHistory: RecallHit[] };  // admitted-relevant history with no explicit reference: quiet context, never quoted
  safety: { action: boolean; steering: boolean; nonEnglish: boolean };
};
```

Important distinctions encoded:
- **Reference ≠ relevance.** `conversation` need = the user *refers to* our conversation. `context.relevantHistory` = a past turn is *about the same subject* but wasn't referred to. Only the former gets a code-written "On … you asked" section. The latter is quiet context, like ChatGPT's "reference chat history". This separation is what keeps always-on memory from recreating F-56.
- **World time ≠ conversation time.** A date phrase attaches to a `premise` (`timeAnchor` → `worldWindow`) **or** to `ref.windows`, never both by default. When ambiguous it is resolved by evidence (§4.2), not by the 5 overrides at `pipeline.ts:212-241`.
- **Depth is a budget, not a gate.** `research` vs `quick` survives as `depth`, and so does the answer model choice (`pipeline.ts:463`).

### 4.2 How needs are decided (monotone union, then evidence)

**Stage 0 (0 ms, code):** `social` (CHITCHAT_RE) and `compute` (`isArithmetic` without WORLD_NOW_RE) are the only needs that suppress the world leg, and only when nothing else is raised.

**Stage 1 (parallel with the planner, ~0.5–1 s):**
- **Memory candidates, always** (non-social turns): `store.recall` over text, plus date windows if any, plus `sessionHits`/`sessionFirst` when FIRST/JUST cues match. Run `semantic.recall` only when lexical finds no text hit, as today. This is cheap and local, and it generalises the existing `preHits` (`pipeline.ts:167-173`) to every turn.
- **Web speculative search, always** (non-social, non-compute turns, ≥3 words). Today it is skipped on memory cues (`:185`). Remove that condition, because those are exactly the mixed turns.
- **Planner**, with schema change: `route` → `needs`. In practice, keep `understanding` as is and add `worldQuestion: boolean` ("does the message ask anything about the world beyond what was said in our conversation?"). The existing fields already *are* the need set: `pastRef`, `premises`, `wantsRecheck`, `factual`. The schema change is small. The structural change is in how `handle()` uses the fields.

**Stage 2 (union, code):**
- `conversation` ← planner `pastRef ≠ none` ∪ `MEMORY_CUE_RE`/FIRST/JUST/LIST ∪ any premise with `assistant_past`.
- `premise[i]` ← `admitPremises(planner.premises ∪ claims-as-premises)`. If the planner returned no premises and `CLAIM_RE` matches, a rule-built premise is created from the clause after "you said/told me / my friend says". It is low-confidence but admitted by the gate's own evidence step.
- `recheck` ← planner `wantsRecheck` ∪ (`conversation` ∧ RECHECK_HINT_RE).
- `world` ← **default ON**. It is removed only if all of the following hold:
  1. `conversation` is present and no premise exists,
  2. the planner did not set `worldQuestion`/`factual`, and no entities beyond those in the recalled turns,
  3. **one Jev noul** (folded into the Stage 3 call): "Can the NEW MESSAGE be answered entirely from the record of our past conversation, without any current facts about the world?" ≥ 0.7.

  In words, the web leg is suppressed only by **agreement** of planner, rules and evaluator, never by a single label. "What did I ask on Tuesday?" passes all three. "You told me Skype shut down — when, and what replaced it?" fails (1) and (2).

**Stage 3 (evidence admission, one Jev request, ~0.5 s, overlapping the tail of the planner):** one `jevNoul` call with several questions:
- `rel_c{i}`: is candidate c about the same subject the user asks about (existing `semantic.ts:72` wording). For `assistant_past` premises, the check is against the claim itself (existing `pipeline.ts:313`).
- `ref`: is the message asking about our conversation itself (existing `pipeline.ts:222` wording). Its result *adds* a `conversation` need (prob ≥ 0.7 with any admitted candidate) or *demotes* a rule-only one (prob < 0.3 and no planner backing). The planner's reading still counts: a planner `pastRef` with no rule and Jev < 0.5 is demoted, which is today's F-90 logic generalised.
- `conv_only`: as above.
- Date ownership, when a time phrase exists and a premise exists: "Does the time phrase describe when the event happened in the world, rather than when we talked?" Code then attaches the window to the premise or the ref. This replaces `:212`, `:215`, `:238` and `:241`.

Outcome per candidate: admitted + referenced → `conversation.evidence.memory`. Admitted, not referenced → `context.relevantHistory`. Rejected → dropped (never quoted).

**Jev unavailable:** relevance falls back to `STRICT_MIN` cosine (`semantic.ts:16`) and lexical `via !== "date"`. `ref` falls back to planner ∪ rules. `conv_only` falls back to "keep the world leg". Each fallback leans toward running more legs.

### 4.3 Legs (parallel; each fills its needs)

| Leg | Runs when | Fills | Existing code reused |
|---|---|---|---|
| Memory | always (Stage 1); deepened (topic recall terms, date ranges, semantic) once the planner returns | `conversation`, context | `store.recall`, `sessionHits`, `semantic.recall/admitHits`, `chooseInterpretation` |
| Web | `world` present (default) | `world` | `retrieveSearch`, the speculative merge, `rerank` |
| Premise gate | any admitted premise, **on every turn** | `premise[i]` | `premiseGate` over the **merged** pool (web leg + probe), so it no longer depends on the route (removes the `earlyGate` split at `:394-409`) |
| Recheck | `recheck` ∧ an admitted target turn | `recheck` | `recheckV2` (claims from answer → re-observe → `renderV2`) |

The legs share one evidence pool with stable numbering, so citations stay consistent across sections. Deadlines come from `depth` plus the presence of the recheck leg, not from a route.

### 4.4 Composition: code-written sections plus one model section

Fixed order. Each section corresponds to one need, and code checks coverage before `finish()`:

1. **Premise frame(s)** (code, `frameFor`), when a premise is non-confirmed. A confirmed premise stays silent but adds a "do not dispute" note (as today).
2. **Conversation section** (code):
   - admitted hits → `askedLines(hits)`, plus for `assistant_past` premises a code-written "On <date> I said: '<quoted span>'" taken from the stored answer (the span located by the premise's words, or the first sentence if not found);
   - none → `noRecordReply` with the topic. With a world need present, drop the "I do have conversations from…" detour, as `:361` does now.
3. **Recheck table** (code, `renderV2`), when recheck ran.
4. **World answer** (model, streamed). Prompt: EVIDENCE + the memory hits as MEMORY + `relevantHistory` as quiet context + a list of **already-written sections** ("do not repeat") + one instruction per open need ("Answer: when exactly Skype was shut down and what replaced it"). The shape comes from `depth`, not from a route.
5. **Coverage line** (code): any need whose status is still `pending`/`unchecked` after the deadline gets one honest sentence ("I couldn't check X in time"). This is the invariant that makes silently dropping a need structurally impossible: the composer **iterates over needs**, not over a route.

Time to first token: sections 1–3 are deterministic and stream as soon as their leg resolves. Memory resolves earliest (about 1 ms plus the Jev call), so mixed turns usually show the conversation line first, before the web leg finishes. This is the same trick as today's preamble, generalised.

### 4.5 Worked examples under the new design

- *"You told me Skype was shut down — when exactly, and what replaced it?"* → needs: conversation (rule + `assistant_past`), premise (Skype shut down), world (default; fails `conv_only`). Memory leg: the candidate is Jev-checked against the claim and none is admitted → "I can't find a conversation where I told you that." The premise gate over the web pool returns confirmed → silent. The world section answers the date and successor with [n].
- *"Since Windows 12 came out last month, what's new?"* → needs: premise (presupposed, if the planner filled it, or rule-built from "since X came out"), world. Conversation: the rule cue from `backReference` alone is demoted because Jev `ref` < 0.3 and the date-ownership question says "world". Noise turns from last month are rejected by relevance anyway. Even if `conversation` survived wrongly, the world leg still runs. The worst case is an extra "no record" line, not an unsearched answer.
- *"What did I ask on Tuesday?"* → conversation; world suppressed by agreement (planner none, no premise, `conv_only` high). No search, as today.
- *"what about battery life?"* (follow-up) → world. The previous turn is in `relevantHistory` as quiet context. No "On … you asked" line (F-90 is handled by the reference/relevance split, not by a special case).

### 4.6 Guards this subsumes

| Today (pipeline.ts) | Fate | Why |
|---|---|---|
| `:206-212` rule/planner vote + data tie-break (F-89) | **delete** | Union + Jev `ref` replaces the vote; hits no longer decide the route |
| `:215` date overrides session reading (F-88) | **delete** | Ref mode comes from the memory leg: a resolved date window with admitted hits wins naturally |
| `:218-227` Jev first/last check (F-90) | **fold** into the Stage 3 `ref` question | Same question, now asked for every candidate reference |
| `:238` premise without memory cue → none (F-97) | **delete** | Date ownership + relevance; the world leg runs regardless |
| `:241` assistant_past → topic/date | **fold** into the union rule | — |
| `:334` arithmetic → chat (F-19) | keep as `compute` need | — |
| `:335-348` route from meaning, F-1/F-56 follow-up rewrite | **delete**; keep the follow-up query rewrite as a web-leg query fallback | The world leg is default; memory is never terminal |
| `:350` chat → quick if factual (F-2/F-70) | **delete** | World is default ON; chat survives only as `social`/`compute` |
| `:358-374` no-record branch + `hasClaims` rescue (F-36) | **delete** | `no_record` is a section status; the premise and world legs run anyway |
| `:382` abort retrieval on memory | **replace** with "abort only if world suppressed" | — |
| `:394-409` earlyGate split by route | **delete** | One gate over the merged pool |
| `planner.ts:82-91` mutually exclusive route definitions; fail-open `pastRef: none` (`:152`) | rewrite as need fields; the fail-open plan keeps rule-derived needs | A planner failure now costs detail, not legs |
| `:185` speculative search skipped on memory cues | **delete** condition | Mixed turns need it |
| `MEMORY_CUE_RE`, `WORLD_RE`, `isFactualQuestion`, `CLAIM_RE` | keep as **add-only** signals | A regex can add a leg, never remove one, so the regexes can't overfit in the dangerous direction |

Safety, language, output guards, the action-claim check and `postVerify` are unaffected. `postVerify` now runs whenever web evidence exists, including on mixed turns (today it's skipped on `memory`, `:568`).

### 4.7 Interaction with the premise gate and recheck v2

- **Premise gate:** it becomes orthogonal to routing, as PREMISE_RESEARCH RC3 asked. It runs on any turn with an admitted premise, over the same pool the world section cites, so verdict numbering and citations agree. `assistant_past` premises get *both* the conversation section (what we really said, or no record) and the premise frame (whether it is true). The "pope from Chicago" false alarm (F-100) is a gate-threshold issue, not a routing one. This design doesn't fix it, but it does make the gate see the full web pool instead of an empty one on memory turns, which should help.
- **Recheck v2:** the renderer for the `recheck` need. Its target is the top admitted conversation hit (as `pipeline.ts:609`). If the message also asks something new ("is what you told me about Neon still right, and does it support branching?"), v2 renders its table and the world section answers the rest from the same pool. Phase 1 can keep v2 exclusive (return early as now) and add the world section in phase 2. That trade-off is noted in §6.

### 4.8 Fail-safe behaviour

| Failure | Behaviour |
|---|---|
| Planner fails or times out | Needs = rules ∪ evidence. World is ON, memory leg ON, premises from rule-built claims. Never memory-only (today's fail-open already searches but drops memory) |
| Small fallback planner, thin reading | Same as above for the missing fields: a thin reading costs detail (worse queries), not legs |
| Jev down | Relevance → strict cosine/lexical; ref → planner ∪ rules; conv_only → world stays ON |
| Embeddings down | Lexical only (as today) |
| Exa slow or failing | Existing provider fallback; the world need's status becomes `unchecked` → coverage line |
| Over-firing (searching a pure memory question) | Costs ~1 s and one search. The world section then has nothing to answer, and the composer omits it when no open world instruction exists. Measured as an S3 metric |

---

## 5. Implementation plan and fair measurement

### 5.1 Steps (mapped to files)

| # | Change | Where | Est. |
|---|---|---|---|
| 1 | `Need`/`Turn` types; `deriveNeeds(plan, rules, evidence)`: pure, unit-tested truth table (planner × rules × Jev outcomes) | **new** `src/agent/needs.ts` | 3 h |
| 2 | Planner: keep `understanding`; add `worldQuestion`; `route` kept only to derive `depth` (or replaced by `depth`); rewrite the Routes section as "fields are independent; a message may refer to our conversation AND ask about the world"; fail-open returns `understanding` from rules | `src/agent/planner.ts` | 2 h |
| 3 | Stage 1: always-on memory candidates + speculation on memory-cue turns; Stage 3: one batched Jev call (rel_c*, ref, conv_only, date-ownership) | `pipeline.ts` `handle()`; `semantic.ts` (expose a batched `judge()` with `jevNoul`) | 4 h |
| 4 | Legs as functions returning need updates; one shared evidence pool; premise gate always over the merged pool | `pipeline.ts` (extract `memoryLeg`, `webLeg`, `premiseLeg`), `claims.ts` unchanged | 4 h |
| 5 | Composer: sections in fixed order, coverage line, answer-input notes listing written sections and open needs; shapes keyed by `depth` | `pipeline.ts` `buildAnswerInput`, `prompts.ts` `shapeFor` | 3 h |
| 6 | Delete the guards in §4.6 behind a flag `NEEDS=1` (default off until the A/B); log `needs[]` with provenance per turn (replaces shadow logs) | `pipeline.ts`, `store.logShadow` | 2 h |
| 7 | Unit tests: union monotonicity (removing a planner field never removes a leg), date ownership, coverage invariant, fail-open paths | `test/` | 3 h |
| 8 | (Phase 2) recheck + world composition | `pipeline.ts` `recheckV2` | 2 h |

About 2.5–3 days, with the old path kept behind the flag for the A/B.

### 5.2 Fair measurement

1. **New frozen set `heldout4-intents`, written before any code and never read before the run** (same discipline as heldout3: a README with counts only, seeds in a file nobody working on routing opens).
   - **Strata = intent combination** (≈10): conversation only (date / topic / first / list); world only; conversation + world question; conversation + embedded claim (true / false / narrower); presupposed premise + world time phrase; third-party claim + time phrase; follow-up continuing the topic; recheck + new question; social; compute.
   - **× history condition** (3): a matching record exists; no record; noise only (unrelated turns inside every time window mentioned, the condition that exposed RC3).
   - About 8 seeds per cell where meaningful, so ≈150–200 items. Topics disjoint from every earlier set. Wording written by hand, or paraphrased by a model family not used in development. 30% dev / 70% test, with the test split run **once**.
   - **Gold per item = the set of needs plus facts:** which legs must fire (`searches > 0` iff the gold has world/premise), whether a conversation section must appear and which planted turn ids it may quote, premise status, and 1–2 gold facts with URLs for the judge.
2. **Primary metrics are computed by code, not judged:** (a) **leg recall**: every gold need has a non-pending status and the required leg fired; (b) **no-foreign-history**: quoted turn ids ⊆ gold-allowed ids; (c) premise status confusion matrix; (d) over-firing rate: searches on conversation-only items. The secondary metric is judged with gold facts: first sentence and correctness.
3. **Planner-degradation arm** (the key robustness test): run both builds with (i) the normal planner chain, (ii) the planner forced to the small NVIDIA model, (iii) the planner disabled (fail-open). Success means the new build's score drop from (i) to (iii) is much smaller than the old build's. This is the direct test of "thin reading costs detail, not legs".
4. **A/B hygiene:** same day, same keys (separate Groq accounts per F-95), and **interleaved** order (old/new alternate per item, ISOLATE=1), so quota pressure doesn't fall on one arm (F-100's baseline ran second). Report first-token p50/p95 and searches per turn per stratum. Report 95% CIs: with n≈120 test items, ±~9 pts overall. Per-stratum numbers are directional only.
5. **Ablations (test split, one run each):** union without Stage 3 (rules + planner only); Stage 3 without default-ON world; full. These show whether the evidence step or the default-ON world leg does the work.

---

## 6. Honest trade-offs

- **More searches.** Default-ON world plus speculation on memory-cue turns adds about one Exa call on mixed and conversation turns, and occasionally searches a pure memory question when the agreement test fails. Expect searches per turn to rise ~10–20% (an estimate, not measured). Exa's 10 QPS and the per-turn cap (`TURN_SEARCH_CAP`) are not at risk. Cost in dollars rises slightly.
- **More Jev dependence.** One more batched Jev call on most non-social turns. The fallbacks are deliberately conservative (more legs), so a Jev outage costs latency and search spend, not correctness. Jev's calibration on the `ref` and date-ownership questions is unmeasured. Thresholds (0.3/0.7) must be tuned on the dev split only.
- **Embeddings on more turns.** The NVIDIA free-tier embedding rate limit is undocumented. Keep semantic recall conditional on lexical misses until it has been measured.
- **First token on mixed turns** can rise by about 0.3–0.6 s (Jev admission before the conversation line). It is offset where the code-written conversation or no-record line streams first.
- **The planner can still miss a need that no rule or evidence signal sees.** Example: a subtle presupposition with no claim words, no premise field, and a message phrased as pure memory. The union only lowers the odds. The coverage invariant guarantees honesty about needs that were *detected*, not detection itself.
- **Relevance/reference separation is new surface.** Quiet `relevantHistory` could leak stale facts into world answers ("you were told $5" contaminating today's price). Mitigation: label it "earlier conversation, may be outdated, never cite", and measure it on the follow-up stratum.
- **Recheck + new question** stays partly single-mode until phase 2.
- **The evidence base for the exact problem is thin.** No benchmark I found mixes conversation-memory reference, a world question and an embedded claim. The design rests on general findings (multi-label intent, CRAG-style evaluation, fan-out) plus this codebase's own failure log. So the frozen set and the degradation arm matter more than the literature here.
- **Deleting guards is a regression risk.** Each deleted guard has a regression test from a finding. Keep the old path behind `NEEDS=0` until the A/B passes, and run the existing regression suite with `NEEDS=1` before the frozen test split.

---

## Sources

- Qin et al., AGIF / MixATIS ([arXiv 2004.10087](https://arxiv.org/abs/2004.10087)); multi-intent SLU survey ([arXiv 2512.11258](https://arxiv.org/abs/2512.11258)); DGIF ([arXiv 2211.04023](https://arxiv.org/abs/2211.04023))
- Gupta et al., TOP ([arXiv 1810.07942](https://arxiv.org/abs/1810.07942)); Budzianowski et al., MultiWOZ ([arXiv 1810.00278](https://arxiv.org/abs/1810.00278))
- Press et al., Self-Ask ([arXiv 2210.03350](https://arxiv.org/abs/2210.03350)); Zhou et al., Least-to-Most ([arXiv 2205.10625](https://arxiv.org/abs/2205.10625)); Khattab et al., DSP ([arXiv 2212.14024](https://arxiv.org/abs/2212.14024))
- Xu et al., ReWOO ([arXiv 2305.18323](https://arxiv.org/abs/2305.18323)); Kim et al., LLMCompiler ([arXiv 2312.04511](https://arxiv.org/abs/2312.04511)); Wang et al., Plan-and-Solve ([arXiv 2305.04091](https://arxiv.org/abs/2305.04091))
- Google Search Central, AI features ([link](https://developers.google.com/search/docs/appearance/ai-features)); Search Engine Journal on query fan-out ([link](https://www.searchenginejournal.com/query-fan-out-technique-in-ai-mode-new-details-from-google/)); Aleyda Solis summary ([link](https://www.aleydasolis.com/en/ai-search/google-query-fan-out/))
- OpenAI help: memory and past chats ([link](https://help.openai.com/en/articles/10303002-how-does-memory-use-pastconversations))
- Jeong et al., Adaptive-RAG ([arXiv 2403.14403](https://arxiv.org/abs/2403.14403)); Asai et al., Self-RAG ([arXiv 2310.11511](https://arxiv.org/abs/2310.11511)); Jiang et al., FLARE ([arXiv 2305.06983](https://arxiv.org/abs/2305.06983)); Yan et al., CRAG ([arXiv 2401.15884](https://arxiv.org/abs/2401.15884))
- Joren et al., Sufficient Context ([arXiv 2411.06037](https://arxiv.org/abs/2411.06037)); Yoran et al. ([arXiv 2310.01558](https://arxiv.org/abs/2310.01558)); Cuconasu et al., Power of Noise ([arXiv 2401.14887](https://arxiv.org/abs/2401.14887))
- Mallen et al. ([arXiv 2212.10511](https://arxiv.org/abs/2212.10511)); Wang et al., SKR ([arXiv 2310.05002](https://arxiv.org/abs/2310.05002))
- Packer et al., MemGPT ([arXiv 2310.08560](https://arxiv.org/abs/2310.08560)); Chhikara et al., Mem0 ([arXiv 2504.19413](https://arxiv.org/abs/2504.19413)); Rasmussen et al., Zep ([arXiv 2501.13956](https://arxiv.org/abs/2501.13956)); Wu et al., LongMemEval ([arXiv 2410.10813](https://arxiv.org/abs/2410.10813))
- aurelio-labs semantic-router ([GitHub](https://github.com/aurelio-labs/semantic-router)); OrchestraBench ([arXiv 2608.05263](https://arxiv.org/abs/2608.05263)); Red Hat on vLLM semantic router ([link](https://developers.redhat.com/articles/2026/06/02/improve-vllm-semantic-router-accuracy-fine-tuning))
- Kamath et al., selective QA ([arXiv 2006.09462](https://arxiv.org/abs/2006.09462)); Wang et al., self-consistency ([arXiv 2203.11171](https://arxiv.org/abs/2203.11171)); Ong et al., RouteLLM ([arXiv 2406.18665](https://arxiv.org/abs/2406.18665))
