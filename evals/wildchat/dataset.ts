/** 120 real English first messages from WildChat-1M (allenai, ODC-BY). No gold answers: behaviour + judge only. */
import { readFileSync } from "node:fs";
import type { Scenario } from "../realworld/dataset.ts";
const data = JSON.parse(readFileSync(new URL("./wildchat-sample.json", import.meta.url), "utf8")) as { cases: Array<{ q: string }> };
const T = (i: number) => new Date(Date.UTC(2026, 10, 12, 4, 0, 0) + i * 60_000).toISOString();
export const SCENARIOS: Scenario[] = [
  {
    name: "wildchat",
    turns: data.cases.map((c, i) => ({
      at: T(i),
      session: `wc${i}`,
      msg: c.q,
      label: "wildchat",
      expect: { rubric: "A real user's message to a general assistant with web search. Pass if the reply is genuinely helpful for what was asked, searches/cites when it states current or specific facts, doesn't invent facts or claim actions, and asks a short clarifying question only if the request is truly ambiguous. Questions from 2023-24 users may reference then-current things; answering with current (2026) information is fine." },
    })),
  },
];
