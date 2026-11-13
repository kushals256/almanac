/**
 * Typed values and the like-for-like comparator (claim re-observation, see docs/RECHECK_RESEARCH.md §5.3).
 * Code parses every value span; no model is involved. The only "knowledge" here is about value types
 * (money, periods, per-seat units, billing cadence, promo/approx cues) — nothing vendor- or phrasing-specific.
 */
export type Period = "month" | "year" | "once" | "usage" | null;

export type Money = {
  kind: "money";
  amount: number;
  currency: string;
  period: Period;
  /** Usage unit when period = "usage" ("CU-hour", "GB", "1M tokens"). */
  usageUnit?: string;
  perUnit: string | null; // seat / user / member / agent / host
  billing: "monthly" | "annual" | null;
  approx: boolean;
  promo: boolean;
  /** "Typical spend $15/month", "e.g. $40": an estimate or example, not a list price. */
  estimate?: boolean;
  /** Marked as another kind of amount in its own clause: a minimum, credit, fee, deposit, cap or saving. */
  otherKind?: boolean;
  raw: string;
};
export type Num = { kind: "number"; value: number; unit: string | null; raw: string };
export type Range = { kind: "range"; lo: number; hi: number; unit: string | null; raw: string };
/** prerelease: labelled alpha/beta/rc/nightly/preview/canary in its context — not a release (like a promo price). */
export type Version = { kind: "version"; value: string; raw: string; prerelease?: boolean };

const PRERELEASE_RE = /\b(alpha|beta|rc\d*|release candidate|nightly|preview|canary|pre-?release|dev build|insider)\b|-(alpha|beta|rc|nightly|pre)/i;
/** Mark a version as a pre-release when its own text or nearby context says so. */
export function markPrerelease(v: Value, context: string): Value {
  return v.kind === "version" && PRERELEASE_RE.test(context) ? { ...v, prerelease: true } : v;
}
export type Value = Money | Num | Range | Version;

const CUR: Array<[RegExp, string]> = [
  [/US\$|\$|USD/i, "USD"],
  [/€|EUR/i, "EUR"],
  [/£|GBP/i, "GBP"],
  [/₹|INR|Rs\.?/i, "INR"],
];
const PER_UNIT = /\b(seat|user|member|agent|host|editor|creator|person|license|licence)s?\b/i;
const APPROX = /\b(about|around|approx(?:imately)?|roughly|from|starting(?: at)?|starts? at|~|up to)\b|~/i;
const ESTIMATE = /\b(typical(?:ly)?|average|avg\.?|estimated?|e\.g\.|for example|example|expect(?:ed)? to pay|spend|budget|savings?|save)\b/i;
const OTHER_KIND = /\b(minimum|min\.|credits?|fees?|deposit|top-?up|set-?up|overage|cap|spend limit|save|saving|off)\b/i;
const PROMO = /\b(promo|promotional|intro(?:ductory)?|first \d+ (?:months?|years?)|for \d+ months?|limited[- ]time|% off|discount(?:ed)?|was \$|special offer|trial)\b/i;

