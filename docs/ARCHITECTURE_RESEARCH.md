# Chat agent with web search: architecture research guide

Research date: 2026-11-11 (Wednesday). It covers the assistant hiring challenge brief, four parallel research tracks, and a code review of MorrowCache (`~/Desktop/jevcache`).
Numbers marked *(vendor)* are self-reported. Numbers marked *(unverified)* come from secondary sources.

---

## 0. What "best architecture" means for this brief

The brief asks for three things: **answer fast, get things right, remember what you asked and when.** Every component below exists because one of these needs it. The test for each part is: *what breaks, measurably, if I remove it?*

All three sample queries test the **memory and time** requirement: what was asked, when, and whether it is still true. Most submissions treat memory as "stuff old messages into context". The winning design treats it as a data model: a log of every turn, the entities mentioned, a ledger of the claims the agent made, and checks of those claims against the live web.

Principles:
1. **Code for what must be certain; the model for judgement.** Dates, filters, citation checks and price diffs run in code. Understanding the question, writing queries and synthesis are done by models.
2. **Design for failure.** The worst output is a confident wrong answer. So bias toward searching, show "as of" dates, abstain when sources don't support a claim, and never cite a URL that wasn't retrieved.
3. **Plan for latency.** Give every stage a time budget, run independent work in parallel, stream status early, and measure.
4. **Keep it small.** A thin custom loop, a few interfaces and one SQLite file. Setup is `npm install && npm run dev`, with no Docker and no database server.
5. **Back claims with evidence.** An eval set, per-request traces, real p50/p95 numbers, and a "considered and rejected" section in DESIGN.md.

---

## 1. Request pipeline (the core design)

```
user msg ──► [0] persist turn (sync) + resolve dates in code (chrono + rules)       ~5 ms
         ├─► [1a] memory recall: SQL date filter + FTS5 BM25 over turns/claims      ~10 ms
         ├─► [1b] planner (fast model, structured output):                          ~300-600 ms
         │        route ∈ {chat, memory, quick, research, recheck}, queries[],
         │        entities, freshness, official domains, false-premise flag
         └─► [1c] speculative search on the raw message (optional, measured)        overlapped
                 │
                 ▼  SSE status: "Searching: neon postgres pricing" (< 500 ms)
         [2] parallel retrieval: Promise.allSettled, per-call timeouts (~3 s),
             fetch top official pages with live crawl (≤ 2 s budget, else fall back to snippets)
         [3] code-side rerank: canonicalise URLs, dedupe, boost official domains + recency,
             cut to passages, keep 8-15 evidence items, label each [n] with its date, oldest → newest
         [4] answerer (strong model, streamed): today's date + memory JSON + numbered evidence;
             answer first, cite [n] for each claim, "as of <date>", flag conflicts, abstain if unsupported;
             may call web_search 1-2 more times (hard step cap)
         [5] after the stream (async, in parallel):
             a. code: every [n] maps to a retrieved URL; split cited sentences into claims
             b. verifier: one batched call per answer (see 15.3)
             c. extractor (fast model): entities, collections, quote-anchored values from the SOURCE pages
             → SSE `verification` badges; ledger rows written with status; timings recorded
```

Targets:
- **chat/memory route:** first token in under 0.8 s, no search.
- **quick route:** first status under 0.5 s, first answer token about 1.5-2.5 s, done in 4-6 s.
- **research route:** a status update every 1-3 s, hard cap about 30-45 s.

**Why a fast planner and not "let the main model decide":** a model-driven loop costs a full main-model pass to decide to search, then a second pass to answer. The planner replaces the first pass with a small, fast call that also writes the queries, so most turns need exactly 2 model round-trips instead of 3-4. Two safeguards cover mis-routing: (a) bias toward searching for anything involving products, prices, organisations, people or events, and (b) the answerer can still search if the evidence is thin (the CRAG-style fallback). If the planner errors or times out, the turn **fails open to search**, the same principle MorrowCache uses.

**Routes:**
| Route | Trigger | Search? |
|---|---|---|
| chat | greetings, thanks, meta | no |
| memory | "what did I ask on…", answerable purely from the log | no |
| quick | a single volatile fact | 1-4 parallel queries |
| research | comparisons, multi-entity questions | 2-3 rounds, 3-5 queries each, stop early when every sub-question has an authoritative source |
| recheck | "is it still correct?" / "changed since…?" | per-entity two-leg check (section 3) |

---

## 2. Memory and time

### 2.1 What the research says
- No off-the-shelf system handles "what did you tell me then, and is it still true?" end to end.
  - Mem0 overwrites facts with UPDATE/DELETE, which destroys exactly the history needed here.
  - Zep/Graphiti has the right bitemporal idea (`valid_at`/`invalid_at` plus created/expired timestamps) but needs a graph database.
  - Mastra's Observational Memory is lossy, so exact past prices get paraphrased away.
- **LongMemEval findings:**
  - Time-aware query expansion with a date-range filter raised temporal Recall@10 from 0.550 to 0.722.
  - Indexing extracted facts alongside rounds: +9.4% recall, +5.4% QA accuracy.
  - Per-round storage beats per-session storage.
  - Records formatted as JSON are the best reading format.
  - Weak models *invent* date ranges, so date resolution must be reliable and able to return "no range".
- **What the leaders share** (Zep, Hindsight, Mastra OM): absolute dates written into every record, a temporal filter at query time, and multi-channel retrieval fused with RRF (k=60).

### 2.2 Date resolution: deterministic code (`resolveTemporal(text, now, tz)`)
chrono-node 2.10.3 was tested locally with now = Wed 2026-11-11, IST:
- "last Tuesday" → **Nov 10** (yesterday). Many people mean **Nov 3**. → Return **both** candidates.
- "3 November" with today = 2 Nov → it returns the *upcoming* Nov 3. → Bias toward the past: if the year is implied and the date is in the future, subtract a year.
- `forwardDate: true` breaks recall, so never use it. `chrono.strict` doesn't match "last Tuesday".
- "last week" / "last month" come back as single instants. → Expand them to ranges yourself.
- Settle ambiguity **using the data**: search both windows, keep the one with hits, and say which date was assumed.
- If code finds no date but memory intent is clear ("the other day"), make one cheap structured LLM call that returns `{start, end} | null`.
- Inject the clock (`AGENT_NOW`) for tests and for reviewers. Store the user's IANA timezone on every turn.

