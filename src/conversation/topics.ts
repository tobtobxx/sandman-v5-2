// Topics (DESIGN §4, §6.4, §6.11).

import { db, now, nowIso, Row } from "../db.ts";
import { config } from "../config.ts";
import { newId } from "../ids.ts";
import { emit } from "../events.ts";

export function slugify(title: string): string {
  const base = title.toLowerCase().replace(/['’]/g, "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "topic";
  let slug = base, i = 2;
  while (db().get(`SELECT id FROM topics WHERE slug=?`, slug)) slug = `${base}-${i++}`;
  return slug;
}

export function createTopic(title: string, summary = "", kind: "subject" | "conversation" = "subject"): Row {
  const id = newId("top");
  const row = { id, slug: slugify(title), title, summary, kind, status: "active", created_at: nowIso(), last_activity_at: nowIso() };
  db().insert("topics", row);
  indexTopic(id);
  emit("topic.created", { topic_id: id, ref_id: id, payload: row });
  return row;
}

export function indexTopic(id: string) {
  const t = db().get(`SELECT * FROM topics WHERE id=?`, id);
  db().run(`DELETE FROM topics_fts WHERE id=?`, id);
  if (t) db().run(`INSERT INTO topics_fts (id, title, summary) VALUES (?,?,?)`, id, t.title, t.summary ?? "");
}

export function getTopic(id: string): Row {
  const t = db().get(`SELECT * FROM topics WHERE id=?`, id);
  if (!t) throw new Error(`no topic ${id}`);
  return t;
}

export function updateTopic(id: string, patch: Row) {
  db().update("topics", id, patch);
  indexTopic(id);
  emit("topic.updated", { topic_id: id, ref_id: id, payload: patch });
}

/** Back to active with a fresh archive timer (tidy counts quiet days from last_activity_at). */
export function unarchiveTopic(id: string) {
  updateTopic(id, { status: "active", archived_at: null, last_activity_at: nowIso() });
}

/** Sidebar list, or with status "all" the overview of every topic (docs/API.md GET /topics). */
export function listTopics(status = "active"): Row[] {
  const hourAgo = new Date(now().getTime() - 3600e3).toISOString();
  return db().all(
    `SELECT t.id, t.title, t.kind, t.slug, t.status, t.summary, t.last_activity_at, t.archived_at, t.created_at, t.is_system,
            (SELECT count(*) FROM questions q WHERE q.topic_id=t.id AND q.status='open') open_questions,
            (SELECT count(*) FROM cards c WHERE c.origin_topic_id=t.id AND c.kind='task' AND c.depth=0 AND c.state NOT IN ('done','failed','cancelled')) open_cards,
            (t.seen_at IS NULL AND t.created_at > ?) is_new
     FROM topics t WHERE (?='all' OR status=?) AND merged_into IS NULL ORDER BY is_system, last_activity_at DESC`,
    hourAgo, status, status,
  ).map((t) => ({ ...t, is_new: !!t.is_new }));
}

/** A conversation topic for general talk: "Conversation 10:15". */
export function createConversationTopic(): Row {
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: config.owner.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now());
  return createTopic(`Conversation ${hm}`, "", "conversation");
}
