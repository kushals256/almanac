/**
 * Generate the frozen held-out set: each seed → 3 variants (casual, unusual wording, another language),
 * written by an LLM that never sees our code. Output: heldout.json (commit it; never edit by hand).
 *   cd evals && npx tsx --env-file=../.env heldout/generate.ts
 */
import { writeFileSync, existsSync } from "node:fs";
import { SEEDS } from "./seeds.ts";
const OUT = new URL("./heldout.json", import.meta.url);
if (existsSync(OUT) && !process.env.FORCE) { console.log("heldout.json already exists (frozen). Set FORCE=1 to regenerate."); process.exit(0); }
const LANGS = ["Hindi", "Spanish", "French"];
const out: any[] = [];
for (const [i, s] of SEEDS.entries()) {
  const lang = LANGS[i % LANGS.length];
  const prompt = `Rewrite this chat message 3 different ways. Keep EXACTLY the same meaning: ${s.meaning}. Do not add or remove facts, names, dates or numbers' meaning.
1) casual: how a busy person might type it (lowercase ok, short, maybe a typo)
2) unusual: very different wording/sentence structure from the original, avoid reusing its key phrases where a synonym exists
3) ${lang}: a natural translation into ${lang} (native script)
Original: "${s.q}"
Reply ONLY JSON: {"casual": "...", "unusual": "...", "translated": "..."}`;
  let v: any = null;
  for (let a = 0; a < 3 && !v; a++) {
    const r = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.NVIDIA_API_KEY}` },
      body: JSON.stringify({ model: "nvidia/nemotron-3-ultra-550b-a55b", max_tokens: 400, temperature: 0.7, chat_template_kwargs: { enable_thinking: false }, messages: [{ role: "user", content: prompt }] }),
    });
    const t = String(((await r.json()) as any).choices?.[0]?.message?.content ?? "");
    try { v = JSON.parse(t.match(/\{[\s\S]*\}/)![0]); } catch { v = null; }
  }
  if (!v) throw new Error(`generation failed for ${s.id}`);
  for (const [style, q] of [["casual", v.casual], ["unusual", v.unusual], [`lang:${lang}`, v.translated]] as const) out.push({ id: `${s.id}-${style.split(":")[0]}`, seed: s.id, kind: s.kind, style, q, expect: s.expect });
  console.log(`${s.id}: ${v.casual} | ${v.unusual} | ${v.translated}`);
}
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), model: "nvidia/nemotron-3-ultra-550b-a55b", cases: out }, null, 1));
console.log(`\nfrozen ${out.length} cases → heldout.json`);