### 2.3 Storage schema (one SQLite file, append-only)
```sql
turns(id, session_id, role, content, created_at_utc, tz, local_date, summary, topics_json)
turns_fts USING fts5(content, summary, topics)            -- BM25
entities(id, name, canonical_name, type, aliases_json)
entity_mentions(entity_id, turn_id, role)                 -- shortlisted / compared / recommended
collections(id, label, turn_id, created_at_utc)           -- "CRM shortlist, 20-person sales team"
collection_items(collection_id, entity_id, rank, rationale)
claims(id, turn_id, entity_id, attribute, value_text, value_num, unit, currency, qualifier,
       claim_text, as_of_date, asserted_at_utc, volatility, superseded_by)
claim_sources(claim_id, source_id)
sources(id, url, title, fetched_at_utc, published_at, content_hash, excerpt, query)
verifications(id, claim_id, checked_at_utc, status, new_value_text, source_id, diff_note)
                                                          -- unchanged|changed|retracted|unverifiable
```
- **Synchronous writes:** the raw turn and every search result, so nothing is lost and the turn is searchable immediately.
- **Asynchronous writes** (after streaming): extraction of topics, entities, collections and claims. It is better still to have the answerer emit `claims[]` as structured output, so provenance is exact rather than reconstructed.
- **Never update in place.** Supersede by appending a new row.
- **Summaries are a cache and a search key, never the record.** Exact past values come from `turns`/`claims`.
- Vectors are skipped in v1 because recall here is temporal plus lexical. Synonyms and entities extracted at write time ("Postgres hosting" → Neon, Supabase, RDS) give semantic-ish recall. sqlite-vec is the upgrade path; it was verified working on `node:sqlite`.

### 2.4 Memory is an internal capability, not a second tool
The orchestrator **always** runs date resolution and recall before the model sees the turn, so recall is deterministic and testable. That framing keeps "one tool, web search" intact: **web search is the only thing that reaches the outside world, and memory is the agent's own state.** A model-called `recall_history` tool was considered and rejected; Claude.ai's known weakness is that the model has to remember to call it.

### 2.5 Re-checking ("is your answer still correct?")
1. Load claims from the matched turns. Prioritise `volatility='high'` and numeric claims.
2. Plan searches **per entity**, not per claim, with two legs:
   - **Change leg:** re-fetch the stored source URL directly with live crawl and **no date filter**. Pricing pages rarely carry a publish date, so a date filter silently drops them. Compare `content_hash`, then re-extract the value.
   - **News leg:** `"{vendor} pricing" / "launches" / "changelog"` with `start_date = the original turn's date`, plus `site:` on the vendor's blog or changelog.
3. The model labels each claim unchanged / changed / unverifiable, with the source and its date. Money and units are normalised in code.
4. Append a `verifications` row and a superseding claim if anything changed.
5. Answer as a then-vs-now table: claim | stated on (date, source) | now (date, source) | status. Handle the three null cases honestly: no record found, no change found, no usable source (for example "pricing now requires contacting sales").

### 2.6 Walkthrough of the sample queries
- **"What did I ask you on 3 November? Still correct?"**
  - Resolves to 2026-11-03 local, then `turns WHERE local_date=?` (pure date retrieval, no topic search), then the linked claims, then the recheck.
  - If nothing is found, report the nearest dates that do have activity.
- **"Last Tuesday… Postgres hosting… pricing changed?"**
  - Two candidate windows (Nov 10 and Nov 3), each with FTS search for "postgres hosting". Pick the window with hits and say which one was used.
  - Then the price claims for the matched entities, then a two-leg recheck with a diff.
- **"On Monday we shortlisted 5 CRM tools… changed or shipped?"**
  - Resolves to Nov 9, then the `collections` row labelled "CRM shortlist", giving 5 entities.
  - Reuse "20-person team" to recompute seat totals.
  - Output: a pricing-diff column plus "notable releases since Monday", with dates.

### 2.7 Context management
Live context holds:
- the static system prompt (cached);
- after the cache breakpoint: today's date and time, the user's timezone, and the memory JSON (records with absolute dates and ids);
- a rolling session summary;
- the last N turns verbatim.

Old raw search results are replaced with `[source:id]` pointers. This is safe because the full text is already stored in `sources`.

---

## 3. Search layer

**Recommendation: a client-side `web_search` tool behind a `SearchProvider` interface.** Primary is **Exa**, fallback is **Tavily**, with a circuit breaker between them.

| | Exa | Tavily |
|---|---|---|
| Price | `auto` $7/1k, text + highlights included; `/contents` $1/1k | $8/1k basic, $16/1k advanced |
| Latency | ~1 s `auto`, ~450 ms `lite` *(vendor)* | 0.36-1.9 s *(third-party)* |
| Full page text | yes, in the same call | `include_raw_content`, plus Extract |
| Date filter | `startPublishedDate`/`endPublishedDate` | `start_date`/`end_date`, `time_range` |
| Force live crawl | `maxAgeHours: 0`, with per-URL status | `max_age_hours: 0` |
| Path restriction | `includeDomains: ["hubspot.com/pricing"]` | `include_domains` (+ `prefer` mode) |
| News | category *(unverified for 2026)* | `topic: "news"` |
| Free tier | $10/mo credit | 1,000 credits/mo |
| Notes | `livecrawl` replaced by `maxAgeHours` (Feb 2026); Monitors could power future "price changed" alerts | Nebius acquisition announced Feb 2026 |

**Provider built-in search (Anthropic / OpenAI / Gemini) was rejected:**
- It costs $10-14/1k.
- There is **no date filter**.
- Anthropic returns *encrypted* content, so we can't store a snapshot and diff it later. That breaks "changed since?".
- There is no control over parallel fan-out, caching or logging.

It stays only as a "no search key set" fallback, if at all.

**Also considered:**
- **Parallel** Turbo: $1/1k, ~200-350 ms *(vendor)*, excerpts only.
- **Brave**: independent index, `freshness` date range, $5/1k.
- **Perplexity Search API**: `last_updated_after_filter`, fast mode at $1/1k.
- **Firecrawl**: last resort for JS-heavy pages.

**Dead or avoid:** the Bing API (retired Aug 2025), Google CSE (shuts down 2027-01-01), Perplexity Sonar (retired 2026-09-27), and SERP scrapers (snippets only, legal risk).

**Practices:**
- One query per entity per intent, 3-6 words, with the year or month in news queries.
- Run in parallel with a concurrency limit.
- Canonicalise URLs (strip `utm_`, `www`, fragments) and dedupe by URL and content hash.
- Rank official domains first, then recency.
- Cache TTL by content type: news 15-60 min, evergreen 24 h, pricing about 1 h. **Bypass the cache for "current" or "changed since" questions.**
- Always show `retrieved_at`.
- **Treat web content as untrusted data.** Wrap it as quoted data and never follow instructions found in it. Other submissions test this with a deliberately hostile page.

