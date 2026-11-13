/**
 * Needs, not routes (docs/ROUTING_RESEARCH.md §4).
 *
 * A turn is a SET of needs — conversation, world, premise, recheck — not one route. Signals can only ADD a
 * need (planner ∪ phrase rules ∪ evidence); a need is removed only by evidence (Jev verdicts), never by a
 * single label. The world leg is ON by default and is switched off only when planner, rules and Jev agree
 * the message is conversation-only. A weak or failed planner therefore costs detail, never a whole leg.
 * Pure function: every branch is unit-tested (test/needs.test.ts).
 */
import type { Route } from "./planner.ts";

/**
 * Decision thresholds on Jev's calibrated probabilities. One place, one reason each. Tuned on development sets
 * (heldout4 dev split), measured on the frozen test split.
 */
export const T = {
  /** Jev "refers to our conversation" strong enough to ADD a conversation need on its own. */
  REF_ADD: 0.7,
  /** Below this, a weakly-backed reference (planner-only or time phrase) is dropped. */
  REF_KEEP: 0.5,
  /** Below this, even a reference backed by a found conversation is dropped (a clear "no"). */
  REF_CLEAR_NO: 0.3,
  /** "Our record alone answers it": skip the web only above this… */
  CONV_ONLY: 0.7,
  /** …or above this even when the planner (weakly) said "factual". */
  CONV_ONLY_STRONG: 0.8,
  /** "Asks about the world": below this the message is conversation-only. */
  WORLD_ASK_NO: 0.4,
  /** Above this, a world question keeps the web on even when our record seems to answer it. */
  WORLD_ASK_YES: 0.5,
  /** "Answerable by reshaping/choosing from the previous reply alone": skip a new search above this. Set at the same
   * "strong agreement" level as CONV_ONLY (not tuned): a wrong "yes" costs a search, so it must be confident. */
  REPLY_ONLY: 0.7,
} as const;

export type NeedSignals = {
  /** Planner read the message (not failed-open / not a rule shortcut). */
  plannerRead: boolean;
  plannerPastRef: "none" | "date" | "topic" | "last_question" | "first_question" | "list";
  plannerWantsRecheck: boolean;
  plannerFactual: boolean;
  plannerRoute: Route;
  entities: number;
  /** "you told me / did I ask / what did we…" — an explicit reference to our conversation (phrase rule). */
  explicitConversationCue: boolean;
  /** "first question / what did I just ask / list everything I asked" (phrase rules). */
  sessionCue: "first" | "last" | "list" | null;
  /** A past time phrase in the message ("last month") — could be about the world or about our chat. */
  pastTimePhrase: boolean;
  recheckHint: boolean;
  /** Admitted premises, and whether any is "you told me X". */
  premises: number;
  assistantPastPremise: boolean;
  social: boolean;
  compute: boolean;
  /** Code's world-question heuristics (WORLD_RE, isFactualQuestion). */
  worldHeuristic: boolean;
  /** Memory candidates admitted as relevant by evidence. */
  admittedMemory: number;
  /** Jev: is the message about our conversation itself? / answerable from our record alone? null = Jev down. */
  jevRef: number | null;
  jevConvOnly: number | null;
  /** Jev: does the message ask for any world facts beyond recalling our conversation? null = Jev down. */
  jevWorldAsk?: number | null;
  /** The message asks to reshape/choose from the previous reply (planner ∪ wording cue), and there is one. */
  replyAsk?: boolean;
  /** Jev: can it be answered from the previous reply alone (no new facts)? null = not asked or Jev down. */
  jevReplyOnly?: number | null;
};

export type Needs = {
  conversation: boolean;
  world: boolean;
  recheck: boolean;
  premise: boolean;
  /** Answer by reshaping the previous reply over its own sources (no new search). */
  reply: boolean;
  /** Provenance per need, logged: which signals raised or removed it. */
  why: string[];
};

function noWorldAsk(s: NeedSignals): boolean {
  if (s.jevWorldAsk != null) return s.jevWorldAsk < T.WORLD_ASK_NO;
  return !s.plannerFactual && !s.worldHeuristic;
}

