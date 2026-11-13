import { test } from "node:test";
import assert from "node:assert/strict";
import { Judge } from "../src/llm/judge.ts";
import type { Config } from "../src/config.ts";

const cfg = { OPENROUTER_API_KEY: "test-key-xxxxxxxx" } as Config;
const Q = { a: { instructions: "Is it about cats?", true: "Yes", false: "No" } };
const signal = new AbortController().signal;

function withFetch(impl: () => Promise<Response>, body: () => Promise<void>) {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return impl();
  }) as typeof fetch;
  return body().finally(() => (globalThis.fetch = real)).then(() => calls);
}
const ok = () => Promise.resolve(new Response(JSON.stringify({ answers: { a: { noul: 0.9 } } }), { status: 200 }));
const down = () => Promise.resolve(new Response("unavailable", { status: 503 }));
const fakeLlm = (reply: string) => ({ complete: async () => ({ text: reply, provider: "groq", model: "m" }) }) as any;

test("judge: Jev answers → probabilities, via jev, not degraded", async () => {
  const j = new Judge(cfg);
  await withFetch(ok, async () => {
    const r = await j.ask("state", Q, signal);
    assert.deepEqual(r, { probs: { a: 0.9 }, via: "jev" });
  });
  assert.equal(j.health().degraded, false);
});

test("judge: Jev down → the LLM answers the same questions when the caller allows it", async () => {
  const j = new Judge(cfg, fakeLlm('{"a": 0.2}'));
  await withFetch(down, async () => {
    assert.deepEqual(await j.ask("state", Q, signal, { llmFallback: true }), { probs: { a: 0.2 }, via: "llm" });
    assert.equal(await j.ask("state", Q, signal), null); // caller didn't allow the LLM → its own default
  });
  assert.equal(j.health().degraded, true);
});

test("judge: after repeated failures the breaker skips Jev instead of re-trying it every call", async () => {
  const j = new Judge(cfg);
  const calls = await withFetch(down, async () => {
    for (let i = 0; i < 6; i++) await j.ask("state", Q, signal);
  });
  assert.equal(calls, 3); // three failures open the breaker; the next three calls never hit the network
  assert.equal(j.health().breakerOpen, true);
});

test("judge: no questions → nothing is called", async () => {
  const calls = await withFetch(ok, async () => {
    assert.deepEqual(await new Judge(cfg).ask("state", {}, signal), { probs: {}, via: "jev" });
  });
  assert.equal(calls, 0);
});

test("config: only Groq + Exa are required; missing fallbacks degrade instead of refusing to boot", async () => {
  const { loadConfig, degradedFeatures } = await import("../src/config.ts");
  const cfg = loadConfig({ GROQ_API_KEY: "g".repeat(12), EXA_API_KEY: "e".repeat(12), NVIDIA_API_KEY: "" } as any);
  assert.equal(degradedFeatures(cfg).length, 3);
  assert.throws(() => loadConfig({ GROQ_API_KEY: "g".repeat(12) } as any), /EXA_API_KEY/);
});

test("judge without an OpenRouter key goes straight to the LLM judge (no Jev call)", async () => {
  let calls = 0;
  const real = globalThis.fetch;
  globalThis.fetch = (async () => (calls++, new Response("{}"))) as any;
  try {
    const j = new Judge({} as Config, fakeLlm('{"a": 0.7}'));
    assert.deepEqual(await j.ask("s", Q, signal, { llmFallback: true }), { probs: { a: 0.7 }, via: "llm" });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = real;
  }
});
