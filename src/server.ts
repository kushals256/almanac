import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import { getCookie, setCookie } from "hono/cookie";
import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { degradedFeatures, loadConfig, type Config } from "./config.ts";
import { LOCAL_OWNER, Store } from "./memory/store.ts";
import { LlmClient } from "./llm/client.ts";
import { SearchRouter } from "./search/router.ts";
import { tapeFromEnv } from "./search/tape.ts";
import { domainOf } from "./util/url.ts";
import { Agent } from "./agent/pipeline.ts";
import { normaliseCitations } from "./agent/text.ts";
import { humanDate, isValidTz, now, setNow } from "./util/clock.ts";

let cfg: Config;
try {
  cfg = loadConfig();
} catch (e) {
  console.error(`\n${(e as Error).message}\n`);
  process.exit(1);
}
if (cfg.AGENT_NOW) setNow(cfg.AGENT_NOW); // test-only clock override

const store = new Store(cfg.DB_PATH);
const llm = new LlmClient(cfg);
// SEARCH_TAPE=record|replay (evaluation only): the same web for every build compared, at no search cost.
const tape = tapeFromEnv(new SearchRouter(cfg, store));
const search = tape.router;
if (tape.stats) console.warn(`Search tape: ${tape.stats.mode} (${process.env.SEARCH_TAPE_DIR ?? "data/tapes/default"})`);
const agent = new Agent(cfg, store, llm, search);

const modelStatus = await llm.probe();
const unavailable = Object.entries(modelStatus).filter(([, ok]) => !ok).map(([k]) => k);
if (unavailable.length) console.warn(`Models not currently listed by their provider (will be skipped): ${unavailable.join(", ")}`);

/** Rolling per-route latency samples for /stats. */
const samples: Array<{ route: string; ttftMs: number; totalMs: number }> = [];
const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]! : null);

const ChatBody = z.object({
  sessionId: z.string().min(1).max(64).regex(/^[\w-]+$/),
  message: z.string().trim().min(1).max(4_000),
  tz: z.string().max(64).optional(),
});

const app = new Hono();

/**
 * Owner of history. Bound to localhost (the default) it's a single-user agent: everything belongs to the local
 * owner, so existing history stays visible. Served on a network address, each browser gets its own random id in
 * an HttpOnly cookie and recall is scoped to it — two people never see each other's questions. (Not authentication;
 * behind a real login this would be the user id.)
 */
const SINGLE_USER = ["127.0.0.1", "localhost", "::1"].includes(cfg.HOST);
function ownerOf(c: Context): string {
  if (SINGLE_USER) return LOCAL_OWNER;
  const got = getCookie(c, "owner");
  if (got && /^[\w-]{8,64}$/.test(got)) return got;
  const id = randomUUID();
  setCookie(c, "owner", id, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
  return id;
}

app.post("/api/chat", async (c) => {
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > 32_768) return c.json({ error: "request too large" }, 413);
  let body: z.infer<typeof ChatBody>;
  try {
    body = ChatBody.parse(await c.req.json());
  } catch {
    return c.json({ error: "expected {sessionId, message, tz}" }, 400);
  }
  const tz = body.tz && isValidTz(body.tz) ? body.tz : "UTC";
  // Same owner rule for both modes (JSON mode must not bypass isolation on a network deployment).
  const owner = ownerOf(c);

  // JSON mode (?mode=json): same pipeline, one response at the end. Used by scripts and test
  // harnesses that can't consume SSE. Includes verification so tests can assert on it.
  if (c.req.query("mode") === "json") {
    const ctl = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => ctl.abort(new Error("client disconnected")));
    let text = "";
    const out: Record<string, unknown> = { status: [] as string[] };
    const emit = (event: string, data: unknown) => {
      if (event === "token") text += (data as { text: string }).text;
      else if (event === "retract" || event === "replace") text = (data as { text: string }).text;
      else if (event === "status") (out.status as string[]).push((data as { detail: string }).detail);
      else out[event] = data;
    };
    try {
      await agent.handle({ sessionId: body.sessionId, message: body.message, tz, owner }, emit, ctl.signal);
    } catch (e) {
      console.error("turn failed (json):", (e as Error).message);
      out.error = { message: friendlyError(e as Error) };
    }
    return c.json({ text: normaliseCitations(text), ...out });
  }

  return streamSSE(c, async (stream) => {
    const ctl = new AbortController();
    stream.onAbort(() => ctl.abort(new Error("client disconnected")));
    const emit = (event: string, data: unknown) => {
      if (event === "done") {
        const d = data as { route: string; timings: { ttftMs: number; totalMs: number } };
        samples.push({ route: d.route, ttftMs: d.timings.ttftMs, totalMs: d.timings.totalMs });
        if (samples.length > 500) samples.shift();
      }
      // Serialise writes and flush before the stream closes, so the final `done` is never lost.
      queue = queue.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })).catch(() => {});
    };
    let queue: Promise<void> = Promise.resolve();
    try {
      await agent.handle({ sessionId: body.sessionId, message: body.message, tz, owner }, emit, ctl.signal);
    } catch (e) {
      if (!ctl.signal.aborted) {
        console.error("turn failed:", e);
        emit("error", { message: friendlyError(e as Error) });
      }
    }
    await queue;
  });
});

