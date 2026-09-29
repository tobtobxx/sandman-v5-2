// Append-only event log (DESIGN §6.2) + notifier levels (§6.12, simplified).
// Clients sync by cursor (GET /events?after=) or SSE.

import { db, j, nowIso, Row } from "./db.ts";
import { config } from "./config.ts";

type Listener = (ev: Row) => void;
const listeners = new Set<Listener>();
export function subscribe(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// presence (POST /presence): the topic on screen, whose events are not pushed
export const presence = { topic_id: null as string | null };

export type Notify = "push" | "badge" | "silent";

function level(kind: string | undefined, topic_id?: string | null): Notify {
  let n = (kind && config.notifier.levels[kind]) as Notify || "silent";
  if (n === "push") {
    if (presence.topic_id && presence.topic_id === topic_id) n = "badge";
    if (n === "push" && kind !== "reminder") {
      const today = nowIso().slice(0, 10);
      const c = db().get(`SELECT count(*) n FROM events WHERE notify='push' AND at >= ? AND type != 'message.created:reminder'`, today)!.n;
      if (c >= config.notifier.max_push_per_day) n = "badge";
    }
  }
  return n;
}

export function emit(type: string, e: { topic_id?: string | null; ref_id?: string | null; payload?: any; kind?: string }) {
  const notify = level(e.kind, e.topic_id);
  const at = nowIso();
  const r = db().run(
    `INSERT INTO events (type, topic_id, ref_id, payload, notify, at) VALUES (?,?,?,?,?,?)`,
    type, e.topic_id ?? null, e.ref_id ?? null, JSON.stringify(e.payload ?? {}), notify, at,
  );
  const ev = { id: Number(r.lastInsertRowid), type, topic_id: e.topic_id ?? null, ref_id: e.ref_id ?? null, payload: e.payload ?? {}, notify, at };
  for (const l of listeners) {
    try {
      l(ev);
    } catch { /* ignore */ }
  }
  return ev;
}

export function eventsAfter(after: number, limit = 500) {
  return db().all(`SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?`, after, limit).map((e) => ({ ...e, payload: j(e.payload, {}) }));
}