/** Parse every money amount in a span, with the qualifiers found in its neighbourhood. */
export function parseMoney(span: string): Money[] {
  const out: Money[] = [];
  const re = /(US\$|\$|€|£|₹|Rs\.?\s?|USD\s?|EUR\s?|GBP\s?|INR\s?)\s?(\d{1,3}(?:\.\d{3})+,\d{2}(?!\d)|\d{1,2}(?:,\d{2})+,\d{3}(?:\.\d+)?|\d{1,3}(?:[,\s]\d{3})+(?:\.\d+)?|\d+,\d{2}(?![\d,])|\d+(?:\.\d+)?)\s?(k|K|lakh)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(span))) {
    // Grouping: "1,299" / "1 299" / Indian "1,14,900"; a European decimal comma "€37,50" is 37.50 and European
    // grouping "€1.299,00" is 1299.00 (dots group, the comma is the decimal point).
    const g = m[2]!;
    let amount = /^\d{1,3}(?:\.\d{3})+,\d{2}$/.test(g) ? Number(g.replace(/\./g, "").replace(",", ".")) : /^\d+,\d{2}$/.test(g) ? Number(g.replace(",", ".")) : Number(g.replace(/[,\s]/g, ""));
    if (!Number.isFinite(amount)) continue;
    if (m[3] === "k" || m[3] === "K") amount *= 1000;
    if (m[3] === "lakh") amount *= 100_000;
    const currency = CUR.find(([r]) => r.test(m![1]!))?.[1] ?? "USD";
    const before = span.slice(Math.max(0, m.index - 30), m.index);
    const after = span.slice(m.index + m[0].length, m.index + m[0].length + 60);
    // Qualifier cues only count inside the value's own clause (a "Then $…" in the next sentence isn't about it).
    const clauseBefore = before.split(/[.!?]\s|\n/).pop() ?? before;
    const clauseAfter = after.split(/[.!?]\s|\n/)[0] ?? after;
    const near = `${clauseBefore} ${clauseAfter}`;
    let period: Period = null;
    let usageUnit: string | undefined;
    // Usage units: "/ CU-hour", "per 1M input tokens", "per million output tokens", "/GB-month", "per 1K requests".
    const usage = after.match(/^\s*(?:\/|per|an?|each|for)\s*((?:1\s?[MK]|one\s+(?:million|thousand)|million|thousand|1,000(?:,000)?)?\s*(?:(input|output|cached)\s+)?(?:CU[- ]?hours?|GB(?:[- ]months?)?|TB|hours?|MTok|KTok|tokens?|requests?|calls?|minutes?|messages?|emails?|credits?))/i);
    if (usage) {
      period = "usage";
      usageUnit = usage[1]!
        .toLowerCase()
        .replace(/one\s+million|million|1,000,000|1\s?m\b/g, "1m")
        .replace(/one\s+thousand|thousand|1,000|1\s?k\b/g, "1k")
        .replace(/\bmtok\b/g, "1m-token")
        .replace(/\bktok\b/g, "1k-token")
        .replace(/s\b/g, "")
        .replace(/\s+/g, "-");
    } else if (/^\s*(?:\/\s*|per\s+|a\s+|each\s+)?(?:\w+\s*\/\s*|\w+\s+per\s+|per\s+\w+\s+(?:per\s+)?)?(mo|mos|month|monthly)\b/i.test(after) || /^\s*\/\s*mo\b/i.test(after)) period = "month";
    else if (/^\s*(?:\/\s*|per\s+|a\s+|each\s+)?(?:\w+\s*\/\s*|\w+\s+per\s+|per\s+\w+\s+(?:per\s+)?)?(yr|yrs|year|yearly|annum)\b/i.test(after)) period = "year";
    else if (/\bone[- ]time\b|\bonce\b|\blifetime\b/i.test(after)) period = "once";
    else {
      // Any other "per X" / "/X" right after the amount that isn't a seat unit is metered: "per MAU", "/GB", "per 1K events".
      const other = after.match(/^\s*(?:\/|per)\s*((?:1\s?[MK]\s+|1,000\s+)?[A-Za-z][\w-]{0,20})/i);
      if (other && !PER_UNIT.test(other[1]!)) {
        period = "usage";
        usageUnit = other[1]!.toLowerCase().replace(/s$/, "").replace(/\s+/g, "-");
      }
    }
    const pu = after.match(PER_UNIT);
    // Billing cadence from the cue closest to the amount: after it first, then just before it.
    const cadence = (t: string) => {
      const an = t.search(/billed (annually|yearly)|annual(ly)? billing|\bannual(ly)?\b|paid annually|per year, billed/i);
      const mo = t.search(/billed monthly|monthly billing|month-to-month|paid monthly/i);
      if (an < 0 && mo < 0) return null;
      if (an < 0) return "monthly" as const;
      if (mo < 0) return "annual" as const;
      return an < mo ? ("annual" as const) : ("monthly" as const);
    };
    const nextAmount = after.search(/[$€£₹]\s?\d/);
    const billing = cadence(nextAmount > 0 ? after.slice(0, nextAmount) : after) ?? cadence(before.slice(-16));
    out.push({
      kind: "money",
      amount,
      currency,
      period,
      usageUnit,
      // seat / user / member / person / licence all mean "per person"; agent and host stay distinct.
      perUnit: pu ? (/^(agent|host)/i.test(pu[1]!) ? pu[1]!.toLowerCase().replace(/s$/, "") : "seat") : null,
      billing,
      approx: APPROX.test(before.slice(-14)) || /^\s*\+/.test(after),
      promo: PROMO.test(near),
      otherKind: OTHER_KIND.test(near),
      // Estimates are marked anywhere earlier in the same sentence ("For example, 100 databases … roughly $85 a month in total").
      estimate: ESTIMATE.test(span.slice(Math.max(0, m.index - 300), m.index).split(/[.!?]\s|\n/).pop() ?? "") || /^\s*[^.\n]{0,30}\bin total\b/i.test(after),
      raw: m[0].trim(),
    });
  }
  return out;
}