export function decideNeeds(s: NeedSignals): Needs {
  const why: string[] = [];

  // conversation: union of every signal that the user refers to OUR conversation.
  let conversation = false;
  if (s.plannerPastRef !== "none") (conversation = true), why.push("conv+planner");
  // Choosing the recheck route IS the planner reading a past reference ("is an EARLIER answer still right?"),
  // even when its pastRef field says none (a thinner fallback planner often fills one and not the other).
  const plannerRecheck = s.plannerRead && s.plannerRoute === "recheck";
  if (plannerRecheck && s.plannerPastRef === "none") (conversation = true), why.push("conv+plannerRoute");
  if (s.explicitConversationCue) (conversation = true), why.push("conv+rule");
  if (s.sessionCue) (conversation = true), why.push(`conv+${s.sessionCue}`);
  if (s.assistantPastPremise) (conversation = true), why.push("conv+assistant_past");
  // A bare past time phrase is ambiguous (world "came out last month" vs our chat "last month"): it only counts
  // when nothing says it's a world claim.
  // Date ownership by EVIDENCE: a time phrase is ours if nothing claims it for the world, or if a relevant
  // conversation was actually found in that window ("on Monday we shortlisted…").
  if (s.pastTimePhrase && (!s.premises || s.admittedMemory > 0)) (conversation = true), why.push("conv+time");
  if (!conversation && s.jevRef !== null && s.jevRef >= T.REF_ADD && s.admittedMemory > 0) (conversation = true), why.push("conv+jev");

  // A time phrase alone (no explicit cue, no planner reading) is a reference only if Jev confirms the user is
  // referring to our conversation; a related old chat is otherwise quiet context (reference ≠ relevance).
  const timeOnly = why.length === 1 && why[0] === "conv+time";
  if (conversation && timeOnly && s.jevRef !== null && s.jevRef < T.REF_KEEP) (conversation = false), why.push("conv-timeOnly");
  // Evidence removes a weakly-backed reference: only explicit cues and "you told me X" are immune.
  const strong = s.explicitConversationCue || !!s.sessionCue || s.assistantPastPremise;
  if (conversation && !strong && s.jevRef !== null) {
    const plannerOnly = s.plannerPastRef !== "none" || plannerRecheck;
    // A relevant earlier conversation that was actually found protects the reference: only a clear "no" drops it.
    // Session-order readings ("last/first question") from the planner alone are its weakest: they need
    // Jev's agreement even when a related turn was found.
    const sessionOrder = s.plannerPastRef === "last_question" || s.plannerPastRef === "first_question";
    if (s.jevRef < T.REF_CLEAR_NO || (plannerOnly && s.jevRef < T.REF_KEEP && (s.admittedMemory === 0 || sessionOrder))) (conversation = false), why.push("conv-jev");
  }

  // Union, not a vote: either the planner or the phrase rule can raise it; an admitted earlier answer is required.
  // A planner-only recheck reading (no "still correct / changed / since" wording) is vetoed when Jev is confident
  // our record alone answers the message ("what did you recommend?") — a weak label never overrides strong evidence.
  // The planner's recheck reading is its flag OR its choice of the recheck route (a thin planner often sets one).
  const plannerRecheckRead = s.plannerWantsRecheck || plannerRecheck;
  const plannerOnlyRecheck = plannerRecheckRead && !s.recheckHint;
  const vetoed = plannerOnlyRecheck && s.jevConvOnly !== null && s.jevConvOnly >= T.CONV_ONLY_STRONG;
  const recheck = conversation && s.admittedMemory > 0 && (plannerRecheckRead || s.recheckHint) && !vetoed;
  if (vetoed) why.push("recheck-vetoed");
  if (recheck) why.push("recheck");

  // reply: a cue (planner or wording) that the message works on the previous reply, CONFIRMED by evidence that the
  // previous reply alone answers it. A claim to check, a recheck or an older conversation keeps the normal legs.
  const reply = !!s.replyAsk && !conversation && !recheck && !s.premises && s.jevReplyOnly != null && s.jevReplyOnly >= T.REPLY_ONLY;
  if (reply) why.push("reply");

  // world: ON by default.
  let world = true;
  const claimsOrFacts = s.premises > 0 || s.plannerFactual;
  // Code-identified arithmetic (live values already excluded upstream) and small talk need no web; the
  // question-shape heuristic doesn't override code's own arithmetic detection.
  if (reply) (world = false), why.push("world-replyOnly");
  else if (!claimsOrFacts && (s.compute || (s.social && !s.worldHeuristic))) (world = false), why.push("world-social/compute");
  // Conversation-only by AGREEMENT: planner (no facts asked), no claim, and Jev says our record suffices.
  // A memory question that found nothing, with no claim and no world question: the honest "no record" IS the
  // whole answer (Jev can't judge "answerable from our record" when there is no record).
  // Skipping the web needs an explicit "no world question": Jev when available, else planner AND heuristics.
  else if (conversation && !s.premises && s.admittedMemory === 0 && noWorldAsk(s)) (world = false), why.push("world-noRecord");
  // Conversation-only by AGREEMENT. A strong evidence verdict (≥ 0.8) outweighs a weak planner "factual" label;
  // a claim to check always keeps the web.
  else if (conversation && !s.premises && !recheck && s.jevConvOnly !== null && (s.jevConvOnly >= T.CONV_ONLY_STRONG || (!s.plannerFactual && s.jevConvOnly >= T.CONV_ONLY)) && (s.jevWorldAsk == null || s.jevWorldAsk < T.WORLD_ASK_YES)) (world = false), why.push("world-convOnly");
  // A chat request the planner kept as chat (writing, explanation) with no world signal anywhere.
  else if (!conversation && s.plannerRead && s.plannerRoute === "chat" && !claimsOrFacts && !s.worldHeuristic && s.entities === 0) (world = false), why.push("world-chat");
  if (world) why.push("world");
  if (s.premises) why.push("premise");
  return { conversation, world, recheck, premise: s.premises > 0, reply, why };
}
