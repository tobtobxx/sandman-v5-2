// Topics (DESIGN §4, §6.4, §6.11).

import { db, nowIso, Row } from "../db.ts";
import { newId } from "../ids.ts";
import { emit } from "../events.ts";

export function slugify(title: string): string {
  const base = title.toLowerCase().replace(/['’]/g, "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "topic";
  let slug = base, i = 2;
  while (db().get(`SELECT id FROM topics WHERE slug=?`, slug)) slug = `${base}-${i++}`;
  return slug;
}

export function createTopic(title: string, summary = ""): Row {
  const id = newId("top");
  const row = { id, slug: slugify(title), title, summary, status: "active", created_at: nowIso(), last_activity_at: nowIso() };
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

export function listTopics(status = "active"): Row[] {
  return db().all(
    `SELECT t.*, (SELECT count(*) FROM questions q WHERE q.topic_id=t.id AND q.status='open') open_questions,
            (SELECT count(*) FROM cards c WHERE c.origin_topic_id=t.id AND c.kind='task' AND c.depth=0 AND c.state NOT IN ('done','failed','cancelled')) open_cards
     FROM topics t WHERE status=? ORDER BY is_system, last_activity_at DESC`,
    status,
  );
}
