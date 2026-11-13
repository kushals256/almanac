import { DEEP_CHARS } from "../answer-input.ts";
import { type GateResult, type Premise, premiseGate } from "../claims.ts";
import { type Plan } from "../planner.ts";
import { dedupeBy, followUpQuery, mapLimit, rerank, uncoveredEntities } from "../retrieval.ts";
import { officialPageQueries } from "../routing.ts";
import { bestPassages } from "../text.ts";
import { DEEP_READ_MS, DEEP_SOURCES, type Emit, MAX_EVIDENCE, MAX_EVIDENCE_RECHECK, REPLY_EVIDENCE_MAX, TTL_MS, type Turn, TURN_SEARCH_CAP } from "../turn.ts";
import { DEADLINES_MS } from "../../config.ts";
import { Judge } from "../../llm/judge.ts";
import type { RecallHit, Store } from "../../memory/store.ts";
import { withoutValues } from "../../recheck/v2.ts";
import { type Evidence, type SearchRouter, type SearchStats } from "../../search/router.ts";
import { canonicalUrl } from "../../util/url.ts";
import { humanDate } from "../../util/clock.ts";

/** The web leg: search for the planned queries (or the previous reply's own sources), read the top pages, check premises. */
export class RetrieveStage {
  constructor(
    private readonly store: Store,
    private readonly search: SearchRouter,
    private readonly judge: Judge,
  ) {}

  /** Stage: web retrieval for the needs that call for it, under the route deadline. */
  async retrieve(t: Turn, hits: RecallHit[]): Promise<{ evidence: Evidence[]; skipped: boolean }> {
    const { p } = t;
    if (p.route === "reply") return { evidence: this.replyEvidence(t), skipped: false };
    if (p.route !== "quick" && p.route !== "research" && p.route !== "recheck") return { evidence: [], skipped: false };
    const deadlineTimer = setTimeout(() => t.retrieveCtl.abort(new Error("retrieval deadline")), Math.max(2_000, DEADLINES_MS[p.route] - 4_000));
    const tRet = performance.now();
    let evidence: Evidence[] = [];
    let skipped = false;
    try {
      evidence = p.route === "recheck" ? await this.retrieveRecheck(p, hits, t.retrieveSignal, t.stats, t.emit) : await this.retrieveSearch(p, t.msg, t.retrieveSignal, t.stats, t.emit);
      // One bounded follow-up round (research only): an entity the question names that no fetched page covers gets
      // one targeted search. Decided by code, at most 2 searches, inside the same retrieval deadline.
      if (p.route === "research") {
        const gaps = uncoveredEntities(p.entities, evidence).slice(0, 2);
        if (gaps.length) {
          t.emit("status", { phase: "search", detail: `Looking up ${gaps.join(" and ")} specifically` });
          const more = await Promise.all(
            gaps.map((e) =>
              this.search
                .search({ query: followUpQuery(e, p.queries[0]?.q ?? ""), objective: `Find current, authoritative information about ${e} specifically, for: ${t.msg.slice(0, 300)}. Prefer ${e}'s own site.`, ttlMs: TTL_MS[p.volatility] }, t.retrieveSignal, t.stats)
                .catch(() => [] as Evidence[]),
            ),
          );
          evidence = [...evidence, ...more.flat()];
        }
      }
    } catch (e) {
      if (t.signal.aborted) throw e;
      skipped = true;
    } finally {
      clearTimeout(deadlineTimer);
    }
    if (t.retrieveCtl.signal.aborted && !t.signal.aborted) skipped = true;
    evidence = rerank(evidence, p, p.route === "recheck" ? MAX_EVIDENCE_RECHECK : MAX_EVIDENCE);
    // Research answers read the top pages' text, not only snippets: the best-matching passages of each.
    if (p.route === "research" && evidence.length && !skipped) evidence = await this.deepenTopSources(evidence, `${t.msg} ${p.queries.map((q) => q.q).join(" ")}`, t);
    t.timings.retrieveMs = performance.now() - tRet;
    return { evidence, skipped };
  }

  /** Planned queries in parallel; if every one comes back empty, one search with the user's own words. */
  private async retrieveSearch(p: Plan, msg: string, signal: AbortSignal, stats: SearchStats, emit: Emit): Promise<Evidence[]> {
    const qs = [...p.queries.slice(0, p.route === "quick" ? 3 : 4), ...(p.route === "research" ? officialPageQueries(p, 4) : [])];
    for (const q of qs) emit("status", { phase: "search", detail: `Searching: ${q.q}` });
    const ttlMs = TTL_MS[p.volatility];
    const results = await Promise.allSettled(qs.map((q) => this.search.search({ query: q.q, objective: q.objective, ttlMs }, signal, stats)));
    const out = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    if (out.length) return out;
    // Every planned query came back empty: one search with the user's own words before giving up.
    emit("status", { phase: "search", detail: `Searching: ${msg.slice(0, 80)}` });
    return this.search.search({ query: msg.slice(0, 200), objective: `Find current, authoritative pages that answer: ${msg.slice(0, 400)}`, ttlMs }, signal, stats).catch(() => []);
  }

