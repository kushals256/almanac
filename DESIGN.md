
# DESIGN

**Brief:** a chat agent whose only tool is web search. It should answer fast, get things right, and remember what you asked and when.
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
3. **Jev as the judge layer.** A small decision model that returns a probability (the vendor calls it calibrated; I have not verified that) fits the many yes/no relevance and support questions in a turn better than a large chat model: cheaper, steadier, and it can be thresholded. It never sees a number (figures are masked before it judges); code owns numbers and dates. Behind a circuit breaker it falls back to an LLM judge, then to a default that leans to doing *more* work (F-109).
4. **Recheck by re-observation.** An earlier claim is re-read at the page it cited. Code finds the value, compares like for like (units, period, tier), and only calls it "Changed" with timing evidence. Otherwise it says "Differs; my earlier figure may have been wrong" (F-82, F-120).
5. **Strict layers.** Deciding modules import no model, search or database client. A test enforces it, so the logic stays testable offline ([ARCH §2](ARCHITECTURE.md#2-layers-and-the-rule-that-keeps-them-honest), F-126).

## Rejected on purpose

A framework agent loop (opaque control flow, no per-stage budgets) · vector-only memory (cannot resolve dates, misses exact names) · LLM-as-judge for everything (slow, inconsistent, uncalibrated) · letting the model write tables and counts (F-21, F-54, F-62, F-68 were all that failure) · a prompt-injection classifier in front of retrieved text (deferred: the agent has no side-effecting tools; see [ARCH §11](ARCHITECTURE.md#11-answer-guards-and-safety)).

## Limits, stated plainly

- **Everything was tested on free-tier models** (Groq, NVIDIA, Exa and Tavily free plans). Absolute numbers are not what a paid stack would score. Groq's cap is 200k tokens per model per day per account (F-49, F-95), and Exa credits ran out mid-project (F-102).
- **The strongest numbers are on a 44-case dev set that was tuned against.** Generalisation was measured only on small frozen held-out sets (43 and 51 items, about ±13–15 points): 41% to 61% with the premise gate (F-100); 47% to 58% with needs routing (F-101). Treat those as the honest figures.
- Jev is an alpha endpoint with no SLA. Its published figures are the vendor's own and unverified here; `scripts/calibrate-jev.ts` is a small seed for measuring it, and I have not run it.
- Vendor pricing pages that render prices with JavaScript can come back "Unverifiable" (F-22).

## With another week

Run the frozen sets on a paid model tier and report the gap. Calibrate Jev's thresholds on a proper labelled set (`calibrate-jev.ts` is only a seed for that). Add the planner-degradation arm and a per-component ablation table. Larger held-out sets (n ≥ 150) so the error bars shrink. Full list: [ARCH §12](ARCHITECTURE.md#12-with-another-week).
