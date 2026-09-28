// Topic messages (DESIGN §6.2, §6.8). Every message is also an event.

import { db, j, nowIso, Row } from "../db.ts";
import { newId } from "../ids.ts";
import { emit } from "../events.ts";

export function postMessage(m: {
  topic_id: string;
  role: "owner" | "sandman";
  kind: string;
  body: string;
  payload?: any;
  client_id?: string;
  client_msg_id?: string;
  capture_item_id?: string;
  desk_turn_id?: string;
}): Row {
  const row = { id: newId("msg"), created_at: nowIso(), ...m, payload: m.payload ?? {} };
  db().insert("messages", row);
  db().run(`UPDATE topics SET last_activity_at=?, status='active' WHERE id=?`, row.created_at, m.topic_id);
  const notifyKind = m.kind === "text" && m.role === "sandman" ? "desk_reply" : m.kind;
  emit("message.created", { topic_id: m.topic_id, ref_id: row.id, payload: row, kind: notifyKind });
  return row;
}

export function topicMessages(topic_id: string, limit = 50): Row[] {
  return db()
    .all(`SELECT * FROM messages WHERE topic_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?`, topic_id, limit)
    .reverse()
    .map((m) => ({ ...m, payload: j(m.payload, {}) }));
}
