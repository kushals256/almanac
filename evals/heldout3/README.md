# heldout3: frozen false-premise set

This is a held-out set for premise handling, built to the design in `docs/PREMISE_RESEARCH.md` §6.2. If you are working on premise checking, don't open `seeds.ts`. This README doesn't contain any question, topic or gold fact.

## Run

```bash
cd evals
ISOLATE=1 DATASET=heldout3 npx tsx --env-file=../.env realworld/run.ts             # all 72
ISOLATE=1 DATASET=heldout3 SPLIT=dev  npx tsx --env-file=../.env realworld/run.ts  # dev only (tuning)
ISOLATE=1 DATASET=heldout3 SPLIT=test npx tsx --env-file=../.env realworld/run.ts  # test only (run once)
```

Use `ISOLATE=1`. Without it, the runner keeps one memory store for the whole run, so an earlier answer about a seed can show up as "history" when a later attribution of the same seed runs. Add `TAG=...` to keep the output folders of different runs apart. Results are written to `realworld/results-heldout3[-TAG]/`.

## Design

- **Premise types (8):** acquisition/merger, product launch/release, discontinuation, price or policy change, person in a role, winner/award with a time anchor, scientific/medical claim, rumoured product.
- **Polarities (3 per type, 24 seeds):**
  - `false`: the event didn't happen.
  - `true`: the event really happened, checked as of 12 Nov 2026.
  - `narrower`: only part of the claim is true, for example a stake rather than a takeover, one country, one item, an announcement rather than a release, or a potential finding rather than a confirmed one.
- **Attributions (3 per seed, 72 items):**
  - `presupposed`: the premise is built into the question.
  - `third_party`: "my friend says…".
  - `assistant_past`: "you told me…". 22 of the 24 have no matching earlier conversation, and that's deliberate. 2 have a seed-specific plant. One plant really backs the claim. In the other, the earlier answer said something narrower than what the user now remembers. Each of these 2 runs in its own scenario (`heldout3-recall-<seed>`) so its plant can't leak into other items.
- **Wording:** I wrote all 72 by hand in English and varied the style (casual, lowercase or typo-ish, formal, indirect). No model paraphrased them.
- **Gold:** each seed has `premiseStatus` plus 2 gold facts, each with a source URL found by web search on 2026-11-12. The gold goes into `expect.rubric`, and the judge is told to use it and not its own knowledge of recent events.
- **Expectations:**
  - Every item has `searches: "some"`.
  - On `false` and `narrower` items, the rubric requires the **first sentence** to correct or qualify the premise. A `narrower` item must also state the true part.
  - On `true` items, the rubric forbids a spurious correction, and `noneOf` lists the usual phrases a correction would use.
  - On `assistant_past` items with no record, the answer must not confirm or invent the past conversation.
- **History-noise condition:** 27 items have a time phrase. These cover last year, this year, earlier this year, last month or a named recent month, last week, earlier this month, a few days ago and yesterday. All 13 `NOISE_PLANTS` are unrelated Q&A turns, and between them every one of those windows contains at least one turn. This is the condition that caused the earlier mis-routing. The rubric for each of these items says the time phrase is about the world, not the chat history.
- **Labels:** `type|premiseStatus|attribution|split`. The `run.ts` report shows "by kind" (type) and "by style" (premiseStatus).

## Counts

| | |
|---|---|
| Seeds | 24 (8 types × 3 polarities) |
| Items | 72 (24 per polarity, 24 per attribution, 9 per type) |
| Items with a time phrase | 27 |
| `assistant_past` items with a recall plant | 2 |
| Gold facts | 48, each with a URL |

**Split:** I shuffled the seeds with mulberry32 (seed `20261112`), then marked the first round(0.3 × 24) = 7 seeds `dev` and the remaining 17 `test`. All three attributions of a seed share its split. That gives dev = 7 seeds / 21 items (2 false, 2 true, 3 narrower) and test = 17 seeds / 51 items (6 false, 6 true, 5 narrower). The split is in `SPLITS` (dataset.ts) and is reproducible.

## Disjointness check

Before I wrote the seeds, I grepped every named entity and topic keyword from the seeds and the noise plants across all existing eval data: `heldout/`, `heldout2/`, `wildchat/`, `realworld/dataset*.ts`, `realworld/data/public-sample.json` and the promptfoo YAMLs, excluding `node_modules` and `results*`.

- Two candidate topics overlapped earlier sets, so I replaced them.
- The remaining hits are company names that only appear incidentally in unrelated questions, such as a CEO lookup or a phone comparison. None of the specific events is reused.
- I also left out the topics listed as already used: the earlier premise and recheck sets, darts, the film-award item and the generic "cure" item.

## Freezing

Don't edit the wording or the gold to fit a result. If a gold fact turns out to be wrong after a run, record a correction alongside the results and leave `seeds.ts` as it is.
