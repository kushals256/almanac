/**
 * Real-world runner (our own, no Promptfoo). Runs the dataset through the real agent in-process,
 * checks each answer with code rules + an LLM judge (NVIDIA, so grading never touches Groq budgets),
 * runs provider-outage checks, and writes evals/realworld/results/{results.json,report.md}.
 *
 *   cd evals && npx tsx --env-file=../.env realworld/run.ts            # everything
 *   SCENARIO=breadth npx tsx --env-file=../.env realworld/run.ts       # one scenario (name substring)
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { loadConfig, type Config } from "../../src/config.ts";
import { Store } from "../../src/memory/store.ts";
import { LlmClient } from "../../src/llm/client.ts";
import { SearchRouter } from "../../src/search/router.ts";
import { tapeFromEnv } from "../../src/search/tape.ts";
import { Agent } from "../../src/agent/pipeline.ts";
import { normaliseCitations } from "../../src/agent/text.ts";
import { setNow } from "../../src/util/clock.ts";
import { SCENARIOS as V1, type Expect, type Scenario } from "./dataset.ts";

/** DATASET=v2 runs dataset2.ts (bigger: public gold-answer sets + personas). */
const SCENARIOS: Scenario[] =
  process.env.DATASET === "v2" ? (await import("./dataset2.ts")).SCENARIOS : process.env.DATASET === "heldout" ? (await import("../heldout/dataset.ts")).SCENARIOS : process.env.DATASET === "wildchat" ? (await import("../wildchat/dataset.ts")).SCENARIOS : process.env.DATASET === "heldout2" ? (await import("../heldout2/dataset.ts")).SCENARIOS : process.env.DATASET === "heldout3" ? (await import("../heldout3/dataset.ts")).SCENARIOS : process.env.DATASET === "heldout4" ? (await import("../heldout4/dataset.ts")).SCENARIOS : V1;

const DS = process.env.DATASET ?? "v1";
const OUT = DS === "v1" ? "realworld/results" : `realworld/results-${DS}${process.env.TAG ? `-${process.env.TAG}` : ""}`;
const DB = `../data/realworld-${DS}.db`;
const PACE_MS = Number(process.env.PACE_MS ?? 5_000);
const only = process.env.SCENARIO;
/** Optional regex: within multi-question scenarios like "breadth", run only matching messages. */
const msgFilter = process.env.MSG ? new RegExp(process.env.MSG, "i") : null;

mkdirSync(OUT, { recursive: true });
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
const cfg = loadConfig();
const store = new Store(DB);
const sharedLlm = new LlmClient(cfg); // one client so rate limits are shared across isolated agents
const agent = makeAgent(cfg);
/** ISOLATE=1: every graded case gets a fresh memory containing only the scenario's planted history. */
const ISOLATE = !!process.env.ISOLATE;

function makeAgent(c: Config, st: Store = store): Agent {
  // SEARCH_TAPE=record|replay: the same web for every build compared (see src/search/tape.ts).
  return new Agent(c, st, c === cfg ? sharedLlm : new LlmClient(c), tapeFromEnv(new SearchRouter(c, st), { ...process.env, SEARCH_TAPE_DIR: process.env.SEARCH_TAPE_DIR ?? `tapes/${DS}` }).router);
}

function plantInto(st: Store, plants: Array<{ at: string; session: string; tz?: string; q: string; a: string }>, tz: string): void {
  for (const p of plants) {
    const at = new Date(p.at);
    const qid = st.insertTurn({ sessionId: p.session, role: "user", content: p.q, tz: p.tz ?? tz, at });
    st.insertTurn({ sessionId: p.session, role: "assistant", content: p.a, tz: p.tz ?? tz, at: new Date(at.getTime() + 5_000), replyTo: qid });
  }
}

type Row = {
  scenario: string; label?: string; at: string; tz: string; session: string; msg: string; history: boolean;
  route?: string; ttftMs?: number; totalMs?: number; searches?: number; costUsd?: number; models?: unknown;
  verification?: { verified: number; weak: number; unsupported: number; total: number } | null; flagged?: unknown[];
  notice?: string | null; retract?: string | null; sources: string[]; text: string; error?: string;
  checks: string[]; judge?: { pass: boolean; score: number; issues: string[] } | null; pass?: boolean;
  grade?: "CORRECT" | "INCORRECT" | "NOT_ATTEMPTED" | null;
};

