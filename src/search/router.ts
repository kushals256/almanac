import { createHash } from "node:crypto";
import type { Config } from "../config.ts";
import { CircuitBreaker, TokenBucket } from "../util/limiter.ts";
import { now } from "../util/clock.ts";
import type { Store } from "../memory/store.ts";

/** One piece of retrieved evidence. */
export type Evidence = {
  url: string;
  title: string;
  publishedAt?: string;
  text: string;
  provider: "exa" | "tavily" | "hn";
  query: string;
  fetchedAt: string;
  /** Exa /contents live re-fetch status for change-leg results. */
  status?: "ok" | "gone" | "error";
  /** Passages read from the full page (research answers), shown to the answerer at a larger budget than snippets. */
  deep?: boolean;
};

export type SearchJob = {
  query: string;
  /** Exa `objective`: the goal this search serves (from the build-with-exa skill). */
  objective: string;
  /** Bounded window that must be enforced (news leg). Local date 'YYYY-MM-DD'. */
  since?: string;
  /** Cache TTL; 0 bypasses the cache (re-checks). */
  ttlMs: number;
};

export type SearchStats = { calls: number; byProvider: Record<string, number>; cacheHits: number; costUsd: number };

class ProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/**
 * SearchRouter (SPEC §5): routes by job, pools providers with per-provider token buckets and
 * circuit breakers, spills over on empty buckets or 402/429/5xx, and caches results.
 * Presented to the models as a single `web_search` tool.
 */
export class SearchRouter {
  private exaSearch = TokenBucket.perSecond(10, 0);
  private exaContents = TokenBucket.perSecond(100, 0);
  private tavily = TokenBucket.perMinute(100, 0);
  /** Out of credit (HTTP 402) won't fix itself in a minute: skip Exa for hours instead of re-trying it. */
  private exaOffUntil = 0;
  private exaOff(): boolean {
    return Date.now() < this.exaOffUntil;
  }
  private noteExaError(e: unknown): void {
    if ((e as { status?: number }).status === 402) this.exaOffUntil = Date.now() + 6 * 60 * 60_000;
  }
  private hn = TokenBucket.perSecond(5, 0);
  private jina = TokenBucket.perMinute(18, 0);
  private breakers = { exa: new CircuitBreaker(3, 60_000), tavily: new CircuitBreaker(3, 60_000), hn: new CircuitBreaker(3, 60_000), jina: new CircuitBreaker(3, 120_000) };
  readonly totals: SearchStats = { calls: 0, byProvider: {}, cacheHits: 0, costUsd: 0 };

  constructor(private readonly cfg: Config, private readonly store: Store) {}

  private count(p: string, stats?: SearchStats, cost = 0): void {
    for (const s of stats ? [this.totals, stats] : [this.totals]) {
      s.calls++;
      s.byProvider[p] = (s.byProvider[p] ?? 0) + 1;
      s.costUsd += cost;
    }
  }

  /** Web search with pooling: Exa first, Tavily on failure or when Exa's bucket is empty. */
  async search(job: SearchJob, signal: AbortSignal, stats?: SearchStats): Promise<Evidence[]> {
    const key = cacheKey("search", job);
    if (job.ttlMs > 0) {
      const hit = this.store.cacheGet(key, now()) as Evidence[] | null;
      if (hit) {
        if (stats) stats.cacheHits++;
        this.totals.cacheHits++;
        return hit;
      }
    }
    const order: Array<"exa" | "tavily"> = this.exaSearch.waitTime(1, "foreground") > 300 ? ["tavily", "exa"] : ["exa", "tavily"];
    let lastErr: Error | null = null;
    for (const p of order) {
      if (this.breakers[p].isOpen() || (p === "exa" && this.exaOff()) || (p === "tavily" && !this.cfg.TAVILY_API_KEY)) continue;
      try {
        const res = p === "exa" ? await this.exa(job, signal, stats) : await this.tavilySearch(job, signal, stats);
        this.breakers[p].success();
        if (job.ttlMs > 0 && res.length) this.store.cachePut(key, res, now(), job.ttlMs);
        return res;
      } catch (e) {
        if (signal.aborted) throw e;
        lastErr = e as Error;
        this.breakers[p].failure();
        if (p === "exa") this.noteExaError(e);
      }
    }
    throw lastErr ?? new Error("no search provider available");
  }

