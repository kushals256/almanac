/**
 * Generate frozen held-out v2: each seed → 4 ENGLISH variants (casual, unusual, typo-heavy, indirect).
 * Prints COUNTS ONLY so the wording isn't seen before the single run. Writes heldout2.json; never edit it.
 *   cd evals && npx tsx --env-file=../.env heldout2/generate.ts
 */
import { writeFileSync, existsSync } from "node:fs";
import { SEEDS } from "./seeds.ts";
const OUT = new URL("./heldout2.json", import.meta.url);
if (existsSync(OUT) && !process.env.FORCE) { console.log("heldout2.json already exists (frozen)."); process.exit(0); }
const out: any[] = [];
let failed = 0;
for (const s of SEEDS) {
  const prompt = `Rewrite this chat message 4 different ways, all in ENGLISH. Keep EXACTLY the same meaning: ${s.meaning}. Don't add or remove facts, names or dates.
1) casual: how a busy person types it (short, lowercase ok)
2) unusual: very different wording and sentence structure; avoid the original's key phrases where a synonym exists
3) typos: casual with 2-3 realistic typos or abbreviations
4) indirect: longer and roundabout, with a bit of context, the way people often ask
Original: "${s.q}"
Reply ONLY JSON: {"casual": "...", "unusual": "...", "typos": "...", "indirect": "..."}`;
  let v: any = null;
  for (let a = 0; a < 3 && !v; a++) {
    const r = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.NVIDIA_API_KEY}` },
      body: JSON.stringify({ model: "nvidia/nemotron-3-ultra-550b-a55b", max_tokens: 500, temperature: 0.8, chat_template_kwargs: { enable_thinking: false }, messages: [{ role: "user", content: prompt }] }),
    }).catch(() => null);
    if (!r?.ok) continue;
    const t = String(((await r.json()) as any).choices?.[0]?.message?.content ?? "");
    try { v = JSON.parse(t.match(/\{[\s\S]*\}/)![0]); } catch { v = null; }
  }
  if (!v) { failed++; continue; }
  for (const style of ["casual", "unusual", "typos", "indirect"]) if (typeof v[style] === "string" && v[style].trim()) out.push({ id: `${s.id}-${style}`, seed: s.id, kind: s.kind, style, q: v[style].trim(), expect: s.expect });
}
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), model: "nvidia/nemotron-3-ultra-550b-a55b", cases: out }, null, 1));
console.log(`frozen ${out.length} cases from ${SEEDS.length - failed}/${SEEDS.length} seeds → heldout2.json (wording not printed)`);