/** SimpleQA-style grading against gold answers (on NVIDIA, never Groq). */
async function gradeGold(row: Row, gold: string[]): Promise<Row["grade"]> {
  const sys = `You grade an answer against GOLD answers, SimpleQA-style. Reply with exactly one word:
CORRECT: the answer contains the gold answer's key fact (or an equivalent; minor wording/rounding is fine), without contradicting it. For a false-premise question, CORRECT means it points out the false premise as the gold does.
INCORRECT: it states something that contradicts the gold, or accepts a false premise.
NOT_ATTEMPTED: it doesn't give the key fact and doesn't contradict the gold (e.g. says it couldn't confirm).`;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.NVIDIA_API_KEY}` },
        body: JSON.stringify({ model: "nvidia/nemotron-3-ultra-550b-a55b", max_tokens: 10, temperature: 0, chat_template_kwargs: { enable_thinking: false }, messages: [{ role: "system", content: sys }, { role: "user", content: `QUESTION: ${row.msg}\nGOLD: ${gold.join(" | ")}\nANSWER: ${row.text.slice(0, 3_000)}` }] }),
        signal: AbortSignal.timeout(45_000),
      });
      if (r.status === 429) { await new Promise((res) => setTimeout(res, 8_000)); continue; }
      if (!r.ok) continue;
      const t = String(((await r.json()) as any).choices?.[0]?.message?.content ?? "").toUpperCase();
      if (t.includes("NOT_ATTEMPTED") || t.includes("NOT ATTEMPTED")) return "NOT_ATTEMPTED";
      if (t.includes("INCORRECT")) return "INCORRECT";
      if (t.includes("CORRECT")) return "CORRECT";
    } catch {
      /* retry */
    }
  }
  return null;
}

async function runTurn(a: Agent, scenario: string, t: { at: string; msg: string; session?: string; tz?: string; label?: string }, tz: string, history: boolean): Promise<Row> {
  setNow(t.at);
  const row: Row = { scenario, label: t.label, at: t.at, tz, session: t.session ?? `${scenario}-s`, msg: t.msg, history, sources: [], text: "", checks: [] };
  let done: any = null;
  const t0 = performance.now();
  try {
    await a.handle({ sessionId: row.session, message: t.msg, tz }, (ev, d: any) => {
      if (ev === "token") row.text += d.text;
      else if (ev === "retract") { row.text = d.text; row.retract = d.reason; }
      else if (ev === "replace") row.text = d.text;
      else if (ev === "done") done = d;
      else if (ev === "sources") row.sources = d.map((s: any) => `${s.domain}${s.dated ? ` ${s.date}` : " (fetched)"}`);
      else if (ev === "verification") { row.verification = d.summary; row.flagged = (d.claims ?? []).filter((c: any) => c.status !== "verified"); }
      else if (ev === "notice") row.notice = d.text;
    }, new AbortController().signal);
  } catch (e) {
    row.error = (e as Error).message;
  }
  row.text = normaliseCitations(row.text);
  row.route = done?.route;
  row.ttftMs = done?.timings?.ttftMs;
  row.totalMs = Math.round(performance.now() - t0);
  row.searches = done?.search?.calls;
  row.costUsd = done?.search?.costUsd;
  row.models = done?.models;
  if (done?.citations?.invalid?.length) row.checks.push(`invalid citations ${done.citations.invalid}`);
  return row;
}

function codeChecks(row: Row, e: Expect | undefined): void {
  if (row.error) row.checks.push(`ERROR: ${row.error.slice(0, 120)}`);
  if (/busy or over their free quota/i.test(row.text)) row.checks.push("models busy");
  if (row.notice) row.checks.push("action-claim notice");
  if (row.verification?.unsupported) row.checks.push(`${row.verification.unsupported} unsupported claim(s)`);
  if (/<\s*(date|today|k|n|\d+ of \d+)\s*>/i.test(row.text)) row.checks.push("template placeholder in answer");
  if (row.route === "quick" && (row.ttftMs ?? 0) > 6_000) row.checks.push(`slow first token ${row.ttftMs} ms`);
  if (row.route !== "quick" && (row.ttftMs ?? 0) > 10_000) row.checks.push(`slow first token ${row.ttftMs} ms`);
  if (!e) return;
  if (e.routes && row.route && !e.routes.includes(row.route)) row.checks.push(`route ${row.route} (expected ${e.routes.join("|")})`);
  if (e.searches === "some" && !row.searches) row.checks.push("expected a search, none made");
  if (e.searches === "none" && row.searches) row.checks.push(`expected no search, made ${row.searches}`);
  const low = row.text.toLowerCase();
  if (e.anyOf && !e.anyOf.some((x) => low.includes(x.toLowerCase()))) row.checks.push(`missing one of: ${e.anyOf.join(" / ")}`);
  for (const x of e.noneOf ?? []) if (low.includes(x.toLowerCase())) row.checks.push(`contains forbidden: "${x}"`);
}

/** LLM judge on NVIDIA Nemotron Ultra (thinking off). Returns null if the judge is unavailable. */
async function judge(row: Row, e: Expect | undefined, st: Store = store): Promise<Row["judge"]> {
  // F-64: the judge sees the real conversation history and is told its knowledge predates Nov 2026.
  const sys = `You grade a research chat assistant's answer. Today is Thu 12 Nov 2026 (user time zone ${row.tz}).