  private async exa(job: SearchJob, signal: AbortSignal, stats?: SearchStats): Promise<Evidence[]> {
    await this.exaSearch.take(1, "foreground", signal);
    // Recommended request from the build-with-exa skill: query + objective + highlights, nothing else
    // unless the task requires it. A bounded window ("since Monday") is a task-stated hard filter.
    const body: Record<string, unknown> = {
      query: job.query,
      objective: job.objective,
      type: "auto",
      contents: { highlights: true },
    };
    if (job.since) body.startPublishedDate = `${job.since}T00:00:00.000Z`;
    const j = await postJson("https://api.exa.ai/search", { "x-api-key": this.cfg.EXA_API_KEY }, body, signal, 8_000);
    this.count("exa", stats, j.costDollars?.total ?? 0);
    const fetchedAt = now().toISOString();
    return (j.results ?? []).map((r: any) => ({
      url: r.url,
      title: r.title ?? r.url,
      publishedAt: r.publishedDate ?? undefined,
      text: (r.highlights ?? []).join(" … "),
      provider: "exa" as const,
      query: job.query,
      fetchedAt,
    })).filter((e: Evidence) => e.text);
  }

  private async tavilySearch(job: SearchJob, signal: AbortSignal, stats?: SearchStats): Promise<Evidence[]> {
    await this.tavily.take(1, "foreground", signal);
    const body: Record<string, unknown> = { query: job.query, max_results: 6 };
    if (job.since) body.start_date = job.since;
    const j = await postJson("https://api.tavily.com/search", { authorization: `Bearer ${this.cfg.TAVILY_API_KEY}` }, body, signal, 8_000);
    this.count("tavily", stats);
    const fetchedAt = now().toISOString();
    return (j.results ?? []).map((r: any) => ({
      url: r.url,
      title: r.title ?? r.url,
      publishedAt: r.published_date ?? undefined,
      text: r.content ?? "",
      provider: "tavily" as const,
      query: job.query,
      fetchedAt,
    })).filter((e: Evidence) => e.text);
  }

  /**
   * Change leg: live re-fetch of known URLs via Exa /contents (100 QPS, and no SSRF exposure
   * because Exa does the fetching). Highlights on /contents need an anchoring query.
   */
  async refetch(urls: string[], focus: string, signal: AbortSignal, stats?: SearchStats): Promise<Evidence[]> {
    if (!urls.length || this.exaOff()) return [];
    await this.exaContents.take(1, "foreground", signal);
    const j = await postJson(
      "https://api.exa.ai/contents",
      { "x-api-key": this.cfg.EXA_API_KEY },
      { urls, maxAgeHours: 0, highlights: { query: focus } },
      signal,
      12_000,
    );
    this.count("exa", stats, j.costDollars?.total ?? 0);
    const fetchedAt = now().toISOString();
    const byUrl = new Map<string, any>((j.results ?? []).map((r: any) => [r.url, r]));
    const statuses = new Map<string, any>((j.statuses ?? []).map((s: any) => [s.id ?? s.url, s]));
    return urls.map((u) => {
      const r = byUrl.get(u);
      if (r) return { url: u, title: r.title ?? u, publishedAt: r.publishedDate, text: (r.highlights ?? []).join(" … "), provider: "exa" as const, query: focus, fetchedAt, status: "ok" as const };
      const st = statuses.get(u);
      const gone = st?.error?.httpStatusCode === 404 || st?.error?.httpStatusCode === 410;
      return { url: u, title: u, text: "", provider: "exa" as const, query: focus, fetchedAt, status: gone ? ("gone" as const) : ("error" as const) };
    });
  }

