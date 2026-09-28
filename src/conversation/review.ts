// Review pile (DESIGN §6.11): non-blocking suggestions with one-tap actions.

import { db, j, nowIso, Row } from "../db.ts";
import { newId } from "../ids.ts";
import { emit } from "../events.ts";

export function createReview(r: { kind: string; topic_id?: string | null; ref_ids?: string[]; payload?: Row }): Row {
  const row = { id: newId("rev"), kind: r.kind, topic_id: r.topic_id ?? null, ref_ids: r.ref_ids ?? [], payload: r.payload ?? {}, status: "open", created_at: nowIso() };
  db().insert("review_items", row);
  emit("review.created", { topic_id: row.topic_id, ref_id: row.id, payload: row, kind: "review" });
  return row;
}

export function listReview(status = "open"): Row[] {
  return db().all(`SELECT * FROM review_items WHERE status=? ORDER BY created_at DESC`, status).map((r) => ({ ...r, ref_ids: j(r.ref_ids, []), payload: j(r.payload, {}) }));
}

export function resolveReview(id: string, status: "accepted" | "rejected") {
  db().update("review_items", id, { status, resolved_at: nowIso() });
  emit("review.resolved", { ref_id: id, payload: { id, status } });
}
