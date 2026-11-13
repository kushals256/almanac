import { MODEL_CHAINS, PROVIDER_URLS, type Config, type Job, type ModelRef, type Provider } from "../config.ts";
import { CircuitBreaker, DailyQuota, TokenBucket, estimateTokens, type Priority } from "../util/limiter.ts";

/** Silence after the first token that counts as a stalled stream. */
const STREAM_IDLE_MS = 15_000;

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type LlmRequest = {
  job: Job;
  messages: ChatMessage[];
  maxTokens: number;
  json?: boolean;
  priority: Priority;
  signal?: AbortSignal;
  /** Abort a model attempt if no first token arrives in this time, then fail over. */
  firstTokenTimeoutMs?: number;
  /** After the first token, abort if the stream goes silent this long (default STREAM_IDLE_MS). */
  idleTimeoutMs?: number;
  /** "provider/model" ids to skip (a retry after that model produced an empty or broken answer). */
  avoidModels?: string[];
  /** Called with "provider/model" each time a model is tried (hedging uses it to send the twin elsewhere). */
  onAttempt?: (model: string) => void;
};

export type LlmResult = { text: string; model: string; provider: Provider; ms: number; ttftMs: number; inTok?: number; outTok?: number; finish?: string };

export type StreamEvent = { type: "token"; text: string } | { type: "done"; result: LlmResult };

type ModelState = {
  ref: ModelRef;
  bucket: TokenBucket; // tokens per minute (Groq) or requests per minute (NVIDIA, shared)
  daily: DailyQuota | null;
  breaker: CircuitBreaker;
  unavailableUntil: number;
  costIsRequests: boolean;
};

class LlmError extends Error {
  constructor(message: string, readonly status?: number, readonly retryAfterMs?: number) {
    super(message);
  }
}

/**
 * One client for every OpenAI-compatible provider (Groq, NVIDIA). Each job walks its ordered
 * model chain and fails over on 404 / 429 / 5xx / timeout / quota (SPEC §2).
 */
export class LlmClient {
  private states = new Map<string, ModelState>();
  private nvidiaBucket = TokenBucket.perMinute(40);

  constructor(private readonly cfg: Config) {
    for (const chain of Object.values(MODEL_CHAINS)) for (const ref of chain) this.state(ref);
  }

  private key(ref: ModelRef): string {
    return `${ref.provider}:${ref.model}`;
  }

  private state(ref: ModelRef): ModelState {
    const k = this.key(ref);
    let s = this.states.get(k);
    if (!s) {
      const groq = ref.provider === "groq";
      s = {
        ref,
        bucket: groq ? TokenBucket.perMinute(8_000) : this.nvidiaBucket,
        daily: groq ? new DailyQuota(1_000) : new DailyQuota(10_000),
        breaker: new CircuitBreaker(3, 30_000),
        unavailableUntil: 0,
        costIsRequests: !groq,
      };
      this.states.set(k, s);
    }
    return s;
  }

  private apiKey(p: Provider): string {
    return (p === "groq" ? this.cfg.GROQ_API_KEY : this.cfg.NVIDIA_API_KEY) ?? "";
  }

