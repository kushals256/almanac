import { loadConfig } from "../src/config.ts";
import { Store } from "../src/memory/store.ts";
import { LlmClient } from "../src/llm/client.ts";
import { SearchRouter } from "../src/search/router.ts";
import { Agent } from "../src/agent/pipeline.ts";
const cfg = loadConfig();
import { setNow } from "../src/util/clock.ts";
if (process.env.AGENT_NOW) setNow(process.env.AGENT_NOW);
const store = new Store(process.env.DB_PATH ?? "data/debug.db");
const llm = new LlmClient(cfg);
const agent = new Agent(cfg, store, llm, new SearchRouter(cfg, store));
const msg = process.argv[2] ?? "What are Neon Postgres pricing plans right now?";
const t0 = performance.now();
let text = "";
await agent.handle({ sessionId: process.argv[3] ?? "debug", message: msg, tz: "Asia/Kolkata" }, (ev, d: any) => {
  const t = ((performance.now() - t0) / 1000).toFixed(2);
  if (ev === "token") { if (!text) console.log(`${t}s first token`); text += d.text; return; }
  console.log(`${t}s ${ev}`, JSON.stringify(d).slice(0, 300));
}, new AbortController().signal);
console.log("---\n" + text);
