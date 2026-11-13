/** Frozen held-out v2 → runner scenario. */
import { readFileSync } from "node:fs";
import type { Scenario } from "../realworld/dataset.ts";
import { PLANTS } from "./seeds.ts";
const data = JSON.parse(readFileSync(new URL("./heldout2.json", import.meta.url), "utf8")) as { cases: Array<{ id: string; kind: string; style: string; q: string; expect: any }> };
const T = (i: number) => new Date(Date.UTC(2026, 10, 12, 5, 0, 0) + i * 60_000).toISOString();
export const SCENARIOS: Scenario[] = [{ name: "heldout2", tz: "Asia/Kolkata", plants: PLANTS.map((p) => ({ ...p })), turns: data.cases.map((c, i) => ({ at: T(i), session: `h2-${c.id}`, msg: c.q, label: `${c.kind}|${c.style}`, expect: c.expect })) }];
