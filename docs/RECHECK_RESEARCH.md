# Recheck redesign: research and proposal

Status: proposal (no source files changed). Date: 2026-11-12.
Scope: the `recheck` route ("is the answer you gave me earlier still correct?", "has pricing changed since Monday?").

---

## 0. TL;DR

The current recheck asks one large model call to do five jobs at once: work out what the earlier answer claimed ("then"), find the current value in about 12 reranked highlight snippets ("now"), pick a citation, choose a verdict, and write a summary. Code then admits the result after the fact. Every observed failure comes from that one design choice. Code can only veto, and the checks it vetoes with are bag-of-numbers checks.

**Proposal: Claim Re-observation.** A recheck stops being "search again and ask the model to compare". It becomes *re-observe each earlier claim at its own source, then diff in code*:

1. **Observable claims.** Every factual cell or sentence in an answer is stored as a typed EAV record: entity, attribute, a qualifier key (plan, cadence, unit, region, promo), the value, the exact span in our answer, the exact quote in the source, and a **re-observation recipe** (URL, heading path, label, which fetcher worked). Turns that have no such records yet (legacy or seeded history) are backfilled lazily at recheck time, with the same span-anchored extraction.
2. **Re-observation ladder per claim.** The ladder is the claim's own URL via Exa `/contents` `text` (cache age tied to the claim's age, not `maxAgeHours:0`), then the r.jina.ai rendered fetch for JS pages, then one targeted search. All claims run in parallel.
3. **Locate in code first.** (a) *Quote survival*: the old quote is still on the page, so the claim is Unchanged, with proof. (b) *Anchor window*: find the label under the same heading and parse the value with its qualifiers. (c) Only if both fail, a small model **selects** a line ID and value substring from a numbered window. It never types a fact. Code checks that the substring exists, and the citation is the line's source **by construction**.
4. **Typed comparator in code.** It compares money, version, date, name and boolean values only under the same qualifier key. It applies precision-aware tolerance ("about $60" equals $59.99) and knows promos, cadence and pricing-model changes. Jev is used only for semantic equivalence: plan renames, and whether a non-numeric claim is still supported.
5. **Code writes the answer.** The table, the counts, the summary sentence (a template over the diff) and the "since" list (dated headlines quoted verbatim) are all written by code. The model writes no prose that contains figures.
6. **Bitemporal ledger.** Each recheck appends an observation, and a changed claim is superseded (`valid_from` / `invalid_from`, Graphiti-style). The next recheck is cheaper and can say *when* a value was last seen.

Expected effect: problems 1, 2 and 4 are removed by construction, and problems 3, 5 and 6 are reduced to measurable residuals. A typical recheck should use roughly 0–2.5k LLM tokens, against about 6–8k today, and 3–6 web calls, against 15–21. Expected latency is about 2–4 s, with a worst case near 7 s when a JS-rendered page needs the Jina fallback.

---

## 1. Evidence I collected (beyond the brief)

### 1.1 Latest held-out results (16 recheck rows, `results-heldout2-final`)

Only 3 of 16 pass. Grouped by cause:

| Cause | Rows | Example |
|---|---|---|
| Target never resolved: "no record", or routed to `quick` | 6 | "stil good on that noiton price?" → "can't find…"; "monday keyboard prices" → no record (the stored topic was "budget mechanical keyboard"); "central bank figure … last weekend" → `quick` |
| Uncited model summary sentence flagged | 4 | "rose from $9.99 to $12.99 per month." (above the table) |
| Wrong citation for "now" | 1 | US $12.99 cited to a quietlychanged.com article about a Pakistan Audiobooks+ launch |
| False "Changed" on rounding | 2–3 | "$60 → $59.99 … Changed", with a summary saying "remains effectively the same" |
| Mixed-cadence comparison | 1 | Then "$10 annual or $12 monthly", now "$10" → **"1 of 1 changed … remains $10"** (and the judge still passed it) |
| Model-written direction contradicts the figures | 1 | "lowered to 3.75–4.00%" in the summary, "FOMC **raised** … to 3.75%–4.00%" in the launches list |
| Wrong `since` / wrong target turn | 1 | "the earlier notion quote" → 8 turns listed, "since Mon 26 Oct" (the CI/CD turn) |

Two findings are not in the brief's list:
- **Problem 0, target resolution, causes the largest share of failures (6 of 13).** The recheck mechanism never ran in those cases.
- **Judge leniency.** A self-contradictory row ("1 of 1 changed … remains $10") passed. Any new evaluation needs code-level row checks, not only an LLM judge (see §8).

The eval harness also seeds history as **raw text turns with no sources and no claims** (`evals/realworld/run.ts:46`, `:181`). The current eval therefore always exercises the "no ledger" path. Whatever design we pick, the **legacy backfill path is the one that gets measured**.

### 1.2 Live probes of real pricing pages (run today)

| Probe | Result |
|---|---|
| Raw HTML GET, 10 SaaS/consumer pricing pages (Spotify, Notion, HubSpot, Pipedrive, Supabase, Neon, Salesforce, Zoho, Freshworks, Keychron) | **0 of 10 contain schema.org `Offer` / `PriceSpecification` JSON-LD.** The JSON-LD found was `BreadcrumbList`, `FAQPage`, `Organization` and `WebPage`. 7 of 10 have prices in the raw HTML. HubSpot and Pipedrive have none (rendered client-side). |
| Exa `/contents`, `maxAgeHours:0`, `livecrawlTimeout:6000`: HubSpot, Pipedrive, Notion | 6.35 s. HubSpot **`CRAWL_EMPTY_CONTENT`**, Notion **`CRAWL_LIVECRAWL_TIMEOUT`**, Pipedrive OK. |
| Exa `/contents`, `maxAgeHours:24`: HubSpot, Notion, Spotify | **0.91 s**. Notion (11.8k chars, "### Plus \| $10 per member / month") and Spotify ("$0 for 1 month, then $12.99 per month after. Offer only available if…") OK. HubSpot still empty. |
| Exa `maxAgeHours:-1` (cache only) | 0.35 s, same content. HubSpot `CONTENT_NOT_CACHED`. |
| `r.jina.ai` (no key): HubSpot, Pipedrive | 5–6 s each. **Prices rendered** ($20, $90, $100, $150 …; Pipedrive $14, $16, $32.50 …). |
| HTTP headers, notion.com/pricing | No `ETag`, `cache-control: max-age=0`, so conditional GET gives us nothing. |

