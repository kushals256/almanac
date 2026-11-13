/**
 * Search record/replay, for evaluation: SEARCH_TAPE=record saves every search-layer call's result (keyed by its
 * arguments) under SEARCH_TAPE_DIR; SEARCH_TAPE=replay answers from those files with no network and no search cost,
 * so a comparison between two builds sees the same web. A replay miss returns an empty result and is counted (never
 * a silent network call). Unset → the real router, untouched.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SearchRouter } from "./router.ts";

type Mode = "record" | "replay";
const METHODS = ["search", "refetch", "pageText", "jinaText", "releases"] as const;

/** What a missed replay returns, per method (the same "nothing found" shapes the router itself returns). */
const EMPTY: Record<(typeof METHODS)[number], (args: unknown[]) => unknown> = {
  search: () => [],
  refetch: () => [],
  releases: () => [],
  jinaText: () => "",
  pageText: (args) => new Map((args[0] as string[]).map((u) => [u, { text: "", title: u, status: "error" }])),
};

export type TapeStats = { mode: Mode; hits: number; misses: number; recorded: number };

/** The call's identity: method + arguments, without the abort signal and the per-turn stats object. */
function keyOf(method: string, args: unknown[]): string {
  const plain = args.filter((a) => !(a instanceof AbortSignal) && !(a && typeof a === "object" && "calls" in a && "byProvider" in a));
  return createHash("sha1").update(`${method}:${JSON.stringify(plain)}`).digest("hex");
}

const encode = (v: unknown) => JSON.stringify(v instanceof Map ? { __map: [...v.entries()] } : v);
const decode = (s: string) => {
  const v = JSON.parse(s) as unknown;
  return v && typeof v === "object" && "__map" in v ? new Map((v as { __map: Array<[string, unknown]> }).__map) : v;
};

export function withTape(router: SearchRouter, mode: Mode, dir: string): { router: SearchRouter; stats: TapeStats } {
  const stats: TapeStats = { mode, hits: 0, misses: 0, recorded: 0 };
  mkdirSync(dir, { recursive: true });
  const proxy = new Proxy(router, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (typeof orig !== "function" || !(METHODS as readonly string[]).includes(prop as string)) return orig;
      const method = prop as (typeof METHODS)[number];
      return async (...args: unknown[]) => {
        const file = join(dir, `${keyOf(method, args)}.json`);
        if (mode === "replay") {
          if (existsSync(file)) {
            stats.hits++;
            return decode(readFileSync(file, "utf8"));
          }
          stats.misses++;
          return EMPTY[method](args);
        }
        const result = await (orig as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        writeFileSync(file, encode(result));
        stats.recorded++;
        return result;
      };
    },
  });
  return { router: proxy, stats };
}

/** SEARCH_TAPE=record|replay (SEARCH_TAPE_DIR, default data/tapes/default); anything else → the router as is. */
export function tapeFromEnv(router: SearchRouter, env: NodeJS.ProcessEnv = process.env): { router: SearchRouter; stats: TapeStats | null } {
  const mode = env.SEARCH_TAPE;
  if (mode !== "record" && mode !== "replay") return { router, stats: null };
  return withTape(router, mode, env.SEARCH_TAPE_DIR ?? "data/tapes/default");
}
