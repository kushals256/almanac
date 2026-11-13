// Reuse the eval DB history and ask one question "today" (for iterating on a single case).
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/memory/store.ts";
import { LlmClient } from "../src/llm/client.ts";
import { SearchRouter } from "../src/search/router.ts";
import { Agent } from "../src/agent/pipeline.ts";
import { normaliseCitations } from "../src/agent/text.ts";
import { setNow } from "../src/util/clock.ts";
const cfg = loadConfig();
const store = new Store("data/eval-brief.db");
const llm = new LlmClient(cfg);
const agent = new Agent(cfg, store, llm, new SearchRouter(cfg, store));
setNow(process.env.AGENT_NOW ?? "2026-11-12T07:00:00Z");
let text = "", done: any, sources: any[] = [], verification: any = null;
await agent.handle({ sessionId: "one", message: process.argv[2]!, tz: "Asia/Kolkata" }, (ev, d: any) => { if (ev === "token") text += d.text; if (ev === "done") done = d; if (ev === "sources") sources = d; if (ev === "verification") verification = d; }, new AbortController().signal);
console.log(JSON.stringify({ route: done.route, timings: done.timings, models: done.models, search: done.search.calls }));
for (const x of sources) console.log(`  [${x.n}] ${x.domain} ${x.dated ? "pub" : "fetched"} ${x.date}  ${x.url.slice(0, 90)}`);
console.log(normaliseCitations(text));
if (verification) {
  console.log(`\nVERIFY via ${verification.verifier} ${verification.ms}ms ${JSON.stringify(verification.summary)} ${verification.error ?? ""}`);
  for (const c of verification.claims) console.log(`  ${c.status.padEnd(11)} ${String(c.score).padEnd(5)} L${c.line} ${c.missingNumbers.length ? "missing#" + c.missingNumbers.join(",") + " " : ""}${c.text.slice(0, 110)}`);
}