  /**
   * Full page text for re-observation (recheck v2). Cache age follows the claim's age (≤24 h): live crawls
   * were slow and failed on 2 of 3 pricing pages in testing, while a ≤24 h cached copy returned prices in <1 s.
   */
  async pageText(urls: string[], maxAgeHours: number, signal: AbortSignal, stats?: SearchStats): Promise<Map<string, { text: string; title: string; status: "ok" | "gone" | "error" }>> {
    const out = new Map<string, { text: string; title: string; status: "ok" | "gone" | "error" }>();
    if (!urls.length || this.exaOff()) return out; // callers fall back to the Jina reader
    await this.exaContents.take(1, "foreground", signal);
    const body: Record<string, unknown> = { urls, text: { maxCharacters: 30_000 }, maxAgeHours: Math.max(0, Math.min(24, Math.round(maxAgeHours))), livecrawlTimeout: 3_000 };
    try {
      const j = await postJson("https://api.exa.ai/contents", { "x-api-key": this.cfg.EXA_API_KEY }, body, signal, 8_000);
      this.count("exa", stats, j.costDollars?.total ?? 0);
      for (const r of j.results ?? []) out.set(r.url, { text: String(r.text ?? ""), title: r.title ?? r.url, status: r.text ? "ok" : "error" });
      for (const st of j.statuses ?? []) {
        const id = st.id ?? st.url;
        if (!out.has(id)) out.set(id, { text: "", title: id, status: st.error?.httpStatusCode === 404 || st.error?.httpStatusCode === 410 ? "gone" : "error" });
      }
    } catch (e) {
      if (signal.aborted) throw e;
      this.noteExaError(e);
    }
    return out;
  }

  /** JS-rendered pages (pricing tables built in the browser): r.jina.ai reader, free ~20 req/min, 6 s cap. */
  async jinaText(url: string, signal: AbortSignal, stats?: SearchStats): Promise<string> {
    if (this.breakers.jina.isOpen()) return "";
    if (!this.jina.tryTake(1, "foreground")) return "";
    try {
      const r = await fetch(`https://r.jina.ai/${url}`, { headers: { Accept: "text/plain", "X-Return-Format": "markdown" }, signal: AbortSignal.any([signal, AbortSignal.timeout(6_000)]) });
      if (!r.ok) throw new Error(`jina ${r.status}`);
      const t = (await r.text()).slice(0, 40_000);
      this.breakers.jina.success();
      this.count("jina", stats);
      return t;
    } catch (e) {
      if (signal.aborted) throw e;
      this.breakers.jina.failure();
      return "";
    }
  }

  /** Free dated release signals: HN Algolia stories since a date (no key). */
  async releases(entity: string, since: string, signal: AbortSignal, stats?: SearchStats): Promise<Evidence[]> {
    if (this.breakers.hn.isOpen()) return [];
    await this.hn.take(1, "foreground", signal);
    const epoch = Math.floor(new Date(`${since}T00:00:00Z`).getTime() / 1000);
    const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(entity)}&tags=story&numericFilters=${encodeURIComponent(`created_at_i>${epoch}`)}&hitsPerPage=5`;
    try {
      const r = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(4_000)]) });
      if (!r.ok) throw new ProviderError(`HN ${r.status}`, r.status);
      const j = (await r.json()) as { hits: any[] };
      this.breakers.hn.success();
      this.count("hn", stats);
      const fetchedAt = now().toISOString();
      return j.hits
        .filter((h) => h.title && (h.points ?? 0) >= 5)
        .map((h) => ({
          url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
          title: h.title,
          publishedAt: h.created_at,
          text: `Hacker News story (${h.points} points, ${h.num_comments ?? 0} comments): ${h.title}`,
          provider: "hn" as const,
          query: entity,
          fetchedAt,
        }));
    } catch (e) {
      if (signal.aborted) throw e;
      this.breakers.hn.failure();
      return [];
    }
  }
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal, timeoutMs: number): Promise<any> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  });
  if (!r.ok) throw new ProviderError(`${new URL(url).host} HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`, r.status);
  return r.json();
}

function cacheKey(kind: string, job: SearchJob): string {
  const norm = { k: kind, q: job.query.toLowerCase().replace(/\s+/g, " ").trim(), s: job.since ?? null };
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex");
}
