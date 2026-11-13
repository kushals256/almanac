import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmClient } from "../src/llm/client.ts";
import type { Config } from "../src/config.ts";

const cfg = { GROQ_API_KEY: "k".repeat(12), NVIDIA_API_KEY: "k".repeat(12) } as Config;

test("a stream that goes silent after its first token is aborted (stall timeout), not left hanging", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n'));
        // ...then silence: never closes. Abort must come from the idle timer.
        init?.signal?.addEventListener("abort", () => c.error(new Error("aborted")));
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const llm = new LlmClient(cfg);
    const got: string[] = [];
    const t0 = Date.now();
    await assert.rejects(async () => {
      for await (const ev of llm.stream({ job: "answer_quick", messages: [{ role: "user", content: "hi" }], maxTokens: 10, priority: "foreground", idleTimeoutMs: 200 })) {
        if (ev.type === "token") got.push(ev.text);
      }
    }, /stalled|interrupted/);
    assert.deepEqual(got, ["Hello"]);
    assert.ok(Date.now() - t0 < 5_000);
  } finally {
    globalThis.fetch = real;
  }
});
