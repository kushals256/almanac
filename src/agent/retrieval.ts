/** Evidence handling for retrieval: ranking, de-duplication, the bounded follow-up round's helpers. */
import type { Plan } from "./planner.ts";
import { type Evidence } from "../search/router.ts";
import { canonicalUrl, domainOf } from "../util/url.ts";
import { now } from "../util/clock.ts";

/** A follow-up query: the entity, plus the first planned query's context without its other entity names. */
export function followUpQuery(entity: string, baseQuery: string): string {
  const esc = entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `${entity} ${baseQuery.replace(new RegExp(esc, "ig"), "").trim()}`.trim().slice(0, 120);
}

/**
 * Entities the question names that no fetched page mentions (by their most distinctive word). Code decides the
 * follow-up round from this, not the model.
 */
export function uncoveredEntities(entities: string[], evidence: Evidence[]): string[] {
  const corpus = evidence.map((e) => `${e.title} ${e.url} ${e.text}`).join(" ").toLowerCase();
  return [...new Set(entities)].filter((ent) => {
    const words = ent.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
    if (!words.length) return false;
    const key = words.reduce((a, b) => (b.length > a.length ? b : a));
    return !corpus.includes(key);
  });
}

/** Code rerank (SPEC §3 step 4): dedupe, official domains and intent overlap first, keep N, order oldest→newest. */
export function rerank(evidence: Evidence[], p: Plan, n: number, today = now().toISOString().slice(0, 10)): Evidence[] {
  const seen = new Set<string>();
  const intent = terms([...p.queries.map((q) => q.q), ...p.entities].join(" "));
  // Brand tokens: any word of ≥4 letters in an entity name ("HubSpot Sales Hub Starter" → hubspot, sales, starter).
  const entityTokens = [...new Set(p.entities.flatMap((e) => e.toLowerCase().split(/[^a-z0-9]+/)).filter((t) => t.length >= 4 && !/^(sales|plan|plans|starter|cloud|suite|team|crm|hosting|pricing)$/.test(t)))];
  const yearAgo = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`;
  const scored: Array<{ e: Evidence; s: number }> = [];
  for (const e of evidence) {
    if (!e.text && e.status !== "gone") continue;
    const key = canonicalUrl(e.url);
    if (seen.has(key)) continue;
    seen.add(key);
    const dom = domainOf(e.url).replace(/[^a-z0-9]/g, "");
    let s = overlap(terms(`${e.title} ${e.text}`), intent);
    if (entityTokens.some((t) => dom.includes(t))) s += 4; // official domain
    if (e.status === "ok" || e.status === "gone") s += 3; // change-leg re-fetch of a page we cited before
    if (e.provider === "hn") s -= 1;
    if (e.publishedAt && e.publishedAt.slice(0, 10) < yearAgo) s -= 3; // stale page
    scored.push({ e, s });
  }
  // Trial fix: every query (sub-question) keeps its best 2 results before the rest fill by score,
  // so a multi-part question ("free tier AND CEO") never loses a part to an official-domain boost.
  scored.sort((a, b) => b.s - a.s);
  const picked = new Set<Evidence>();
  // on rechecks every entity first gets its best piece of evidence (official domain or a page
  // that names it), so no product in a shortlist is left without a "Now" source.
  if (p.route === "recheck") {
    for (const ent of p.entities) {
      const toks = ent.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
      const best = scored.find((x) => !picked.has(x.e) && toks.some((t) => domainOf(x.e.url).replace(/[^a-z0-9]/g, "").includes(t) || `${x.e.title} ${x.e.text}`.toLowerCase().includes(t)));
      if (best && picked.size < n) picked.add(best.e);
    }
  }
  const byQuery = new Map<string, number>();
  for (const x of scored) {
    if (picked.size >= n) break;
    const k = x.e.query;
    if ((byQuery.get(k) ?? 0) < 2) {
      picked.add(x.e);
      byQuery.set(k, (byQuery.get(k) ?? 0) + 1);
    }
  }
  for (const x of scored) {
    if (picked.size >= n) break;
    picked.add(x.e);
  }
  const top = [...picked];
  return top.sort((a, b) => (a.publishedAt ?? "9999").localeCompare(b.publishedAt ?? "9999"));
}

export function terms(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9][a-z0-9.+-]{2,}/g) ?? []).filter((t) => !/^(the|and|for|with|from|that|this|what|how|are|was|has|have|pricing|price|new)$/.test(t)));
}

export function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

export function dedupeBy<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = { status: "fulfilled", value: await fn(items[idx]!) };
      } catch (e) {
        out[idx] = { status: "rejected", reason: e };
      }
    }
  });
  await Promise.all(workers);
  return out;
}
