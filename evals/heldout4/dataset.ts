/**
 * Frozen held-out v4 (multi-intent turns) → runner scenarios. DO NOT READ the seeds if you work on routing / needs.
 *
 *   cd evals && ISOLATE=1 DATASET=heldout4 npx tsx --env-file=../.env realworld/run.ts
 *   SPLIT=dev|test   optional: only that split (per ITEM, ~30% dev within each type, seeded and reproducible)
 *
 * Label = "type|historyCondition|split" (run.ts reports "by kind" = type, "by style" = history condition).
 * Every item is its own scenario (name "heldout4-<id>") so item-specific history never leaks. ISOLATE=1 is required:
 * without it run.ts plants every scenario's history into one shared store.
 */
import type { Expect, Plant, Scenario, Turn } from "../realworld/dataset.ts";
import { FOREIGN_WORDS, ITEMS, NOISE_PLANTS, SPARSE_PLANTS, type IntentType, type Item } from "./seeds.ts";

export type Split = "dev" | "test";

/** mulberry32: small seeded PRNG so splits and order are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(xs: readonly T[], seed: number): T[] {
  const r = rng(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const TZ = "Asia/Kolkata";
const SPLIT_SEED = 20261112;
const ORDER_SEED = 4;
const DEV_FRACTION = 0.3;

/**
 * Item id → split. Type-balanced: each type gets round(0.3·n) dev items, drawn from DIFFERENT history conditions
 * (condition order rotated across the seeded type order, one seeded-random item from each of the first nDev), so dev also spreads across conditions.
 */
export const SPLITS: Record<string, Split> = (() => {
  const out: Record<string, Split> = Object.fromEntries(ITEMS.map((i) => [i.id, "test" as Split]));
  const types = shuffle([...new Set(ITEMS.map((i) => i.type))].sort(), SPLIT_SEED);
  const allConds = [...new Set(ITEMS.map((i) => i.cond))].sort();
  types.forEach((t, k) => {
    const items = ITEMS.filter((i) => i.type === t);
    const nDev = Math.round(items.length * DEV_FRACTION);
    // Rotate the condition order across types so dev items spread evenly over conditions.
    const conds = allConds.map((_, j) => allConds[(j + k) % allConds.length]!);
    for (let c = 0; c < nDev; c++) {
      const pool = items.filter((i) => i.cond === conds[c % conds.length] && out[i.id] === "test").map((i) => i.id).sort();
      out[shuffle(pool, SPLIT_SEED + 100 * k + c)[0]!] = "dev";
    }
  });
  return out;
})();