Conclusions:
1. `maxAgeHours:0` is the main cause of problem 3. It is slow and fails on exactly the pages we need. Freshness only has to be newer than the claim being checked.
2. The JSON-LD fast path is real for e-commerce product pages, but nearly absent on SaaS pricing pages. Treat it as an opportunistic bonus, not a pillar.
3. Exa and Jina both return markdown with headings. A *heading path + label* address therefore works across fetchers. That address is the markdown equivalent of the CSS selector a page monitor would use.
4. A JS-render fallback exists for free (Jina: about 20 RPM without a key, `x-engine: browser`). It costs 5–6 s, so it belongs only on the claims that need it, hedged and in parallel.

### 1.3 Code-level root causes found while reading

- `checkNumbers` (verify.ts) proves a figure if it occurs **anywhere** in the cited evidence, **or if it can be derived** as a×b, a+b or a×b×12 from up to 200 numbers in the pool, with "12" always added. With a large pool, almost any price is "derivable": for example, 12.99 = 12 + 0.99. The proof is close to vacuous. Wrong-citation rows pass it.
- `admitRows` compares then and now as **sorted sets of all numbers in the cell**. "$10 annual or $12 monthly" against "$10" therefore counts as different. Approximate values ("about $60") count as different from $59.99.
- `refetch` asks Exa for `highlights` with a fixed generic focus ("pricing plans prices per month features limits"). Highlights are a model-chosen excerpt and can omit the figure. Then `rerank` caps evidence at 12, with 600 chars each, mixed with news.
- The claims ledger is written *after* display, from the verifier's sentence split (`insertClaims`). It has no entity, attribute, value or quote and no URL-level anchor. `entity_id`, `attribute`, `value_num`, `unit`, `evidence_quote` and `verifications` are never populated. The extractor job is configured in `config.ts` but never called.
- `since = min(hits.local_date)`, which takes the earliest of *all* recalled turns rather than the turn being rechecked.

---

## 2. Root-cause analysis (one level below the symptoms)

| # | Symptom | Proximate cause | Root cause |
|---|---|---|---|
| 0 | No record / wrong route / wrong `since` (the largest group) | Lexical recall on topic words; `since` taken from all hits | A recheck has no **target object**. Recall returns turns, not the claims the user is asking about. Typos ("noiton") and paraphrase ("keyboard prices" vs "budget mechanical keyboard") miss the FTS index, and nothing indexes the *subjects* of past answers. |
| 1 | Uncited summary sentence | The model writes `summary` free-form | **The model is allowed to state facts in prose.** Anything a model writes with figures needs post-hoc proof, and prose summaries are uncited by nature. |
| 2 | Wrong evidence cited for "now" | The model picks `cites`; code only checks that the numbers exist somewhere in them, with permissive derivations | **The citation is chosen separately from the value.** Value and source are two outputs, so they can drift apart. Proof is bag-of-numbers, not *span-bound* to entity, plan and region. |
| 3 | "Now" unverifiable; 15–21 searches; 4–10 s | `maxAgeHours:0` failures and timeouts; highlights miss the figure; rerank cap drops the right page; one search per entity plus official-page queries plus news | **"Now" is searched for, not re-observed.** We usually know where the fact lived (the URL we cited), and often where on the page (label, heading). We throw that away and search again, then hope the reranker and the model find it. Freshness is set to the maximum (live crawl) instead of to what the question needs. |
| 4 | "Then" re-read from free text | The ledger has no structured values; recheck passes `answer_then` (1,500 chars) to the model | **Claims are not captured as data at answer time.** The ledger stores sentences and support status. It has no entity, attribute, qualifier, value, quote or URL, so code has nothing to diff. |
| 5 | Promo, cadence, plan-rename and pricing-model confusion | Comparison of whole cells, or of number sets | **Values are untyped and unkeyed.** A price is only comparable under the same key (entity, plan, metric, cadence, unit, region, list-vs-promo). Without that key, "different numbers" and "different thing" look the same. |
| 6 | Entities missing, so rows are empty or wrong | The planner names none; `entitiesFromHistory` parses table first columns | **Entities are guessed from text instead of being the subjects of stored claims.** If claims were records, the recheck's entities *would be* the claims' subjects by definition. |

One sentence covers all six: **today the recheck is a generation task with after-the-fact policing. It should be a verification task over stored, typed claims, in which the model only chooses between options that code has already grounded.** This is the same move that took fact verification from free generation to the FEVER framing (SUPPORTED / REFUTED / NOT ENOUGH INFO maps directly to Unchanged / Changed / Unverifiable), and from post-hoc citation (RARR) to attribution by construction.

---

## 3. What the research says, and what to borrow

