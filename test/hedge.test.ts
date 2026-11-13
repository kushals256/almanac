import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmClient, type LlmRequest, type LlmResult } from "../src/llm/client.ts";

const req: LlmRequest = { job: "planner", messages: [{ role: "user", content: "x" }], maxTokens: 10, priority: "foreground" };
const result = (model: string): LlmResult => ({ text: "{}", model, provider: "groq", ms: 1, ttftMs: 1 });
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), rej(signal.reason)), { once: true });
  });

/** A client whose complete() is scripted per call: [model it "tries", delay, ok]. */
function scripted(plan: Array<{ model: string; ms: number; ok: boolean }>) {
  const c = new LlmClient({} as any);
  const calls: Array<{ avoid: string[]; aborted: boolean }> = [];
  (c as any).complete = async (r: LlmRequest) => {
    const step = plan[calls.length]!;
    const call = { avoid: r.avoidModels ?? [], aborted: false };
    calls.push(call);
    r.onAttempt?.(step.model);
    try {
      await sleep(step.ms, r.signal);
    } catch (e) {
      call.aborted = true;
      throw e;
    }
    if (!step.ok) throw new Error(`${step.model} failed`);
    return result(step.model);
  };
  return { c, calls };
}

test("hedge: a fast answer never starts a twin", async () => {
  const { c, calls } = scripted([{ model: "groq/a", ms: 10, ok: true }]);
  assert.equal((await c.completeHedged(req, 100, 1_000)).model, "groq/a");
  assert.equal(calls.length, 1);
});

test("hedge: a slow answer gets a twin on a DIFFERENT model; the first good answer wins and the other is cancelled", async () => {
  const { c, calls } = scripted([{ model: "groq/a", ms: 500, ok: true }, { model: "nvidia/b", ms: 20, ok: true }]);
  assert.equal((await c.completeHedged(req, 50, 2_000)).model, "nvidia/b");
  assert.deepEqual(calls[1]!.avoid, ["groq/a"]);
  await sleep(10);
  assert.equal(calls[0]!.aborted, true);
});

test("hedge: if the first request fails outright (whole chain), it fails at once instead of waiting for a twin", async () => {
  const { c, calls } = scripted([{ model: "groq/a", ms: 5, ok: false }]);
  const t0 = performance.now();
  await assert.rejects(c.completeHedged(req, 500, 2_000), /failed/);
  assert.ok(performance.now() - t0 < 200);
  assert.equal(calls.length, 1);
});

test("hedge: the twin failing doesn't sink a first request that then answers", async () => {
  const { c } = scripted([{ model: "groq/a", ms: 120, ok: true }, { model: "nvidia/b", ms: 5, ok: false }]);
  assert.equal((await c.completeHedged(req, 30, 2_000)).model, "groq/a");
});

test("hedge: the cap bounds the whole call", async () => {
  const { c } = scripted([{ model: "groq/a", ms: 5_000, ok: true }, { model: "nvidia/b", ms: 5_000, ok: true }]);
  const t0 = performance.now();
  await assert.rejects(c.completeHedged(req, 30, 150));
  assert.ok(performance.now() - t0 < 1_000);
});
