/** Turns the frozen heldout.json into runner scenarios (planted history + one session per case). */
import { readFileSync } from "node:fs";
import type { Scenario } from "../realworld/dataset.ts";
import { PLANTS } from "./seeds.ts";
const data = JSON.parse(readFileSync(new URL("./heldout.json", import.meta.url), "utf8")) as { cases: Array<{ id: string; seed: string; kind: string; style: string; q: string; expect: any }> };
const T = (i: number) => new Date(Date.UTC(2026, 10, 12, 5, 0, 0) + i * 60_000).toISOString();
export const SCENARIOS: Scenario[] = [
  {
    name: "heldout",
    tz: "Asia/Kolkata",
    plants: PLANTS.map((p) => ({ ...p })),
    // ENGLISH_ONLY=1: casual + unusual rewordings only (the translated variants are skipped).
    turns: data.cases.filter((c) => !(process.env.ENGLISH_ONLY && c.style.startsWith("lang:"))).map((c, i) => ({ at: T(i), session: `ho-${c.id}`, msg: c.q, label: `${c.kind}|${c.style}`, expect: c.expect })),
  },
];