IMPORTANT: your own knowledge stops well before Nov 2026. Products, versions, prices and events from 2025-2026 that you don't recognise are NOT errors. Never mark a claim false because you haven't heard of it. Judge only:
- consistency with the cited sources listed and with the CONVERSATION HISTORY below (that history is real; recalling it is correct, not invention),
- whether it answers the user's question (in the user's language),
- honesty: says when it couldn't confirm something; no claims of actions it can't take,
- the specific EXPECTATION, if any.
Reply ONLY JSON: {"pass": true|false, "score": 1-5, "issues": ["short issue", ...]}`;
  const all = (st.db.prepare("SELECT role, content, local_date, session_id, created_at_utc FROM turns WHERE created_at_utc < ? ORDER BY id").all(row.at) as Array<{ role: string; content: string; local_date: string; session_id: string; created_at_utc: string }>)
    .filter((t) => t.content !== row.msg);
  // Earlier days (planted/built history) + this session, so the judge sees every turn the agent could recall.
  const hist = [...all.filter((t) => t.created_at_utc.slice(0, 10) < row.at.slice(0, 10)).slice(-24), ...all.filter((t) => t.session_id === row.session).slice(-8)]
    .map((t) => `[${t.local_date} · ${t.session_id}] ${t.role}: ${t.content.replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n");
  const user = `CONVERSATION HISTORY (before this message, real):\n${hist || "(none)"}\n\nUSER MESSAGE (${row.at.slice(0, 16)} UTC):\n${row.msg}\n\nEXPECTATION:\n${e?.rubric ?? "(general quality only)"}\n\nROUTE: ${row.route}; SEARCHES: ${row.searches}; SOURCES: ${row.sources.slice(0, 10).join(", ") || "none"}\n\nANSWER:\n${row.text.slice(0, 6_000)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.NVIDIA_API_KEY}` },
        body: JSON.stringify({ model: "nvidia/nemotron-3-ultra-550b-a55b", max_tokens: 400, temperature: 0, chat_template_kwargs: { enable_thinking: false }, messages: [{ role: "system", content: sys }, { role: "user", content: user }] }),
        signal: AbortSignal.timeout(60_000),
      });
      if (r.status === 429) { await new Promise((res) => setTimeout(res, 8_000)); continue; }
      if (!r.ok) continue;
      const j: any = await r.json();
      const txt: string = j.choices?.[0]?.message?.content ?? "";
      const m = txt.match(/\{[\s\S]*\}/);
      if (!m) continue;
      const v = JSON.parse(m[0]);
      return { pass: !!v.pass, score: Number(v.score) || 0, issues: Array.isArray(v.issues) ? v.issues.map(String) : [] };
    } catch {
      /* retry */
    }
  }
  return null;
}

