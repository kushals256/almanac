# SPEC: chat agent with web search

This file is the single source of truth for the build. It contains final decisions only. The reasoning, sources and rejected options are in `ARCHITECTURE_RESEARCH.md`.

The goal: **answer fast, get things right, remember what you asked and when.** The agent has one external tool, web search. Memory is the agent's own internal state, not a second tool.

## 1. Principles
1. **Code for certainty, models for judgement.** Code handles dates, recall, number checks, diffs, rate limits and deadlines.
2. **Cheapest, fastest check first.** The order is cache, then code, then a conditional GET, then search, then Jev, then an LLM. Each step escalates only when the previous one can't decide.
3. **Fail open to search, never to a confident guess.** State "as of" dates, hedge or withhold unsupported claims, and never cite a URL that wasn't retrieved.
4. **Every key required, no mock mode.** The app refuses to boot with a missing key and names that key.
5. **Built in tiers.** Core first, then signature, then stretch. Each tier is tested before the next one starts.

## 2. Providers and keys (all free tiers, all required)
| Env var | Provider | Job |
|---|---|---|
| `GROQ_API_KEY` | Groq (OpenAI-compatible) | Planner, answerer, extractor, prompt guard |
| `NVIDIA_API_KEY` | NVIDIA NIM (OpenAI-compatible) | Fallback for every model job |
| `EXA_API_KEY` | Exa | Primary search (`/search`) and page fetch (`/contents`) |
| `TAVILY_API_KEY` | Tavily | Search pool overflow and failover |
| `OPENROUTER_API_KEY` | OpenRouter Decisions API | Jev claim verifier |

**Model lineup** (from the 2026-11-12 bake-off). Each job has an ordered list. The first model available at boot is used, and the list fails over on 404, 429, 5xx or timeout:

| Job | Order |
|---|---|
| planner | groq `qwen/qwen3.8-27b` → groq `openai/gpt-oss-20b` → nvidia `nvidia/nemotron-3.5-bolt-e4b` |
| answer_quick (chat, quick) | groq `qwen/qwen3.8-27b` → groq `openai/gpt-oss-20b` → groq `openai/gpt-oss-120b` → nvidia `nvidia/nemotron-3-ultra-550b-a55b` |
| answer_deep (research, recheck, memory) | groq `openai/gpt-oss-120b` → groq `openai/gpt-oss-20b` → groq `qwen/qwen3.8-27b` → nvidia `nvidia/nemotron-3-ultra-550b-a55b` |
| extractor | groq `openai/gpt-oss-20b` → groq `qwen/qwen3.8-27b` → nvidia `nvidia/nemotron-3.5-bolt-e4b` |
| verifier | openrouter `typesafe/jev-1.14` → the planner chain |
| guard | groq `meta-llama/llama-prompt-guard-2-22m` → none (untrusted-data marking only) |

**Model choice:** each Groq model has its own 8k TPM budget, so the two answer jobs start on different models to spread the load. The picker follows chain order, and only skips a model whose expected wait plus typical TTFT is more than 1.5 s worse than the best option. Unused reserved tokens are refunded, and buckets are synced to Groq's `x-ratelimit-remaining-tokens` header.

**Rate budgets** are enforced by token buckets per (provider, model):
- Groq: 8,000 TPM and 1,000 RPD per model.
- NVIDIA: 40 RPM.
- Exa: 10 QPS on `/search` and 100 QPS on `/contents`.
- Tavily: 100 RPM.

Foreground calls (planner, answerer) have **70% of capacity reserved**. Background calls (extractor, verifier) only use what's left.

## 3. Request pipeline
```
POST /api/chat {sessionId, message, tz}
 0. guards: body ≤ 32 KB, zod validation, per-route deadline (chat 5 s, quick 10 s, research 45 s, recheck 45 s)
 1. persist the user turn (sync); resolveTemporal(message, now, tz) → date windows + backReference flag
 2. in parallel:
    a. recall: SQL date-window filter + FTS5 BM25 → turns, claims, collections (deterministic)
    b. planner (structured JSON) → {route, queries[{q, objective}], entities[], volatility, answerShape}
    c. speculative search (Exa `lite`) on the raw message. SKIPPED when backReference or chit-chat
 3. retrieve per route via SearchRouter (status SSE events as each lands)
 4. code rerank: canonicalise URLs, dedupe, official domains first, recency; keep ≤ 10 items with dates, ordered oldest→newest
 5. answerer (streamed): today's date + memory JSON + numbered evidence → answer in the route's shape, with [n] citations
 6. after the stream (background, low priority):
    a. code: every [n] maps to a retrieved source; split cited sentences into claims
    b. verifier: one Jev request per answer; numbers and dates are checked in code (quote anchoring), never by Jev
    c. extractor: entities, collections and quote-anchored values from the SOURCE pages
    d. write the ledger rows with their support status → SSE `verification` events (badges)
```
Planner errors fail open to `quick` with the raw message as the query. The answerer may call `web_search` at most once more if the evidence is thin.

