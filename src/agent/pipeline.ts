import { cachedStatus, frameFor, noteFor } from "./claims.ts";
import { askedLines, clarifyDate, memoryLines } from "./history.ts";
import { recheckTarget } from "./routing.ts";
import { plan, type Plan, type Route } from "./planner.ts";
import { readSignals } from "./signals.ts";
import { AnswerStage } from "./stages/answer.ts";
import { Persist } from "./stages/persist.ts";
import { RecheckStage } from "./stages/recheck.ts";
import { RetrieveStage } from "./stages/retrieve.ts";
import { RouteStage } from "./stages/route.ts";
import { type Emit, NO_UNDERSTANDING, REPLAY_TURNS, type Timings, type Turn, type TurnInput } from "./turn.ts";
import { Verifier } from "./verify.ts";
import type { Config } from "../config.ts";
import { loadDemo } from "../demo/seed.ts";
import type { ChatMessage, LlmClient } from "../llm/client.ts";
import { Judge } from "../llm/judge.ts";
import { SemanticRecall } from "../memory/semantic.ts";
import { LOCAL_OWNER, type Store } from "../memory/store.ts";
import { resolveTemporal } from "../memory/temporal.ts";
import { type SearchRouter, type SearchStats } from "../search/router.ts";
import { domainOf } from "../util/url.ts";
import { now } from "../util/clock.ts";

/**
 * The request pipeline: deterministic code around two model calls (planner, answerer). The Agent owns the shared
 * services and runs one turn through the stages (src/agent/stages/); each stage is a small class with only the
 * services it needs.
 */
export class Agent {
  readonly judge: Judge;
  private readonly semantic: SemanticRecall;
  private readonly persist: Persist;
  private readonly routeStage: RouteStage;
  private readonly retrieveStage: RetrieveStage;
  private readonly recheckStage: RecheckStage;
  private readonly answerStage: AnswerStage;

  constructor(
    cfg: Config,
    private readonly store: Store,
    private readonly llm: LlmClient,
    search: SearchRouter,
  ) {
    this.judge = new Judge(cfg, llm);
    this.semantic = new SemanticRecall(cfg, store, this.judge);
    this.persist = new Persist(store, llm, this.judge, this.semantic, new Verifier(this.judge));
    this.routeStage = new RouteStage(store, this.semantic, this.judge, this.persist);
    this.retrieveStage = new RetrieveStage(store, search, this.judge);
    this.recheckStage = new RecheckStage(store, llm, search, this.judge, this.persist);
    this.answerStage = new AnswerStage(store, llm, this.persist);
  }

  /** Demo history (real recorded conversations, re-dated to this week) for one owner; indexed for recall like any turn. */
  loadDemo(owner: string, tz: string): ReturnType<typeof loadDemo> {
    const r = loadDemo(this.store, owner, tz, now());
    if (r.added) this.semantic.indexInBackground();
    return r;
  }

  /**
   * One turn, as explicit stages sharing a typed Turn:
   *   understand → gather + decide needs (+ conversation section) → boundaries
   *   → [recheck alone: premise check + recheck v2, code-written] → retrieve → premise check → answer → verify.
   */
  async handle(input: TurnInput, emit: Emit, clientSignal: AbortSignal): Promise<void> {
    const t = await this.understand(input, emit, clientSignal);
    const S = await this.routeStage.needsRoute(t);
    if (!S) return; // fully answered in code (honest "no record")
    const { hits, notes, extraNotes, premises } = S;
    let preamble = S.preamble;
    this.answerStage.boundaryNotes(t, S);

    // Premises already confirmed today are not re-checked (cache).
    // In a recheck, what we said earlier IS the recheck's subject (recheck v2 re-observes it); the premise check
    // covers only the message's other assumptions ("since Amazon bought Spotify…").
    let gatePremises = premises.filter((x) => cachedStatus(x, t.temporal.today) !== "confirmed" && !(t.p.route === "recheck" && x.attribution === "assistant_past"));

    // Recheck alone: code re-observes each earlier claim at its source and writes the whole answer. A premise in
    // the message is checked first (its own probe search) and framed above the table.
    let streamed = "";
    if (t.p.route === "recheck" && hits.length) {
      // The code-written "On … you asked" line needs no model and no search: it streams first, before the premise
      // check and the claim extraction.
      streamed = (S.dateNote ? `${S.dateNote}\n` : "") + askedLines([recheckTarget(hits)]);
      t.timings.ttftMs = performance.now() - t.t0;
      t.emit("token", { text: streamed });
      let premiseFrame = "";
      if (gatePremises.length) {
        const g = await this.retrieveStage.runPremiseGate(t, gatePremises, []);
        premiseFrame = g.verdicts.map((v) => frameFor(v, () => null)).filter((x): x is string => !!x).join(" ");
        gatePremises = [];
      }
      if (await this.recheckStage.recheckV2({ ...t, hits, head: streamed, premiseFrame })) return;
      // No checkable claims in the earlier answer: a streamed answer over fresh evidence follows the line already
      // shown (and the premise frame decided above).
      preamble = `${streamed}${premiseFrame ? `${premiseFrame}\n\n` : ""}`;
    }

    let { evidence, skipped } = await this.retrieveStage.retrieve(t, hits);

    // Premise check over the same pool the answer cites (one extra search only if the pool doesn't settle it).
    if (gatePremises.length && (t.p.route === "quick" || t.p.route === "research" || t.p.route === "recheck")) {
      const g = await this.retrieveStage.runPremiseGate(t, gatePremises, evidence);
      evidence = [...evidence, ...g.added.slice(0, 4)];
      const cite = (i: number) => (i < evidence.length ? i + 1 : null);
      const frames = g.verdicts.map((v) => frameFor(v, cite)).filter((x): x is string => !!x);
      for (const v of g.verdicts) {
        const n = noteFor(v, cite, t.temporal.today);
        if (n) extraNotes.push(n);
      }
      if (frames.length) preamble = `${preamble}${frames.join(" ")}\n\n`;
    }
    t.emit("sources", evidence.map((e, i) => ({ n: i + 1, title: e.title, url: e.url, domain: domainOf(e.url), date: (e.publishedAt ?? e.fetchedAt).slice(0, 10), dated: !!e.publishedAt })));

    await this.answerStage.answer(t, { hits, notes, extraNotes, preamble, evidence, skipped, steering: S.steering, alreadyStreamed: streamed });
  }

