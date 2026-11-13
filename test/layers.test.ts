/**
 * The architecture's direction, enforced: "models propose, code decides".
 *   - The modules that DECIDE (dates, needs, routing, the value comparator, citations/text, guards, signals, the
 *     answer's input) import no model client, search client or database at runtime: they are pure and unit-tested.
 *   - Lower layers never import the agent: search, memory, LLM, recheck and util know nothing about turns or stages.
 * Type-only imports are allowed (they vanish at runtime).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** Runtime (non-type) imports of a file, as paths relative to src/. */
function runtimeImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(/^import\s+(type\s+)?([^;]*?)\s+from\s+"([^"]+)";/gm)) {
    if (m[1]) continue; // import type { … }
    const specs = m[2]!.replace(/[{}]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
    if (specs.length && specs.every((s) => s.startsWith("type "))) continue; // import { type A, type B }
    if (!m[3]!.startsWith(".")) continue; // packages and node: builtins
    out.push(relative(SRC, join(file, "..", m[3]!)));
  }
  return out;
}

const PURE = ["recheck/values.ts", "memory/temporal.ts", "agent/history.ts", "agent/needs.ts", "agent/routing.ts", "agent/text.ts", "agent/signals.ts", "agent/guard.ts", "agent/answer-input.ts", "util/url.ts", "util/clock.ts"];
const IO = /^(llm\/|search\/|memory\/store\.ts|memory\/semantic\.ts|server\.ts|agent\/stages\/|agent\/pipeline\.ts)/;

test("layers: the deciding modules import no model, search or database client", () => {
  const bad = PURE.flatMap((f) => runtimeImports(join(SRC, f)).filter((i) => IO.test(i)).map((i) => `${f} → ${i}`));
  assert.deepEqual(bad, []);
});

test("layers: search, memory, LLM, recheck and util never import the agent", () => {
  const lower = files(SRC).filter((f) => /\/(search|memory|llm|recheck|util)\//.test(f));
  const bad = lower.flatMap((f) => runtimeImports(f).filter((i) => i.startsWith("agent/")).map((i) => `${relative(SRC, f)} → ${i}`));
  assert.deepEqual(bad, []);
});

test("layers: stages don't import each other except through Persist (the one shared after-answer step)", () => {
  const stages = files(join(SRC, "agent/stages"));
  const bad = stages.flatMap((f) => runtimeImports(f).filter((i) => i.startsWith("agent/stages/") && i !== "agent/stages/persist.ts").map((i) => `${relative(SRC, f)} → ${i}`));
  assert.deepEqual(bad, []);
});