**Routes:** chat (no search) · memory (log only) · quick (1–3 queries) · research (≤ 2 rounds × ≤ 4 queries) · recheck (per-entity change leg + news leg).

## 4. Memory and time
- **`resolveTemporal`:**
  - chrono-node plus our own rules, with an injected clock (`AGENT_NOW`, test-only).
  - "last <weekday>" returns **both** candidate dates.
  - A bare date that falls in the future is moved back one year.
  - "last week/month" expands to a range.
  - `forwardDate` is never used.
- **Storage:** one SQLite file (`node:sqlite`, WAL, versioned migrations).
  - **Append-only for facts:** turns and claims are never edited in place.
  - Derived index columns (summary, topics, FTS rows) may be filled in later.
- **Schema:**
  - `turns`, `turns_fts`
  - `entities`, `entity_mentions`
  - `collections`, `collection_items`
  - `claims` (with `support` = verified | unsupported | unchecked | pending, and `expires_at`)
  - `claim_sources`
  - `sources` (also serves as the search cache)
  - `verifications`
  - `search_cache`
- **Recall** always returns the raw turns in the matched windows, plus indexed collections and claims. When both "last Tuesday" windows hit, the most recent one is preferred and the answer says which date it used.
- **Turn status:** recall waits up to 2 s for in-flight post-processing of the same session.
- **Corrections:** a claim struck after the stream is never edited out of history. The next turn's memory JSON carries the verification note.

## 5. Search (`SearchRouter`, presented to the model as one `web_search` tool)
- **Jobs:**
  - `discover` → Exa `/search` `{query, objective, type:"auto", contents:{highlights:true}}`.
  - `bounded window` → same, plus `startPublishedDate` (news leg).
  - `refetch known URL` → Exa `/contents` with `maxAgeHours: 0` (change leg).
  - `speculative` → Exa `type:"lite"`.
  - `releases` → HN Algolia `search_by_date` (no key).
- **Pool:** Exa → Tavily. Spillover happens when a bucket is empty, or on 402/429/5xx. A circuit breaker opens per provider after repeated failures.
- **Batching:** the news leg for N vendors is batched where possible. Results stream per entity. Each turn has a hard cap of 40 search calls.
- **Cache:** results go in `sources` keyed by hash(provider, normalised query, filters, date bucket). TTL comes from volatility. Re-checks bypass the cache.
- **Safety:**
  - All fetched text is wrapped as untrusted data.
  - Direct fetches use the SSRF-safe fetcher: http(s) only, private/loopback/link-local ranges blocked, each redirect hop revalidated, 5 s timeout, 2 MB cap.
  - Prompt Guard runs on fetched snippets.

## 6. Re-check ("is it still correct?" / "changed since…?")
1. Load the claims and collections from the matched turns. If there are no ledger rows, read the raw turn.
2. Per entity, in parallel:
   - **change leg:** re-fetch the stored URL (Exa `/contents`, live).
   - **news leg:** dated search since the original turn, plus HN.
3. **Diff cascade:** compare normalised text hashes (same fetcher only), then the extracted fields. Only after that does an LLM label the change.
4. **Verdicts:** Unchanged · Changed (with dates) · Unverifiable · Source gone.
5. **Output:** a summary line, then a then-vs-now table with the columns *Item · Then (date) · Now (date) · Verdict · Evidence*, then notable releases.
6. **Stretch:** a Wayback CDX baseline when there are no ledger values, under a 2.5 s budget.

## 7. Answer shapes
| Route | Answer shape |
|---|---|
| quick | A 1-line answer, then 1–2 lines of context with [n] citations and an "as of" date |
| research | A 1-line verdict, then a table, then caveats |
| recheck | A summary line, then the then-vs-now table |
| memory | "On Tue 3 Nov you asked: '…'" + the answer given then + its status now |
| no record | "I have no conversation from 3 Nov", followed by the nearest dates that do have history |

The date interpretation is always stated.

## 8. Server and UI
- **Server:** Hono on `127.0.0.1:3000`, with SSE on `POST /api/chat`.
- **SSE events:** `status`, `sources`, `memory`, `token`, `verification`, `done{timings, route, models, cost}`, `error`.
- **Other routes:** `GET /api/history`, `GET /stats` (p50/p95, quota remaining), `GET /health` (keys, models, quotas).
- **UI:** a single static page. It shows status lines, citation chips and verification badges.

## 9. Tiers
| Tier | Contents |
|---|---|
| **Core** | config/boot checks · limiter · LLM client with fallbacks · resolveTemporal · store + recall · planner · SearchRouter (Exa, Tavily, HN) · answerer streaming · recheck table · quote-anchored number checks · deadlines · server + UI |
| **Signature** | speculative search · Jev verification + badges · extractor + ledger · prompt guard · search cache |
| **Stretch** | Wayback fallback · learned expiry · ETag revalidation · three-signal confidence calibration |

## 10. Tests
- **Unit tests** (`node:test`): resolveTemporal, quote anchoring and money normalisation, SSRF guard, limiter, citation check, recall.
- **Eval:** the three brief queries plus the "no record" case run as multi-turn scripts against the live app, recording p50/p95 latency.
