/** What one turn's stages share: its input, the typed Turn built by understand(), timings, and the limits every stage uses. */
import type { Premise } from "./claims.ts";
import { type Plan } from "./planner.ts";
import type { Signals } from "./signals.ts";
import type { ChatMessage } from "../llm/client.ts";
import type { RecallHit, TurnRow } from "../memory/store.ts";
import { resolveTemporal } from "../memory/temporal.ts";
import type { SearchStats } from "../search/router.ts";

export type Emit = (event: string, data: unknown) => void;
/** owner: whose history this turn belongs to and may recall (defaults to the single local owner). */
export type TurnInput = { sessionId: string; message: string; tz: string; owner?: string };

export const NO_UNDERSTANDING: Plan["understanding"] = { pastRef: "none", recallTerms: [], wantsRecheck: false, actionRequest: false, steering: false, claims: [], premises: [], factual: false, aboutReply: false };

/** Code-written disclosure when a turn needed the web and got nothing back (search outage or deadline). */
export const NO_WEB_NOTE = "I couldn't get any web results just now";
/** An answer with fewer letters/digits than this (beyond the code-written preamble) is a failed generation. */
export const MIN_ANSWER_WORD_CHARS = 12;
/** Value claims re-checked per earlier answer (a 5-product shortlist with price + plan fits). */
export const MAX_RECHECK_CLAIMS = 12;
export const wordChars = (s: string) => (s.match(/[\p{L}\p{N}]/gu) ?? []).length;
export const TTL_MS = { live: 5 * 60_000, fast: 60 * 60_000, slow: 24 * 60 * 60_000, stable: 7 * 24 * 60 * 60_000 } as const;
export const MAX_EVIDENCE = 10;
export const MAX_EVIDENCE_RECHECK = 12;
/** Research answers: how many top pages are read in full, how much of each is kept, and the cap on reading. */
export const DEEP_SOURCES = 3;
export const DEEP_READ_MS = 3_000;
export const TURN_SEARCH_CAP = 40;
/** Conversation replayed to the answerer: this chat's last turns, within a character budget (deep routes carry more evidence). */
export const REPLAY_TURNS = 16;
/** Reply route: sources of the replies in view (latest first, keeping its numbering), capped. */
export const REPLY_EVIDENCE_MAX = 16;
export const REPLAY_BUDGET = { light: 7_000, deep: 4_500 } as const;

/** Everything one turn's stages share; built once by understand(). */
export type Turn = {
  input: TurnInput;
  emit: Emit;
  signal: AbortSignal;
  t0: number;
  at: Date;
  timings: Timings;
  stats: SearchStats;
  msg: string;
  questionId: number;
  temporal: ReturnType<typeof resolveTemporal>;
  /** Message signals (phrase rules, heuristics), computed once in understand(). */
  sig: Signals;
  rule: { first: boolean; list: boolean; just: boolean; memoryCue: boolean; action: boolean };
  recent: ChatMessage[];
  arithmetic: boolean;
  retrieveCtl: AbortController;
  retrieveSignal: AbortSignal;
  p: Plan;
  u: Plan["understanding"];
  plannerRead: boolean;
  plannerModel: string;
  plannerFailedOpen: boolean;
  /** This chat's completed turns, oldest first (replayed to the answerer), and its latest reply. */
  history: TurnRow[];
  lastReply: TurnRow | null;
};
export type RouteState = { hits: RecallHit[]; notes: string[]; preamble: string; extraNotes: string[]; premises: Premise[]; wantsAction: boolean; steering: boolean; dateNote: string | null };
export type Timings = { recallMs: number; planMs: number; retrieveMs: number; ttftMs: number; totalMs: number; premiseMs?: number };

export function roundTimings(t: Timings): Timings {
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Math.round(v)])) as Timings;
}
