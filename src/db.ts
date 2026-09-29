// SQLite access (DESIGN §9). Uses node:sqlite, built into Deno.
// The active database and clock live in an AsyncLocalStorage context, so the benchmark can run
// many isolated cases concurrently, each against its own in-memory database.

import { DatabaseSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS topics (id TEXT PRIMARY KEY, slug TEXT UNIQUE, aliases TEXT DEFAULT '[]', title TEXT,
  kind TEXT DEFAULT 'subject', seen_at TEXT,
  status TEXT DEFAULT 'active', merged_into TEXT, is_system INTEGER DEFAULT 0, summary TEXT DEFAULT '',
  summary_msg_count INTEGER DEFAULT 0, last_activity_at TEXT, archived_at TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS captures (id TEXT PRIMARY KEY, client_id TEXT, client_msg_id TEXT, source TEXT,
  url TEXT, transcript TEXT, state TEXT, confirmation TEXT, created_at TEXT, UNIQUE(client_id, client_msg_id));
CREATE TABLE IF NOT EXISTS capture_items (id TEXT PRIMARY KEY, capture_id TEXT, seq INTEGER, quote TEXT,
  topic_id TEXT, route_confidence TEXT, provisional INTEGER DEFAULT 0, message_id TEXT, desk_turn_id TEXT,
  route_info TEXT);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, topic_id TEXT, role TEXT, kind TEXT, body TEXT,
  payload TEXT, client_id TEXT, client_msg_id TEXT, capture_item_id TEXT, desk_turn_id TEXT, created_at TEXT,
  UNIQUE(client_id, client_msg_id));
CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, desk_turn_id TEXT, message_id TEXT, topic_id TEXT,
  capture_item_id TEXT, kind TEXT, ref_id TEXT, text TEXT, undo TEXT, undone_at TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, topic_id TEXT, ref_id TEXT,
  payload TEXT, notify TEXT, at TEXT);
CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, card_id TEXT, topic_id TEXT, message_id TEXT, text TEXT,
  options TEXT DEFAULT '[]', reason TEXT, status TEXT DEFAULT 'open', answer_option TEXT, answer_text TEXT,
  answered_via TEXT, answered_at TEXT, details TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS review_items (id TEXT PRIMARY KEY, kind TEXT, topic_id TEXT, ref_ids TEXT, payload TEXT,
  status TEXT DEFAULT 'open', resolved_at TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS briefings (id TEXT PRIMARY KEY, script TEXT, position INTEGER DEFAULT 0, state TEXT,
  started_at TEXT, ended_at TEXT);
CREATE TABLE IF NOT EXISTS desk_turns (id TEXT PRIMARY KEY, topic_id TEXT, mode TEXT, input_ref TEXT, input_text TEXT,
  session_id TEXT, intents TEXT DEFAULT '[]', reply_message_id TEXT, created_at TEXT);

CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, kind TEXT, role TEXT, title TEXT, goal TEXT, original_goal TEXT,
  done_when TEXT DEFAULT '[]', constraints TEXT DEFAULT '[]', inputs TEXT DEFAULT '[]', depth INTEGER DEFAULT 0,
  parent_id TEXT, root_id TEXT, origin_topic_id TEXT, state TEXT, blocked_reason TEXT, phase TEXT DEFAULT 'execute',
  attempt INTEGER DEFAULT 1, priority TEXT DEFAULT 'normal', created_by TEXT, recipe_id TEXT, recipe_step TEXT,
  recipe_params TEXT, fanout_item TEXT, due_at TEXT, lease_owner TEXT, lease_expires_at TEXT, result TEXT,
  result_source TEXT, llm_calls_used INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS card_deps (card_id TEXT, depends_on TEXT, PRIMARY KEY(card_id, depends_on));
CREATE TABLE IF NOT EXISTS card_events (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT, from_state TEXT,
  to_state TEXT, event TEXT, actor TEXT, payload TEXT, at TEXT);
CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, card_id TEXT, author TEXT, body TEXT, seen INTEGER DEFAULT 0,
  created_at TEXT);
CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, card_id TEXT, name TEXT, path TEXT, mime TEXT,
  bytes INTEGER, content TEXT, summary TEXT, origin TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS recipes (id TEXT PRIMARY KEY, title TEXT, description TEXT, body TEXT, uses INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, type TEXT, card_id TEXT, topic_id TEXT, desk_turn_id TEXT,
  steps INTEGER DEFAULT 0, outcome TEXT, started_at TEXT, ended_at TEXT);
CREATE TABLE IF NOT EXISTS tool_calls (id TEXT PRIMARY KEY, session_id TEXT, llm_call_id TEXT, step INTEGER, tool TEXT,
  args TEXT, args_hash TEXT, deduplicated INTEGER DEFAULT 0, result_text TEXT, result_artifact_id TEXT,
  exit_code INTEGER, ok INTEGER, ms INTEGER, at TEXT);
CREATE TABLE IF NOT EXISTS llm_calls (id TEXT PRIMARY KEY, call_type TEXT, prompt_version TEXT, model_profile TEXT,
  model TEXT, provider TEXT, session_id TEXT, card_id TEXT, topic_id TEXT, step INTEGER, attempt INTEGER, input TEXT,
  schema TEXT, raw_output TEXT, parsed TEXT, ok INTEGER, error TEXT, repaired TEXT, tokens_in INTEGER,
  tokens_out INTEGER, cost REAL, ms INTEGER, at TEXT, eval_label TEXT, reasoning TEXT);

CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, kind TEXT, title TEXT, aliases TEXT DEFAULT '[]',
  one_liner TEXT DEFAULT '', body_rendered TEXT DEFAULT '', status TEXT DEFAULT 'active', created_at TEXT);
CREATE TABLE IF NOT EXISTS claims (id TEXT PRIMARY KEY, note_id TEXT, text TEXT, source TEXT, observed_at TEXT,
  volatility TEXT, status TEXT DEFAULT 'active', superseded_by TEXT, confidence TEXT DEFAULT 'medium',
  corroborations INTEGER DEFAULT 0, topic_id TEXT);
CREATE TABLE IF NOT EXISTS facts (id TEXT PRIMARY KEY, card_id TEXT, message_id TEXT, topic_id TEXT, subject TEXT,
  text TEXT, source TEXT, volatility TEXT, status TEXT DEFAULT 'pending', decision TEXT, decision_analysis TEXT,
  target_claim_id TEXT, decided_at TEXT, created_at TEXT);
-- memory search vectors (retriever.ts): id is a note, claim or pending fact; grp the note or pending subject it
-- counts for; model the embedding model and document prefix; text what was embedded; vec normalized float32
CREATE TABLE IF NOT EXISTS embeddings (id TEXT PRIMARY KEY, grp TEXT, model TEXT, text TEXT, vec BLOB);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(id UNINDEXED, title, aliases, one_liner, body);
CREATE VIRTUAL TABLE IF NOT EXISTS topics_fts USING fts5(id UNINDEXED, title, aliases, summary);
CREATE VIRTUAL TABLE IF NOT EXISTS recipes_fts USING fts5(id UNINDEXED, title, description);
`;

// Rows are loosely typed on purpose (prototype).
export type Row = any;

export class DB {
  raw: DatabaseSync;
  constructor(path = ":memory:") {
    if (path !== ":memory:") {
      const dir = path.split("/").slice(0, -1).join("/");
      if (dir) Deno.mkdirSync(dir, { recursive: true });
    }
    this.raw = new DatabaseSync(path);
    this.raw.exec(SCHEMA);
    // columns added after the first release: add them to existing databases
    for (const [table, col, def] of [["topics", "kind", "TEXT DEFAULT 'subject'"], ["topics", "seen_at", "TEXT"], ["questions", "details", "TEXT"], ["llm_calls", "reasoning", "TEXT"]]) {
      const cols = this.raw.prepare(`PRAGMA table_info(${table})`).all() as Row[];
      if (!cols.some((c) => c.name === col)) this.raw.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    }
    // topics_fts gained an aliases column (merged slugs, DESIGN §6.11): rebuild it from topics
    const ftsCols = this.raw.prepare(`PRAGMA table_info(topics_fts)`).all() as Row[];
    if (!ftsCols.some((c) => c.name === "aliases")) {
      this.raw.exec(`DROP TABLE topics_fts; CREATE VIRTUAL TABLE topics_fts USING fts5(id UNINDEXED, title, aliases, summary);
        INSERT INTO topics_fts (id, title, aliases, summary) SELECT id, title,
          (SELECT coalesce(group_concat(value, ' '), '') FROM json_each(coalesce(aliases, '[]'))), coalesce(summary, '') FROM topics;`);
    }
  }
  all(sql: string, ...params: any[]): Row[] {
    return this.raw.prepare(sql).all(...params.map(norm)) as Row[];
  }
  get(sql: string, ...params: any[]): Row | undefined {
    return this.raw.prepare(sql).get(...params.map(norm)) as Row | undefined;
  }
  run(sql: string, ...params: any[]) {
    return this.raw.prepare(sql).run(...params.map(norm));
  }
  /** Insert a row object. Objects/arrays are JSON-encoded. */
  insert(table: string, row: Row) {
    const keys = Object.keys(row);
    this.run(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`, ...keys.map((k) => row[k]));
  }
  update(table: string, id: string, patch: Row) {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.run(`UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`, ...keys.map((k) => patch[k]), id);
  }
  depth = 0;
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec("BEGIN");
    this.depth++;
    try {
      const r = fn();
      this.raw.exec("COMMIT");
      return r;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
    }
  }
}

function norm(v: any) {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Uint8Array) return v;
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  return v;
}

export function j<T = any>(v: any, fallback: T = null as T): T {
  if (v === null || v === undefined || v === "") return fallback;
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

// ---- context: db + clock ----
export interface Ctx {
  db: DB;
  now?: () => Date; // fixed clock for benchmarks
  tags?: Record<string, string>; // e.g. bench case id, attached to llm calls
}
const als = new AsyncLocalStorage<Ctx>();
let defaultCtx: Ctx | null = null;

export function setDefaultDb(db: DB) {
  defaultCtx = { db };
}
export function withCtx<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}
export function ctx(): Ctx {
  const c = als.getStore() ?? defaultCtx;
  if (!c) throw new Error("no database context");
  return c;
}
export const db = () => ctx().db;
export const now = () => (ctx().now ? ctx().now!() : new Date());
export const nowIso = () => now().toISOString();

/** Escape user text into an FTS5 OR query over its words. */
export function ftsQuery(text: string): string {
  return ftsWords(text).map((w) => `"${w}"`).join(" OR ");
}
/** The words ftsQuery searches for: lower case, 3+ letters, no stop words, at most 12. */
export function ftsWords(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w)))].slice(0, 12);
}
const STOP = new Set(
  "the and for with that this from what have has are was were you your can could would should will about into also then than them they their there which who whom when where how why not but all any some our out get got its just like make made more most much need needs only other over such very want wants find check".split(" "),
);
