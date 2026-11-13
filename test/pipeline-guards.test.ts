import { test } from "node:test";
import assert from "node:assert/strict";

test("degenerate output: random multi-script tokens are caught; real bilingual answers are not", async () => {
  const { isDegenerate } = await import("../src/agent/guard.ts");
  const garbage = "uvi*.3末«NonTreatmentwig1strapOfferSwitch.Fulltaj/CreateLiteral3模 magát minima They飜7 Evil8QUI7r况74大正 lớn}監督acağı樓3ווי étudiveryХ5727%> 8）,MIC喂17리כإنجليزية75 2кро61VM42ואר161£ Voltaire기7Twenty每}`GL";
  assert.equal(isDegenerate(garbage), true);
  const ok = "« Où est la gare ? » means “Where is the train station?”. In Hindi: “रेलवे स्टेशन कहाँ है?” Both are polite in everyday use, and you can add “s'il vous plaît” in French to be extra courteous.";
  assert.equal(isDegenerate(ok), false);
});

test("scriptCount: short multi-script garbage vs a normal sentence", async () => {
  const { scriptCount } = await import("../src/agent/guard.ts");
  assert.ok(scriptCount("Quant'></线科өр名称但NC aquela internes those") >= 3);
  assert.equal(scriptCount("Apple announced the iPhone 18 on 9 Sep [1]."), 1);
});

test("failed generation: a short real answer without sources is kept; empty or garbage is not", async () => {
  const { unusable } = await import("../src/agent/stages/answer.ts");
  assert.equal(unusable("441", false), false);
  assert.equal(unusable("Où est la gare ?", false), false);
  assert.equal(unusable("  … ", false), true);
  assert.equal(unusable("Yes.", true), true); // a sourced answer must state something citable
  assert.equal(unusable("Neon Launch is $19 per month [1].", true), false);
});