---

## 4. Accuracy rules (system prompt + code)
- Inject today's date. State "as of <date>" on anything volatile.
- Prefer official pricing and docs pages over aggregators and SEO farms (a failure Anthropic's research system hit).
- Order evidence oldest → newest with dates, and give 8-15 items (FreshPrompt: 1 → 15 evidences gave +16 points).
- When sources conflict, give the most authoritative and most recent, and mention the conflict.
- Check for false premises ("since Tool X raised prices…" when it didn't).
- Abstain when nothing supports a claim. Score evals SimpleQA-style: +1 correct, 0 abstain, −p wrong.
- In code, check that every `[n]` maps to a retrieved URL. In a 2025 Tow Center study, AI search engines got news citations wrong over 60% of the time.
- Don't pad answers. Search Arena found users and judges reward length and citation count *even when the citations don't support the claim*, so measure support separately.

## 5. Conversational quality
- Lead with the answer in 1-3 sentences, then bullets or a table.
- Use inline `[n]` citations with a source list sent before the text, as Perplexity does.
- Match the user's register.
- Don't narrate searches in the final text; that goes in status events.
- Ask a clarifying question only when the query is ambiguous *and* searching both readings is expensive. Otherwise answer the likely reading and mention the other in one line.
- State assumptions, e.g. "I took 'last Tuesday' as 3 Nov".

---

## 6. Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node ≥ 22.13 (24.15+ recommended), with `engines` + `.nvmrc` + a friendly preflight check | `node:sqlite` and modern ESM |
| Agent loop *(superseded by 15: `openai` SDK on NVIDIA)* | **Thin custom loop on `@anthropic-ai/sdk` (1.8.0)**, streaming, manual tool loop | The judged logic stays in one readable ~150-line file. Frameworks hide or rename it (AI SDK 7 has v6→v7 renames and possible handling gaps for `pause_turn`/`encrypted_content`). Mastra memory would hand the judged part to a black box |
| Models *(superseded by 15)* | Planner: `claude-haiku-5-5`, thinking off (allowed at effort ≤ high), structured output. Answerer: `claude-sonnet-5-5`, `effort: "low"`, with `MODEL_ANSWER=claude-opus-5-5` as an env option | Haiku outputs ~255 tok/s. Measure one model at low effort before committing to a two-model split, because caches are per model |
| Storage | `node:sqlite` (built in, FTS5 + bm25 verified on 22.23) | No native compile. MorrowCache already ships on it |
| Dates | `chrono-node` 2.10.3 plus our own rules and an injected clock | Section 2.2 |
| Server | Hono + `@hono/node-server`, `streamSSE` | Small, readable |
| UI | One process: Hono serves a static page plus the API (or Vite + React via `concurrently`) | Lowest friction for reviewers |
| Validation | zod 4 | Planner and claim schemas |
| Dev runner | `tsx watch --env-file-if-exists=.env` | No dotenv dependency |

**Claude API gotchas** *(no longer applicable: the build uses NVIDIA, see section 15)*:
- Forced `tool_choice` returns 400 on Sonnet/Opus 5.5. Use `auto` plus `strict: true` and steer from the prompt.
- Opus 5.5 can't disable thinking; its default effort is `medium`, so set effort explicitly.
- `temperature`/`top_p` return 400 on API version 2026-10-21.
- There is no assistant prefill.
- Handle `stop_reason: "refusal"`.
- Keep history append-only (preserved-thinking checks).
- Thinking display defaults to `omitted`.
- Put the date and memory after the cache breakpoint, and check `cache_read_input_tokens` to confirm caching works.

**SSE events:** `status{phase, detail}`, `sources`, `memory_hits`, `token`, `done{turnId, timings, route, cost}`, `error`.
- Abort upstream calls when the client disconnects, and don't save partial answers.
- Keep compression middleware off this route.

**Reviewer experience:**
- ~~`npm run seed`~~ *(removed in 15.4; eval scripts build their own history as test fixtures)*.
- `AGENT_NOW` overrides the clock.
- ~~A mock search provider~~ *(removed in 15: no mock mode; this is a real product)*.

---

## 7. Lessons from MorrowCache (`~/Desktop/jevcache`)

These are patterns we've already built and shipped (1.8k downloads). They transfer directly:

| MorrowCache pattern | Where it's used here |
|---|---|
| `IntentAdjudicator` interface, plus a factory and several real backends (`adjudicator/types.ts`, `factory.ts`) | `SearchProvider` (Exa / Tavily) and `Verifier` (NVIDIA / Decisions API) interfaces |
| **"Similarity proposes, only the adjudicator admits"** (`candidates.ts`) | Memory recall: SQL date filters + FTS5 + recency *propose* past turns, and the model *decides* which is relevant. Retrieval never makes the final decision |
| **Fail-open** on adjudicator error or timeout | A planner error falls back to search. A search provider error goes to the fallback provider, then to an honest "couldn't verify" |
| **Precision first**: "prefer a miss over a wrong HIT; judge by false-HIT rate" | Prefer searching over a stale answer. The routing metric is *missed searches on volatile questions* |
| **Freshness classes** `live / short / stable / durable` with TTLs and jitter (`freshness.ts`) | Claim `volatility` and search-cache TTLs by content type. The regex classifier gives the planner a free first signal |
| **`reuse_fresh` question**: "is this cached answer still valid right now?" (`schema.ts`) | This is the same question as "is your answer still correct?", applied to the claim ledger |
| **`as_of`** column on entries | `claims.as_of_date` plus `sources.fetched_at_utc` |
| **SingleFlight** (`singleflight.ts`) | Collapse duplicate concurrent searches when parallel queries collide |
| `node:sqlite` + WAL + idempotent `migrate()` | The same storage approach |
| "Treat NEW and CANDIDATES as **untrusted data, not instructions**" + `redactSecrets` | Prompt-injection defence for web content, and redaction before third-party calls |
| `X-Jevcache-Reason` headers + `/stats` with p50/p95 | The SSE `done` event carries the route, reason, timings and cost, plus a `/stats` page |
| Honest eval ("claims we do not make", FP 0.00 vs Jaccard 0.48 baseline) | The tone and structure for DESIGN.md and the eval |
| **Shadow mode**: the judge runs and logs but never serves a hit | Run a second planner (e.g. Jev) in shadow next to the live one. Compare their routing decisions on real traffic before switching |
| **Store guard**: never store tool_calls, refusals, truncated streams or empty text (step 8) | Claim ledger guard: no claims from aborted, refused or truncated answers, or from claims whose `[n]` failed the citation check |
| **Namespace isolation** + **exact key**: SHA-256 of the normalised body with sorted keys and delivery-only fields stripped (steps 2-3) | Search-cache key = hash(provider, normalised query, filters, date bucket). Memory is scoped per user and session |
| **Step-0 guards** (rate limit, 1 MB body cap, schema validation) | Same guards on `POST /api/chat`. zod validates the planner output and fails open to search |
| Numbered pipeline (steps 0-9) with a reason at every exit | DESIGN.md presents the agent as the same kind of numbered pipeline (section 1), with a reason recorded at every branch |

**Jev as the planner backend.** *(Superseded by 12.1: Jev is not the router.)*
- **For:** measured ~350-480 ms on the hit path, about $0.00005 per decision, and calibrated probabilities (`noul`) that let us *set the threshold* for "search?" (e.g. search unless P(no-search) > 0.9).
- **Against:** the Decisions API asks typed questions (`noul` / `choice`), so it can't *write search queries*. A query writer is still needed, which means either a second call or the Haiku planner doing both jobs. It also needs another key (OpenRouter) and depends on an alpha endpoint (`/api/alpha/decisions`).
- **Options:**
  - (A) The Haiku planner does route + queries in one call. Simplest, one key.
  - (B) Jev routes **in parallel** with Haiku writing queries. Same critical path, a calibrated route decision, and it showcases our own work.
  - Either way, it sits behind a `Planner` interface and the eval measures routing accuracy for both.

---

## 8. Evaluation harness
- **Question set:** 40-80 fixed items, tagged:
  - chit-chat (must not search) and stable facts (should not search);
  - slow- and fast-changing facts;
  - false premise and multi-hop;
  - comparisons;
  - **multi-turn memory scripts**;
  - **seeded "changed since" scripts** (a fake past turn with a deliberately stale price);
  - date-ambiguity cases;
  - a hostile page;
  - a non-English question.
- **Judge:** a SimpleQA-style grader (correct / incorrect / not attempted) plus a rubric scoring factual accuracy, citation accuracy, completeness, source quality and tool efficiency. Pin the judge model and calibrate it against about 20 hand labels.
- **Metrics:**
  - accuracy and the penalty score;
  - citation precision and recall;
  - **invented URL rate (target 0)**;
  - routing confusion matrix;
  - time to first status, first token and total, at p50/p95 per route;
  - searches, tokens and $ per turn.
- **Unit tests:** `resolveTemporal` with an injected clock; recall against fixture histories; the citation check; the price/unit normaliser; recorded fixtures (test-only, never an app mode) for the provider.

---

## 9. Considered and rejected (for DESIGN.md)
| Option | Why not |
|---|---|
| Provider built-in web search | No date filter, encrypted content (no snapshots to diff), no control over fan-out, caching or logging |
| Mem0 / Zep / Mastra memory | Destructive updates, a graph DB dependency, or lossy compression. All hide the judged component |
| Vercel eve / LangGraph / Mastra agents | Durability and graphs we don't need; the design gets hidden behind a framework |
| Multi-agent orchestrator | About 15x the tokens (Anthropic). Parallel queries inside one loop get most of the speed benefit |
| Model-called memory tool | The model may not call it. Deterministic pre-retrieval is testable and keeps "one tool" literal |
| Vectors in v1 | Recall is temporal and lexical. Local embeddings cost about 500 MB of `node_modules`; an API adds a key and a network hop |
| better-sqlite3 | Native build risk on unusual Node versions. `node:sqlite` is built in |
| Separate gate model in front of a model-driven loop | Adds a step. Our planner *replaces* the main model's first pass rather than adding to it |

## 10. With another week

- Llama Prompt Guard 2 injection firewall (deferred in 14.4).
- Ax + GEPA offline optimisation of the planner prompt against the eval set (moved here in round 3).
- **Proactive nudges** (assistant's own product). Watch high-volatility claims (Exa Monitors or a scheduled recheck) and tell the user when a price they were quoted changes.
- Commitment capture ("I'll decide by Friday") surfaced at the next session.
- sqlite-vec hybrid recall with RRF; a cross-encoder rerank.
- Speculative next-round queries (SPAgent-style, ~1.65x faster *(paper)*).
- Bitemporal `valid_from/valid_to` on claims; a user-facing `/memory` and `/forget`.

---

## 11. About assistant (for tone and fit)
- **Company:** Shram Intelligence. Founders Jay Gadekar and Ojasvika Sahu, both former architects who taught themselves to code.
- **Product:** assistant, "AI that pings you at the right moment". "Cotton" captures context and "Melody" hunts open loops and forgotten commitments. They also offer a Memory MCP for Claude, ChatGPT and Gemini.
- **Claim:** 54% on the BEAM long-term-memory benchmark *(self-reported)*.
- **Ethos:** "We build extensively. Then we trim the fat."
- **What fits them:** time as a first-class part of memory, honesty about stale data, local-first storage, and a trimmed codebase.

**Other public submissions** (for contrast):
- Most use Tavily + SQLite + Gemini or Groq, sometimes with a two-model plan/answer split.
- One uses MongoDB, which adds setup friction.
- The trap they handle unevenly: "last Tuesday" on Wed 11 Nov could be Nov 10 or Nov 3.

---

## 12. Distinctive additions (second research round)

### 12.1 Verdict on Jev as the router: no
Running Jev alongside the planner adds no speed. The planner still has to write the queries, so the wait is set by the slower of the two. It also duplicates a decision the planner already makes, and it adds a key plus a dependency on an alpha endpoint. Running Jev first, then the planner, is slower. The same holds with an NVIDIA model.
**Routing = one planner call returning `{route, queries, entities, volatility}`.** This works with Haiku 5.5 or a Nemotron model via NVIDIA's OpenAI-compatible `integrate.api.nvidia.com/v1`; the NVIDIA trial tier is about 40 RPM.

### 12.2 Jev as the grounding verifier: yes (the signature component)
- **The finding:** on the LLM-AggreFact grounding leaderboard, decision models now top the board. nimble-v4-max scores 79.5, Clef 79.0, and **Jev 1.13 78.7**. Bespoke-MiniCheck-7B scores 77.4 and Claude-3.5 Sonnet 77.2. Jev 1.14 shipped on 2026-10-14. It costs $0.042/M input, output is free, so one passage check is about $0.00002.
- **"Answer proposes, Jev admits."** This is MorrowCache's "similarity proposes, adjudicator admits", applied to claims:
  1. After the answer streams, split it into claims, each paired with its cited passage.
  2. *(Revised by 15.3: one batched call per answer.)* Send **one Decisions request per cited passage, all in parallel**: the passage is the `state`, with one `noul` question per claim ("is this claim fully supported by the passage?").
  3. Below the threshold, emit an SSE `correction`: the claim is hedged or struck through, with a reason.
  4. Show the support probability on each citation chip.
  5. **Only claims that pass verification enter the claim ledger.** This is the store guard.
- **Keep numbers and dates in code.** TypeSafe documents that decision models are weak at quantities, dates and negation. Prices are checked by **quote anchoring**: the extractor must return a verbatim `evidence_quote` containing the price string, and the row is rejected if that quote isn't a substring of the page text.
- *(Superseded by 13.1/14.2: the fallback is the planner model, not "unchecked".)* **Fail open, and say so.** If there's no OpenRouter key or Jev errors, claims are labelled "unchecked". A local fallback is possible: MiniCheck-Flan-T5-L or HHEM-2.1 via ONNX in `onnxruntime-node` (community exports, so check output parity first).
- **Measurable:** faithfulness rate per answer, and accuracy on a small LLM-AggreFact / RAGTruth slice.

### 12.3 Search over time: `web_search(query, { as_of })`, still one tool
"Has X changed since Tuesday?" is answered with **public archived evidence**, even when the agent never stored a baseline.
- **Wayback CDX** (`web.archive.org/cdx/search/cdx?url=&from=&to=&filter=statuscode:200&output=json`) lists the captures. Take the last capture ≤ T as "then", and the live page as "now". Fetch the raw page with the `id_` suffix.
- **Do not use the availability API.** In testing it returned *empty* for HubSpot even though a capture existed.
- A **CDX digest** works one way only: the same digest means unchanged for certain. A different digest means you still have to diff, because build hashes change it.
- **Change bracketing:** binary-search the captures to say "changed between 31 Oct and 4 Nov", with archive links. That's about 4 fetches; run it only when asked *when*.
- **Diff cascade**, stopping at the first level that says "no change": same digest/body hash → same normalised visible text → same extracted fields (zod + quote anchoring) → only then an LLM labels the diff as pricing / launch / cosmetic. Most rechecks cost $0 in LLM tokens.
- **Archive what we cite:** fire an async Save Page Now 2 request (`POST web.archive.org/save`, auth required) and store the `archive_url` on the source. Then "here's exactly what the page said when I answered" is possible.
- **"Shipped something big?"** Use free dated signals in parallel: HN Algolia `search_by_date` with `numericFilters=created_at_i>epoch` (~0.3 s, URL-encode the `>`), vendor changelog RSS, GitHub releases, and news-mode search with dates. Rank by how many independent sources agree.
- **Output:** a then-vs-now table with four verdicts: **Unchanged / Changed (between d1 and d2) / Unverifiable / Source gone**. Capture dates are always shown.
- **Failure modes:**
  - JS-rendered pricing pages (archived HubSpot has no prices). Say "no machine-readable archived baseline" and don't guess.
  - Sparse captures. State the baseline date.
  - Wayback outages and 429s in 2026. Use an 8 s timeout and one retry.
  - Geo-personalised pricing.
- **Framing for "one tool":** Wayback and HN are extra web sources, so the time travel is exposed as a parameter of the single `web_search` tool ("search, as of a date").

### 12.4 Speculative search prefetch
At t=0, fire `search(raw message)` alongside the planner. When the planner returns, reuse the result if its query matches; otherwise merge it into the rerank pool. Also prefetch the top 2 result URLs once search lands, following PASTE's search→fetch pattern.
- **Evidence:** PASTE (arXiv 2603.18897) reports up to 43.5% lower end-to-end latency and 55% lower p99. SPAgent reports 1.65x on search agents.
- Searches have no side effects, so a wrong guess wastes only about one search call.
- Log `speculative_hit` per turn and publish our own measured hit rate.

### 12.5 Smaller, cheap additions
- *(Deferred to another week, see 14.4.)* **Injection firewall:** run Llama Prompt Guard 2 22M (~19 ms, ONNX locally or hosted on Groq) on 512-token chunks of fetched pages, and quarantine flagged chunks. Combine it with marking untrusted text in the prompt. Don't use Jev for this; TypeSafe says decision models handle untrusted text badly.
- *(Superseded by 13.2.)* **Answer expiry:** every claim gets `expires_at` by FreshQA volatility class. When a session starts, stale claims from recent topics are lazily re-checked: "Since you asked on 3 Nov, X changed".
- **Calibrated hedging, lite version:** score each claim on support count, Jev probability and recency. Tune the answer / hedge / abstain cut-off on the eval set (Kalai et al. 2025: binary grading rewards guessing).
- ~~Optional Ax + GEPA planner optimisation~~: dropped in round 3, moved to section 10.
- **Rerank 20 snippets down to 5** (zerank-2 or Cohere Rerank 5 Fast, ~150-300 ms) only if eval shows it improves answers. Otherwise use code rerank.

### 12.6 Rejected in this round
Arch-Router (needs self-hosting or the Plano proxy, and is built for model routing, not tool choice) · semantic-router (no JS port) · RouteLLM (Python, cost routing) · Parallel web-grounded decisions (effectively a second search tool) · full semantic entropy (5-10x compute) · a blind answer cache · archive.today and Common Crawl (timed out, or too coarse).

## 13. Decisions (third round, agreed with the user)

The top principle is now **cheapest and fastest check first**. Every step escalates only when a cheaper step can't decide. The order is cache, then code, then a HEAD request, then search, then Jev, then the LLM.

| Component | Decision | Added latency | Added cost |
|---|---|---|---|
| Speculative search: the raw message fires an Exa search while the planner runs (PASTE, SJTU + Microsoft Research) | **Adopt** | Negative: it removes about 0.5–1 s | About one wasted search when the guess is wrong; a cache hit makes that free |
| Claim verification after the stream, with inline badges | **Adopt, as a core step and not an option** | 0 before the first token; badges arrive about 0.5 s after the stream ends | About $0.0002 per answer with Jev |
| Cache search results, not answers (same `sources` table as the ledger) | **Adopt** | Negative on repeat questions | Storage is about 10 KB per search, so roughly 10 MB per 1,000 searches |
| Learned expiry (see 13.2) | **Adopt** | 0 | 0 |
| Score each claim on 3 things (see 13.3) | **Adopt** | 0, done in code | 0 |
| Quote-anchored extraction, with every number proved in code | **Adopt** | 0 | 0 |
| Free "shipped something big" signals: HN Algolia, changelog RSS, GitHub releases | **Adopt** | Runs in parallel with Exa | 0, no keys needed |
| Wayback as a fallback only, run in parallel with a time budget (see 13.4) | **Adopt, off the hot path** | 0 on the usual path | 0 |
| Ax + GEPA prompt optimisation | **Drop** and move to "another week" | Runs offline only, with no runtime gain | A few dollars per optimisation run |

### 13.1 Verification is the gate into memory, which is why it isn't optional
*(Revised in 14.1.)* Every claim is written to the ledger **with its support status**, and only verified, quote-anchored values become **baselines** for re-checks. "Is your answer still correct today?" can then also say "that part wasn't well supported even when I said it". The verifier is pluggable, following the MorrowCache adjudicator pattern:
- **With an OpenRouter key:** Jev handles it, batched as one request with one `noul` question per claim.
- **Without that key:** the planner model runs the same check, which is slower and costs more but works the same way.

Numbers and dates never go to Jev. Code checks them with the quote-anchor rule. The chat and memory-only routes skip verification entirely.

### 13.2 Expiry: classes as the starting point, learned from real changes, revalidated like HTTP
1. **Prior.** The planner already returns `volatility` (live, fast, slow or stable), so a class costs no extra call. Each class maps to a starting TTL.
2. **Learned rate.** Every re-check records whether an `(entity, attribute)` pair changed. Expiry uses the observed change rate, as a Gamma–Poisson update over changes and days observed. Neon's pricing page changing twice in a month gives it a shorter TTL than its "slow" class would.
3. **Cheap revalidation before a re-search.** When a claim expires, steps run in order of cost and stop at the first one that decides:
   1. A conditional GET using ETag or Last-Modified, which takes about 0.2 s. A 304 means the claim is still fresh. Many pricing pages send neither header (neon.com didn't), so the next step is usually needed.
   2. A hash of the visible text.
   3. The extracted fields.
   4. A full search.
4. **Proactive surfacing.** On the next visit, the agent can say "Since you asked on 3 Nov, Neon's Launch plan changed".

### 13.3 Per-claim confidence comes from three signals, all computed in code
- **Support:** whether the cited quote entails the claim, judged by Jev or the fallback.
- **Agreement:** the number of independent domains that agree.
- **Freshness:** the source's age relative to the claim's expiry.

The combined score maps to a label:
- **Stated plainly:** all three signals are strong.
- **Hedged:** for example, "one source, as of 4 Nov".
- **Withheld:** "I couldn't confirm X".

The thresholds are tuned on the eval set. The rationale comes from Kalai et al.: models hallucinate because training rewards guessing over abstaining.

### 13.4 Wayback timing (measured on 2026-11-12)
- **CDX lookup:** 1.0–1.6 s warm and 5.5 s cold.
- **Raw archived page (`id_`):** about 1.7 s.

That gives 3–7 s per page. Neon's digest changed on nearly every capture, because the page has dynamic markup. A digest diff is therefore only a fast "unchanged" signal, and changes have to be confirmed on extracted fields.

**Policy:**
- Wayback runs only when the agent has no baseline of its own. For the test queries the agent has its own baseline, because the earlier turn stored it.
- When it runs, it runs in parallel with the live legs under a 2.5 s budget.
- If it misses the budget, the answer streams without it and a "📜 archive evidence" row is appended when it arrives.
- Archiving cited pages with SPN2 is fire-and-forget.

There is no opt-in button. The behaviour is automatic and never blocks the answer.

### 13.5 Answer formats (one shape per route, enforced by the answerer prompt)
- **quick:** a one-line answer, 1–2 lines of context, [n] citations and an "as of" date.
- **research / compare:** a one-line verdict, a comparison table, caveats and dated sources.
- **recheck:** a one-line summary such as "2 of 5 changed". Then a then-vs-now table with the columns *Item · Then (date) · Now (date) · Verdict · Evidence*, followed by what changed and why it matters.
- **memory recall:** "On Tue 3 Nov you asked: '…'". This is followed by the answer given then and its status now.
- **no record:** "I have no conversation from 3 Nov". The nearest dates with history follow.
- **Every route:** the date interpretation is stated ("taking 'last Tuesday' as 10 Nov"). Confidence labels follow 13.3.

## 14. Architecture audit (2026-11-12): clashes, errors and gaps, with fixes

### 14.1 Design errors
1. **The verifier should label claims, not act as a gate.** Dropping unverified claims from the ledger breaks "What did I ask on 3 Nov, is it still correct?", because that question has to cover *everything* the agent said, including the shaky parts. **Fix:** store every claim with `support = verified | unsupported | unchecked`. Only verified, quote-anchored values become re-check baselines. Unsupported ones are reported honestly.
2. **Snapshots from different fetchers can't be compared by hash.** Exa's cleaned text, a raw HEAD/GET from our server, and Wayback's raw HTML all produce different bytes for the same page, so every hash comparison would say "changed". **Fix:**
   - Hash only text produced by **one** fetch path: Exa contents with `maxAgeHours: 0`, normalised.
   - Compare across fetchers only on **extracted fields**.
   - Treat an ETag 304 as a one-way "unchanged" shortcut.
3. **Struck-through claims still feed the model's next turn.** Rewriting an earlier assistant message would break the append-only history rule (preserved thinking and caching). **Fix:**
   - Never edit an earlier assistant message.
   - Inject the verification results into the next turn's memory JSON ("claim c12 was unsupported").
   - The UI shows the strike-through, and the model sees the note.
4. **Quote anchoring will reject real prices on formatting alone.** `$19` / `per month` gets split across table cells, and non-breaking spaces and `US$` variants break exact matching. **Fix:** normalise whitespace, currency symbols and thousands separators on both sides before the substring check. Add unit tests built from real pricing-page text.

### 14.2 Things that clash with each other
1. **Speculative search vs the re-check and memory routes.** A raw query like "what did I ask you on 3 November?" searched on the web is pure waste. Re-checks must also bypass the cache, so a speculative cache hit is useless there too. **Fix:** step 0 already runs the date resolver in code (about 5 ms). Skip speculation when it detects a back-reference to the past (on Monday, last Tuesday, since, still correct) or a chit-chat pattern.
2. **Speculative results can pollute the evidence.** Off-topic hits from the raw message get merged into the rerank pool. **Fix:**
   - Merge speculative results only when they overlap the planner's queries or entities.
   - Otherwise discard them and log a `speculative_miss`.
3. **Verifier batching** *(revised by 15.3 under NVIDIA's 40 RPM)*: **one batched call per answer**, holding only the cited passages trimmed to about 300 relevant tokens each. One call per passage would exhaust the rate budget.
4. **Race between async writes and the next turn.** The user can ask a follow-up before verification or extraction has finished. **Fix:**
   - Ledger rows start as `pending`.
   - Recall awaits any in-flight post-processing for the same session (singleflight), with a 2 s cap.
   - The raw turn is always readable immediately.
5. **"Never update in place" vs async summaries and topics in FTS.** **Fix:** the rule covers facts (turns and claims). Derived index columns (summary, topics, FTS rows) may be filled in later.

### 14.3 Gaps
1. **Who produces structured claims?** The answerer streams prose and can't also stream strict JSON. **Fix:**
   - Code splits cited sentences into claims, at no cost.
   - A fast-model extractor runs after the stream, in parallel with the verifier. It pulls entities, collections and quote-anchored values from the **source pages**, not from the answer.
   - Cost: one call to the fast NVIDIA model per answer.
2. **Collections depend on the extractor noticing them.** If it misses "let's shortlist these 5", query 1 fails. **Fix:** collections are an index, not the record. Recall always returns the raw turns in the date window too, so the model can read the shortlist directly.
3. **Per-claim volatility.** The planner runs before any claim exists, so it can't assign volatility to individual claims. **Fix:** claims inherit volatility from the attribute (pricing, release, people). The extractor can override it.
4. **The learned expiry rate has almost no data in a demo.** The class-based starting estimate will dominate for weeks. Keep the code, because it's small, but describe it honestly in DESIGN.md.
5. **Rate limits on the re-check fan-out.** Five entities × (change leg + news leg + HN) is about 15 calls. **Fix:** a concurrency limit, an ordering that runs the cheapest call first, and measured p95. Exa's QPS limit still needs checking.
6. **"One tool" framing.** Exa, HN Algolia, RSS, Wayback and direct page fetches all go through one `WebSearch` module, presented as one tool with options (`as_of`, `fetch_url`). DESIGN.md has to state this explicitly, so reviewers don't count them as five tools.
7. **Test fixtures** (not app seed data, see 15.4) must carry verified claims with sources. Otherwise re-check tests have no baselines.

### 14.4 Trims (cost, setup friction)
- **Prompt Guard 2 is deferred.** `onnxruntime-node` adds a large native dependency, which works against "`npm install` just works". Groq would add another key. The agent has no tools with side effects, so the blast radius of an injection is limited. Data-marking plus the "untrusted data" prompt covers v1.
- **Keys:** *(superseded by 15.1)*.

## 15. Provider switch: NVIDIA, free keys only, every key required, no mock mode (2026-11-12)

### 15.1 Keys (all required, all free)
| Key | Used for | Free tier (checked 2026-11-12) | Per-turn usage |
|---|---|---|---|
| `NVIDIA_API_KEY` | Planner, answerer, extractor, verifier (OpenAI-compatible `https://integrate.api.nvidia.com/v1`) | 40 req/min, 10,000 req/day per account; no card; phone verification | 4–6 calls |
| `EXA_API_KEY` | Primary search, live-crawl contents, date filters | $20 sign-up + $10/month credits; 10 QPS `/search`, 100 QPS `/contents` | 1–15 searches |
| `TAVILY_API_KEY` | Failover search when Exa returns 429/402/5xx or credits run out | 1,000 credits/month | 0 normally |

The agent refuses to start if any key is missing, and names the key it needs. HN Algolia, changelog RSS and Wayback need no key. OpenRouter is pending the verifier decision in 15.3.

### 15.2 What changes with NVIDIA
- **SDK:** `openai` npm package with `baseURL` set to NVIDIA. The provider sits behind an `LLM` interface, so switching later is one file.
- **Models change weekly.** On the free list, nemotron-3-super was dropped on 2026-10-20 and kimi-k3 in October. So:
  - Model IDs live in config as **ordered lists**: planner = fast models such as nemotron-3.5-lightning or gpt-oss-20b; answerer = strong models such as deepseek-v4.1-flash, nemotron-3-ultra or gemma-4-31b.
  - At boot, `GET /v1/models` picks the first available model in each list.
  - A 404 at runtime moves to the next model in the list.
  - Final picks come from a latency and quality bake-off during the build.
- **Rate budget:** 40 RPM ÷ about 5 calls per turn gives about 8 turns per minute. That's fine for one user, but there's no room for one call per passage. A token bucket in front of the client queues calls instead of failing.
- **Latency risk:** free endpoints are shared and can be throttled. Measure time to first token per model, and keep a per-call timeout with fail-over to the next model in the list.
- **Structured output:** NIM supports `response_format` / guided JSON. Confirm per model in the bake-off; zod validates either way.
- **No prompt caching** like Anthropic's, so keep the system prompt short.
- **Privacy note for DESIGN.md:** NVIDIA's trial terms say inputs and outputs are logged to improve their products.

### 15.3 Verifier under "free keys only"
Jev is **not free**: $0.042/M input on a paid OpenRouter balance, with no `:free` variant. The options:
1. **NVIDIA fast model as verifier** (recommended for free-only). One batched call per answer, holding only the cited passages trimmed to the relevant ~300 tokens each, with one yes/no per claim. It's free and within limits. It loses the published LLM-AggreFact standing, so measure it on a small RAGTruth/AggreFact slice.
2. **Inception Mercury Decide `:free` on OpenRouter.** It uses the same Decisions schema as Jev, so the MorrowCache adjudicator code carries over. But free accounts get **50 requests/day, 20/min**, and there's no published grounding benchmark. That would only fit one batched request per answer.
3. **Jev**, if about $10 of OpenRouter credit is acceptable. That's not free, but at about $0.0002 per answer it would last a very long time, and it also lifts free-model limits to 1,000/day.

Whichever is chosen sits behind the `Verifier` interface. Any change must update the per-turn call count in 15.2.

### 15.4 No mock mode
- No mock provider, no keyless mode and no seeded demo data in the app.
- Tests use recorded fixtures inside the test suite only.
- `AGENT_NOW` remains as a **test-only** clock override and is not documented as a user feature.

## 16. Search capacity and a senior-engineering review (2026-11-12)

### 16.1 Search capacity: design for any fan-out, not just 15 calls
**The real limits on free tiers** are per-second QPS *and* monthly credit.
| Provider | Free allowance | QPS | Card needed |
|---|---|---|---|
| Exa `/search` | $20 sign-up + $10/month (about 1,400 searches/month) | 10 | No |
| Exa `/contents` (re-fetch known URLs) | Same credit, cheaper per call | **100** | No |
| Tavily | 1,000 credits/month | About 100/min for dev keys | No |
| Brave | $5/month credit (about 1,000 searches) | 50 | Reportedly yes, for abuse checks |
| Serper / Jina / Linkup | One-time grants (2.5k queries / 10M tokens / trial) | Varies | No |
| HN Algolia, RSS, GitHub releases, Wayback | Unlimited or generous, no key | High | No |

**Design: a `SearchRouter`, not a single provider.**
1. **Route by job.** Re-checking a known URL uses `/contents` (100 QPS), not `/search`. "Shipped something big?" goes to HN, RSS and GitHub first, and only then to news search. Only open-ended discovery uses `/search`.
2. **Batch by domain.** The news leg for N vendors becomes one `/search` with `includeDomains: [all vendor domains]` plus a date filter. Without batching it would be N separate calls.
3. **Pool providers.** Each provider gets a token bucket sized to its QPS and a monthly quota counter. A call goes to the first provider with tokens left and spills over to the next. Pooled capacity is the sum of the members.
4. **Stream partial results.** Re-check rows stream into the then-vs-now table as each entity finishes, so 50 entities never means a 50-call wait before the first row. The most volatile entities go first.
5. **Cap and tell.** There's a hard per-turn budget, for example 40 search calls. Anything beyond it gets "checked the 20 most important; say 'continue' for the rest".
6. **Track quota.** Remaining monthly credit per provider shows on `/stats`. Below 10%, Exa is reserved for `/contents` and discovery spills to Tavily.

### 16.2 Review lens
The review checks the design against:
- **Requirements fit.**
- **Simplicity:** KISS, YAGNI.
- **Modularity:** separation of concerns, interface boundaries.
- **Correctness of the data model.**
- **Failure modes:** timeouts, deadlines, retries with jitter, `Retry-After`, circuit breakers, bulkheads, backpressure, idempotency, graceful degradation, single points of failure.
- **Security:** OWASP, SSRF, injection, secrets, data exposure.
- **Performance budget.**
- **Observability.**
- **Testability:** the test pyramid, deterministic tests over a live web.
- **Operability and DX:** config validation, migrations, `npm install` with no surprises.
- **Cost.**
- **Documentation as the source of truth.**

### 16.3 New findings
1. **SSRF (security, high).** The server fetches URLs that come from search results and stored sources (ETag HEAD, re-fetch, Wayback). A hostile page could point at `http://169.254.169.254/` or `localhost`. **Fix:** go through Exa `/contents` where possible. Any direct fetch must:
   - allow http(s) only;
   - resolve DNS and block private, loopback and link-local ranges;
   - revalidate the address on every redirect, with at most 3 redirects;
   - set a 5 s timeout and a 2 MB body cap.
2. **Background work can starve the next turn (clash).** Post-stream verification and extraction spend NVIDIA's 40 RPM, and the user's next planner call can end up queued behind them. **Fix:** a priority limiter (bulkhead).
   - Foreground calls (planner, answerer) have about 70% of capacity reserved.
   - Background calls only use what's left and are skipped first when the budget is tight. Their claims stay `unchecked` and are retried later.
3. **A single LLM provider is a single point of failure.** NVIDIA's free models churn weekly, and new keys have been reported to 404. **Fix:** a second free LLM provider behind the same `LLM` interface. Groq's free tier (about 30 RPM, no card, verify the current numbers) also gives the fastest planner calls. *This adds a key and needs the user's decision.*
4. **No end-to-end deadline.** There are per-call timeouts but no turn-level deadline. **Fix:**
   - Each route gets a deadline: 8 s for quick, 45 s for research.
   - It is propagated as an `AbortSignal` through every call.
   - When it expires, the agent answers with the evidence it has and says what was skipped.
5. **Retries.** Retry only idempotent calls. Use exponential backoff with jitter, honour `Retry-After` on 429, and allow at most 2 attempts. Use a circuit breaker per provider, so the agent doesn't hammer a failing free endpoint.
6. **Monthly quota exhaustion during grading.** This is a real risk on free tiers. **Fix:** the quota tracker from 16.1, the search cache, a `/health` check showing remaining credit, and a clear user-facing message instead of a crash.
7. **Exposure.** The app has no auth and holds the whole conversation history. **Fix:** bind to `127.0.0.1` by default and state that it's a single-user local app. Add redaction before third-party calls, as MorrowCache does.
8. **Evals over a live web aren't repeatable.**
   - Regression evals replay recorded search responses. These are test fixtures, not a mock mode (15.4).
   - A small live smoke set runs separately.
   - Scores are reported for both.
9. **Bounded growth.** Cap page size at 200 KB of text. Run an eviction job for uncited cache rows. Make schema migrations versioned (MorrowCache's `migrate()`).
10. **Scope risk (the biggest one).** This guide now has more than 20 components. Too much scope is a common reason take-home projects fail. **Fix:** tier the build.
    - **Core:** dates, memory and ledger, planner, SearchRouter, streamed cited answers, re-check table, code number-proofs, deadlines and limits.
    - **Signature:** speculative search, post-stream verification, quote anchoring, free release signals.
    - **Stretch:** Wayback fallback, learned expiry, ETag revalidation, three-score calibration.

    Ship core plus signature fully tested before starting stretch. "We build extensively. Then we trim the fat."
11. **Documentation hygiene.** This research file is now layered with "superseded" notes. **Fix:** before coding, write a clean `docs/SPEC.md` that holds only the final decisions, as the single source of truth. DESIGN.md is distilled from it at the end.

### 16.4 Score (before and after the fixes above)
| Dimension | Now | After 16.3 fixes |
|---|---|---|
| Fit to the brief (fast, right, remembers when) | 9 | 9 |
| Data model and correctness | 8.5 | 9 |
| Latency design | 7 (unmeasured on free NVIDIA endpoints) | 8 |
| Reliability and failure handling | 6 | 8.5 |
| Security | 5 | 8 |
| Simplicity and scope | 5.5 | 8 |
| Testability and observability | 7.5 | 8.5 |
| Operability and DX | 8 | 8.5 |
| Cost | 9.5 | 9.5 |
| Docs as source of truth | 6 | 8.5 |
| **Overall** | **7.0 / 10** | **8.5 / 10** |

The remaining 1.5 points can only come from measurement: real p50/p95 latency, verifier accuracy, and eval scores once built.

## Sources
The full source lists are in the four research reports in this session. The key ones:
- Anthropic: multi-agent research system, Building effective agents, web search / memory tool docs.
- Perplexity: Search API architecture and Photon posts.
- Papers: LongMemEval (arXiv 2410.10813), Zep (2501.13956), Mem0 (2504.19413), Hindsight (2512.12818), FreshLLMs (2310.03214), SimpleQA (2411.04368), CRAG (2401.15884), Search-o1 (2501.05366), Search Arena (2506.05334), SPAgent (2511.20048).
- Provider docs: Exa (exa.ai/docs), Tavily (docs.tavily.com).
- Node: nodejs.org/api/sqlite.html.
- assistant: projectassistant.com.
