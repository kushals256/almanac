import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { localDate } from "../util/clock.ts";
import type { DateWindow } from "./temporal.ts";

/**
 * One SQLite file (node:sqlite, WAL). Facts (turns, claims) are append-only; derived index
 * columns may be filled in later (SPEC §4).
 */
const MIGRATIONS: string[] = [
  // v1
  `
  CREATE TABLE turns (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content TEXT NOT NULL,
    created_at_utc TEXT NOT NULL,
    tz TEXT NOT NULL,
    local_date TEXT NOT NULL,
    route TEXT,
    reply_to INTEGER REFERENCES turns(id),
    status TEXT NOT NULL DEFAULT 'complete',
    summary TEXT,
    topics_json TEXT
  );
  CREATE INDEX turns_local_date ON turns(local_date);
  CREATE INDEX turns_session ON turns(session_id, id);
  CREATE VIRTUAL TABLE turns_fts USING fts5(content, topics, tokenize = 'porter unicode61');

  CREATE TABLE sources (
    id INTEGER PRIMARY KEY,
    url TEXT NOT NULL,
    title TEXT,
    published_at TEXT,
    fetched_at_utc TEXT NOT NULL,
    content_hash TEXT,
    excerpt TEXT,
    provider TEXT,
    query TEXT
  );
  CREATE INDEX sources_url ON sources(url);

  CREATE TABLE turn_sources (
    turn_id INTEGER NOT NULL REFERENCES turns(id),
    source_id INTEGER NOT NULL REFERENCES sources(id),
    n INTEGER NOT NULL,
    PRIMARY KEY (turn_id, n)
  );

  CREATE TABLE entities (
    id INTEGER PRIMARY KEY,
    canonical_name TEXT NOT NULL UNIQUE,
    type TEXT,
    domain TEXT,
    aliases_json TEXT
  );
  CREATE TABLE entity_mentions (
    entity_id INTEGER NOT NULL REFERENCES entities(id),
    turn_id INTEGER NOT NULL REFERENCES turns(id),
    role TEXT,
    PRIMARY KEY (entity_id, turn_id)
  );
  CREATE TABLE collections (
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL,
    turn_id INTEGER NOT NULL REFERENCES turns(id),
    created_at_utc TEXT NOT NULL
  );
  CREATE TABLE collection_items (
    collection_id INTEGER NOT NULL REFERENCES collections(id),
    entity_id INTEGER NOT NULL REFERENCES entities(id),
    rank INTEGER,
    rationale TEXT,
    PRIMARY KEY (collection_id, entity_id)
  );

  CREATE TABLE claims (
    id INTEGER PRIMARY KEY,
    turn_id INTEGER NOT NULL REFERENCES turns(id),
    entity_id INTEGER REFERENCES entities(id),
    attribute TEXT,
    value_text TEXT,
    value_num REAL,
    unit TEXT,
    currency TEXT,
    claim_text TEXT NOT NULL,
    evidence_quote TEXT,
    as_of_date TEXT NOT NULL,
    asserted_at_utc TEXT NOT NULL,
    volatility TEXT,
    support TEXT NOT NULL DEFAULT 'pending' CHECK (support IN ('verified','unsupported','unchecked','pending')),
    support_score REAL,
    expires_at TEXT,
    superseded_by INTEGER REFERENCES claims(id)
  );
  CREATE INDEX claims_turn ON claims(turn_id);
  CREATE TABLE claim_sources (
    claim_id INTEGER NOT NULL REFERENCES claims(id),
    source_id INTEGER NOT NULL REFERENCES sources(id),
    PRIMARY KEY (claim_id, source_id)
  );
  CREATE TABLE verifications (
    id INTEGER PRIMARY KEY,
    claim_id INTEGER NOT NULL REFERENCES claims(id),
    checked_at_utc TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('unchanged','changed','unverifiable','source_gone')),
    new_value_text TEXT,
    source_id INTEGER REFERENCES sources(id),
    diff_note TEXT
  );

  CREATE TABLE search_cache (
    key TEXT PRIMARY KEY,
    created_at_utc TEXT NOT NULL,
    expires_at_utc TEXT NOT NULL,
    payload_json TEXT NOT NULL
  );
  `,
  // v2: shadow mode — where the planner's reading and the phrase rules disagree (real-traffic signal)
  `
  CREATE TABLE shadow_disagreements (
    id INTEGER PRIMARY KEY,
    turn_id INTEGER NOT NULL,
    signal TEXT NOT NULL,
    planner TEXT,
    rules TEXT,
    at_utc TEXT NOT NULL
  );
  `,
  // v3: meaning vectors for user turns (semantic recall)
  `
  CREATE TABLE turn_vectors (
    turn_id INTEGER PRIMARY KEY REFERENCES turns(id),
    vec BLOB NOT NULL
  );
  `,
  // v4: claims as data. Value claims (entity · attribute · value as we said it · source · quote) are written when
  // an answer is saved; rechecks read them and record each re-observation in verifications. Unused columns go.
  `
  ALTER TABLE claims ADD COLUMN kind TEXT NOT NULL DEFAULT 'sentence' CHECK (kind IN ('sentence','value'));
  ALTER TABLE claims ADD COLUMN source_url TEXT;
  ALTER TABLE claims DROP COLUMN expires_at;
  ALTER TABLE turns DROP COLUMN summary;
  CREATE INDEX claims_value ON claims(turn_id, kind);
  `,
  // v5: an owner per turn. Recall across history is scoped to the owner (one browser / one user); sessions already
  // belong to one owner. Existing history becomes the default local owner.
  `
  ALTER TABLE turns ADD COLUMN owner TEXT NOT NULL DEFAULT 'local';
  CREATE INDEX turns_owner_date ON turns(owner, local_date);
  `,
  // v6: the shadow-mode disagreement log belonged to the removed legacy router; nothing writes it any more.
  `
  DROP TABLE IF EXISTS shadow_disagreements;
  `,
  // v7: re-check verdicts gain "differs" (today's figure differs, but nothing shows a change after the earlier
  // answer) and "not_comparable" (shown per another currency, period or unit). SQLite can't alter a CHECK: rebuild.
  `
  CREATE TABLE verifications_v7 (
    id INTEGER PRIMARY KEY,
    claim_id INTEGER NOT NULL REFERENCES claims(id),
    checked_at_utc TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('unchanged','changed','differs','not_comparable','unverifiable','source_gone')),
    new_value_text TEXT,
    source_id INTEGER REFERENCES sources(id),
    diff_note TEXT
  );
  INSERT INTO verifications_v7 SELECT id, claim_id, checked_at_utc, status, new_value_text, source_id, diff_note FROM verifications;
  DROP TABLE verifications;
  ALTER TABLE verifications_v7 RENAME TO verifications;
  `,
  // v8: decisions on a shortlist. Each item is a candidate until the user says otherwise ("we went with X", "X is too
  // expensive"); the reason goes in the existing rationale column.
  `
  ALTER TABLE collection_items ADD COLUMN status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','chosen','ruled_out'));
  ALTER TABLE collection_items ADD COLUMN decided_at_utc TEXT;
  CREATE INDEX collections_turn ON collections(turn_id);
  `,
];

