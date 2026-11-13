/**
 * Signals: everything code reads from the USER'S MESSAGE with phrase rules and heuristics, in one place.
 * In the needs model these can only ADD a need (planner ∪ rules ∪ evidence); they never remove one, so a rule
 * that misses costs nothing and a rule that fires wrongly is checked by evidence (Jev) downstream.
 * They are a safety net for when the planner model is thin or fails — not the primary reader of meaning (the planner
 * is). Rationale and measurements for each are in evals/FINDINGS.md.
 */
export const CHITCHAT_RE = /^\s*(hi|hello|hey|yo|thanks|thank you|thx|ok(ay)?|cool|great|bye|good (morning|evening|night)|what can you do|who are you|what are you|help)\b[^a-z]*$/i;
/** Cues that a "chat" route is wrong: the question is about the changing world. */
export const WORLD_RE = /\b(price|pricing|cost|latest|current(ly)?|today|this (year|month|week)|news|release[ds]?|discontinu\w*|launch\w*|ceo|version|acqui[rs]\w*|announc\w*|stock|weather|score|won|winner|election)\b/i;
export const RECHECK_HINT_RE = /\b(changed|still (correct|true|valid|accurate|right|the best|current|up to date)|since|any updates?|shipped|launched|outdated|is (it|that|this) (still )?(right|correct))\b/i;
/** "What did I just ask?" means this session, not history. */
/** "What did I ask at the start of this conversation?" → the session's first question. */
export const FIRST_RE = /\b(at the (start|beginning)( of (this|our) (chat|conversation))?|(my|the) first (question|thing|message)|beginning of (this|our) (chat|conversation)|when we started)\b/i;
/** "List everything / all the questions I asked …". */
export const LIST_RE = /\b(list|show|give me)\b.{0,30}\b(everything|all( the)?( my)?( questions)?|every question)\b|\beverything (i|we) (asked|discussed|talked about)\b/i;
export const JUST_RE = /\b(just (ask|asked|say|said|tell|told)|a (moment|minute|second) ago|earlier in (this|our) (chat|conversation)|(my|the) (last|previous) (question|message))\b/i;
/** Explicit memory cues beyond date phrases. */
export const MEMORY_CUE_RE = /\b(did you (tell|say|recommend|suggest|mention|answer)|what did you|you (told|said|recommended|suggested|mentioned|gave)|remind me|did i (ever )?ask|have i asked|what did (i|we)|did we (talk|discuss)|have we (talked|discussed)|our (earlier|last|previous) (chat|conversation))\b/i;
/**
 * a factual question about a specific named thing or number must be searched, never answered
 * from model memory (chat was right 4/11 vs search 47/55 on public datasets).
 */
