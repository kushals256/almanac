/**
 * Whole-turn harness: the real Agent, Store, needs model, recheck and verifier, with scripted fakes for the two
 * outside services (model client, web search). No network. Each fake records what it was asked, so tests can assert
 * on what the pipeline DID (searched or not, which route, what was stored), not just on returned text.
 */
import { Agent } from "../../src/agent/pipeline.ts";
import type { Emit } from "../../src/agent/turn.ts";
import type { Config } from "../../src/config.ts";
import type { LlmRequest, LlmResult, StreamEvent } from "../../src/llm/client.ts";
import { Store } from "../../src/memory/store.ts";
import type { Evidence, SearchJob } from "../../src/search/router.ts";
import { setNow } from "../../src/util/clock.ts";

export type Script = {
  /** Planner output for a message (the JSON the planner model would return). */
  plan: (msg: string) => Record<string, unknown>;
  /** The streamed answer text for an answer request. */
  answer?: (req: LlmRequest) => string;
  /** Judge probabilities by question id (default: a neutral, mostly-"no" judge). */
  judge?: (id: string, state: string) => number;
  /** Extractor replies (recheck claims, decisions, model-select). */
  extractor?: (req: LlmRequest) => string;
  search?: (job: SearchJob) => Evidence[];
  pages?: Record<string, string>;
};

export const ev = (url: string, title: string, text: string, publishedAt?: string): Evidence => ({ url, title, text, provider: "exa", query: "q", fetchedAt: "2026-11-12T06:00:00Z", publishedAt, status: "ok" });

export function plan(route: string, extra: Record<string, unknown> = {}, understanding: Record<string, unknown> = {}): Record<string, unknown> {
  return { route, queries: route === "chat" || route === "memory" ? [] : [{ q: "query", objective: "objective" }], entities: [], volatility: "fast", ...extra, understanding: { pastRef: "none", recallTerms: [], wantsRecheck: false, actionRequest: false, steering: false, claims: [], premises: [], factual: route !== "chat", aboutReply: false, ...understanding } };
}

export function harness(script: Script, at = "2026-11-12T06:00:00Z") {
  setNow(at);
  const store = new Store(":memory:");
  const calls = { planner: 0, answer: 0, judge: 0, extractor: 0, searches: [] as string[], pageText: [] as string[] };
  const result = (text: string, job: string): LlmResult => ({ text, model: `fake-${job}`, provider: "groq", ms: 1, ttftMs: 1 });
  const lastUser = (req: LlmRequest) => [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const llm = {
    async complete(req: LlmRequest): Promise<LlmResult> {
      if (req.job === "planner") {
        calls.planner++;
        const msg = lastUser(req).split("USER MESSAGE:\n").pop() ?? "";
        return result(JSON.stringify(script.plan(msg)), "planner");
      }
      if (req.job === "verifier_llm") {
        calls.judge++;
        const user = lastUser(req);
        const ids = [...user.split("QUESTIONS:\n").pop()!.matchAll(/^([\w-]+):/gm)].map((m) => m[1]!);
        const p = (id: string) => (script.judge ? script.judge(id, user) : /^rel\d/.test(id) ? 0.9 : /^(c|claim)\d/.test(id) ? 0.9 : 0.2);
        return result(JSON.stringify(Object.fromEntries(ids.map((id) => [id, p(id)]))), "judge");
      }
      calls.extractor++;
      const sys = req.messages[0]?.content ?? "";
      return result(script.extractor ? script.extractor(req) : /decisions/.test(sys) ? '{"decisions":[]}' : /ITEM/.test(sys) ? "{}" : '{"claims":[]}', "extractor");
    },
    async completeHedged(req: LlmRequest): Promise<LlmResult> {
      return this.complete(req);
    },
    async *stream(req: LlmRequest): AsyncGenerator<StreamEvent> {
      calls.answer++;
      const text = script.answer ? script.answer(req) : "Here is the answer [1].";
      for (const piece of text.match(/[\s\S]{1,12}/g) ?? []) yield { type: "token", text: piece };
      yield { type: "done", result: result(text, "answer") };
    },
    quotas: () => ({}),
  };
  const search = {
    async search(job: SearchJob): Promise<Evidence[]> {
      calls.searches.push(job.query);
      return script.search ? script.search(job) : [];
    },
    async pageText(urls: string[]) {
      calls.pageText.push(...urls);
      return new Map(urls.map((u) => [u, script.pages?.[u] !== undefined ? { text: script.pages[u]!, title: u, status: "ok" as const } : { text: "", title: u, status: "error" as const }]));
    },
    async jinaText() {
      return "";
    },
    async releases() {
      return [] as Evidence[];
    },
    async refetch() {
      return [] as Evidence[];
    },
  };
  const agent = new Agent({} as Config, store, llm as any, search as any);

  /** One turn: returns the events in order, the final text (after replace/retract) and the "done" payload. */
  async function turn(message: string, sessionId = "s1", when?: string) {
    if (when) setNow(when);
    const events: Array<{ ev: string; data: any }> = [];
    let text = "";
    const emit: Emit = (e, data: any) => {
      events.push({ ev: e, data });
      if (e === "token") text += data.text;
      if (e === "replace" || e === "retract") text = data.text;
    };
    await agent.handle({ sessionId, message, tz: "UTC" }, emit, new AbortController().signal);
    const of = (name: string) => events.find((x) => x.ev === name)?.data;
    return { events, text, done: of("done"), needs: of("needs"), sources: of("sources") as Array<{ n: number; url: string }> | undefined, of };
  }
  return { agent, store, calls, turn };
}