  /** Boot check: mark chain models the provider doesn't list as unavailable. */
  async probe(): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    for (const p of ["groq", "nvidia"] as Provider[]) {
      let ids = new Set<string>();
      try {
        const r = await fetch(`${PROVIDER_URLS[p]}/models`, { headers: { authorization: `Bearer ${this.apiKey(p)}` }, signal: AbortSignal.timeout(8_000) });
        if (r.ok) ids = new Set(((await r.json()) as { data: { id: string }[] }).data.map((m) => m.id));
      } catch {
        /* provider unreachable at boot: leave models enabled, runtime failover handles it */
      }
      for (const s of this.states.values()) {
        if (s.ref.provider !== p) continue;
        const ok = ids.size === 0 || ids.has(s.ref.model);
        if (!ok) s.unavailableUntil = Date.now() + 10 * 60_000;
        out[this.key(s.ref)] = ok;
      }
    }
    return out;
  }

  /** Quota snapshot for /stats and /health. */
  quotas(): Record<string, { tpmOrRpmRemaining: number; dailyRemaining: number | null; available: boolean }> {
    const out: Record<string, { tpmOrRpmRemaining: number; dailyRemaining: number | null; available: boolean }> = {};
    for (const [k, s] of this.states) {
      out[k] = { tpmOrRpmRemaining: s.bucket.remaining(), dailyRemaining: s.daily?.remaining() ?? null, available: Date.now() >= s.unavailableUntil && !s.breaker.isOpen() };
    }
    return out;
  }

  /** Non-streaming completion with failover. */
  async complete(req: LlmRequest): Promise<LlmResult> {
    let last: LlmResult | null = null;
    for await (const ev of this.stream(req)) if (ev.type === "done") last = ev.result;
    if (!last) throw new Error("no result");
    return last;
  }

  /**
   * A short JSON call on the critical path (planner, recheck extraction): if it hasn't returned after hedgeAfterMs —
   * a slow model in flight or a long bucket wait — the same request goes to a DIFFERENT model and the first good answer
   * wins; the other is cancelled (cancelling doesn't count against that model). capMs bounds the whole call. Never used
   * for streamed answers: a reply is never stitched from two models.
   */
  async completeHedged(req: LlmRequest, hedgeAfterMs: number, capMs: number): Promise<LlmResult> {
    const outer = AbortSignal.any([req.signal ?? new AbortController().signal, AbortSignal.timeout(capMs)]);
    const tried: string[] = [];
    const ctls = [new AbortController(), new AbortController()];
    const run = (i: number, avoid: string[]) =>
      this.complete({ ...req, avoidModels: [...(req.avoidModels ?? []), ...avoid], signal: AbortSignal.any([outer, ctls[i]!.signal]), onAttempt: (m) => (tried.push(m), req.onAttempt?.(m)) });
    return await new Promise<LlmResult>((resolve, reject) => {
      let settled = false;
      let running = 1;
      let lastErr: unknown;
      const win = (i: number) => (r: LlmResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctls[1 - i]!.abort(new Error("hedge: other request won"));
        resolve(r);
      };
      const lose = (e: unknown) => {
        lastErr = e;
        if (settled || --running > 0 || !hedgeDone) return; // the twin may still answer
        settled = true;
        clearTimeout(timer);
        reject(outer.aborted ? (outer.reason ?? lastErr) : lastErr);
      };
      let hedgeDone = false;
      run(0, []).then(win(0), (e) => {
        // The first request already walked the whole chain: a twin can't do better, so don't wait for it.
        if (!hedgeDone) (hedgeDone = true), clearTimeout(timer);
        lose(e);
      });
      const timer = setTimeout(() => {
        if (settled || hedgeDone) return;
        hedgeDone = true;
        running++;
        run(1, [...tried]).then(win(1), lose);
      }, hedgeAfterMs);
    });
  }

  /** Streaming completion with failover. Failover only happens before the first token. */
  async *stream(req: LlmRequest): AsyncGenerator<StreamEvent> {
    const chain = MODEL_CHAINS[req.job];
    const cost = estimateTokens(req.messages.map((m) => m.content).join("\n")) + req.maxTokens;
    const errors: string[] = [];
    const tried = new Set<string>(chain.filter((r) => req.avoidModels?.includes(`${r.provider}/${r.model}`)).map((r) => this.key(r)));

    while (tried.size < chain.length) {
      if (req.signal?.aborted) throw req.signal.reason ?? new Error("aborted");
      const s = this.pick(chain, tried, cost, req.priority, req.job === "answer_deep" ? 6_000 : 1_500);
      if (!s) break;
      tried.add(this.key(s.ref));
      req.onAttempt?.(`${s.ref.provider}/${s.ref.model}`);
      const reqCost = s.costIsRequests ? 1 : cost;
      try {
        await s.bucket.take(reqCost, req.priority, req.signal);
      } catch (e) {
        errors.push(`${s.ref.model}: ${(e as Error).message}`);
        continue;
      }
      s.daily?.consume();
      let emitted = false;
      try {
        for await (const ev of this.attempt(s, req)) {
          if (ev.type === "token") emitted = true;
          if (ev.type === "done" && !s.costIsRequests) {
            const actual = (ev.result.inTok ?? 0) + (ev.result.outTok ?? 0);
            if (actual > 0) s.bucket.refund(reqCost - actual);
          }
          yield ev;
        }
        s.breaker.success();
        return;
      } catch (e) {
        const err = e as LlmError;
        if (req.signal?.aborted) throw req.signal.reason ?? err;
        errors.push(`${s.ref.provider}/${s.ref.model}: ${err.message}`);
        if (process.env.DEBUG_LLM) console.error("LLM attempt failed", req.job, s.ref.model, err.status, err.message.slice(0, 300));
        if (err.status === 404) s.unavailableUntil = Date.now() + 10 * 60_000;
        else if (err.status === 429) {
          const ms = err.retryAfterMs ?? 20_000;
          if (ms > 60_000) s.unavailableUntil = Date.now() + ms; // daily limit: skip this model for a while
          else s.bucket.coolDown(ms);
        }
        else s.breaker.failure();
        if (emitted) throw new Error(`stream interrupted: ${err.message}`);
      }
    }
    throw new Error(`all models failed for ${req.job}: ${errors.join(" | ") || "none available"}`);
  }

  /** Choose the first usable model that can run now; otherwise the one with the shortest wait. */
  /**
   * Choose the model with the lowest expected time to first token = bucket wait + its typical
   * TTFT. Waiting 3 s for a fast Groq model beats an idle NVIDIA model that takes 8 s.
   */
  private pick(chain: ModelRef[], tried: Set<string>, cost: number, priority: Priority, toleranceMs: number): ModelState | null {
    const options: Array<{ s: ModelState; expected: number; wait: number }> = [];
    for (const ref of chain) {
      if (tried.has(this.key(ref))) continue;
      if (!this.apiKey(ref.provider)) continue; // optional provider not configured
      const s = this.state(ref);
      if (Date.now() < s.unavailableUntil || s.breaker.isOpen() || (s.daily && !s.daily.available())) continue;
      const wait = s.bucket.waitTime(s.costIsRequests ? 1 : cost, priority);
      if (!Number.isFinite(wait)) continue;
      options.push({ s, expected: wait + ref.ttftMs, wait });
    }
    if (!options.length) return null;
    // Chain order is the quality preference; only skip ahead when a model is much slower than the
    // best option (1.5 s for quick answers; deep answers wait up to 6 s for the strongest model).
    const fastest = Math.min(...options.map((o) => o.expected));
    const choice = options.find((o) => o.expected <= fastest + toleranceMs)!;
    // Answers wait up to 35 s for a free-tier budget to refill before failing; others 20 s.
    const maxWait = priority === "background" ? 60_000 : toleranceMs >= 6_000 ? 35_000 : 20_000;
    return choice.wait < maxWait ? choice.s : null;
  }

  private async *attempt(s: ModelState, req: LlmRequest): AsyncGenerator<StreamEvent> {
    const t0 = performance.now();
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(req.signal?.reason);
    req.signal?.addEventListener("abort", onAbort, { once: true });
    const ttftLimit = Math.max(req.firstTokenTimeoutMs ?? 10_000, s.ref.ttftMs * 3);
    const ttftTimer = setTimeout(() => ctl.abort(new LlmError(`no first token in ${ttftLimit} ms`)), ttftLimit);
    // After the first token, a stream that goes silent is stalled (a 138 s degenerate generation). Each
    // token re-arms the idle timer; silence for STREAM_IDLE_MS aborts the stream.
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      clearTimeout(idleTimer);
      const idle = req.idleTimeoutMs ?? STREAM_IDLE_MS;
      idleTimer = setTimeout(() => ctl.abort(new LlmError(`stream stalled: no tokens for ${idle} ms`)), idle);
    };

    const body: Record<string, unknown> = {
      model: s.ref.model,
      messages: req.messages,
      max_tokens: req.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (s.ref.model.includes("gpt-oss")) body.reasoning_effort = "low";
    if (req.json && s.ref.provider === "groq") body.response_format = { type: "json_object" };
    // Nemotron otherwise spends its token budget "thinking" and can return an empty answer.
    if (s.ref.provider === "nvidia") body.chat_template_kwargs = { enable_thinking: false };

    let text = "";
    let ttft = 0;
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    let finish: string | undefined;
    try {
      const r = await fetch(`${PROVIDER_URLS[s.ref.provider]}/chat/completions`, {
        method: "POST",
        signal: ctl.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey(s.ref.provider)}` },
        body: JSON.stringify(body),
      });
      const remaining = Number(r.headers.get("x-ratelimit-remaining-requests"));
      if (s.daily && Number.isFinite(remaining) && r.headers.has("x-ratelimit-remaining-requests")) s.daily.sync(remaining);
      const remTok = Number(r.headers.get("x-ratelimit-remaining-tokens"));
      if (!s.costIsRequests && r.headers.has("x-ratelimit-remaining-tokens") && Number.isFinite(remTok)) s.bucket.sync(remTok);
      if (!r.ok) {
        const ra = Number(r.headers.get("retry-after"));
        const errText = await r.text();
        // Groq's free tier also has a per-DAY token limit (200k/model). Parse "try again in 20m30s" so the
        // model is skipped until its rolling window frees up, instead of being retried every minute.
        let retryMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined;
        const m = errText.match(/try again in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/);
        if (m && /per day/i.test(errText)) retryMs = ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000;
        throw new LlmError(`HTTP ${r.status} ${errText.slice(0, 160)}`, r.status, retryMs);
      }
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let inThink = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let j: any;
          try {
            j = JSON.parse(data);
          } catch {
            continue;
          }
          if (j.usage) usage = j.usage;
          const fr = j.choices?.[0]?.finish_reason;
          if (fr) finish = fr;
          if (j.x_groq?.usage) usage = j.x_groq.usage;
          let c: string | undefined = j.choices?.[0]?.delta?.content;
          if (!c) continue;
          // Strip inline <think> blocks some open models emit.
          if (c.includes("<think>")) inThink = true;
          if (inThink) {
            const end = c.indexOf("</think>");
            if (end < 0) continue;
            inThink = false;
            c = c.slice(end + 8);
            if (!c) continue;
          }
          if (!ttft) {
            ttft = performance.now() - t0;
            clearTimeout(ttftTimer);
          }
          armIdle();
          text += c;
          yield { type: "token", text: c };
        }
      }
    } catch (e) {
      if (e instanceof LlmError) throw e;
      const reason = ctl.signal.reason;
      if (reason instanceof LlmError) throw reason;
      throw new LlmError((e as Error).message);
    } finally {
      clearTimeout(ttftTimer);
      clearTimeout(idleTimer);
      req.signal?.removeEventListener("abort", onAbort);
    }
    if (!text.trim()) throw new LlmError("empty response");
    yield {
      type: "done",
      result: { text, model: s.ref.model, provider: s.ref.provider, ms: performance.now() - t0, ttftMs: ttft, inTok: usage?.prompt_tokens, outTok: usage?.completion_tokens, finish },
    };
  }
}

/** Parse a JSON object from model output (tolerates code fences and leading prose). */
export function parseJsonObject(text: string): unknown {
  const t = text.replace(/```(?:json)?/g, "").trim();
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error("no JSON object in model output");
  }
}