  /** Stage 1: persist the turn, read recent history, resolve dates in code (and a clarifying reply), run the planner. */
  private async understand(input: TurnInput, emit: Emit, signal: AbortSignal): Promise<Turn> {
    const t0 = performance.now();
    const at = now();
    const timings: Timings = { recallMs: 0, planMs: 0, retrieveMs: 0, ttftMs: 0, totalMs: 0 };
    const stats: SearchStats = { calls: 0, byProvider: {}, cacheHits: 0, costUsd: 0 };
    const questionId = this.store.insertTurn({ sessionId: input.sessionId, role: "user", content: input.message, tz: input.tz, at, owner: input.owner, status: "pending" });
    // A session belongs to one owner; turns from anyone else (a guessed session id) never reach the planner.
    const history = this.store.recentTurns(input.sessionId, REPLAY_TURNS).filter((x) => x.id !== questionId && x.owner === (input.owner ?? LOCAL_OWNER));
    const recentTurns = history.slice(-8);
    const lastReply = [...history].reverse().find((x) => x.role === "assistant") ?? null;
    // "No, the other one" / "I meant the 10th" right after an ambiguous date: the turn becomes the previous question
    // with that date settled (code decides; the stored turn keeps the user's own words).
    const prevUser = [...history].reverse().find((x) => x.role === "user");
    const clar = prevUser && lastReply ? clarifyDate(input.message, { message: prevUser.content, at: new Date(prevUser.created_at_utc), tz: prevUser.tz }, lastReply.content, at, input.tz) : null;
    const msg = clar ? clar.message : input.message;
    const temporal = clar ? { ...resolveTemporal(msg, at, input.tz), groups: clar.groups, backReference: true } : resolveTemporal(msg, at, input.tz);
    const allWin0 = temporal.groups.flat();
    const sig = readSignals(msg, recentTurns.filter((x) => x.role === "user").map((x) => x.content));
    const rule = { first: sig.first, list: sig.list, just: sig.just, memoryCue: temporal.backReference || sig.memoryCue, action: sig.action };
    // Pre-planner recall: only context for the planner; the memory leg decides what is actually used.
    const preHits = rule.just
      ? rule.first
        ? this.store.sessionFirst(input.sessionId, questionId, input.owner)
        : this.store.sessionHits(input.sessionId, questionId, 1, input.owner)
      : rule.memoryCue || allWin0.length
        ? this.store.recall({ windows: allWin0, text: msg, excludeTurnId: questionId, sessionId: input.sessionId, owner: input.owner })
        : [];
    const recent = recentTurns.map((x): ChatMessage => ({ role: x.role, content: x.content.slice(0, 1_200) }));

    // One abort for the web leg: cancelled when the needs decide no search is needed.
    const retrieveCtl = new AbortController();
    const retrieveSignal = AbortSignal.any([signal, retrieveCtl.signal]);
    const arithmetic = sig.arithmetic;

    emit("status", { phase: "plan", detail: "Understanding the question" });
    const tPlan = performance.now();
    const planned = sig.chitchat
      ? { plan: { route: "chat" as Route, queries: [], entities: [], volatility: "stable" as const, understanding: NO_UNDERSTANDING }, model: "rule", ms: 0, failedOpen: false }
      : await plan(this.llm, { message: msg, today: temporal.today, memoryLines: memoryLines(preHits), recent, signal });
    timings.planMs = performance.now() - tPlan;
    const p: Plan = planned.plan;
    return {
      input, emit, signal, t0, at, timings, stats, msg, questionId, temporal, sig, rule, recent, arithmetic,
      retrieveCtl, retrieveSignal,
      p, u: p.understanding,
      plannerRead: !planned.failedOpen && planned.model !== "rule",
      plannerModel: planned.model,
      plannerFailedOpen: planned.failedOpen,
      history,
      lastReply,
    };
  }
}
