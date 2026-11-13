/** Answer-text handling in code: citations, code blocks, spacing, repeated leads, and picking page passages. */

/**
 * The passages of a page that best match the question (paragraphs ranked by distinct question words they contain),
 * kept in page order up to a character budget.
 */
export function bestPassages(text: string, question: string, budget: number): string {
  const words = new Set(question.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4));
  if (!words.size) return "";
  const paras = text.split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z])/).map((p) => p.trim()).filter((p) => p.length >= 40);
  const scored = paras.map((p, i) => ({ i, p, s: [...words].filter((w) => p.toLowerCase().includes(w)).length })).filter((x) => x.s >= 2);
  const picked: typeof scored = [];
  let used = 0;
  for (const x of [...scored].sort((a, b) => b.s - a.s)) {
    if (used + x.p.length > budget) continue;
    picked.push(x);
    used += x.p.length;
  }
  return picked.sort((a, b) => a.i - b.i).map((x) => x.p).join(" … ");
}

/** gpt-oss emits 【1】 or 【1†source】; normalise to [1]. */
/** Code blocks and inline code are the user's content, never citations: transforms apply only outside them. */
export const CODE_RE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;

export function outsideCode(text: string, fn: (prose: string) => string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(CODE_RE)) {
    out += fn(text.slice(last, m.index)) + m[0];
    last = m.index! + m[0].length;
  }
  return out + fn(text.slice(last));
}

export function normaliseCitations(text: string): string {
  return outsideCode(text, (prose) =>
    normaliseSpaces(
      prose
        .replace(/【\s*(\d{1,2})(?:[^】]*)】/g, "[$1]")
        // "[7, 9]" / "[3,5,7]" → "[7][9]" so every citation is parsed, verified and rendered.
        .replace(/\[(\d{1,2}(?:\s*,\s*\d{1,2})+)\]/g, (_, list: string) => list.split(",").map((n) => `[${n.trim()}]`).join("")),
    ),
  );
}

/**
 * Citations must point at something retrieved: "[n]" beyond the evidence list is dropped, and a markdown link to a
 * URL that isn't one of the sources keeps its label but loses the link (an unsourced URL is a guess). Code only.
 */
export function dropUnbackedCitations(text: string, sourceUrls: string[]): string {
  const known = new Set(sourceUrls.map(linkKey));
  return outsideCode(text, (prose) => {
    let removed = false;
    const out = prose
      .replace(/\[(\d{1,2})\](?!\()/g, (m, n: string) => (Number(n) >= 1 && Number(n) <= sourceUrls.length ? m : ((removed = true), "\u0000")))
      .replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^)\s]+)\)/g, (m, label: string, url: string) => (known.has(linkKey(url)) ? m : label));
    // Only where a citation was removed: "costs $5 [9]." → "costs $5."
    return removed ? out.replace(/[ \t]*\u0000/g, "") : out;
  });
}
const linkKey = (u: string) => u.toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/[#?].*$/, "").replace(/\/+$/, "");

/** gpt-oss writes narrow/no-break spaces inside dates and numbers ("Tue\u202f3\u202fNov"). */
export function normaliseSpaces(text: string): string {
  return text.replace(/[\u202f\u00a0\u2007\u2009]/g, " ");
}

/** drop a leading "On <date> you asked …" sentence that repeats the code-written preamble. */
export function dropRepeatedLead(s: string, preamble = ""): string {
  const m = s.match(/^\s*(on\s+[^.\n]{0,40}?\byou asked\b[^\n]*?(?:[.”"]\s+|\n+|$))/i);
  if (m) return s.slice(m[0].length).replace(/^\s+/, "");
  // The model sometimes echoes the tail of the quoted question ("…on pricing.”"); drop that echo.
  const echo = s.match(/^\s*([^\n]{8,240}?[”"])\s*/);
  if (echo && preamble.includes(echo[1]!.trim())) return s.slice(echo[0].length);
  return s;
}
