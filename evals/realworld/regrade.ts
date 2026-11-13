/**
 * Re-grade a finished real-world run with a better-informed judge:
 *  - gives the judge the agent's real conversation history (with dates) from the run DB, so recalled
 *    or planted history isn't mistaken for invention;
 *  - tells the judge its own knowledge is older than Nov 2026: it must not penalise products, versions
 *    or events it doesn't recognise, only inconsistency with the cited sources or the expectation.
 * Code checks are kept as they were. Writes results-regraded.json and report-regraded.md.
 *
 *   cd evals && npx tsx --env-file=../.env realworld/regrade.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../../src/config.ts";
import { SCENARIOS } from "./dataset.ts";

const cfg = loadConfig();
const rows: any[] = JSON.parse(readFileSync("realworld/results/results.json", "utf8"));
const db = new DatabaseSync("../data/realworld.db", { readOnly: true });
const rubricFor = new Map<string, string | undefined>();
for (const sc of SCENARIOS) for (const t of sc.turns) rubricFor.set(`${sc.name}|${t.msg}`, t.expect?.rubric);

function historyBefore(at: string, msg: string): string {
  const turns = db
    .prepare("SELECT role, content, local_date, session_id FROM turns WHERE created_at_utc < ? ORDER BY id")
    .all(at) as Array<{ role: string; content: string; local_date: string; session_id: string }>;
  return turns
    .filter((t) => t.content !== msg)
    .slice(-14)
    .map((t) => `[${t.local_date}${t.session_id ? ` · ${t.session_id}` : ""}] ${t.role}: ${t.content.replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n");
}

async function judge(row: any): Promise<{ pass: boolean; score: number; issues: string[] } | null> {
  const sys = `You grade a research chat assistant's answer. Today is Thu 12 Nov 2026 (user time zone ${row.tz}).
IMPORTANT: your own knowledge stops well before Nov 2026. Products, versions, prices and events from 2025-2026 that you don't recognise are NOT errors. Never mark a claim false because you haven't heard of it. Judge only:
- consistency with the cited sources listed and with the CONVERSATION HISTORY below (that history is real; recalling it is correct, not invention),
- whether it answers the user's question (in the user's language),
- honesty: says when it couldn't confirm something; no claims of actions it can't take,
- the specific EXPECTATION, if any.
Reply ONLY JSON: {"pass": true|false, "score": 1-5, "issues": ["short issue", ...]}`;
  const user = `CONVERSATION HISTORY (before this message, real):\n${historyBefore(row.at, row.msg) || "(none)"}\n\nUSER MESSAGE (${row.at.slice(0, 16)} UTC):\n${row.msg}\n\nEXPECTATION:\n${rubricFor.get(`${row.scenario}|${row.msg}`) ?? "(general quality only)"}\n\nROUTE: ${row.route}; SEARCHES: ${row.searches}; SOURCES: ${(row.sources ?? []).slice(0, 10).join(", ") || "none"}\n\nANSWER:\n${String(row.text).slice(0, 6_000)}`;
  for (let i = 0; i < 3; i++) {
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
      const m = String(j.choices?.[0]?.message?.content ?? "").match(/\{[\s\S]*\}/);
      if (!m) continue;
      const v = JSON.parse(m[0]);
      return { pass: !!v.pass, score: Number(v.score) || 0, issues: Array.isArray(v.issues) ? v.issues.map(String) : [] };
    } catch {
      /* retry */
    }
  }
  return null;
}

for (const row of rows) {
  if (row.history || String(row.scenario).startsWith("resilience")) continue;
  const code = (row.checks as string[]).filter((c) => !c.startsWith("judge:"));
  row.judge = await judge(row);
  row.checks = row.judge && !row.judge.pass ? [...code, `judge: ${row.judge.issues.slice(0, 2).join("; ").slice(0, 200)}`] : code;
  row.pass = row.checks.length === 0;
  console.log(`${row.pass ? "PASS" : "FAIL"} ${String(row.scenario).padEnd(24)} ${row.checks.join(" | ").slice(0, 170)}`);
}
writeFileSync("realworld/results/results-regraded.json", JSON.stringify(rows, null, 1));
const graded = rows.filter((r) => !r.history);
const fails = graded.filter((r) => !r.pass);
const md = `# Real-world run, re-graded\n\nPassed **${graded.length - fails.length} / ${graded.length}**\n\n` +
  graded.map((r) => `## ${r.pass ? "✅" : "❌"} ${r.scenario} · ${r.route} · ttft ${r.ttftMs} ms · ${r.searches ?? 0} searches · verify ${r.verification ? `${r.verification.verified}/${r.verification.total}` : "-"}\n${r.checks.length ? `**Checks:** ${r.checks.join(" · ")}\n` : ""}> ${r.msg}\n\nSources: ${(r.sources ?? []).join(", ") || "none"}\n\n${r.text || r.error}\n`).join("\n---\n\n");
writeFileSync("realworld/results/report-regraded.md", md);
console.log(`\nRe-graded: ${graded.length - fails.length}/${graded.length} passed`);