/** Demo history for this owner: real recorded conversations re-dated to this week (no model or search calls). */
app.post("/api/demo", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { tz?: string };
  const tz = body.tz && isValidTz(body.tz) ? body.tz : "UTC";
  const r = agent.loadDemo(ownerOf(c), tz);
  return c.json({ added: r.added, conversations: r.conversations.map((x) => ({ ...x, label: humanDate(x.date) })) });
});

app.get("/api/history", (c) => {
  const sessionId = c.req.query("sessionId") ?? "";
  if (!/^[\w-]{1,64}$/.test(sessionId)) return c.json({ turns: [] });
  const owner = ownerOf(c);
  const turns = store
    .recentTurns(sessionId, 50)
    .filter((t) => t.owner === owner)
    // An answer's [n] citations need its numbered sources to render after a reload.
    .map((t) => ({
      id: t.id,
      role: t.role,
      content: t.content,
      at: t.created_at_utc,
      localDate: t.local_date,
      route: t.route,
      sources: t.role === "assistant" ? store.turnSources(t.id).map((s, i) => ({ n: i + 1, title: s.title ?? s.url, url: s.url, domain: domainOf(s.url), date: (s.published_at ?? s.fetched_at_utc).slice(0, 10), dated: !!s.published_at })) : [],
    }));
  return c.json({ turns });
});

app.get("/health", (c) =>
  c.json({ ok: true, now: now().toISOString(), degraded: degradedFeatures(cfg), models: modelStatus, quotas: llm.quotas(), judge: agent.judge.health(), searchTape: tape.stats }),
);

app.get("/stats", (c) => {
  const routes = [...new Set(samples.map((s) => s.route))];
  const byRoute = Object.fromEntries(
    routes.map((r) => {
      const xs = samples.filter((s) => s.route === r);
      return [r, { n: xs.length, ttftP50: pct(xs.map((x) => x.ttftMs), 50), ttftP95: pct(xs.map((x) => x.ttftMs), 95), totalP50: pct(xs.map((x) => x.totalMs), 50), totalP95: pct(xs.map((x) => x.totalMs), 95) }];
    }),
  );
  return c.json({ byRoute, search: search.totals, quotas: llm.quotas() });
});

const indexHtml = () => readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
app.get("/", (c) => c.html(indexHtml()));

function friendlyError(e: Error): string {
  if (/all models failed/.test(e.message)) return "All language models are busy or over their free quota right now. Please try again in a minute.";
  if (/no search provider/.test(e.message)) return "Web search is unavailable right now (both providers failed). Please try again shortly.";
  return "Something went wrong while answering. Please try again.";
}

// Hourly eviction of expired cache rows (bounded growth).
setInterval(() => store.evictCache(now()), 60 * 60_000).unref();

serve({ fetch: app.fetch, port: cfg.PORT, hostname: cfg.HOST }, (info) => {
  console.log(`chat agent ready → http://${info.address}:${info.port}`);
  for (const d of degradedFeatures(cfg)) console.log(`  degraded — ${d}`);
});
