
# DESIGN

**Brief:** a verified query system whose only tool is web search. It should answer fast, get things right, and remember what you asked and when.
**Answer in one line:** models propose, code decides, and a small probability-scoring judge ([Jev](https://openrouter.ai/typesafe/jev-1.14)) arbitrates the evidence. Details: [`ARCHITECTURE.md`](ARCHITECTURE.md). Tests: [`TESTING.md`](TESTING.md). Raw log: [`evals/FINDINGS.md`](evals/FINDINGS.md) (F-1 to F-126).

## The three requirements, and what carries each

| Requirement | Mechanism | Where |
|---|---|---|
| **Fast** | A small planner replaces the model-driven tool loop (about two model round-trips per turn); a hedged twin planner call at 1.8 s cuts the tail; the answer streams; verification runs *after* the stream; history questions need no search. | ARCH §9, §7 |
| **Right** | Every number is proved against its cited page by code. A premise gate checks what the question takes for granted. Jev answers "does this page support this claim?" with a probability. Nothing unproven is stated as fact. | ARCH §4, §5, §7 |
| **Remembers what and when** | Each turn is stored with a timestamp, owner and session in SQLite (FTS5 plus embeddings). Dates ("last Tuesday", "the Monday before last") are resolved by code, never by a model. Earlier answers are stored as *claims* (entity, attribute, value, source, quote), so "is it still true?" is a re-observation, not a guess. | ARCH §8, §6 |

## Five decisions that define it

1. **A turn is a set of needs, not one route.** Conversation, world, premise and recheck can all fire on one message. Signals only add a need; only evidence removes one. A single-route classifier cannot answer "you told me X, is that still right?" ([ARCH §3](ARCHITECTURE.md#3-needs-routing), F-101, F-79).
2. **Models propose, code decides.** Dates, thresholds, unit checks, change verdicts, counts, tables and every "On Tue 3 Nov you asked…" line are plain functions with unit tests. Weak free models cannot corrupt what they never write (F-80).
3. **Jev as the judge layer.** A small decision model that returns a probability fits the many yes/no relevance and support questions in a turn better than a large chat model: cheaper, steadier, and it can be thresholded. It never sees a number (figures are masked before it judges); code owns numbers and dates. Behind a circuit breaker it falls back to an LLM judge, then to a default that leans to doing *more* work (F-109). While the system runs cleanly without it via LLM fallback, Jev avoids multi-token chat generation and offloads primary LLM quotas.
4. **Recheck by re-observation.** An earlier claim is re-read at the page it cited. Code finds the value, compares like for like (units, period, tier), and only calls it "Changed" with timing evidence. Otherwise it says "Differs; my earlier figure may have been wrong" (F-82, F-120).
5. **Strict layers.** Deciding modules import no model, search or database client. A test enforces it, so the logic stays testable offline ([ARCH §2](ARCHITECTURE.md#2-layers-and-the-rule-that-keeps-them-honest), F-126).

## What sets this architecture apart

Standard web-search agents on the internet rely on framework tool loops (ReAct/LangChain) with an LLM-as-judge. In real-world multi-turn conversations, that pattern breaks down in predictable ways. Here is how this design deliberately solves them:

| Problem in Standard Agents | How This Architecture Solves It | Architectural Advantage |
|---|---|---|
| **Single-route tool classification** (LLM picks Search *or* Chat *or* Memory) | **The Needs Model**: a message activates a union of orthogonal needs (`conversation ∪ world ∪ premise ∪ recheck`). Signals only add; only evidence removes. | Multi-intent queries (e.g., *"You told me X on Tuesday, has it changed?"*) fire history retrieval, source re-fetching, and dated news concurrently. |
| **LLM hallucinates comparison tables & math** | **Code-owned comparison engine**: typed comparators handle currency, European decimal commas, per-seat conversions, and cadences. | Deterministic comparisons. The agent never claims a price changed due to charm pricing, billing cadence mismatches, or rounding noise. |
| **Context-stuffing past turns** (hoping the model spots what changed) | **Claims as Data + Exact Re-observation**: past answers extract structured claims (entity, attribute, value, source URL, quote). Recheck re-fetches the original source directly. | Deterministic attribution. The agent knows *exactly* which URL it quoted before, rather than guessing from conversation context. |
| **Slow, uncalibrated LLM-as-judge** | **Dedicated Jev Judge Layer with 3-tier fallback**: specialized probability-scoring judge backed by circuit breakers. | Continuous probabilities instead of noisy yes/no tokens. Numbers are masked before judging so models never evaluate math. |
| **Unbounded tool loop latency** | **Fixed pipelined stages + post-stream verification**: streaming begins immediately (~2.2s TTFT); claim proof runs asynchronously after stream completion. | Responsive UX with rigorous safety guarantees without slowing down first token arrival. |


## Rejected on purpose

A framework agent loop (opaque control flow, no per-stage budgets) · vector-only memory (cannot resolve dates, misses exact names) · LLM-as-judge for everything (slow, inconsistent, uncalibrated) · letting the model write tables and counts (F-21, F-54, F-62, F-68 were all that failure) · a prompt-injection classifier in front of retrieved text (deferred: the agent has no side-effecting tools; see [ARCH §11](ARCHITECTURE.md#11-answer-guards-and-safety)).

## Limits, stated plainly

- **Everything was tested on free-tier models** (Groq, NVIDIA, Exa and Tavily free plans). Absolute numbers are not what a paid stack would score. Groq's cap is 200k tokens per model per day per account (F-49, F-95), and Exa credits ran out mid-project (F-102).
- **The strongest numbers are on a 44-case dev set that was tuned against.** Generalisation was measured only on small frozen held-out sets (43 and 51 items, about ±13–15 points): 41% to 61% with the premise gate (F-100); 47% to 58% with needs routing (F-101). Treat those as the honest figures.
- Jev is an alpha endpoint with no SLA. Its published figures are the vendor's own and unverified here; `scripts/calibrate-jev.ts` is a small seed for measuring it, and I have not run it.
- Vendor pricing pages that render prices with JavaScript can come back "Unverifiable" (F-22).

## With another week

Run the frozen sets on a paid model tier and report the gap. Calibrate Jev's thresholds on a proper labelled set (`calibrate-jev.ts` is only a seed for that). Add the planner-degradation arm and a per-component ablation table. Larger held-out sets (n ≥ 150) so the error bars shrink. Full list: [ARCH §12](ARCHITECTURE.md#12-with-another-week).