export function isFactualQuestion(text: string): boolean {
  const t = text.trim();
  if (/^(translate|write|compose|draft|rewrite|explain|summari[sz]e (this|the following)|tell me a joke)\b/i.test(t)) return false;
  const wh = /^(who|whom|whose|what|what's|when|where|which|how (many|much|long|old|tall|far|big|often))\b/i.test(t);
  // A proper noun after the first word, a number, or a quoted title.
  const specific = /\s[A-Z][\w'’.-]+/.test(t.slice(1)) || /\d/.test(t) || /["“'‘][^"”'’]{3,}["”'’]/.test(t);
  const procedure = /\bhow (do|can|should) (i|we|you)\b.*\b(file|apply|renew|register|claim|pay (my )?tax|get an? (visa|passport|licen[cs]e|permit|pan|aadhaar))\b/i.test(t);
  return (wh && specific) || procedure;
}

/** Arithmetic that still needs live data ("…at today's price") is not pure arithmetic. */
export const WORLD_NOW_RE = /\b(current(ly)?|today'?s?|right now|latest|live)\b/i;
/** Requests to act. */
export const ACTION_REQ_RE = /\b(buy|purchase|order (it|this|one)|place (the|an) order|check ?out|pay (for|with)|use my (saved|card|credit|payment)|email (me|it|the|a)|send (me|an email|the receipt)|book (a|the|me)|schedule|open (my|the) .{0,40}(file|sheet|spreadsheet|drive|doc)|update (my|the) .{0,30}(sheet|spreadsheet|file|doc|cell)|save (it|the|my)|execute|run (this|the) (script|code|command))\b/i;
/** Session-level cue that someone is steering toward impersonation or extraction over several turns. */
export const STEERING_RE = /\b(pretend|act as|role-?play|you are now|as an? (official|real)|in the voice of|sign (it|off) as|system prompt|your (instructions|configuration|rules|hidden))\b/i;

/** The user names a format or length for the answer ("in two lines", "as a table", "3 bullets", "tl;dr"): it overrides the route's default shape. */
export const FORMAT_RE = /\b(in (one|two|three|four|five|a few|\d{1,2}) (lines?|sentences?|bullets?|bullet points?|words|points?|paragraphs?)|(one|two|three|\d{1,2})[- ](line|sentence|bullet|word)s?\b|as a (table|list|bulleted list|checklist|paragraph)|in a (table|list|sentence|paragraph)|(in )?bullet points|tl;?dr|short(er)? (version|answer)|briefly|in short|no table|without (a|the) table)\b/i;
/** Reshaping what was just said ("shorter", "summarise that", "explain the second one", "which would you pick?"). */
const RESHAPE_RE = /\b(shorter|simpler|summari[sz]e (that|this|it|the above)|rephrase|reword|simplify|eli5|explain (that|this|it|the (first|second|third|last) (one|point|option))|translate (that|this|it)|(which|what) (one )?would you (pick|choose|recommend|go with)|your (recommendation|pick|verdict|answer|summary|take)|the (first|second|third|last) (one|option|point)|of (those|these|them)|from (that|this|the) (list|table|answer))\b/i;

/** Non-English input: a non-Latin script, Spanish ¿/¡, or a stopword profile of another language — not one
 * accented brand name in an English sentence ("Pokémon", "Nestlé", "café"). */
const NON_LATIN_RE = /[\u0400-\u04FF\u0590-\u06FF\u0900-\u097F\u0E00-\u0E7F\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/;
// Stopword profiles (standard language-ID signal): function words, not topic words.
const EN_STOP = new Set("the a an is are was were what which who how when where why of and or to in on for with from at by this that it do does did can could should would will i you my your me we our".split(" "));
const OTHER_STOP = new Set("o le la les un une des du est et ou en dans pour avec sur qui que quoi quel quelle el los las del es y con por para cómo qué cuál der die das und ist nicht mit für ein eine wie was il lo gli della che è non per con o um uma os não com como você é qual são da".split(" "));
export function isNonEnglish(text: string): boolean {
  if (NON_LATIN_RE.test(text) || /[¿¡]/.test(text)) return true;
  // A quoted title is not the message's language ("what does 'la vie en rose' mean?").
  const frame = text.replace(/"[^"]*"|“[^”]*”|(?<![A-Za-z])'[^']{3,}'(?![A-Za-z])|‘[^’]*’|«[^»]*»/g, " ");
  const words = frame.toLowerCase().split(/[^a-zà-ÿœß']+/).filter(Boolean);
  const en = words.filter((w) => EN_STOP.has(w) && !OTHER_STOP.has(w)).length;
  const other = words.filter((w) => OTHER_STOP.has(w)).length;
  // Any English function word frames the message in English unless the other language clearly outweighs it:
  // "Who sang la vie en rose?" stays English; "Quel est le prix de Notion ?" doesn't.
  return other >= 2 && other >= en + (en ? 2 : 0);
}
/** Pure arithmetic on numbers the user supplied: ≥2 numbers and a hypothetical/compute cue. */
export function isArithmetic(text: string): boolean {
  const nums = text.match(/\$?\d[\d,]*(\.\d+)?/g) ?? [];
  if (nums.length < 2) return false;
  if (/\d+(\.\d+)?\s*%\s*of\s*\$?\d/.test(text)) return true; // "18% of 2,450"
  return /^\s*(if|suppose|assuming|say)\b/i.test(text) || /\b(calculate|compute|how much (is|would|will)|what('?s| is| would be) the (total|annual|yearly|monthly))\b/i.test(text) || /\d\s*[x×*\/+]\s*\$?\d/.test(text) || /\d\s*(times|multiplied by|divided by|plus|minus)\s*\$?\d/i.test(text);
}

/** All message signals, computed once per turn. */
export type Signals = {
  chitchat: boolean;
  /** "first thing I asked" / "what did I just ask" / "list everything I asked" (this-chat references). */
  first: boolean;
  just: boolean;
  list: boolean;
  /** Explicit reference to our conversation: "you told me", "did I ask", "u said". */
  memoryCue: boolean;
  /** Wording that asks to reshape/choose from the previous reply (a cue; the judge decides). */
  reshapeCue: boolean;
  /** A requested format or length (overrides the route's default answer shape). */
  formatAsk: boolean;
  recheckHint: boolean;
  /** Question shape suggests the changing world (prices, versions, winners…) or a factual lookup. */
  worldShape: boolean;
  /** Refers to a set of items from before ("the shortlist", "the options", "the tools we compared"). */
  refersToSet: boolean;
  /** Comparison / choice wording ("compare", "vs", "which", "best", "cheapest"): a research-depth answer. */
  compareShape: boolean;
  /** Arithmetic on numbers the user gave, without live values. */
  compute: boolean;
  arithmetic: boolean;
  action: boolean;
  /** Steering toward impersonation or instruction extraction, in this message or recent user turns. */
  steering: boolean;
  nonEnglish: boolean;
};

export function readSignals(msg: string, recentUserTexts: string[] = []): Signals {
  const arithmetic = isArithmetic(msg);
  return {
    chitchat: CHITCHAT_RE.test(msg),
    first: FIRST_RE.test(msg),
    just: JUST_RE.test(msg) || FIRST_RE.test(msg),
    list: LIST_RE.test(msg),
    memoryCue: MEMORY_CUE_RE.test(msg) || /\b(you|u)\s+(said|told|mentioned|recommended|suggested)\b/i.test(msg),
    recheckHint: RECHECK_HINT_RE.test(msg),
    // The world-question heuristics only read English: a question in another language isn't small talk just
    // because they stayed silent.
    worldShape: WORLD_RE.test(msg) || isFactualQuestion(msg) || (isNonEnglish(msg) && /[?？؟]/.test(msg)),
    compareShape: /\b(compare|vs\.?|versus|which|best|cheapest)\b/i.test(msg),
    refersToSet: /\b(shortlist|compared|tools|options|vendors|asked you about)\b/i.test(msg),
    compute: arithmetic && !WORLD_NOW_RE.test(msg),
    arithmetic,
    action: ACTION_REQ_RE.test(msg),
    steering: [msg, ...recentUserTexts].some((t) => STEERING_RE.test(t)),
    nonEnglish: isNonEnglish(msg),
    reshapeCue: RESHAPE_RE.test(msg) || (FORMAT_RE.test(msg) && msg.trim().split(/\s+/).length <= 12),
    formatAsk: FORMAT_RE.test(msg),
  };
}