  /**
   * Re-check of an earlier answer that has NO typed figure (a person in a role, a feature, a policy): recheck v2 can't
   * compare those in code, so the answerer writes the table over fresh evidence (per-entity change leg, live re-fetch of
   * the earlier sources, dated news). Typed values (prices, versions, numbers) never come here: code decides them.
   */
  private async retrieveRecheck(p: Plan, hits: RecallHit[], signal: AbortSignal, stats: SearchStats, emit: Emit): Promise<Evidence[]> {
    const since = hits.map((h) => h.question.local_date).sort()[0]!;
    const oldUrls = dedupeBy(
      hits.flatMap((h) => h.sources.map((s) => s.url)),
      (u) => canonicalUrl(u),
    )
      .sort((a, b) => Number(/pric|plan|billing|changelog|release/i.test(b)) - Number(/pric|plan|billing|changelog|release/i.test(a)))
      .slice(0, 8);
    const entities = p.entities.slice(0, 6);
    let budget = TURN_SEARCH_CAP;
    const jobs: Array<() => Promise<Evidence[]>> = [];

    if (oldUrls.length) {
      emit("status", { phase: "recheck", detail: `Re-reading ${oldUrls.length} pages cited on ${humanDate(since)}` });
      jobs.push(() => this.search.refetch(oldUrls, "pricing plans prices per month features limits", signal, stats));
      budget--;
    }
    for (const q of [...p.queries.slice(0, 6), ...officialPageQueries(p, 6)]) {
      if (budget-- <= 0) break;
      jobs.push(() => this.search.search({ query: withoutValues(q.q), objective: q.objective, ttlMs: 0 }, signal, stats));
    }
    for (const ent of entities) {
      if (budget <= 1) break;
      budget -= 2;
      emit("status", { phase: "recheck", detail: `Checking ${ent} for changes since ${humanDate(since)}` });
      jobs.push(() =>
        this.search.search(
          {
            query: `${ent} pricing change or new launch announcement`,
            objective: `Find announcements, pricing changes, plan changes, launches or major releases by ${ent} published since ${since}. Prefer ${ent}'s own blog, changelog or pricing page and reputable tech press. Pull dates, prices and plan names.`,
            since,
            ttlMs: 0,
          },
          signal,
          stats,
        ),
      );
      jobs.push(() => this.search.releases(ent, since, signal, stats));
    }
    const settled = await mapLimit(jobs, 8, (j) => j());
    return settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  /**
   * Evidence for the reply route: the latest reply's sources FIRST and in its order (its [n] keep their meaning), then
   * the sources of the earlier replies the answerer can see in this chat, newest first — a summary of the whole
   * conversation ("your recommendation in two lines") cites facts from those too.
   */
  private replyEvidence(t: Turn): Evidence[] {
    if (!t.lastReply) return [];
    const replies = [t.lastReply, ...t.history.filter((x) => x.role === "assistant" && x.id !== t.lastReply!.id).reverse()];
    const rows = replies.flatMap((r) => this.store.turnSources(r.id));
    const seen = new Set<string>();
    return rows
      .filter((s) => (seen.has(canonicalUrl(s.url)) ? false : (seen.add(canonicalUrl(s.url)), true)))
      .slice(0, REPLY_EVIDENCE_MAX)
      .map((s) => ({ url: s.url, title: s.title ?? s.url, text: s.excerpt ?? "", publishedAt: s.published_at ?? undefined, fetchedAt: s.fetched_at_utc, provider: (s.provider as Evidence["provider"]) ?? "exa", query: "previous reply", status: "ok" as const }));
  }

  /**
   * Read the top DEEP_SOURCES pages (Exa /contents, cached ≤ 24 h) and keep their passages that best match the
   * question. Best-effort under a short cap: a page that can't be read keeps its snippet.
   */
  private async deepenTopSources(evidence: Evidence[], question: string, t: Turn): Promise<Evidence[]> {
    const top = evidence.slice(0, DEEP_SOURCES);
    try {
      const pages = await this.search.pageText(top.map((e) => e.url), 24, AbortSignal.any([t.signal, AbortSignal.timeout(DEEP_READ_MS)]), t.stats);
      return evidence.map((e, i) => {
        if (i >= DEEP_SOURCES) return e;
        const page = pages.get(e.url) ?? [...pages.entries()].find(([u]) => canonicalUrl(u) === canonicalUrl(e.url))?.[1];
        const passages = page?.status === "ok" ? bestPassages(page.text, question, DEEP_CHARS) : "";
        return passages ? { ...e, text: `${e.text} … ${passages}`, deep: true } : e;
      });
    } catch (e) {
      if (t.signal.aborted) throw e;
      return evidence;
    }
  }

  /** The premise check over a pool of evidence (one probe search only if the pool doesn't settle it); verdicts go to the UI. */
  async runPremiseGate(t: Turn, premises: Premise[], pool: Evidence[]): Promise<GateResult> {
    t.emit("status", { phase: "premise", detail: "Checking an assumption in your question" });
    const g = await premiseGate({ premises, pool, search: this.search, stats: t.stats, judge: this.judge, today: t.temporal.today, entities: t.p.entities, signal: t.signal });
    t.emit("premise", g.verdicts.map((v) => ({ claim: v.premise.claim, status: v.status, searches: g.searches, ms: Math.round(g.ms) })));
    if (process.env.TRACE_RECALL) console.error("TRACE premise", JSON.stringify(g.verdicts.map((v) => ({ c: v.premise.claim, a: v.premise.attribution, t: v.premise.timeAnchor, s: v.status, e: v.exact, x: v.contra, d: v.different }))), Math.round(g.ms), "ms", g.searches, "searches");
    t.timings.premiseMs = g.ms;
    return g;
  }
}
