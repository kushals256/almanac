/**
 * Multi-day eval of the brief's sample queries (SPEC §10). Builds real history on simulated
 * past days with the test-only clock, then asks the brief's questions "today" (Thu 12 Nov 2026).
 * Uses live providers. Run: npx tsx --env-file=.env scripts/eval-brief.ts
 */
import { rmSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/memory/store.ts";
import { LlmClient } from "../src/llm/client.ts";
import { SearchRouter } from "../src/search/router.ts";
import { Agent } from "../src/agent/pipeline.ts";
import { setNow } from "../src/util/clock.ts";
import { normaliseCitations } from "../src/agent/text.ts";

const DB = "data/eval-brief.db";
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
const cfg = loadConfig();
const store = new Store(DB);
const llm = new LlmClient(cfg);
const agent = new Agent(cfg, store, llm, new SearchRouter(cfg, store));
const TZ = "Asia/Kolkata";

const steps: Array<{ at: string; session: string; msg: string; show?: boolean }> = [
  { at: "2026-11-03T05:30:00Z", session: "day-03", msg: "I need managed Postgres hosting for a small SaaS. Compare Neon, Supabase and AWS RDS on pricing." },
  { at: "2026-11-09T06:00:00Z", session: "day-09", msg: "We're a 20-person sales team. Shortlist 5 CRM tools for us with per-seat pricing." },
  { at: "2026-11-10T07:00:00Z", session: "day-10", msg: "What's the latest stable version of Node.js?" },
  { at: "2026-11-12T06:00:00Z", session: "today", msg: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?", show: true },
  { at: "2026-11-12T06:05:00Z", session: "today", msg: "What did I ask you on 3 November? Is your answer still correct today?", show: true },
  { at: "2026-11-12T06:10:00Z", session: "today", msg: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", show: true },
  { at: "2026-11-12T06:15:00Z", session: "today", msg: "What did I ask you on 28 October?", show: true },
];

const PACE_MS = Number(process.env.EVAL_PACE_MS ?? 0); // gap between turns, to emulate a person typing
for (const s of steps) {
  if (PACE_MS) await new Promise((r) => setTimeout(r, PACE_MS));
  setNow(s.at);
  let text = "";
  let done: any = null;
  const memory: string[] = [];
  const t0 = performance.now();
  try {
    await agent.handle({ sessionId: s.session, message: s.msg, tz: TZ }, (ev, d: any) => {
      if (ev === "token") text += d.text;
      else if (ev === "done") done = d;
      else if (ev === "memory") memory.push(...d.map((m: any) => m.label));
    }, new AbortController().signal);
  } catch (e) {
    text = `ERROR: ${(e as Error).message}`;
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== [${s.at.slice(0, 10)}] ${s.msg}`);
  console.log(`route=${done?.route} plan=${done?.timings.planMs}ms retrieve=${done?.timings.retrieveMs}ms ttft=${done?.timings.ttftMs}ms total=${secs}s searches=${done?.search.calls} memory=[${memory.join(", ")}] models=${JSON.stringify(done?.models)} invalidCites=${JSON.stringify(done?.citations?.invalid)}`);
  if (s.show) console.log(normaliseCitations(text).trim());
}
