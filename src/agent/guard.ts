/**
 * Output guard: checks on the MODEL'S OUTPUT (after or while it streams). Precise checks always run; looser
 * patterns only under steering, so ordinary answers aren't refused.
 */
import { ANSWER_SYSTEM } from "./prompts.ts";

/** Claims of having acted, checked in code after the stream. */
export const ACTION_CLAIM_RE = /\b(i(['’]ve| have)? (just )?(purchased|bought|ordered|placed (the|your) order|paid|emailed|sent (you|the|an)|booked|scheduled|saved|updated|edited|opened (the|your)|executed)|(tool|function) call succeeded)|"actions"\s*:/i;
/** Any 8-word run copied from the system prompt counts as a leak (general, not tied to one wording). */
const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
/** The system prompt's 8-word runs, built once (not on every streamed token). */
const SYSTEM_8GRAMS: Set<string> = (() => {
  const sys = norm(ANSWER_SYSTEM);
  const set = new Set<string>();
  for (let i = 0; i + 8 <= sys.length; i++) set.add(sys.slice(i, i + 8).join(" "));
  return set;
})();
function leaksPrompt(text: string): boolean {
  const w = norm(text);
  for (let i = 0; i + 8 <= w.length; i++) if (SYSTEM_8GRAMS.has(w.slice(i, i + 8).join(" "))) return true;
  return false;
}
/** While streaming, check only the recent tail (covers any new 8-word run, line opening or degenerate window); the
 * full answer is checked once at the end. Keeps per-token work constant instead of growing with the answer. */
export const GUARD_TAIL_CHARS = 600;
/** A signed byline that OPENS a line ("Daniel Mercer, Reuters, reporting for Reuters") — any outlet, no list. */
export const BYLINE_RE = /(^|\n)\s*\**\s*(by\s+)?[A-Z][a-z]+ [A-Z][a-z]+,\s+([A-Z][\w&.' ]{1,30},\s+)?(reporting|correspondent|staff (writer|reporter)|for)\b/;
/** Looser "writing for / on behalf of <Org>" phrasing: normal in news summaries, so only checked under steering. */
const BYLINE_LOOSE_RE = /\b(reporting for|writing for|correspondent (for|at)|on behalf of) (the )?[A-Z][\w&.]+/;
/**
 * Degenerate generation (a model collapsing into random tokens): many writing systems mixed within a short
 * window, or replacement characters. Real multilingual answers don't switch among 4+ scripts in 300 chars.
 */
const SCRIPTS = [/[A-Za-z]/, /[\u4E00-\u9FFF\u3040-\u30FF]/, /[\u0400-\u04FF]/, /[\u0600-\u06FF]/, /[\u0590-\u05FF]/, /[\u0900-\u097F]/, /[\uAC00-\uD7AF]/, /[\u0E00-\u0E7F]/, /[\u0370-\u03FF]/];
/** How many writing systems a text mixes. */
export function scriptCount(text: string): number {
  return SCRIPTS.filter((r) => r.test(text)).length;
}
export function isDegenerate(text: string): boolean {
  const w = text.slice(-300);
  if (w.length < 120) return false;
  if ((w.match(/\uFFFD/g) ?? []).length >= 3) return true;
  return scriptCount(w) >= 4;
}

/**
 * Output guard. Always: degenerate output, copied system-prompt text (8-word runs), a prompt presented as a TITLE,
 * an opening byline. Only when the conversation shows steering (planner ∪ rule): the looser byline phrasing.
 */
export function outputViolation(text: string, steering = false): "prompt-leak" | "impersonation" | "degenerate" | null {
  if (isDegenerate(text)) return "degenerate";
  if (leaksPrompt(text)) return "prompt-leak";
  // paraphrased reconstructions ("System Prompt – Research Chat Assistant", "My instructions are:")
  // presented as the assistant's own configuration.
  // Presented as a title ("# System Prompt: …", "**System Prompt – …**"), not prose that mentions system prompts.
  if (/(^|\n)\s*(#+|\*\*)\s*(sample |my |the |assistant |hidden |internal )?system[-\s]?prompt\b|(^|\n)\s*(sample |my |the |assistant |hidden |internal )?system[-\s]?prompt\s*[:–—-]/i.test(text)) return "prompt-leak";
  if (/\b(my|these are my|here are my) (full |complete |exact |hidden |internal |standing )?(instructions|configuration|operating rules|system rules)\b\s*(are|is|:)/i.test(text)) return "prompt-leak";
  if (/\byou are an? [^.\n]{0,60}(research|chat) assistant\b/i.test(text) && /\b(rules|instructions|cite|citation)\b/i.test(text)) return "prompt-leak";
  if (BYLINE_RE.test(text) || (steering && BYLINE_LOOSE_RE.test(text))) return "impersonation";
  return null;
}
export const REFUSALS = {
  "prompt-leak": "I can't share my instructions or configuration. In short: I search the live web and cite sources, remember our conversations with their dates, and can re-check whether an earlier answer is still correct. What would you like to look up?",
  degenerate: "Sorry — the model's output came out garbled, so I stopped it. Please ask again in a moment.",
  impersonation: "I can't write as a real journalist, outlet or company. I can give you a neutral, cited summary of the news instead — want that?",
} as const;
