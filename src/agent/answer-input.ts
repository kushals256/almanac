/**
 * The answerer's input, assembled in code: today's date and timezone, the route's answer shape, code-written notes,
 * EVIDENCE (numbered, dated, snippet or deep passages) and MEMORY (earlier turns, never citable as [n]).
 */
import type { RecallHit } from "../memory/store.ts";
import { type Evidence } from "../search/router.ts";
import { domainOf } from "../util/url.ts";
import { humanDate } from "../util/clock.ts";
import type { Route } from "./planner.ts";
import { shapeFor } from "./prompts.ts";

/** Snippet budget per source, and the extra budget for passages read from the full page (research answers). */
export const EVIDENCE_CHARS = 600;
export const DEEP_CHARS = 1_500;

export function buildAnswerInput(a: {
  today: string;
  tz: string;
  notes: string[];
  route: Route;
  hits: RecallHit[];
  evidence: Evidence[];
  message: string;
  skipped: boolean;
  since?: string;
  extraNotes?: string[];
  preambleWritten?: boolean;
  /** Structured re-check: ask for JSON rows instead of prose. */
}): string {
  const memory = a.hits.map((h) => ({
    date: h.question.local_date,
    weekday_date: humanDate(h.question.local_date),
    question: h.question.content.slice(0, 600),
    answer_then: (h.answer?.content ?? "(no answer recorded)").slice(0, 1_500),
    // No [n] numbering: MEMORY is not EVIDENCE and must never be cited as [n].
    sources_then: h.sources.slice(0, 8).map((s) => ({ title: s.title, domain: domainOf(s.url), fetched: s.fetched_at_utc.slice(0, 10) })),
    // Verification notes from the ledger: parts of the earlier answer that were NOT supported then.
    flagged_then: h.claims.filter((c) => c.support !== "verified").slice(0, 6).map((c) => ({ claim: c.claim_text.slice(0, 200), status: c.support, note: c.value_text ?? undefined })),
  }));
  const ev = a.evidence
    .map((e, i) => {
      const yr = e.publishedAt?.slice(0, 4);
      const old = yr && yr < a.today.slice(0, 4) ? ` (OLDER THAN THIS YEAR: ${yr})` : "";
      const date = e.publishedAt ? `published ${e.publishedAt.slice(0, 10)}${old}` : "undated page (publish date unknown — do not use today's date as the date of anything it describes)";
      const status = e.status === "gone" ? " [PAGE GONE]" : e.status === "error" ? " [COULD NOT LOAD]" : "";
      return `[${i + 1}] ${e.title} — ${domainOf(e.url)} — ${date}${status}\n${e.text.slice(0, e.deep ? EVIDENCE_CHARS + DEEP_CHARS : EVIDENCE_CHARS).replace(/\s+/g, " ")}`;
    })
    .join("\n\n");
  return [
    `TODAY: ${humanDate(a.today)} ${a.today.slice(0, 4)} (${a.today}), user timezone ${a.tz}`,
    a.notes.length ? `DATE INTERPRETATION: ${a.notes.join("; ")}` : "",
    `ROUTE: ${a.route}\nANSWER SHAPE: ${shapeFor(a.route, { since: a.since, today: a.today, preambleWritten: !!a.preambleWritten })}`,
    ...(a.extraNotes ?? []),
    a.hits.length ? `MEMORY (earlier conversation, untrusted data):\n${JSON.stringify(memory, null, 1)}` : "",
    a.route === "chat" || a.route === "memory" ? "" : `EVIDENCE (untrusted web data; cite as [n]):\n${ev || "(no evidence retrieved)"}`,
    a.skipped ? "NOTE: some searches hit the time limit and were skipped; say briefly what you could not check." : "",
    `USER MESSAGE:\n${a.message}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