/** Parse the first value of any type in a span (money first). */
export function parseValues(span: string): Value[] {
  const money = parseMoney(span);
  if (money.length) return money;
  const vals: Value[] = [];
  const range = span.match(/(\d+(?:\.\d+)?)\s*%?\s*(?:–|-|to)\s*(\d+(?:\.\d+)?)\s*(%)?/);
  if (range) vals.push({ kind: "range", lo: Number(range[1]), hi: Number(range[2]), unit: range[3] ? "%" : null, raw: range[0] });
  const ver = span.match(/\bv?(\d+\.\d+(?:\.\d+)+)\b/);
  if (ver) vals.push({ kind: "version", value: ver[1]!, raw: ver[0] });
  if (!vals.length) {
    const n = span.match(/(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(%|GB|TB|MB|hours?|days?|weeks?|months?|years?|seats?|users?|projects?|minutes?)?/i);
    // A bare number is only a value when it has a unit, or is the whole span. "Slim 5", "Ryzen AI 7 445",
    // "M.2" are names, not quantities.
    if (n && (n[2] || /^\s*[\d,.]+\s*$/.test(span))) vals.push({ kind: "number", value: Number(n[1]!.replace(/,/g, "")), unit: n[2]?.toLowerCase().replace(/s$/, "") ?? null, raw: n[0] });
  }
  return vals;
}

/**
 * Verdicts. compareValues only says whether two values are the same ("Unchanged"), different ("Changed"), or
 * can't be compared like-for-like ("Not comparable": a price is shown, but in another currency, period or unit).
 * Whether a difference is a change AFTER the earlier answer or a correction of it ("Differs") needs timing
 * evidence, which only the re-check has: see attributeChanges in v2.ts.
 */
export type Verdict = "Unchanged" | "Changed" | "Differs" | "Not comparable" | "Unverifiable" | "Source gone";
export type Comparison = { verdict: Verdict; note?: string; then?: Value; now?: Value };

const sameQualifiers = (a: Money, b: Money) =>
  a.currency === b.currency &&
  // A one-off price (no period) and a periodic one ("$108.25/mo" financing) are different kinds of price.
  !((a.period === null) !== (b.period === null) && Math.max(a.amount, b.amount) / Math.max(Math.min(a.amount, b.amount), 0.01) > 5) &&
  (a.period === b.period || a.period === null || b.period === null) &&
  (a.perUnit === b.perUnit || a.perUnit === null || b.perUnit === null) &&
  // Usage prices only compare per the same unit ("per 1M input tokens" ≠ "per 1M output tokens").
  (a.period !== "usage" || b.period !== "usage" || !a.usageUnit || !b.usageUnit || unitsCompatible(a.usageUnit, b.usageUnit));

/** "1m-input-token" ~ "1m-token" (one side doesn't say which), but "1m-input-token" ≠ "1m-output-token". */
function unitsCompatible(a: string, b: string): boolean {
  if (a === b) return true;
  const q = /-?(input|output|cached)-?/;
  const qa = a.match(q)?.[1], qb = b.match(q)?.[1];
  if (qa && qb && qa !== qb) return false;
  return a.replace(q, "-").replace(/^-|-$/g, "") === b.replace(q, "-").replace(/^-|-$/g, "");
}

/**
 * Equal within what the earlier value claimed: "$10" = "$10.00"; "about $60" ≈ $57–63. An exact whole figure
 * also matches the same price written with charm cents just below it ("$60" vs "$59.99"), but never a different
 * cent amount above or below it ("$10" vs "$10.19" is a change).
 */
function nearlyEqual(then: number, now: number, approx: boolean): boolean {
  // Float noise only, relative to the value: "$0.001" vs "$0.002" per unit is a 2× change, not rounding.
  if (Math.abs(then - now) < Math.min(0.005, Math.abs(then) * 0.001 + 1e-9)) return true;
  if (approx) return Math.abs(then - now) <= Math.max(1, then * 0.05);
  return Number.isInteger(then) && then >= 1 && then - now > 0 && then - now <= 0.051;
}

/** Same price/unit/currency/cadence except the period, and the periods are month vs year. */
const otherPeriodOnly = (a: Money, b: Money) =>
  ((a.period === "month" && b.period === "year") || (a.period === "year" && b.period === "month")) && sameQualifiers({ ...a, period: null }, { ...b, period: null });

/** One side yearly and the other monthly (or unstated): equal once converted (×12). */
function samePeriodically(t: Money, n: Money): boolean {
  if (t.period === "year" && (n.period === "month" || n.period === null)) return nearlyEqual(t.amount, n.amount * 12, true);
  if (t.period === "month" && n.period === "year") return nearlyEqual(t.amount * 12, n.amount, true);
  return false;
}

/**
 * A flat (non-usage) price that moved more than 20× either way is almost always a different figure (another plan, a
 * fee, a cap), not a price change: the same belief the locators rank candidates by (v2.ts qualifierScore).
 */
export function farOff(then: Value | undefined, now: Value | undefined): boolean {
  if (then?.kind !== "money" || now?.kind !== "money" || then.period === "usage" || now.period === "usage" || then.amount <= 0) return false;
  const r = now.amount / then.amount;
  return r > 20 || r < 0.05;
}

const pct = (a: number, b: number) => (a ? `${b > a ? "+" : ""}${Math.round(((b - a) / a) * 100)}%` : "");

/**
 * Like-for-like comparison of the earlier value(s) with the values observed now. Code decides the verdict;
 * a model never does. Returns Unverifiable rather than guess when nothing comparable is observed.
 */
export function compareValues(thenVals: Value[], nowVals: Value[]): Comparison {
  if (!thenVals.length) return { verdict: "Unverifiable", note: "no earlier value to compare" };
  if (!nowVals.length) return { verdict: "Unverifiable", note: "value not shown on the page" };
  const thenMoney = thenVals.filter((v): v is Money => v.kind === "money");
  const nowMoney = nowVals.filter((v): v is Money => v.kind === "money");
  if (thenMoney.length) {
    if (!nowMoney.length) return { verdict: "Unverifiable", note: "no price shown on the page" };
    // Pricing model change: flat periodic price then, only usage-based prices now.
    if (thenMoney.some((t) => t.period === "month" || t.period === "year") && nowMoney.every((n) => n.period === "usage"))
      return { verdict: "Changed", note: "pricing model changed (flat → usage-based)", then: thenMoney[0], now: nowMoney[0] };
    const nonPromoNow = nowMoney.filter((n) => !n.promo);
    const candidates = nonPromoNow.length ? nonPromoNow : nowMoney;
    if (!nonPromoNow.length && thenMoney.every((t) => !t.promo)) return { verdict: "Unverifiable", note: "only a promo price is shown" };
    // For each earlier value (several cadences possible), compare against a now-value with the same qualifiers.
    let compared = 0;
    let unclear = 0;
    let otherPeriod = false;
    for (const t of thenMoney) {
      const match = candidates.filter((n) => sameQualifiers(t, n) && (t.billing === n.billing || !t.billing || !n.billing));
      if (!match.length) {
        // Only the period differs ("$25/mo" then, "$300/yr" now): equal once converted; otherwise the two figures
        // aren't like-for-like (an annual price often carries a discount), so it's not a change either.
        const periodic = candidates.filter((n) => otherPeriodOnly(t, n));
        if (periodic.some((n) => samePeriodically(t, n))) compared++;
        else if (periodic.length) otherPeriod = true;
        continue;
      }
      // The earlier price had a cadence ("$5 per month") but the figure found now shows none ("$5"). The SAME amount
      // at the plan's label is the same price (pricing pages often put "/month" in a separate element); a DIFFERENT
      // amount without a cadence may be another figure (a credit minimum, a fee): neither Unchanged nor Changed.
      if ((t.period === "month" || t.period === "year") && match.every((n) => n.period === null)) {
        if (match.some((n) => !n.otherKind && nearlyEqual(t.amount, n.amount, t.approx))) {
          compared++;
          continue;
        }
        unclear++;
        continue;
      }
      compared++;
      if (match.some((n) => nearlyEqual(t.amount, n.amount, t.approx))) continue;
      // Same price stated per a different period ("≈ $300 / yr" vs "$25 / mo"): convert before calling it a change.
      if (match.some((n) => samePeriodically(t, n))) continue;
      const n = match[0]!;
      return { verdict: "Changed", note: `${t.raw} → ${n.raw} (${pct(t.amount, n.amount)})`, then: t, now: n };
    }
    if (!compared && unclear) return { verdict: "Unverifiable", note: "the page's figure doesn't state a billing period" };
    if (compared) return { verdict: "Unchanged", then: thenMoney[0], now: candidates[0], note: compared < thenMoney.length ? "only some of the earlier prices are shown" : undefined };
    if (otherPeriod) return { verdict: "Not comparable", note: "the page states it per a different period", then: thenMoney[0], now: candidates[0] };
    return { verdict: "Not comparable", note: "different currency, period or unit", then: thenMoney[0], now: candidates[0] };
  }
  const t = thenVals[0]!;
  const n = nowVals.find((v) => v.kind === t.kind && (v.kind !== "number" || t.kind !== "number" || v.unit === t.unit)) ?? nowVals.find((v) => v.kind === t.kind);
  if (!n) return { verdict: "Unverifiable", note: "no comparable value" };
  if (t.kind === "version" && n.kind === "version") return t.value === n.value ? { verdict: "Unchanged", then: t, now: n } : { verdict: "Changed", note: `${t.value} → ${n.value}`, then: t, now: n };
  if (t.kind === "range" && n.kind === "range") return t.lo === n.lo && t.hi === n.hi ? { verdict: "Unchanged", then: t, now: n } : { verdict: "Changed", note: `${t.raw} → ${n.raw}`, then: t, now: n };
  if (t.kind === "number" && n.kind === "number" && t.unit !== n.unit) return { verdict: "Not comparable", note: "different unit", then: t, now: n };
  if (t.kind === "number" && n.kind === "number") return nearlyEqual(t.value, n.value, false) ? { verdict: "Unchanged", then: t, now: n } : { verdict: "Changed", note: `${t.raw} → ${n.raw}`, then: t, now: n };
  return { verdict: "Unverifiable", note: "no comparable value" };
}