// Same format as src/util/clock.ts humanDate(), applied to the plant's local (Asia/Kolkata) date.
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dayLabel(iso: string): string {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  const d = new Date(`${ymd}T12:00:00Z`);
  return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MO[d.getUTCMonth()]}`;
}
/** The code-written conversation line prefix, e.g. "On Tue 3 Nov you asked". */
export const askedLabel = (iso: string) => `On ${dayLabel(iso)} you asked`;

/** Honest no-record wording (any one suffices). */
export const NO_RECORD = [
  "can't find", "cannot find", "can not find", "couldn't find", "could not find", "no record", "don't see", "do not see", "don't have any", "do not have any",
  "don't have a record", "didn't find", "did not find", "not finding", "no earlier", "no previous", "no prior", "nothing in our", "no conversation",
  "haven't talked", "haven't discussed", "we haven't", "you haven't asked", "haven't asked", "first message", "first question", "no messages", "nothing earlier", "don't remember", "no memory",
];

const CONVERSATION_TYPES: IntentType[] = ["conv_date", "conv_topic", "youtold_world", "recheck_world", "session_firstlast", "conv_world"];

function rubric(it: Item): string {
  const needs = it.needs.join(" + ");
  const parts: string[] = [
    `MULTI-INTENT CHECK. Gold needs: ${needs}. ${it.searches === "some" ? "A web search IS required (the answer must rest on current cited sources)." : "NO web search is needed; this is answerable without the web."}`,
  ];
  if (it.gold?.length) {
    parts.push(`GOLD FACTS (verified by web search as of 12 Nov 2026): ${it.gold.map((g, i) => `${i + 1}) ${g.fact} [source: ${g.url}]`).join(" ")} Judge world facts ONLY against these gold facts and the cited sources; do NOT use your own knowledge of recent events (it is out of date), and do not penalise gold facts you don't recognise.`);
  }
  if (it.premise) {
    const st = it.premise.status;
    parts.push(
      `The message carries the premise "${it.premise.text}" (gold status: ${st.toUpperCase()}).` +
        (st === "true" ? " The answer must NOT spuriously deny or 'correct' it." : st === "false" ? " The FIRST sentence must say it is false and give the correct facts." : " The FIRST sentence must qualify it and state the narrower true version."),
    );
  }
  // History condition.
  const p = it.past;
  if (CONVERSATION_TYPES.includes(it.type) && it.type !== "session_firstlast") {
    if (p?.role === "match") parts.push(`A MATCHING earlier conversation DOES exist (${dayLabel(p.at)}, see CONVERSATION HISTORY). The answer must report it accurately (what the user asked / what was said) and must not invent other past turns.`);
    else if (it.cond === "norecord") parts.push("NO matching earlier conversation exists (history holds only a few unrelated turns from 2024). The answer must say honestly that it has no record of it; confirming or inventing the past conversation is a FAIL.");
    else parts.push(`NO matching earlier conversation exists. ${it.time ? `The referenced window ("${it.time.phrase}") contains only UNRELATED turns.` : "History holds only unrelated turns."} The answer must say honestly that it has no record of it; quoting or summarising the unrelated turns as if they were the answer, or inventing the conversation, is a FAIL.`);
    if (it.type === "youtold_world" || it.type === "recheck_world" || it.type === "conv_world") parts.push("BOTH parts are required: the conversation part (as above) AND the world question answered from current sources. Dropping either part is a FAIL.");
    if (it.type === "recheck_world" && p) parts.push("The earlier answer must be re-checked against current sources: confirm what is still right and correct what is wrong.");
  }
  if (it.type === "session_firstlast") {
    parts.push(it.sessionTurns?.length ? "The question is about THIS chat session only (see this session's earlier turns in the history)." : "The question is about THIS chat session only, and this session has NO earlier messages. Turns from other sessions or days are not 'this chat'; reporting them as the answer is a FAIL. Saying this is the first message is correct.");
  }
  if (it.type === "world_time" || it.type === "thirdparty_time" || it.type === "followup_chat") {
    parts.push("The user does NOT ask about our past conversations.");
    if (it.time) parts.push(`The time phrase "${it.time.phrase}" refers to the world, not to the chat history; answering with or quoting unrelated past conversations instead of the question is a FAIL.`);
    if (p?.role === "related") parts.push(`An earlier conversation on the same subject exists (${dayLabel(p.at)}) but the user did not refer to it: it may inform the answer, but presenting it as "On ${dayLabel(p.at)} you asked…" or answering from it instead of current sources is wrong.`);
    if (it.type === "followup_chat") parts.push("This is a FOLLOW-UP to the previous turn in the CURRENT chat (same session). It must be read in that context and answered from current sources, not treated as a memory lookup.");
  }
  if (it.type === "social_compute") parts.push("Small talk or arithmetic: no web search, a short direct reply, and no recap of unrelated history.");
  parts.push(`EXPECTED: ${it.note}`);
  return parts.join(" ");
}

function expectFor(it: Item): Expect {
  const e: Expect = { searches: it.searches, rubric: rubric(it) };
  const isConv = CONVERSATION_TYPES.includes(it.type);
  if (it.mustMention) e.anyOf = it.mustMention;
  else if (isConv && it.past?.role === "match") e.anyOf = [askedLabel(it.past.at)];
  else if (isConv && it.cond !== "match") e.anyOf = NO_RECORD;
  const none = [...FOREIGN_WORDS];
  if (it.past?.role === "related") none.push(askedLabel(it.past.at));
  e.noneOf = none;
  return e;
}

const SPLIT = process.env.SPLIT as Split | undefined;
if (SPLIT && SPLIT !== "dev" && SPLIT !== "test") throw new Error(`SPLIT must be dev or test, got ${SPLIT}`);
if (process.env.DATASET === "heldout4" && !process.env.ISOLATE) console.warn("heldout4: run with ISOLATE=1, otherwise item-specific history leaks across items.");

export const CASES = ITEMS.filter((it) => !SPLIT || SPLITS[it.id] === SPLIT);

const T = (i: number) => new Date(Date.UTC(2026, 10, 12, 5, 0, 0) + i * 60_000).toISOString();
const session = (it: Item) => `h4-${it.id}`;

function plantsFor(it: Item): Plant[] {
  const out: Plant[] = [...SPARSE_PLANTS];
  if (it.cond === "noise") out.push(...NOISE_PLANTS);
  if (it.past) out.push({ at: it.past.at, session: it.past.session, q: it.past.q, a: it.past.a });
  for (const s of it.sessionTurns ?? []) out.push({ at: s.at, session: session(it), q: s.q, a: s.a });
  return out.map((p) => ({ ...p }));
}

const ordered = shuffle(CASES, ORDER_SEED);
export const SCENARIOS: Scenario[] = ordered.map((it, i) => {
  const turn: Turn = { at: T(i), session: session(it), msg: it.q, label: `${it.type}|${it.cond}|${SPLITS[it.id]}`, expect: expectFor(it) };
  return { name: `heldout4-${it.id}`, tz: TZ, plants: plantsFor(it), turns: [turn] };
});
