# heldout4: frozen multi-intent set

This is a held-out set for multi-intent turns (conversation reference, world question, embedded claim, recheck, follow-up, small talk), built to the measurement plan in `docs/ROUTING_RESEARCH.md` §5.2. If you are working on routing, needs, memory recall or the composer, don't open `seeds.ts` (or `dataset.ts`'s rubric output). This README doesn't contain any question, topic, entity or gold fact.

## Run

```bash
cd evals
ISOLATE=1 DATASET=heldout4 npx tsx --env-file=../.env realworld/run.ts             # all 63
ISOLATE=1 DATASET=heldout4 SPLIT=dev  npx tsx --env-file=../.env realworld/run.ts  # dev only (tuning)
ISOLATE=1 DATASET=heldout4 SPLIT=test npx tsx --env-file=../.env realworld/run.ts  # test only (run once)
```

`ISOLATE=1` is required. Every item is its own scenario (`heldout4-<id>`) with its own planted history; without `ISOLATE` the runner plants every scenario into one shared store and item-specific history leaks across items (the dataset prints a warning). Add `TAG=...` to keep output folders apart, and `LABEL=<type>` or `LABEL=noise` to run one stratum. Results go to `realworld/results-heldout4[-TAG]/`; the report's "by kind" is the intent type and "by style" is the history condition.

## Design

- **Intent types (10):** `conv_date` (conversation only, by date), `conv_topic` (conversation only, by topic), `world_time` (world-only question carrying a world time phrase), `youtold_world` ("you told me X" + world follow-up), `recheck_world` (recheck an earlier answer + new world question), `followup_chat` (follow-up continuing the current chat; must not be treated as memory), `thirdparty_time` (third-party claim + date phrase), `session_firstlast` (first/last question in this chat), `social_compute` (small talk / arithmetic; must not search), `conv_world` (conversation reference + world question).
- **History conditions (3):**
  - `match`: a matching record exists (an item-specific plant on a past day, or earlier turns in the same session). For the world-only types (`world_time`, `thirdparty_time`, `followup_chat`) it is a *related but unreferenced* earlier conversation, which tests reference ≠ relevance.
  - `norecord`: history is only 3 sparse unrelated turns from 2024, outside every window any item uses.
  - `noise`: the sparse turns plus 14 unrelated noise turns covering every window used (last year, earlier this year, last month, a couple of weeks ago, last week, Monday, Tuesday, earlier this week, a few days ago, yesterday, and earlier today in a different session).
- **Wording:** all 63 written by hand in English, varied styles (casual, lowercase/typo-ish, formal, indirect). No model paraphrasing.
- **Test clock:** Thu 12 Nov 2026, user in Asia/Kolkata. Item turns run at 05:00 UTC + i min; same-session turns are planted earlier that morning.

## Gold (per item)

- **Needs:** subset of `conversation | world | premise | recheck | none`.
- **`expect.searches`:** `"some"` iff the gold needs include world/premise/recheck (39 items); `"none"` otherwise (24 items).
- **`expect.anyOf`:**
  - matching record on a past day → the code-written label `On <Day D Mon> you asked` for that plant's local date (10 items);
  - conversation-type items with no matching record → a list of honest no-record phrasings (25 items);
  - session/arithmetic items → the expected key token (5 items).
- **`expect.noneOf`:** every item forbids the distinctive words of all sparse and noise plants (none appear in any correct answer; checked by script). Items with a *related* plant also forbid that plant's `On <Day D Mon> you asked` label (6 items).
- **`expect.rubric`:** needs, search requirement, premise status (where a premise exists), what the history condition means for this item, and an EXPECTED line. World items carry 1–2 gold facts, each with a source URL found by web search on 2026-11-12, and the judge is told to use them and not its own knowledge of recent events. Two items expect a cited current source for a value that could still move.

## Counts

| type | match (dev/test) | norecord (dev/test) | noise (dev/test) | total |
|---|---|---|---|---|
| conv_date | 0/2 | 1/1 | 1/1 | 6 |
| conv_topic | 1/1 | 1/1 | 0/2 | 6 |
| conv_world | 1/1 | 1/1 | 0/2 | 6 |
| followup_chat | 1/1 | 1/1 | 0/2 | 6 |
| recheck_world | 1/1 | 0/2 | 1/1 | 6 |
| session_firstlast | 0/2 | 1/1 | 1/1 | 6 |
| social_compute | 0/2 | 1/1 | 1/1 | 6 |
| thirdparty_time | 1/1 | 0/2 | 1/2 | 7 |
| world_time | 1/1 | 0/2 | 1/2 | 7 |
| youtold_world | 1/1 | 0/2 | 1/2 | 7 |
| **total** | 7/13 = 20 | 6/14 = 20 | 7/16 = 23 | **63** (20 dev / 43 test) |

Other counts: 33 items have a time phrase (15 about the world, 18 about the conversation); 10 items have a matching past-day plant, 6 have a related-but-unreferenced plant, 10 have same-session earlier turns; 29 distinct gold facts with URLs (47 item references).

**Labels:** `type|historyCondition|split`.

**Split:** type-balanced. Each type gets round(0.3 × n) = 2 dev items, drawn from two different history conditions (the condition order is rotated across a mulberry32-shuffled type order, seed `20261112`; the item within a cell is chosen by a seeded shuffle). That gives 20 dev / 43 test. The split is in `SPLITS` (dataset.ts) and is reproducible.

## Disjointness check

Before writing, every candidate entity/topic and every plant keyword was grepped across `heldout/`, `heldout2/`, `heldout3/`, `wildchat/`, `realworld/dataset*.ts`, `realworld/data/` and the promptfoo YAMLs (excluding `node_modules` and `results*`). One candidate topic already used in `realworld/dataset.ts` was dropped. The remaining hits are generic phrases in unrelated questions; no specific event is reused. The excluded-topic list from the brief was respected.

## Freezing

Don't edit wording or gold to fit a result. If a gold fact turns out to be wrong after a run, record a correction alongside the results and leave `seeds.ts` as it is.