| Area | What it does | Borrow | Don't borrow |
|---|---|---|---|
| **Zep / Graphiti** temporal KG ([paper, arXiv 2501.13956](https://arxiv.org/abs/2501.13956); [Graphiti repo](https://github.com/getzep/graphiti); [field semantics review](https://zby.github.io/commonplace/agent-memory-systems/reviews/graphiti/)) | Every fact edge has `valid_at` / `invalid_at` (world time) plus `created_at` / `expired_at` (system time). Contradicting facts invalidate older edges instead of deleting them, and an LLM decides on invalidation against similar edges. | Bitemporal columns on our claims plus an append-only observation log. We already have `superseded_by` and append-only rules (SPEC §4). | An LLM judging contradictions per edge: too costly on 8k TPM, and weak models get it wrong. Our comparator decides this in code, under the qualifier key. |
| **Mem0** ([arXiv 2504.19413](https://arxiv.org/abs/2504.19413); [v3 ADD-only note](https://levelup.gitconnected.com/choosing-an-ai-agent-memory-layer-lessons-from-mem0s-evolution-from-fde-pov-8b1268fa8735)) | LLM chooses ADD / UPDATE / DELETE / NOOP per memory. Later versions dropped the UPDATE/DELETE decision and went **ADD-only**. | Evidence that LLM-decided memory mutation is fragile in production. Append-only observations are the robust choice. | LLM mutation decisions. |
| **Hindsight** ([arXiv 2512.12818](https://arxiv.org/abs/2512.12818)) | Separates *world facts* from *opinions* (with confidence), and recall combines vector, BM25, entity graph and temporal filters. Reports 83.6% on LongMemEval with a 20B open model. | Split "observable facts" (re-checkable) from "recommendations" (opinions, re-evaluated, never "Changed"). An entity index plus temporal filter for target resolution (problem 0). | The full four-network system. |
| **LongMemEval** knowledge-update category ([arXiv 2410.10813](https://arxiv.org/abs/2410.10813); [site](https://xiaowu0162.github.io/long-mem-eval/)) | Knowledge-update and temporal reasoning are the hardest categories. Time-aware indexing and query expansion improve temporal recall by 7–11%. | Index claims by subject and time, and resolve the target from that index. | — |
| **FreshQA / FreshPrompt** ([arXiv 2310.03214](https://arxiv.org/abs/2310.03214)) | Models fail most on fast-changing facts and false premises. The number and **order** of evidence matter, and concise answers reduce hallucination. | Give the model less and better-ordered evidence: one window per claim, not 12 mixed snippets. | — |
| **FEVER / Attributed QA / AutoAIS** ([Bohnet et al., arXiv 2212.08037](https://arxiv.org/abs/2212.08037)) | Attribution is measured as NLI between the cited passage and the claim. | Our Jev "is the claim still supported by this passage" question is an AIS check. Use it for **non-numeric** claims only (Jev is weak at numbers). Use AIS as an eval metric (§8). | — |
| **RARR** ([arXiv 2210.08726](https://arxiv.org/abs/2210.08726)) | Post-hoc: research the evidence, then revise the unsupported text. | The "research → agreement → revision" loop maps onto "re-observe → compare → render". | Post-hoc revision of model prose. We avoid writing that prose in the first place. |
| **Page monitors**: changedetection.io ([restock/price processor](https://www.mintlify.com/dgtlmoon/changedetection.io/features/restock-price-monitoring), [processors](https://www.mintlify.com/dgtlmoon/changedetection.io/advanced/processors)), Visualping, Exa Monitors ([docs](https://exa.ai/docs/websets/api/monitors/create-a-monitor.md)) | They watch a **filtered region** of a page (CSS/XPath/JSONPath), not the whole page, because whole-page hashes change on every load. The price processor reads JSON-LD, microdata or OpenGraph and advises text filters when a page has several prices. Exa Monitors run scheduled searches (at most daily) and push to webhooks. | **Region-scoped comparison**: our heading path plus label is the filter, and "quote survival" is a region hash. JSON-LD only as an opportunistic first try for product pages. | Whole-page hashes (SPEC §6.3 "normalised text hashes") produce false "changed" signals on pricing pages. Scheduled monitors burn the free quota on claims nobody re-asks about (see candidate D). |
| **schema.org pricing** ([UnitPriceSpecification](https://schema.org/UnitPriceSpecification), [billingDuration](https://schema.org/billingDuration), [Google merchant listing](https://developers.google.com/search/docs/appearance/structured-data/merchant-listing), [SaaS JSON-LD example](https://docs.limio.com/labs/ai-and-agent-discovery/json-ld-schema)) | `Offer.priceSpecification` → `UnitPriceSpecification {price, priceCurrency, unitCode: MON/ANN, billingDuration}`. | Use its vocabulary as our qualifier model: currency, unit code, billing duration, reference quantity (per seat). | Relying on it being present: 0 of 10 SaaS pages had it (§1.2). |
| **Exa Contents** ([contents guide](https://exa.ai/docs/reference/contents-api-guide-for-coding-agents.md), [livecrawl/freshness](https://exa.ai/docs/reference/livecrawling-contents.md)) | `text` (markdown, `maxCharacters`), `highlights` (query-focused), `summary` (optional JSON `schema`). `maxAgeHours` 0 = live, N = cache newer than N h, −1 = cache only. `livecrawlTimeout` defaults to 10 s. Per-URL `statuses` with error tags. | Use `text`, not highlights, for re-observation; we do the locating. `maxAgeHours` = f(claim age). Read `statuses` to choose the next ladder rung. | `summary.schema` as the extractor: it is an unattributed LLM summary, the same problem one layer down. |
| **Jina Reader** ([jina.ai/reader](https://jina.ai/reader); [README](https://cdn.jsdelivr.net/gh/jina-ai/reader@main/README.md)) | `https://r.jina.ai/<url>` renders JS (`x-engine: browser`) and returns markdown. Free without a key at about 20 RPM (figures vary by source; [Spider comparison](https://spider.cloud/blog/spider-vs-jina-reader/)). | Rung 2 of the fetch ladder for pages Exa returns empty. The recipe remembers that a domain needs it. | Using it as rung 1: 5–6 s. |
| **Wayback** ([Wayback API](https://archive.org/help/wayback_api.php); [CDX server](https://github.com/internetarchive/wayback/blob/ARI-4010/wayback-cdx-server/README.md)) | Closest-snapshot lookup; 3–7 s in our tests. | Background only: bracket *when* a change happened, or build a "then" baseline for legacy turns that have no answer value. | The foreground path. |

---

## 4. Candidate architectures

### A. Harden the current design (better evidence, quoted spans, code-written summary)

**Flow:** same planner and searches. The refetch uses `text` with `maxAgeHours:24`. Rerank keeps one window per entity. The model returns rows with `now_quote` (a substring of the cited evidence) and `then_quote` (a substring of the earlier answer). Code verifies both substrings, parses figures from the quotes, and writes the summary from the rows.

- **Model does:** extracts then and now with quotes, plus the verdict hint. **Code does:** substring checks, number parsing from quotes, verdict, summary, counts.
- **Budget:** about 5–7k tokens per recheck on gpt-oss-120b (evidence and memory still go in one call); 10–15 searches; 4–7 s.
- **Failure modes:** wrong citations become rare (the quote must be in the cited source), but the model can still quote the *wrong plan or region*. Evidence still comes from search plus a cap, so "now" is still often missing. There is no memory of where facts live. One call per recheck uses most of a minute's 8k TPM.
- **Generalises?** Yes, nothing is wording-specific. But it reaches the quality ceiling of "search then read".
- **Cost:** about 1 day. **Verdict: a good stopgap, and every piece of it is reused in C.**

### B. Re-answer and diff

**Flow:** re-run the original question through the normal research pipeline, extract claims from the old and new answers, align them (entity + attribute), and diff.

- **Model does:** a full new answer, plus claim extraction twice. **Code does:** alignment and diff.
- **Budget:** a full research answer (about 6–8k tokens) plus 2 extractions (about 2k), with 8–12 searches. 6–12 s. This is too slow for the 8 s target and doubles Groq spend.
- **Failure modes:** the new answer may cover *different* items or plans (search drift), so alignment fails and items show as "gone" or "new". Any error in the new answer is reported as a "change". It doesn't use the knowledge of where the facts lived.
- **Generalises?** Very well across domains, since it needs no claim schema. **Verdict: keep it as the last-resort fallback** when an earlier answer yields no extractable claims (pure recommendations), with the diff limited to "recommendation still holds / what's new".

### C. Claim Re-observation (recommended; detailed in §5)

**Flow:** typed, quote-anchored claims with recipes (captured at answer time, or backfilled), then a per-claim fetch ladder in parallel, code-first location, a model selection step only on misses, a typed comparator, code-rendered output, and an appended observation.

- **Model does:** (1) backfill extraction for legacy turns, where it *selects spans* of the old answer. (2) Span selection in a numbered window when the code anchor fails. (3) Jev yes/no for renames and for non-numeric support. **Code does:** everything that states a fact, a number, a date, a citation, a verdict or a count.
- **Budget:** 0 tokens when every claim resolves in code (common for pages fetched before). Typically about 1–2.5k on gpt-oss-20b / qwen, plus 1–6 Jev calls. Uses 2–6 Exa calls (100 QPS on `/contents`), 0–2 Jina calls, and 1 batched news search per entity. 2–4 s typical, about 7 s worst case.
- **Failure modes:** listed in §5.10, each with a fallback.
- **Generalises?** The mechanisms work on *types of claims* (money, number+unit, version, date, name, boolean) and *page structure* (headings, labels), never on question wording or vendors.

### D. (Rejected for now) Background monitoring

Re-observe high-volatility claims on a schedule, so a recheck becomes a database read plus confirmation. Latency would be excellent. But it spends the free daily quotas (Groq 200k tokens/day/model, Jina 20 RPM, Exa) on claims nobody may ask about, and it adds a scheduler. **Keep one cheap piece:** right after an answer, validate each new recipe once in the background (re-locate the value from the page we already have). A broken recipe is then fixed while the evidence is fresh, not during the user's recheck.

---

## 5. Recommended design: Claim Re-observation

### 5.1 The data model: observable claims

New migration (v4). This is additive and append-only, consistent with SPEC §4.

```sql
-- One row per atomic, re-checkable statement in an answer (or backfilled from an old answer).
ALTER TABLE claims ADD COLUMN kind TEXT;            -- 'observable' | 'opinion' | 'sentence' (legacy rows)
ALTER TABLE claims ADD COLUMN qual_key TEXT;        -- canonical qualifier key, see 5.3 (plan|metric|cadence|unit|region|tier)
ALTER TABLE claims ADD COLUMN value_type TEXT;      -- money | number | version | date | name | bool | text
ALTER TABLE claims ADD COLUMN value_json TEXT;      -- parsed value {amount, currency, period, perUnit, approx, promo, ...}
ALTER TABLE claims ADD COLUMN answer_span TEXT;     -- exact substring of OUR answer (the "Then" cell, by construction)
ALTER TABLE claims ADD COLUMN recipe_json TEXT;     -- how to re-observe, see 5.2
ALTER TABLE claims ADD COLUMN valid_from TEXT;      -- world time the value was observed true (source date or fetch date)
ALTER TABLE claims ADD COLUMN invalid_from TEXT;    -- set (by a NEW row's observation) when superseded
-- existing: entity_id, attribute, value_text, value_num, unit, currency, evidence_quote, as_of_date, superseded_by

CREATE TABLE observations (            -- append-only re-observation log (replaces the unused `verifications`)
  id INTEGER PRIMARY KEY,
  claim_id INTEGER NOT NULL REFERENCES claims(id),
  observed_at_utc TEXT NOT NULL,
  source_id INTEGER REFERENCES sources(id),   -- the fetched page this observation is bound to
  fetcher TEXT,                               -- exa-cache | exa-live | jina | search | wayback
  locate TEXT,                                -- quote-survived | anchor | model-select | none
  quote TEXT,                                 -- exact substring of the fetched text
  value_json TEXT,
  verdict TEXT CHECK (verdict IN ('unchanged','changed','unverifiable','source_gone','not_comparable')),
  note TEXT
);
CREATE INDEX claims_entity ON claims(entity_id, attribute);
```

`entities` (already in the schema, unused) gets a trigram/alias index. This is the subject index for problem 0: "noiton" → Notion, "kb" → keyboard.

### 5.2 The re-observation recipe

```jsonc
{
  "url": "https://www.notion.com/pricing",      // the page the quote came from (canonicalised)
  "fetcher": "exa",                              // which rung produced the text last time ("jina" for JS-rendered domains)
  "headingPath": ["One tool to run your company.", "Plus"],   // markdown heading chain above the quote
  "label": "Plus",                               // the nearest label token(s) to the value
  "ordinal": 0,                                  // which money/number token after the label (0 = first)
  "contextBefore": "### Plus |", "contextAfter": "per member / month",
  "discover": { "q": "Notion Plus plan price per member", "officialDomain": "notion.com" } // rung-3 search
}
```

Recipes are produced **by code** from the quote location. The verifier already locates figures in the cited evidence, so we keep *where* it found them instead of just a yes/no. Both Exa and Jina return markdown with `#` headings, so the address works across fetchers. Page-monitor tools use CSS selectors because they own a browser. We don't, and markdown heading paths are the robust equivalent.

### 5.3 Typed values and the qualifier key (problem 5)

Code parses each value span; no model is involved. The parse covers:
- **money:** amount, currency, `period` (month / year / one-off / usage unit such as "per CU-hour" or "per GB"), `perUnit` (seat / user / member / host), `billing` (monthly / annual, from "billed annually"), `approx` ("about", "~", "around", "from", "starting at"), `promo` ("for N months, then", "first", "intro", "% off", "limited time", "was $X", "only available if you haven't tried").
- **number+unit:** for example "8 GB", "3.75–4.00%".
- **version:** semver-like.
- **date**, **name** (person or company), **bool** (available / discontinued).

The **qualifier key** is `entity | plan | metric | billing | perUnit | region`. Comparison happens only between observations with the same key. Rules (all code):

| Situation | Rule |
|---|---|
| Same key, values equal (after normalisation) | Unchanged |
| Same key, then `approx` or integer and now within the then-value's precision (±1 unit of the last significant digit, or ≤2%) | **Unchanged** (note: "same, rounded"). Fixes $60 → $59.99. |
| Same key, values differ beyond tolerance | **Changed**, with direction and % computed by code (↑ $9.99 → $12.99, +30%) |
| Now span is a promo and then wasn't | Look for the non-promo price in the same window ("then $12.99 per month after"). If it is found, compare that. Otherwise **Not comparable** (note: "only a promo price shown"). Fixes F-13. |
| Then had several cadences ("$10 annual / $12 monthly"), page shows one | Compare the matching cadence. The other is "not shown on page" (Unchanged for what is shown, with a note). Fixes the Notion row. |
| Then `period=month`, now only usage units for that plan | **Changed: pricing model** ("flat $5/mo → usage-based, $0.106 per CU-hour"). Fixes F-57 generally. |
| Plan label not found, but a heading at the same position or ordinal has another name | Jev noul: *"Does this passage indicate that the plan previously called '{old}' is now offered as '{new}' (renamed or replaced)?"* Yes → compare under the new label, note "renamed". No → Unverifiable. |
| Non-numeric claim (CEO, "Node 22 is LTS", "feature X available") | Jev AIS: *"Does the passage support: '{masked claim}'?"* Yes → Unchanged; no plus an extracted contrary span → Changed; otherwise Unverifiable. |

Verdicts stay the four the UI knows. `not_comparable` renders as "Unverifiable (only a promo shown)" so the answer stays honest.

### 5.4 Capture at answer time (problem 4)

This runs after the stream, in the background, alongside the existing verifier. Sources:
1. **Table rows (code only).** Entity = first cell, attribute = column header, value span = cell text, and citations come from the row. The verifier's number proof is changed from *bag-of-numbers* to *locate*. For each figure it returns `{evidenceIndex, offset}` of the occurrence **nearest a token of the entity or plan label**. From that location, code builds `evidence_quote`, `headingPath`, `label` and `ordinal`.
2. **Sentences with figures or named facts.** One extractor call (the `extractor` job: gpt-oss-20b → qwen, background priority, about 800–1,200 tokens) returns `[{entity, attribute, answer_span, cite}]`. `answer_span` **must be a substring of the answer** (checked in code; dropped otherwise). Values are then parsed and located by code as in (1).
3. **Recommendations / opinions** ("Best for small teams: Pipedrive") are stored as `kind='opinion'`. They are never marked "Changed". A recheck re-evaluates them only through B-style "still holds?" prose, clearly labelled as judgement.

Note the evidence we persist today is ≤4,000 chars of highlights. That is enough for the quote and context. Full page text is not needed, because the recipe points back to the live page.

### 5.5 Lazy backfill for legacy turns (the path the eval actually measures)

When the target turn has no `observable` claims (seeded history, or turns from before the migration):
1. **Extract from the old answer**, using one extractor call with the same span-selection contract. The input is the old answer (≤1,500 chars) with numbered lines. The output is `[{line, entity, attribute, answer_span}]`. Code checks each span is a substring of that line, so the "Then" cell is our earlier answer's own words by construction. About 1k tokens and about 0.6–1.2 s on gpt-oss-20b. It runs **in parallel with** the news leg and discovery.
2. **Recipe without a URL:** use the stored sources of that turn if any (`turn_sources`). Otherwise run one *discovery* search per entity (Exa `/search` with `contents.text`, `numResults: 3`, objective "official pricing/spec page of {entity}") and keep the result on the entity's official domain (domain matched to an entity token, as `rerank` already does).
3. Persist the backfilled claims and recipes, so the second recheck of the same turn takes the fast path.

### 5.6 The recheck flow

```
t=0     resolve target (5.8)  →  claims C1..Cn (ledger or backfill), since = target turn's date
t≈0.1s  emit preamble "On Mon 9 Nov you asked: …" + status "Re-checking 5 items at their sources"
        ┌──────────────── per claim, in parallel (mapLimit 8) ─────────────────┐
        │ rung 1  Exa /contents {urls:[recipe.url], text:{maxCharacters:40k},  │
        │         maxAgeHours: clamp(hoursSince(claim.valid_from)-1, 0, 24),   │
        │         livecrawlTimeout: 3000}            ~0.4–1.5 s               │
        │   status error/empty, or locate fails ─► rung 2 Jina r.jina.ai      │
        │         (started immediately if recipe.fetcher=='jina'; 6 s cap)     │
        │   still nothing ─► rung 3 recipe.discover search (text) ~1–2 s      │
        │ locate:  (a) quote survival  (b) anchor window  (c) model-select     │
        │ compare: typed comparator (5.3), Jev only for renames / non-numeric │
        │ emit status "Notion Plus: unchanged" as each claim settles          │
        └─────────────────────────────────────────────────────────────────────┘
        news leg (parallel): per entity, Exa /search startPublishedDate=since, + HN
t≈2–4s  render (code): count line, summary-from-diff, table, "Since <date>" headlines
        append observations; supersede changed claims (invalid_from = observed_at)
```

**Freshness rule.** The question is "changed since T₀?", so the observation only needs to be newer than T₀. `maxAgeHours = clamp(hours since the claim's valid_from − 1, 0, 24)` serves from cache in under 1 s in the common case (§1.2). It uses a live crawl only for claims made in the last hour. The "Now" column states the observation date honestly ("Now (≤ 12 Nov)"), using the fetch date of a cached copy when Exa provides it.

**Locate (code first), in order:**
- **(a) Quote survival.** The normalised `evidence_quote` (whitespace and case folded, digits kept) occurs in the new text. The verdict is **Unchanged with proof**: the quote is the evidence, and the citation is this fetch. Zero tokens. Since the stored quote is about 120 chars around the value, this works like a region hash, not a whole-page hash, so unrelated page churn doesn't matter.
- **(b) Anchor window.** Find `headingPath` (fuzzy: last heading exact, parents optional), else `label`. Take the window from that point to the next heading of the same level, at most 600 chars. Parse typed values in the window. Pick the token at `ordinal`, or the one whose qualifiers match the claim's key. Require an entity or plan token inside the window (this is the "span-bound" proof that fixes problem 2).
- **(c) Model select.** Only when (a) and (b) fail. Cut the best window candidates from the new text: up to 3 windows around entity, label or attribute tokens, at most 1,500 chars total. Number the lines. Ask the extractor model: *"Which line states {entity} {attribute} ({qual key in words})? Return {line, value_substring} or null."* Code checks the substring is in that line and parses it. The citation is that page. Claims that need this step are **batched into one call** (about 300 tokens per claim).

**JSON-LD bonus (product pages).** If the fetcher returned HTML (raw GET for Shopify-style product pages) and it contains `Offer.price` / `priceSpecification`, use it as a typed observation with `locate='jsonld'` before (b). It costs one regex. Expect it to fire on e-commerce pages (keyboards, headphones) and almost never on SaaS.

### 5.7 News leg ("shipped something big since?")

- Per entity: one Exa `/search` with `startPublishedDate = since`, the objective as today, highlights on, `numResults: 5`. Plus HN `search_by_date`. Batch entities when there are 4 or more.
- **Code** filters to `publishedAt ≥ since`, dedupes by canonical URL, and keeps a result only if its title or highlight names the entity (token match).
- **Jev** (one batched request, one noul question per item, about 0.5 s): *"Does this headline/excerpt announce a pricing change, plan change, or major product launch by {entity}?"*
- **Rendered verbatim:** `2026-11-10 — <source title> [n]`. The headline is the source's own words. No model paraphrase means no "raised vs lowered" contradictions.
- A news item that *is* a pricing announcement for an item in the table gets attached to that row as supporting dated evidence ("Changed on 10 Nov per [n]"). That gives the *when* that a page re-observation alone can't.

### 5.8 Target resolution (problem 0, the biggest failure group)

The recheck's subject should be the **claims**, not the turns:
1. Build the subject index: `entities` with aliases, linked to claims. It is filled by capture and backfill, and seeded once from old answers (table first columns plus the extractor) for existing history.
2. Resolve the message to subjects by: exact or alias match → trigram similarity ≥ 0.4 (catches "noiton") → semantic recall (already built: `SemanticRecall`, NIM embeddings) over *claim subjects + attributes*, not only turns ("keyboard prices" ↔ "budget mechanical keyboard … Keychron K2 $79").
3. Intersect with the date window when one is given ("last weekend" → Sat–Sun). If the window is empty but a subject match exists *outside* it, use that match and say so, instead of replying "no record".
4. `since` = the target turn's date, never `min(all hits)`. The "On … you asked" preamble lists only target turns.

This is general: it is fuzzy entity linking plus a time filter (the LongMemEval and Hindsight lesson), with no new phrase rules.

### 5.9 Rendering (problems 1 and 2 by construction)

All text containing a fact is produced by code from the observations:
- **Count line:** "**1 of 2 changed since Mon 9 Nov; 1 couldn't be checked.**"
- **Summary from the diff,** using a small template set: `"{entity} {plan}: {then} → {now} ({+30%}) [n]"` for the most important change (largest relative change, then pricing-model changes, then renames). Otherwise "Everything I could check matches what I told you on {date}." The citation is the observation's source.
- **Optional "so what" sentence from the model,** under a hard rule: **no digits, no currency symbols, no dates** (code rejects it otherwise and keeps the template). Example: "If you're budgeting for Spotify, the individual plan is the one that moved." It stays human and can't add an uncited fact. It is generated in parallel with the last fetches, so it adds no latency.
- **Table:** Item | Then (date): the stored `answer_span` | Now (date): the observed quote's value with its qualifiers | Verdict (+ note) | Evidence: the one source the value was extracted from. The "Then" column needs no citation, because it is our own earlier answer and the preamble says so.
- **Since list:** dated headlines (5.7).
- The post-display verifier continues to run, but for the recheck route the row claims are already **pre-verified**: `locate` and `quote` are attached, so the verifier marks them verified-by-construction and only checks the optional "so what" sentence and the headlines with Jev.

### 5.10 Failure modes and honest fallbacks

| Failure | Behaviour |
|---|---|
| Recipe URL 404/410 or redirected to a different page | "Source gone" (from Exa `statuses` or the Jina status code) → rung 3 discovery for the current value, noted "page moved". |
| Exa empty plus Jina timeout (6 s) | Unverifiable ("couldn't load {domain}"). Mark `recipe.fetcher='jina'` so next time Jina starts immediately. |
| Locate fails everywhere | Unverifiable ("price not shown on {domain}"). Never a guess. |
| Several prices match (regions, tiers) | Prefer the key match (region from the claim, `/us/` in the URL). If still ambiguous, Unverifiable with "several prices shown". |
| Region mismatch (page shows a currency other than the claim's) | Not comparable. Fixes the "Pakistan article for a US price" class: wrong-region windows are rejected by the qualifier key. |
| Model-select returns a substring not in the line | Dropped (code). Counted in metrics as `select_reject`. |
| No observable claims at all (pure recommendation) | Candidate B fallback: re-answer with research, prose clearly labelled "fresh look", no then-vs-now table. |
| Groq TPM exhausted | Paths (a) and (b) need no LLM. Model-select falls back down the chain (qwen → NIM). Jev is OpenRouter (a separate budget). In the worst case a row is Unverifiable, and the turn doesn't fail. |
| Change happened and then reverted between T₀ and now | We report Unchanged. This is correct for "is it still correct?" Wayback (background) could reveal it; out of scope. |

### 5.11 Budget per recheck (5 items, free tiers)

| Step | Calls | Tokens | Latency |
|---|---|---|---|
| Target resolution | 0–1 embedding (NIM) | — | 50–300 ms |
| Backfill extraction (legacy only) | 1 × gpt-oss-20b | ~1.0k | 0.6–1.2 s (parallel with fetches via discovery) |
| Re-observation rung 1 | 1 batched Exa `/contents` (multi-URL) | 0 | 0.4–1.5 s |
| Rung 2 (JS pages only) | 0–2 Jina | 0 | ≤ 6 s (hedged; usually only HubSpot-like) |
| Rung 3 / discovery | 0–5 Exa `/search` | 0 | 1–2 s |
| Model-select (misses only) | 0–1 batched call | 0–1.5k | 0.5–1 s |
| Jev (renames, non-numeric, news relevance) | 1–2 batched | (OpenRouter) | ~0.5 s |
| News leg | 5 Exa `/search` + 5 HN, or batched | 0 | 1–2 s (parallel) |
| "So what" sentence | 0–1 × qwen | ~0.4k | parallel |
| **Total** | **~8–15 web calls (vs 15–21), 1–3 LLM calls** | **0–3k (vs ~6–8k)** | **~2–4 s typical, ~7 s worst** |

First meaningful output: the preamble is emitted at about 0.1–0.5 s (it is code). Per-row status events stream as claims settle, typically by about 1.5 s on cache hits. The token saving matters more than the latency gain: three rechecks a minute no longer drain a model's 8k TPM (F-43).

### 5.12 Why this generalises (no overfitting)

- The only "knowledge" in code is about **value types** (money, period, seat, promo cue words, versions, dates) and **document structure** (markdown headings, labels). That is the same vocabulary as schema.org `UnitPriceSpecification`, and none of it is vendor- or phrasing-specific.
- Entities come from **our own stored claims**. Target resolution is fuzzy matching on subjects plus a date filter, with no new message regexes.
- The model's only tasks are *selection over numbered options* and *yes/no grounding*. These are the two things weak free models and Jev do reliably. Anything that a weaker model would get wrong (numbers, dates, citations, counts, direction words) is never generated.
- It works the same for non-pricing claims (the "3 November, still correct?" case: versions, people, availability) through the version/date/name comparators and Jev AIS.

---

## 6. What NOT to do (and why)

- **Don't make JSON-LD the fast path.** 0 of 10 SaaS pricing pages have it today. Keep it as a regex bonus for product pages.
- **Don't use `maxAgeHours: 0` by default.** It was 6.35 s with 2 of 3 failures in my probe. Freshness should follow the claim's age.
- **Don't use whole-page content hashes** (SPEC §6.3) for change detection. Pricing pages change on every load (A/B tests, geo, tokens). Use region hashes (quote survival) instead.
- **Don't use Exa `summary.schema` as the extractor.** It is an unattributed LLM output, the same problem moved one hop away.
- **Don't let the LLM decide invalidation** (Graphiti-style per-edge prompts, Mem0 UPDATE/DELETE). Mem0 itself moved to ADD-only. Code decides under the qualifier key.
- **Don't run Wayback in the foreground.** It takes 3–7 s. Use it only in background enrichment for the *when*.

---

## 7. Implementation plan (mapped to files)

Estimates assume one engineer who knows the codebase. Every step ships behind `RECHECK_V2=1` and keeps the current path as the fallback until §8 passes.

| # | Step | Files and functions | Est. |
|---|---|---|---|
| 1 | **Migration v4**: claim columns, `observations`, entity index | `src/memory/store.ts`: add MIGRATIONS[3]; `insertObservableClaims()`, `claimsForTarget(turnIds)`, `appendObservation()`, `supersede(claimId, newClaimId, at)`, `entityCandidates(text)` (trigram + alias) | 0.5 d |
| 2 | **Typed value parser and qualifier key** (pure, unit-tested) | new `src/agent/values.ts`: `parseValue(span) → TypedValue`, `qualKey(entity, attribute, TypedValue)`, `promoCue()`, `approxPrecision()`; reuse `normNum`, `PERIOD_RE` from verify.ts | 1 d |
| 3 | **Locate, not just prove**: make the number proof span-bound and return locations; remove derivations for recheck "now" values | `src/agent/verify.ts`: `locateFigure(claim, evidence, entityTokens) → {n, offset}`; `checkNumbers` keeps derivations only for computed totals in *answers* and limits operands to the cited window (fixes the vacuous proof) | 0.5 d |
| 4 | **Recipe builder** from a located quote over markdown | new `src/agent/recipe.ts`: `buildRecipe(url, text, offset)`, `headingPathAt(text, offset)`, `locateByRecipe(text, recipe, claim) → {quote, value} \| null`, `quoteSurvives(text, quote)` | 1 d |
| 5 | **Capture at answer time** (table rows by code; sentences by extractor with span check) | `src/agent/pipeline.ts`: after `verifier.verify`, call `captureClaims(fin, evidence, plan)` (background priority); new `src/agent/capture.ts` with `rowsToClaims()`, `extractSentenceClaims()` (extractor job, `answer_span` must be a substring) | 1 d |
| 6 | **Fetch ladder** | `src/search/router.ts`: `observe(urls, {maxAgeHours, livecrawlTimeout}) → Evidence[]` using `text` and reading `statuses`; `jinaFetch(url, signal)` via the SSRF-safe fetcher (https only, 6 s cap, own TokenBucket at 15 RPM); optional raw GET for JSON-LD on product pages | 1 d |
| 7 | **Backfill for legacy turns** | `src/agent/capture.ts`: `backfillClaims(hit) → claims` (numbered-lines span selection on the old answer); discovery search per entity; persist | 0.5 d |
| 8 | **Recheck engine** (per-claim locate → compare → observation) | new `src/agent/recheck2.ts`: `recheckClaims(claims, since, signal, emit)`, `compare(then, now) → {verdict, note, delta}`, `modelSelect(batch)`, Jev calls via `Verifier` (add `askNoul(questions[])`) | 1.5 d |
| 9 | **Rendering from the diff** | `src/agent/recheck.ts`: `renderRecheck` takes `Observation[]`; `summaryFromDiff()`; optional `soWhatSentence()` with a no-digit guard; headline list from news. Delete `summary` and `launches.text` from the model schema | 0.5 d |
| 10 | **Target resolution** | `src/agent/pipeline.ts`: replace `entitiesFromHistory` with `store.entityCandidates()` plus `SemanticRecall` over claim subjects; `since` from the target turn; recheck preamble lists only target turns | 1 d |
| 11 | **Wire the route** | `pipeline.ts`: the recheck branch calls `recheckClaims` instead of `retrieveRecheck` + structured LLM; the old path stays as the fallback when there are no claims and backfill fails, or under `RECHECK_V2=0`; per-row `status` SSE | 0.5 d |
| 12 | **Tests** | unit: values (promo, cadence, approx, usage), recipe (heading path on real Notion/Spotify/Pipedrive markdown fixtures saved today), comparator truth table, substring guards; integration: recorded Exa/Jina fixtures | 1 d |
| | **Total** | | **≈ 10 working days** (a minimum useful slice, steps 1–4, 6–9 and 11 with backfill only, is ≈ 6 d) |

Order of value: **10 (target resolution) and 9 (code-rendered summary) first.** Between them they cover 10 of the 13 current failures, and both are small. Then 6 (freshness and ladder), then 2–4 and 8 (the core), then 5 (answer-time capture: it pays off for real users, but the seeded eval doesn't exercise it).

---

## 8. How to measure it fairly

### 8.1 A new frozen set (never seen during development)

- **Seeds.** About 30 *(entity, attribute, then-value, then-date)* cases in **domains not used so far**: password managers, video conferencing, cloud storage, email marketing, VPNs, project tools, language runtimes (versions), people-in-role (CEOs), availability (discontinued or not). About a third are non-pricing.
- **Ground truth at freeze time.** For each seed, save the current page text (Exa plus Jina) to `evals/recheck-frozen/pages/` with the fetch date, and hand-label the true current value and qualifiers. The then-value is planted to create balanced labels:
  - ~35% **true Unchanged** (then = current)
  - ~35% **true Changed** (then = a plausible older value)
  - ~15% **traps**: promo-only differences, annual vs monthly, rounding ("about $X"), plan rename, flat → usage
  - ~15% **should be Unverifiable** (no public price, "contact sales", JS-only page with no rendered price)
- **Two history modes.** (1) *Seeded raw text*, like today, which exercises backfill. (2) *Lived*: the original question is sent through the app at `AGENT_NOW = then-date`, so capture runs, and the recheck runs later with an advanced clock. Report both, because answer-time capture is half the design.
- **Wording.** Recheck messages are generated by a *different* model than the one used for heldout2, in 4 styles (as heldout2/generate.ts). Counts only are printed, and the set is run once. The development set stays the existing heldout2.

### 8.2 Metrics (code-computed first, LLM judge second)

| Metric | Definition | Target |
|---|---|---|
| Target resolution | the right turn or claims found (vs label) | ≥ 95% |
| Row verdict accuracy | 4-way vs label; **report the confusion matrix** | ≥ 85% |
| **False-Changed rate** | predicted Changed / true Unchanged (the trust-killer) | ≤ 3% |
| Missed-change rate | predicted Unchanged / true Changed | ≤ 5% |
| Unverifiable rate on rows that have a public value | coverage | ≤ 15% |
| **Citation precision (AIS-style, code)** | the cited source's fetched text contains the now-value **within a window that names the entity/plan** | ≥ 98% |
| Uncited-figure sentences | the verifier's F-40 check on the final text | 0 |
| Internal consistency | count line = rows; summary direction = sign of the delta | 100% (code) |
| Latency | first token p50/p95; total p50/p95 | p50 < 3 s total; p95 < 8 s |
| Cost | LLM tokens per recheck (by model); web calls per recheck | ≤ 3k; ≤ 15 |

Also run the LLM judge with history visible (`regrade.ts`). But the judge passed a self-contradictory row in the last run, so **code metrics gate the decision**.

### 8.3 Ablations (to prove each part pays for itself)

Run the frozen set with these switched off one at a time: quote survival, anchor window, model-select, Jina rung, cache-age freshness (vs `maxAgeHours:0`), the qualifier key (vs number-set compare), and code summary (vs model summary). Keep a mechanism only if it moves a metric. This also protects against adding clever-but-fragile parts.

### 8.4 Drift re-run

Re-run the same frozen set (same planted values) about 2 weeks later without changing code. Real prices will have moved for some vendors. Labels are re-derived from newly saved pages. This catches overfitting to page layouts on the freeze date.

---

## 9. Honest trade-offs

- **More code surface.** values.ts, recipe.ts and recheck2.ts add roughly 600–900 lines, but all of it is pure and unit-testable. Today's `admitRows` approach puts its complexity in prompts, which you can't test.
- **Markdown structure varies by fetcher.** Heading paths from Exa and Jina can differ slightly, so the anchor match must be fuzzy (last heading exact, parents optional), and model-select is the safety net. Measure `locate` method shares in the eval.
- **Answer-time capture adds background tokens** (about 1k per answer with figure sentences) to the daily Groq cap (F-49). Mitigation: table rows need no LLM, and sentence extraction runs only when the answer has uncited-table figures and the route is `quick` or `research`.
- **Jina's free tier is small** (about 20 RPM). It must stay rung 2, with its own bucket. If it disappears, JS-only vendors fall back to search (today's behaviour) and stay mostly Unverifiable. Say so honestly in the answer.
- **"When did it change?" is only bracketed** (between T₀ and the observation date) unless a dated announcement attaches to the row. Wayback can tighten this later, in the background.
- **The 4-verdict UI hides `not_comparable`.** It is rendered as an Unverifiable note. If evaluators penalise that, add a fifth visible verdict.

---

## Sources

- Zep: A Temporal Knowledge Graph Architecture for Agent Memory: https://arxiv.org/abs/2501.13956 · Graphiti: https://github.com/getzep/graphiti · field-semantics review: https://zby.github.io/commonplace/agent-memory-systems/reviews/graphiti/ · maintainer blog: https://blog.getzep.com/beyond-static-knowledge-graphs/
- Mem0 (Chhikara et al. 2025): https://arxiv.org/abs/2504.19413 · ADD-only evolution: https://levelup.gitconnected.com/choosing-an-ai-agent-memory-layer-lessons-from-mem0s-evolution-from-fde-pov-8b1268fa8735
- Hindsight is 20/20: https://arxiv.org/abs/2512.12818
- LongMemEval: https://arxiv.org/abs/2410.10813 · https://xiaowu0162.github.io/long-mem-eval/
- FreshLLMs / FreshQA: https://arxiv.org/abs/2310.03214
- RARR: https://arxiv.org/abs/2210.08726
- Attributed QA / AutoAIS: https://arxiv.org/abs/2212.08037
- changedetection.io restock/price processor: https://www.mintlify.com/dgtlmoon/changedetection.io/features/restock-price-monitoring · processors: https://www.mintlify.com/dgtlmoon/changedetection.io/advanced/processors
- Exa Monitors: https://exa.ai/docs/websets/api/monitors/create-a-monitor.md · Exa Contents guide: https://exa.ai/docs/reference/contents-api-guide-for-coding-agents.md · Exa freshness/livecrawl: https://exa.ai/docs/reference/livecrawling-contents.md
- schema.org UnitPriceSpecification: https://schema.org/UnitPriceSpecification · billingDuration: https://schema.org/billingDuration · Google merchant listing structured data: https://developers.google.com/search/docs/appearance/structured-data/merchant-listing · SaaS JSON-LD example: https://docs.limio.com/labs/ai-and-agent-discovery/json-ld-schema
- Jina Reader: https://jina.ai/reader · README: https://cdn.jsdelivr.net/gh/jina-ai/reader@main/README.md · rate-limit comparison: https://spider.cloud/blog/spider-vs-jina-reader/
- Wayback Availability API: https://archive.org/help/wayback_api.php · CDX server: https://github.com/internetarchive/wayback/blob/ARI-4010/wayback-cdx-server/README.md
- Own probes (2026-11-12): raw-HTML JSON-LD scan of 10 pricing pages; Exa `/contents` with `maxAgeHours` 0 / 24 / −1; r.jina.ai on HubSpot and Pipedrive; notion.com response headers. Results are in §1.2.
