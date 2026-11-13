import { entitiesFromHistory } from "../history.ts";
import { Persist, storedClaim } from "./persist.ts";
import { recheckTarget, uncheckedEntities } from "../routing.ts";
import { MAX_RECHECK_CLAIMS, type Turn } from "../turn.ts";
import { DEADLINES_MS } from "../../config.ts";
import type { LlmClient } from "../../llm/client.ts";
import { Judge } from "../../llm/judge.ts";
import type { RecallHit, Store } from "../../memory/store.ts";
import { attributeChanges, claimsFromAnswer, newsSince, type ObsClaim, type ObsResult, renderV2, reobserve } from "../../recheck/v2.ts";
import { parseValues } from "../../recheck/values.ts";
import { type Evidence, type SearchRouter } from "../../search/router.ts";
import { domainOf } from "../../util/url.ts";
import { humanDate, now } from "../../util/clock.ts";

/** "Is that still right?" alone: code re-observes each earlier claim at its source and writes the whole answer (recheck/v2.ts). */
export class RecheckStage {
  constructor(
    private readonly store: Store,
    private readonly llm: LlmClient,
    private readonly search: SearchRouter,
    private readonly judge: Judge,
    private readonly persist: Persist,
  ) {}

  /**
   * Re-observe each claim of the most relevant earlier answer at its own source (recheck/v2.ts), decide each verdict in
   * code (Changed only with timing evidence, else Differs), and write the whole answer — every product the earlier
   * answer named is a row. Returns false when the earlier answer has no checkable figure (the turn falls through).
   */
  async recheckV2(a: Turn & { hits: RecallHit[]; head: string; premiseFrame?: string }): Promise<boolean> {
    const { emit } = a;
    // The target is the most relevant recalled turn (text match first); "since" is ITS date, not the
    // earliest of all hits (which produced "since 26 Oct" on a Notion question).
    const targets = [recheckTarget(a.hits)];
    const since = targets[0]!.question.local_date;
    emit("status", { phase: "recheck", detail: `Reading what I told you on ${humanDate(since)}` });
    // Claims as data: read the value claims recorded when that answer was saved; extract (and record) only if none.
    const target = targets[0]!;
    let claims: ObsClaim[] = target.answer ? this.store.valueClaimsFor(target.answer.id).map((c) => ({ entity: c.entity, attribute: c.attribute, answerSpan: c.answerSpan, thenValues: parseValues(c.answerSpan), sourceUrl: c.sourceUrl ?? undefined, quote: c.quote ?? undefined, claimId: c.id })).filter((c) => c.thenValues.length) : [];
    if (!claims.length) {
      try {
        claims = (await claimsFromAnswer(this.llm, target, a.signal)).slice(0, MAX_RECHECK_CLAIMS);
        if (claims.length && target.answer) {
          const ids = this.store.recordValueClaims(target.question.id, target.answer.id, claims.map(storedClaim), target.answer.local_date, now(), target.question.content);
          claims = claims.map((c, k) => ({ ...c, claimId: ids[k] }));
        }
      } catch (e) {
        if (a.signal.aborted) throw e;
      }
    }
    if (!claims.length) return false;
    // The "On … you asked" line (a.head) is already shown; the premise frame, if any, follows it.
    const frame = a.premiseFrame ? `${a.premiseFrame}\n\n` : "";
    if (frame) emit("token", { text: frame });
    const preamble = a.head + frame;
    const tRet = performance.now();
    const hitSources = targets.flatMap((t) => t.sources.map((src) => src.url));
    // One budget for the re-observation legs, counted from the start of the turn. Out of time → the claims not
    // yet re-checked are reported as "couldn't verify", and the table still renders (never a hung turn).
    const budget = AbortSignal.any([a.signal, AbortSignal.timeout(Math.round(Math.max(8_000, DEADLINES_MS.recheck - (performance.now() - a.t0))))]);
    const [obs, news] = await Promise.all([
      reobserve(this.llm, this.search, claims, since, hitSources, budget, a.stats, (d) => emit("status", { phase: "recheck", detail: d })).catch((e) => {
        if (a.signal.aborted) throw e;
        const results: ObsResult[] = claims.map((c) => ({ ...c, cmp: { verdict: "Unverifiable", note: "ran out of time re-checking the source" }, how: "timeout" }));
        return { results, evidence: [] as Evidence[] };
      }),
      newsSince(this.search, [...new Set(claims.map((c) => c.entity))], since, budget, a.stats, this.judge, target.question.content).catch(() => [] as Evidence[]),
    ]);
    a.timings.retrieveMs = performance.now() - tRet;
    // A different figure is a change since then only with timing evidence; otherwise it "differs" (code decides).
    obs.results = attributeChanges(obs.results, news, obs.evidence.length, since);
    const evidence = [...obs.evidence, ...news];
    emit("sources", evidence.map((e, i) => ({ n: i + 1, title: e.title, url: e.url, domain: domainOf(e.url), date: (e.publishedAt ?? e.fetchedAt).slice(0, 10), dated: !!e.publishedAt })));
    // Every product the earlier answer named appears in the table: one with no checkable figure is listed as such
    // (and counted as unverified), never silently dropped ("1 of 3 changed" when 5 were shortlisted).
    // Products named = what the earlier answer itself lists (tables, bold names) ∪ recorded entities.
    const stored = this.store.collectionItems(target.question.id);
    const listed = [...new Set([...(stored.length ? stored : entitiesFromHistory([target])), ...this.store.entitiesForTurn(target.question.id)])];
    const results = [...obs.results, ...uncheckedEntities(listed, claims).map((entity): ObsResult => ({ entity, attribute: "", answerSpan: "no figure given", thenValues: [], cmp: { verdict: "Unverifiable", note: "no figure in my earlier answer to re-check" }, how: "none" }))];
    const body = renderV2(results, news, obs.evidence.length, since, a.temporal.today);
    emit("token", { text: body });
    const fullText = preamble + body;
    const fin = this.persist.finish({ input: a.input, questionId: a.questionId, route: "recheck", text: fullText, evidence, emit, timings: a.timings, t0: a.t0, stats: a.stats, models: { planner: a.plannerModel, answerer: "code (recheck v2)", finish: `claims=${claims.length} ${obs.results.map((r) => r.how ?? "-").join(",")}` }, streamed: true });
    // Each re-observation is recorded against its stored claim; a change supersedes the old value (knowledge update).
    const status = { Unchanged: "unchanged", Changed: "changed", Differs: "differs", "Not comparable": "not_comparable", Unverifiable: "unverifiable", "Source gone": "source_gone" } as const;
    for (const r of obs.results) {
      if (!r.claimId) continue;
      try {
        this.store.recordVerification(r.claimId, { status: status[r.cmp.verdict], nowText: r.nowSpan, note: r.cmp.note, sourceUrl: r.evidenceIdx ? evidence[r.evidenceIdx - 1]?.url : undefined, recheckAnswerId: fin.answerId }, now());
      } catch {
        /* the ledger is best-effort; the answer is already shown */
      }
    }
    await this.persist.postVerify({ fin, evidence, route: "recheck", hits: targets, msg: a.msg, preamble, today: a.temporal.today, volatility: a.p.volatility, emit, signal: a.signal, codeWritten: true });
    return true;
  }
}
