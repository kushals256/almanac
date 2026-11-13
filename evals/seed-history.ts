/**
 * Build real conversation history in a separate eval database (../data/eval.db) by running real
 * turns on simulated past days with the test-only clock. Your own chat history is never touched.
 *   npm run seed   (then: npm run serve)
 */
import { rmSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/memory/store.ts";
import { LlmClient } from "../src/llm/client.ts";
import { SearchRouter } from "../src/search/router.ts";
import { Agent } from "../src/agent/pipeline.ts";
import { setNow } from "../src/util/clock.ts";

const DB = "../data/eval.db";
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
const cfg = loadConfig();
const store = new Store(DB);
const llm = new LlmClient(cfg);
const agent = new Agent(cfg, store, llm, new SearchRouter(cfg, store));

const HISTORY: Array<[string, string, string]> = [
  ["2026-11-03T05:30:00Z", "hist-03", "I need managed Postgres hosting for a small SaaS. Compare Neon, Supabase and AWS RDS on pricing."],
  ["2026-11-09T06:00:00Z", "hist-09", "We're a 20-person sales team. Shortlist 5 CRM tools for us with per-seat pricing."],
  ["2026-11-10T07:00:00Z", "hist-10", "What's the latest stable version of Node.js?"],
  ["2026-11-11T09:00:00Z", "hist-11", "How much does Vercel Pro cost per seat, and what are the bandwidth limits?"],
];
for (const [at, session, msg] of HISTORY) {
  setNow(at);
  let done: any = null;
  await agent.handle({ sessionId: session, message: msg, tz: "Asia/Kolkata" }, (ev, d) => { if (ev === "done") done = d; }, new AbortController().signal);
  console.log(`seeded ${at.slice(0, 10)} [${done?.route}] ${msg}`);
  await new Promise((r) => setTimeout(r, 8_000));
}
console.log("eval history ready → npm run serve");