/** Owner of history when the caller names none (single-user local use, tests, evals). */
export const LOCAL_OWNER = "local";

export type TurnRow = {
  id: number;
  owner: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  created_at_utc: string;
  tz: string;
  local_date: string;
  route: string | null;
  reply_to: number | null;
  status: string;
};

export type SourceInput = { url: string; title?: string; publishedAt?: string; excerpt?: string; provider?: string; query?: string; fullText?: string };
export type SourceRow = { id: number; url: string; title: string | null; published_at: string | null; fetched_at_utc: string; content_hash: string | null; excerpt: string | null; provider: string | null };

export type ClaimRow = { id: number; claim_text: string; support: string; support_score: number | null; value_text: string | null };
export type RecallHit = { question: TurnRow; answer: TurnRow | null; sources: SourceRow[]; claims: ClaimRow[]; via: "date" | "text" | "date+text" };

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)");
    const row = this.db.prepare("SELECT v FROM schema_version").get() as { v: number } | undefined;
    let v = row?.v ?? 0;
    if (!row) this.db.prepare("INSERT INTO schema_version (v) VALUES (0)").run();
    for (; v < MIGRATIONS.length; v++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[v]!);
        this.db.prepare("UPDATE schema_version SET v = ?").run(v + 1);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
  }

  insertTurn(t: { sessionId: string; role: "user" | "assistant"; content: string; tz: string; at: Date; route?: string; replyTo?: number; status?: string; owner?: string }): number {
    const r = this.db
      .prepare(
        `INSERT INTO turns (session_id, role, content, created_at_utc, tz, local_date, route, reply_to, status, owner)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.sessionId, t.role, t.content, t.at.toISOString(), t.tz, localDate(t.at, t.tz), t.route ?? null, t.replyTo ?? null, t.status ?? "complete", t.owner ?? LOCAL_OWNER);
    const id = Number(r.lastInsertRowid);
    this.db.prepare("INSERT INTO turns_fts (rowid, content, topics) VALUES (?, ?, '')").run(id, t.content);
    return id;
  }

  setTurnStatus(id: number, status: "pending" | "complete"): void {
    this.db.prepare("UPDATE turns SET status = ? WHERE id = ?").run(status, id);
  }
  setTurnRoute(id: number, route: string): void {
    this.db.prepare("UPDATE turns SET route = ? WHERE id = ?").run(route, id);
  }

  /** Derived index column, safe to fill later. */
  setTopics(id: number, topics: string[]): void {
    this.db.prepare("UPDATE turns SET topics_json = ? WHERE id = ?").run(JSON.stringify(topics), id);
    this.db.prepare("UPDATE turns_fts SET topics = ? WHERE rowid = ?").run(topics.join(" "), id);
  }

  /** Persist sources and link them to an answer turn as [1..n]. Returns source ids in order. */
  linkSources(turnId: number, sources: SourceInput[], fetchedAt: Date): number[] {
    const ins = this.db.prepare(
      "INSERT INTO sources (url, title, published_at, fetched_at_utc, content_hash, excerpt, provider, query) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const link = this.db.prepare("INSERT OR REPLACE INTO turn_sources (turn_id, source_id, n) VALUES (?, ?, ?)");
    const ids: number[] = [];
    sources.forEach((s, i) => {
      const hash = s.fullText ? contentHash(s.fullText) : s.excerpt ? contentHash(s.excerpt) : null;
      const r = ins.run(s.url, s.title ?? null, s.publishedAt ?? null, fetchedAt.toISOString(), hash, (s.excerpt ?? "").slice(0, 4_000), s.provider ?? null, s.query ?? null);
      const id = Number(r.lastInsertRowid);
      link.run(turnId, id, i + 1);
      ids.push(id);
    });
    return ids;
  }

  turnSources(turnId: number): SourceRow[] {
    return this.db
      .prepare(
        `SELECT s.* FROM turn_sources ts JOIN sources s ON s.id = ts.source_id WHERE ts.turn_id = ? ORDER BY ts.n`,
      )
      .all(turnId) as SourceRow[];
  }

  answerFor(questionId: number): TurnRow | null {
    return (this.db.prepare("SELECT * FROM turns WHERE reply_to = ? AND role = 'assistant' ORDER BY id LIMIT 1").get(questionId) as TurnRow | undefined) ?? null;
  }

  recentTurns(sessionId: string, limit: number): TurnRow[] {
    const rows = this.db.prepare("SELECT * FROM turns WHERE session_id = ? AND status = 'complete' ORDER BY id DESC LIMIT ?").all(sessionId, limit) as TurnRow[];
    return rows.reverse();
  }

  /**
   * Deterministic recall (SPEC §4). User questions inside the date windows (all of them, so a
   * missed index never hides a turn), optionally narrowed/ranked by FTS; without windows, FTS only.
   * Excludes the current turn.
   */
  recall(opts: { windows: DateWindow[]; text: string; excludeTurnId?: number; limit?: number; sessionId?: string; owner?: string }): RecallHit[] {
    const limit = opts.limit ?? 6;
    const owner = opts.owner ?? LOCAL_OWNER;
    const fts = ftsQuery(opts.text);
    const byId = new Map<number, { row: TurnRow; via: RecallHit["via"]; score: number }>();
    const exclude = opts.excludeTurnId ?? -1;

    for (const w of opts.windows) {
      const rows = this.db
        .prepare("SELECT * FROM turns WHERE owner = ? AND role = 'user' AND local_date BETWEEN ? AND ? AND id != ? AND status = 'complete' ORDER BY id")
        .all(owner, w.start, w.end, exclude) as TurnRow[];
      for (const row of rows) byId.set(row.id, { row, via: "date", score: 0 });
    }
    if (fts) {
      const rows = this.db
        .prepare(
          `SELECT t.*, bm25(turns_fts) AS score FROM turns_fts JOIN turns t ON t.id = turns_fts.rowid
           WHERE turns_fts MATCH ? AND t.owner = ? AND t.role = 'user' AND t.id != ? AND t.status = 'complete' ORDER BY score LIMIT 20`,
        )
        .all(fts, owner, exclude) as Array<TurnRow & { score: number }>;
      for (const r of rows) {
        const hit = byId.get(r.id);
        if (hit) {
          hit.via = "date+text";
          hit.score = r.score;
        } else if (!opts.windows.length) byId.set(r.id, { row: r, via: "text", score: r.score });
      }
    }
    // Date+text first, then date-only (chronological), then text-only by BM25.
    const order = { "date+text": 0, date: 1, text: 2 } as const;
    // Same-session turns rank first within each tier: "what did I ask" most often means this chat.
    const same = (h: { row: TurnRow }) => (opts.sessionId && h.row.session_id === opts.sessionId ? 0 : 1);
    const hits = [...byId.values()].sort((a, b) => order[a.via] - order[b.via] || same(a) - same(b) || a.score - b.score || a.row.id - b.row.id).slice(0, limit);
    return hits.map((h) => {
      const answer = this.answerFor(h.row.id);
      return { question: h.row, answer, sources: answer ? this.turnSources(answer.id) : [], claims: answer ? this.claimsFor(answer.id) : [], via: h.via };
    });
  }

  /** Append verified/flagged claims for an answer turn (append-only ledger). */
  insertClaims(
    turnId: number,
    claims: Array<{ text: string; status: string; score: number | null; cites: number[]; missingNumbers: string[] }>,
    sourceIds: number[],
    asOf: string,
    at: Date,
    volatility: string,
  ): void {
    const ins = this.db.prepare(
      `INSERT INTO claims (turn_id, claim_text, value_text, as_of_date, asserted_at_utc, volatility, support, support_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const link = this.db.prepare("INSERT OR IGNORE INTO claim_sources (claim_id, source_id) VALUES (?, ?)");
    const support = (s: string) => (s === "verified" ? "verified" : s === "unsupported" ? "unsupported" : "unchecked");
    this.db.exec("BEGIN");
    try {
      for (const c of claims) {
        const r = ins.run(turnId, c.text.slice(0, 1_000), c.missingNumbers.length ? `unproven numbers: ${c.missingNumbers.join(", ")}` : null, asOf, at.toISOString(), volatility, support(c.status), c.score);
        const cid = Number(r.lastInsertRowid);
        for (const n of c.cites) if (sourceIds[n - 1]) link.run(cid, sourceIds[n - 1]!);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** The question turn's shortlist (one per turn): created on first use, items appended in order, never duplicated. */
  private addToCollection(questionId: number, label: string, entityIds: number[], at: Date): number {
    const existing = this.db.prepare("SELECT id FROM collections WHERE turn_id = ? ORDER BY id LIMIT 1").get(questionId) as { id: number } | undefined;
    const col = existing?.id ?? Number(this.db.prepare("INSERT INTO collections (label, turn_id, created_at_utc) VALUES (?, ?, ?)").run(label.slice(0, 200), questionId, at.toISOString()).lastInsertRowid);
    const next = ((this.db.prepare("SELECT MAX(rank) AS r FROM collection_items WHERE collection_id = ?").get(col) as { r: number | null }).r ?? 0) + 1;
    const item = this.db.prepare("INSERT OR IGNORE INTO collection_items (collection_id, entity_id, rank) VALUES (?, ?, ?)");
    entityIds.forEach((eid, k) => item.run(col, eid, next + k));
    return col;
  }

  /** Record the products an answer shortlisted (named in the answer itself), so later turns read a list, not old text. */
  recordShortlist(questionId: number, label: string, names: string[], at: Date): void {
    if (names.length < 2) return;
    this.db.exec("BEGIN");
    try {
      const ids = names.map((n) => this.upsertEntity(n));
      const mention = this.db.prepare("INSERT OR IGNORE INTO entity_mentions (entity_id, turn_id, role) VALUES (?, ?, 'subject')");
      for (const id of ids) mention.run(id, questionId);
      this.addToCollection(questionId, label, ids, at);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** The shortlist recorded for a question turn, in order. */
  collectionItems(questionId: number): string[] {
    return (this.db.prepare(
      `SELECT e.canonical_name AS name FROM collections c JOIN collection_items i ON i.collection_id = c.id JOIN entities e ON e.id = i.entity_id WHERE c.turn_id = ? ORDER BY c.id, i.rank`,
    ).all(questionId) as Array<{ name: string }>).map((r) => r.name);
  }

  /** This owner's recent shortlists (newest first) with each item's status and reason. */
  recentShortlists(owner: string, sinceDate: string, limit = 3): Array<{ id: number; label: string; date: string; items: Array<{ name: string; status: string; rationale: string | null; decidedAt: string | null }> }> {
    const cols = this.db
      .prepare(`SELECT c.id, c.label, t.local_date AS date FROM collections c JOIN turns t ON t.id = c.turn_id WHERE t.owner = ? AND t.local_date >= ? ORDER BY c.id DESC LIMIT ?`)
      .all(owner, sinceDate, limit) as Array<{ id: number; label: string; date: string }>;
    const items = this.db.prepare(`SELECT e.canonical_name AS name, i.status, i.rationale, i.decided_at_utc AS decidedAt FROM collection_items i JOIN entities e ON e.id = i.entity_id WHERE i.collection_id = ? ORDER BY i.rank`);
    return cols.map((c) => ({ ...c, items: items.all(c.id) as Array<{ name: string; status: string; rationale: string | null; decidedAt: string | null }> }));
  }

  /** The user decided about a shortlist item: chosen or ruled out, with their reason. Only existing items can be decided. */
  recordDecision(collectionId: number, name: string, status: "chosen" | "ruled_out", rationale: string | null, at: Date): boolean {
    const r = this.db
      .prepare(`UPDATE collection_items SET status = ?, rationale = ?, decided_at_utc = ? WHERE collection_id = ? AND entity_id = (SELECT id FROM entities WHERE lower(canonical_name) = lower(?))`)
      .run(status, rationale?.slice(0, 300) ?? null, at.toISOString(), collectionId, name);
    return Number(r.changes) > 0;
  }

  claimsFor(turnId: number): ClaimRow[] {
    return this.db.prepare("SELECT id, claim_text, support, support_score, value_text FROM claims WHERE turn_id = ? AND kind = 'sentence' AND superseded_by IS NULL ORDER BY id").all(turnId) as ClaimRow[];
  }

  /** The last user turn(s) in this session before the current one ("what did I just ask?"). */
  sessionHits(sessionId: string, beforeId: number, n = 1, owner = LOCAL_OWNER): RecallHit[] {
    // Skip small talk ("thanks!", "ok") so "what did I just ask?" finds the last real question.
    const SMALL_TALK = /^\s*(hi|hello|hey|yo|thanks|thank you|thx|ok(ay)?|cool|great|nice|bye|good (morning|evening|night))\b[^a-z]*$/i;
    const rows = (this.db
      .prepare("SELECT * FROM turns WHERE session_id = ? AND owner = ? AND role = 'user' AND id < ? AND status = 'complete' ORDER BY id DESC LIMIT 10")
      .all(sessionId, owner, beforeId) as TurnRow[])
      .filter((r) => !SMALL_TALK.test(r.content))
      .slice(0, n);
    return rows.map((row) => {
      const answer = this.answerFor(row.id);
      return { question: row, answer, sources: answer ? this.turnSources(answer.id) : [], claims: answer ? this.claimsFor(answer.id) : [], via: "date+text" as const };
    });
  }

  /** User turns without a meaning vector yet: question + the start of its answer. */
  turnsMissingVectors(limit: number): Array<{ id: number; text: string }> {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.content, (SELECT a.content FROM turns a WHERE a.reply_to = t.id AND a.role = 'assistant' ORDER BY a.id LIMIT 1) AS answer
         FROM turns t LEFT JOIN turn_vectors v ON v.turn_id = t.id WHERE t.role = 'user' AND v.turn_id IS NULL ORDER BY t.id DESC LIMIT ?`,
      )
      .all(limit) as Array<{ id: number; content: string; answer: string | null }>;
    return rows.map((r) => ({ id: r.id, text: `${r.content}\n${(r.answer ?? "").slice(0, 300)}` }));
  }

  putVector(turnId: number, vec: number[]): void {
    this.db.prepare("INSERT OR REPLACE INTO turn_vectors (turn_id, vec) VALUES (?, ?)").run(turnId, new Uint8Array(new Float32Array(vec).buffer));
  }

  /** Vectors of past user turns, optionally restricted to date windows. */
  userTurnVectors(windows: DateWindow[], excludeTurnId: number, owner = LOCAL_OWNER): Array<{ id: number; vec: Float32Array }> {
    const rows = this.db
      .prepare("SELECT t.id, t.local_date, v.vec FROM turn_vectors v JOIN turns t ON t.id = v.turn_id WHERE t.owner = ? AND t.id != ? AND t.status = 'complete' ORDER BY t.id DESC LIMIT 2000")
      .all(owner, excludeTurnId) as Array<{ id: number; local_date: string; vec: Uint8Array }>;
    return rows
      .filter((r) => !windows.length || windows.some((w) => r.local_date >= w.start && r.local_date <= w.end))
      .map((r) => ({ id: r.id, vec: new Float32Array(r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.vec.byteLength)) }));
  }

  hitForTurn(id: number): RecallHit | null {
    const row = this.db.prepare("SELECT * FROM turns WHERE id = ? AND role = 'user'").get(id) as TurnRow | undefined;
    if (!row) return null;
    const answer = this.answerFor(row.id);
    return { question: row, answer, sources: answer ? this.turnSources(answer.id) : [], claims: answer ? this.claimsFor(answer.id) : [], via: "text" };
  }

  /** The first real user question of this session ("what did I ask at the start?"). */
  sessionFirst(sessionId: string, beforeId: number, owner = LOCAL_OWNER): RecallHit[] {
    const SMALL_TALK = /^\s*(hi|hello|hey|yo|thanks|thank you|thx|ok(ay)?|cool|great|nice|bye|good (morning|evening|night))\b[^a-z]*$/i;
    const row = (this.db
      .prepare("SELECT * FROM turns WHERE session_id = ? AND owner = ? AND role = 'user' AND id < ? AND status = 'complete' ORDER BY id LIMIT 10")
      .all(sessionId, owner, beforeId) as TurnRow[]).find((r) => !SMALL_TALK.test(r.content));
    if (!row) return [];
    const answer = this.answerFor(row.id);
    return [{ question: row, answer, sources: answer ? this.turnSources(answer.id) : [], claims: answer ? this.claimsFor(answer.id) : [], via: "date+text" as const }];
  }

  /** Nearest local dates that have conversation, for the honest "no record" answer. */
  nearestDatesWithHistory(target: string, n = 3, owner = LOCAL_OWNER): string[] {
    const rows = this.db
      .prepare(
        `SELECT local_date, ABS(julianday(local_date) - julianday(?)) AS dist FROM turns WHERE owner = ? AND role = 'user' AND status = 'complete'
         GROUP BY local_date ORDER BY dist LIMIT ?`,
      )
      .all(target, owner, n) as Array<{ local_date: string }>;
    return rows.map((r) => r.local_date).sort();
  }

  cacheGet(key: string, at: Date): unknown | null {
    const r = this.db.prepare("SELECT payload_json, expires_at_utc FROM search_cache WHERE key = ?").get(key) as { payload_json: string; expires_at_utc: string } | undefined;
    if (!r || r.expires_at_utc <= at.toISOString()) return null;
    return JSON.parse(r.payload_json);
  }

  cachePut(key: string, payload: unknown, at: Date, ttlMs: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO search_cache (key, created_at_utc, expires_at_utc, payload_json) VALUES (?, ?, ?, ?)")
      .run(key, at.toISOString(), new Date(at.getTime() + ttlMs).toISOString(), JSON.stringify(payload));
  }

  /** Bounded growth: drop expired cache rows. */
  evictCache(at: Date): number {
    return Number(this.db.prepare("DELETE FROM search_cache WHERE expires_at_utc <= ?").run(at.toISOString()).changes);
  }

  // ---- Claims as data (v4) -------------------------------------------------------------------------------

  /** Find or create an entity by its canonical (case-insensitive) name. */
  upsertEntity(name: string): number {
    const n = name.trim().slice(0, 120);
    const got = this.db.prepare("SELECT id FROM entities WHERE lower(canonical_name) = lower(?)").get(n) as { id: number } | undefined;
    if (got) return got.id;
    return Number(this.db.prepare("INSERT INTO entities (canonical_name) VALUES (?)").run(n).lastInsertRowid);
  }

  /**
   * Record the value claims of an answer: one claims row each (kind 'value'), the entities they name (mentioned by
   * the question turn), a collection when the answer names several entities (a shortlist), and the entity names
   * as the question's recall topics. Returns the claim ids in order.
   */
  recordValueClaims(
    questionId: number,
    answerId: number,
    claims: Array<{ entity: string; attribute: string; answerSpan: string; quote?: string; sourceUrl?: string; num?: number; currency?: string; unit?: string }>,
    asOf: string,
    at: Date,
    label: string,
  ): number[] {
    // Idempotent: a background recording and a recheck can both try to record the same answer's claims. This check
    // and the inserts below run synchronously (no await between them), so they can't interleave.
    const existing = this.valueClaimsFor(answerId);
    if (existing.length) return existing.map((c) => c.id);
    const ins = this.db.prepare(
      `INSERT INTO claims (turn_id, entity_id, attribute, value_text, value_num, unit, currency, claim_text, evidence_quote, source_url, as_of_date, asserted_at_utc, kind, support)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'value', 'unchecked')`,
    );
    const mention = this.db.prepare("INSERT OR IGNORE INTO entity_mentions (entity_id, turn_id, role) VALUES (?, ?, 'subject')");
    const ids: number[] = [];
    const entityIds: number[] = [];
    this.db.exec("BEGIN");
    try {
      for (const c of claims) {
        const eid = this.upsertEntity(c.entity);
        if (!entityIds.includes(eid)) entityIds.push(eid);
        mention.run(eid, questionId);
        const r = ins.run(answerId, eid, c.attribute.slice(0, 120), c.answerSpan.slice(0, 300), c.num ?? null, c.unit ?? null, c.currency ?? null, `${c.entity} — ${c.attribute}: ${c.answerSpan}`.slice(0, 1_000), c.quote?.slice(0, 600) ?? null, c.sourceUrl ?? null, asOf, at.toISOString());
        ids.push(Number(r.lastInsertRowid));
      }
      if (entityIds.length >= 2) this.addToCollection(questionId, label, entityIds, at);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    const names = (this.db.prepare(`SELECT canonical_name FROM entities WHERE id IN (${entityIds.map(() => "?").join(",") || "NULL"})`).all(...entityIds) as Array<{ canonical_name: string }>).map((r) => r.canonical_name);
    if (names.length) this.setTopics(questionId, names); // recall can now find this turn by the entities it named
    return ids;
  }

  /** Value claims recorded for an answer turn (oldest first), with their entity names. */
  valueClaimsFor(answerId: number): Array<{ id: number; entity: string; attribute: string; answerSpan: string; quote: string | null; sourceUrl: string | null }> {
    return this.db
      .prepare(
        `SELECT c.id, e.canonical_name AS entity, c.attribute, c.value_text AS answerSpan, c.evidence_quote AS quote, c.source_url AS sourceUrl
         FROM claims c JOIN entities e ON e.id = c.entity_id WHERE c.turn_id = ? AND c.kind = 'value' ORDER BY c.id`,
      )
      .all(answerId) as Array<{ id: number; entity: string; attribute: string; answerSpan: string; quote: string | null; sourceUrl: string | null }>;
  }

  /** Entities a question turn mentioned (via its recorded claims), in first-mention order. */
  entitiesForTurn(questionId: number): string[] {
    return (this.db.prepare("SELECT e.canonical_name FROM entity_mentions m JOIN entities e ON e.id = m.entity_id WHERE m.turn_id = ? ORDER BY e.id").all(questionId) as Array<{ canonical_name: string }>).map((r) => r.canonical_name);
  }

  /**
   * Record one re-observation of a value claim. A change also writes the new value as a claim that supersedes the
   * old one (knowledge update), attributed to the recheck's answer turn.
   */
  recordVerification(claimId: number, v: { status: "unchanged" | "changed" | "differs" | "not_comparable" | "unverifiable" | "source_gone"; nowText?: string; note?: string; sourceUrl?: string; recheckAnswerId?: number }, at: Date): void {
    this.db.prepare("INSERT INTO verifications (claim_id, checked_at_utc, status, new_value_text, diff_note) VALUES (?, ?, ?, ?, ?)").run(claimId, at.toISOString(), v.status, v.nowText ?? null, v.note ?? null);
    // Changed or differs: either way today's observed value is the one to remember (knowledge update); the
    // verification row keeps which it was.
    if ((v.status === "changed" || v.status === "differs") && v.nowText && v.recheckAnswerId) {
      const old = this.db.prepare("SELECT entity_id, attribute FROM claims WHERE id = ?").get(claimId) as { entity_id: number; attribute: string } | undefined;
      if (!old) return;
      const r = this.db
        .prepare(`INSERT INTO claims (turn_id, entity_id, attribute, value_text, claim_text, source_url, as_of_date, asserted_at_utc, kind, support) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'value', 'verified')`)
        .run(v.recheckAnswerId, old.entity_id, old.attribute, v.nowText.slice(0, 300), `${old.attribute}: ${v.nowText}`.slice(0, 1_000), v.sourceUrl ?? null, at.toISOString().slice(0, 10), at.toISOString());
      this.db.prepare("UPDATE claims SET superseded_by = ? WHERE id = ?").run(Number(r.lastInsertRowid), claimId);
    }
  }

}

export function contentHash(text: string): string {
  return createHash("sha256").update(normaliseText(text)).digest("hex").slice(0, 32);
}

/** Normalised visible text for same-fetcher hash comparison. */
export function normaliseText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

// Generic words never decide recall ("right now" matched unrelated turns).
const STOP = new Set("the a an and or of to in on for with about what did i you we me my is it are was were has have had any since then that this from your our ask asked tell told still correct today last right now current currently best which more most get gets got years year month week day days time new latest really just like want need good will would could should much many also some one two first start beginning conversation chat question friend said says say true right".split(" "));

/** Build a safe FTS5 query: quoted terms OR'd, stopwords dropped. */
export function ftsQuery(text: string): string {
  const terms = [...new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9.+-]{2,}/g) ?? [])].filter((t) => !STOP.has(t)).slice(0, 12);
  return terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}
