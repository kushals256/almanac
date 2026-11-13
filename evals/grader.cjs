// Custom Promptfoo grader provider. Promptfoo's built-in retry misreads Groq's rate-limit headers
// (it waited 34 minutes on a 3-second limit), so grading goes through this small client instead:
// Groq models in rotation (each has its own 8k TPM budget), honouring the real retry delay, then NVIDIA.
// NVIDIA's strongest model goes first: grading is offline (speed matters less), a stronger judge
// reduces false negatives (F-26), and it keeps grading off the app's Groq budgets (F-27).
const MODELS = [
  { url: "https://integrate.api.nvidia.com/v1/chat/completions", key: "NVIDIA_API_KEY", model: "nvidia/nemotron-3-ultra-550b-a55b" },
  { url: "https://api.groq.com/openai/v1/chat/completions", key: "GROQ_API_KEY", model: "openai/gpt-oss-120b" },
  { url: "https://api.groq.com/openai/v1/chat/completions", key: "GROQ_API_KEY", model: "qwen/qwen3.8-27b" },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toMessages(prompt) {
  try {
    const j = JSON.parse(prompt);
    if (Array.isArray(j)) return j.map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }));
  } catch {}
  return [{ role: "user", content: String(prompt) }];
}

module.exports = class Grader {
  id() {
    return "grader:groq-rotation";
  }
  async callApi(prompt) {
    const messages = toMessages(prompt);
    const errors = [];
    for (let round = 0; round < 3; round++) {
      for (const m of MODELS) {
        const body = { model: m.model, messages, max_tokens: 1500, temperature: 0 };
        if (m.model.includes("gpt-oss")) body.reasoning_effort = "low";
        if (m.url.includes("groq")) body.response_format = { type: "json_object" };
        try {
          const r = await fetch(m.url, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${process.env[m.key]}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(90_000),
          });
          if (r.status === 429) {
            const ra = Number(r.headers.get("retry-after"));
            errors.push(`${m.model} 429`);
            if (Number.isFinite(ra) && ra > 0 && ra <= 20) await sleep(ra * 1000);
            continue;
          }
          if (!r.ok) {
            errors.push(`${m.model} ${r.status}`);
            continue;
          }
          const j = await r.json();
          const out = j.choices?.[0]?.message?.content;
          if (out) return { output: out, tokenUsage: { total: j.usage?.total_tokens ?? 0 } };
          errors.push(`${m.model} empty`);
        } catch (e) {
          errors.push(`${m.model} ${e.message}`);
        }
      }
      await sleep(5_000 * (round + 1));
    }
    return { error: `grader failed: ${errors.slice(-6).join("; ")}` };
  }
};
