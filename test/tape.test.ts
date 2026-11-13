import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTape, tapeFromEnv } from "../src/search/tape.ts";

const signal = new AbortController().signal;
const stats = { calls: 0, byProvider: {}, cacheHits: 0, costUsd: 0 };

function fakeRouter() {
  let network = 0;
  const r = {
    async search(job: { query: string }) { network++; return [{ url: `https://x.example/${job.query}`, title: job.query, text: "t", provider: "exa", query: job.query, fetchedAt: "2026-11-12" }]; },
    async pageText(urls: string[]) { network++; return new Map(urls.map((u) => [u, { text: `page ${u}`, title: u, status: "ok" }])); },
    async jinaText() { network++; return "jina"; },
    async releases() { network++; return []; },
    async refetch() { network++; return []; },
    totals: stats,
  };
  return { r: r as any, calls: () => network };
}

test("tape: record saves each call; replay answers the same calls with no network, keyed by arguments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tape-"));
  try {
    const live = fakeRouter();
    const rec = withTape(live.r, "record", dir);
    const a = await rec.router.search({ query: "neon pricing", objective: "o", ttlMs: 0 }, signal, stats);
    const pages = await rec.router.pageText(["https://a.example"], 24, signal, stats);
    assert.equal(rec.stats.recorded, 2);

    const off = fakeRouter();
    const rep = withTape(off.r, "replay", dir);
    assert.deepEqual(await rep.router.search({ query: "neon pricing", objective: "o", ttlMs: 0 }, new AbortController().signal, { ...stats }), a);
    const p2 = await rep.router.pageText(["https://a.example"], 24, signal, stats);
    assert.ok(p2 instanceof Map);
    assert.deepEqual([...p2.entries()], [...pages.entries()]);
    assert.equal(off.calls(), 0, "no network on replay");
    // A different call is a miss: an empty result, counted, still no network.
    assert.deepEqual(await rep.router.search({ query: "supabase pricing", objective: "o", ttlMs: 0 }, signal, stats), []);
    assert.deepEqual([rep.stats.hits, rep.stats.misses, off.calls()], [2, 1, 0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tape: off unless SEARCH_TAPE is record or replay", () => {
  const live = fakeRouter();
  const t = tapeFromEnv(live.r, {} as NodeJS.ProcessEnv);
  assert.equal(t.router, live.r);
  assert.equal(t.stats, null);
});