const rows: Row[] = [];
const save = () => writeFileSync(`${OUT}/results.json`, JSON.stringify(rows, null, 1));
const t0 = Date.now();

for (const sc of SCENARIOS) {
  if (only && !only.split(",").some((o) => sc.name.includes(o))) continue;
  for (const p of sc.plants ?? []) {
    const at = new Date(p.at);
    const tz = p.tz ?? sc.tz ?? "Asia/Kolkata";
    const qid = store.insertTurn({ sessionId: p.session, role: "user", content: p.q, tz, at });
    store.insertTurn({ sessionId: p.session, role: "assistant", content: p.a, tz, at: new Date(at.getTime() + 5_000), replyTo: qid });
  }
  for (const t of sc.turns) {
    if (msgFilter && sc.name === "breadth" && !msgFilter.test(t.msg)) continue;
    // LABEL=premise runs only turns whose label contains that text (e.g. one kind in a frozen set).
    if (process.env.LABEL && t.expect && !(t.label ?? "").includes(process.env.LABEL)) continue;
    const tz = t.tz ?? sc.tz ?? "Asia/Kolkata";
    const history = !t.expect && !t.label && new Date(t.at) < new Date("2026-11-12T00:00:00Z");
    let st = store;
    let a = agent;
    if (ISOLATE && !history) {
      st = new Store(":memory:");
      plantInto(st, sc.plants ?? [], sc.tz ?? "Asia/Kolkata");
      a = makeAgent(cfg, st);
    }
    const row = await runTurn(a, sc.name, t, tz, history);
    if (!history) {
      codeChecks(row, t.expect);
      row.label = t.label;
      if (t.expect?.gold) {
        // Public gold-answer items: INCORRECT fails; NOT_ATTEMPTED is an honest abstention (reported, not failed).
        row.grade = await gradeGold(row, t.expect.gold);
        if (row.grade === "INCORRECT") row.checks.push(`gold: INCORRECT (gold: ${t.expect.gold[0]!.slice(0, 80)})`);
      } else {
        row.judge = await judge(row, t.expect, st);
        if (row.judge && !row.judge.pass) row.checks.push(`judge: ${row.judge.issues.slice(0, 2).join("; ").slice(0, 160)}`);
      }
    }
    row.pass = !row.checks.length;
    rows.push(row);
    save();
    const v = row.verification ? `${row.verification.verified}/${row.verification.total}` : "-";
    console.log(`${history ? "hist" : row.pass ? "PASS" : "FAIL"}${row.grade ? `[${row.grade[0]}]` : ""} ${sc.name.padEnd(24)} ${String(row.route).padEnd(8)} ttft=${String(row.ttftMs ?? "-").padStart(5)} total=${String(row.totalMs).padStart(6)} s=${String(row.searches ?? "-").padStart(2)} ver=${v.padEnd(5)} ${row.checks.join(" | ").slice(0, 160)}`);
    if (t.label !== "burst") await new Promise((r) => setTimeout(r, PACE_MS)); // bursts fire back-to-back
  }
}

// ───────── Provider-outage checks: broken search key → Tavily; broken Groq key → NVIDIA
if (!only || only.split(",").includes("resilience")) {
  const outages: Array<[string, Partial<Config>]> = [
    ["exa-down", { EXA_API_KEY: "invalid-exa-key-for-outage-test" }],
    ["groq-down", { GROQ_API_KEY: "gsk_invalid_key_for_outage_test_000000000" }],
  ];
  for (const [name, patch] of outages) {
    const a = makeAgent({ ...cfg, ...patch } as Config);
    const row = await runTurn(a, `resilience:${name}`, { at: T(10), msg: "What's the latest stable version of Python?", session: `res-${name}` }, "Asia/Kolkata", false);
    codeChecks(row, { searches: "some" });
    const providers = JSON.stringify(row.models ?? {});
    if (name === "groq-down" && !/nvidia/.test(providers)) row.checks.push(`expected NVIDIA fallback, got ${providers}`);
    row.pass = !row.checks.length;
    rows.push(row);
    save();
    console.log(`${row.pass ? "PASS" : "FAIL"} resilience:${name.padEnd(14)} ${String(row.route).padEnd(8)} ttft=${row.ttftMs} s=${row.searches} models=${providers} ${row.checks.join(" | ")}`);
  }
}

// ───────── Report
const graded = rows.filter((r) => !r.history);
const fails = graded.filter((r) => !r.pass);
const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : 0);
const tt = graded.map((r) => r.ttftMs ?? 0).filter(Boolean);
const summary = `# Real-world run (${new Date().toISOString().slice(0, 16)})

- Cases graded: **${graded.length}**, passed **${graded.length - fails.length}**, failed **${fails.length}** (wall time ${Math.round((Date.now() - t0) / 60000)} min)
- First token p50 **${pct(tt, 50)} ms**, p95 **${pct(tt, 95)} ms**
- Searches ${rows.reduce((a, r) => a + (r.searches ?? 0), 0)}, search spend $${rows.reduce((a, r) => a + (r.costUsd ?? 0), 0).toFixed(3)}
${["simpleqa", "freshqa:false-premise", "freshqa:slow-changing", "freshqa:never-changing"].map((k) => {
  const xs = graded.filter((r) => (r.label ?? "") === k || (k === "simpleqa" && r.label === "simpleqa"));
  if (!xs.length) return "";
  const c = xs.filter((r) => r.grade === "CORRECT").length, w = xs.filter((r) => r.grade === "INCORRECT").length, n = xs.filter((r) => r.grade === "NOT_ATTEMPTED").length;
  return `- **${k}**: ${c} correct, ${w} incorrect, ${n} not attempted (of ${xs.length}) — accuracy when attempted ${c + w ? Math.round((100 * c) / (c + w)) : 0}%\n`;
}).join("")}${DS.startsWith("heldout") ? (() => {
  const by = (f: (r: Row) => string) => { const m = new Map<string, [number, number]>(); for (const r of graded) { const k = f(r); const v = m.get(k) ?? [0, 0]; v[0] += r.pass ? 1 : 0; v[1]++; m.set(k, v); } return [...m].map(([k, [p, n]]) => `${k} ${p}/${n}`).join(" · "); };
  return `- by kind: ${by((r) => (r.label ?? "").split("|")[0]!)}\n- by style: ${by((r) => (r.label ?? "").split("|")[1]!)}\n`;
})() : ""}- Mean judge score ${(graded.filter((r) => r.judge).reduce((a, r) => a + (r.judge?.score ?? 0), 0) / Math.max(1, graded.filter((r) => r.judge).length)).toFixed(2)} / 5
`;
const detail = rows
  .filter((r) => !r.history)
  .map((r) => `## ${r.pass ? "✅" : "❌"} ${r.scenario}${r.label ? ` · ${r.label}` : ""} · ${r.route} · ttft ${r.ttftMs} ms · ${r.searches ?? 0} searches · verify ${r.verification ? `${r.verification.verified}/${r.verification.total}` : "-"} · judge ${r.judge ? r.judge.score : "-"}
${r.checks.length ? `**Checks:** ${r.checks.join(" · ")}\n` : ""}> (${r.at.slice(0, 16)} ${r.tz}) ${r.msg}

Sources: ${r.sources.join(", ") || "none"}

${r.text || r.error}
${r.flagged?.length ? `\nFlagged claims:\n${(r.flagged as any[]).map((c) => `- ${c.status}${c.reason ? ` (${c.reason})` : ""}: ${c.text}`).join("\n")}` : ""}`)
  .join("\n\n---\n\n");
writeFileSync(`${OUT}/report.md`, `${summary}\n---\n\n${detail}\n`);
console.log(`\n${summary}`);

function T(h: number): string {
  return `2026-11-12T${String(h).padStart(2, "0")}:00:00Z`;
}
