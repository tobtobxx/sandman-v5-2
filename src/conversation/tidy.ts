// Topic tidy-up (DESIGN §6.11): merge suggestions (topic_same), automatic archive with undo.

import { db, ftsQuery, j, now, nowIso, Row } from "../db.ts";
import { llmJson } from "../llm/gateway.ts";
import { topicSame } from "../prompts/conversation.ts";
import { createReview, resolveReview } from "./review.ts";
import { getTopic, updateTopic } from "./topics.ts";
import { emit } from "../events.ts";

export async function tidy(opts: { archive_after_days?: number } = {}) {
  const topics = db().all(`SELECT * FROM topics WHERE status='active' AND is_system=0 AND merged_into IS NULL`);
  const suggested = new Set(db().all(`SELECT ref_ids FROM review_items WHERE kind='topic_merge'`).map((r) => j<string[]>(r.ref_ids, []).sort().join()));
  for (const a of topics) {
    const q = ftsQuery(`${a.title} ${a.summary ?? ""}`);
    if (!q) continue;
    for (const b of db().all(`SELECT t.* FROM topics_fts f JOIN topics t ON t.id=f.id WHERE topics_fts MATCH ? AND t.id != ? AND t.status='active' AND t.is_system=0 ORDER BY rank LIMIT 2`, q, a.id)) {
      const key = [a.id, b.id].sort().join();
      if (suggested.has(key)) continue;
      suggested.add(key);
      const p = topicSame({ a: `${a.title}. ${a.summary ?? ""}`, b: `${b.title}. ${b.summary ?? ""}` });
      const r = await llmJson<{ same: string }>("topic_same", p.prompt, p.schema, { maxTokens: p.maxTokens, version: p.version, priority: "background" });
      if (r.same === "yes") createReview({ kind: "topic_merge", topic_id: a.id, ref_ids: [a.id, b.id], payload: { a: a.title, b: b.title } });
    }
  }
  const days = opts.archive_after_days ?? 14;
  const cutoff = new Date(now().getTime() - days * 86400e3).toISOString();
  for (const t of topics) {
    if ((t.last_activity_at ?? t.created_at) > cutoff) continue;
    const open = db().get(`SELECT (SELECT count(*) FROM cards WHERE origin_topic_id=? AND state NOT IN ('done','failed','cancelled')) + (SELECT count(*) FROM questions WHERE topic_id=? AND status='open') n`, t.id, t.id)!.n;
    if (open) continue;
    updateTopic(t.id, { status: "archived", archived_at: nowIso() });
    createReview({ kind: "topic_archived", topic_id: t.id, ref_ids: [t.id], payload: { title: t.title } });
  }
}

/** Accept a merge: move everything from `drop` into `keep`; `drop` becomes an alias. */
export function mergeTopics(keep: string, drop: string) {
  const k = getTopic(keep), d = getTopic(drop);
  db().tx(() => {
    db().run(`UPDATE messages SET topic_id=? WHERE topic_id=?`, keep, drop);
    db().run(`UPDATE cards SET origin_topic_id=? WHERE origin_topic_id=?`, keep, drop);
    db().run(`UPDATE questions SET topic_id=? WHERE topic_id=?`, keep, drop);
    db().run(`UPDATE receipts SET topic_id=? WHERE topic_id=?`, keep, drop);
    db().run(`UPDATE capture_items SET topic_id=? WHERE topic_id=?`, keep, drop);
    db().run(`UPDATE claims SET topic_id=? WHERE topic_id=?`, keep, drop);
    const aliases = [...j<string[]>(k.aliases, []), d.slug, ...j<string[]>(d.aliases, [])];
    db().update("topics", keep, { aliases });
    db().update("topics", drop, { status: "archived", merged_into: keep, archived_at: nowIso() });
  });
  emit("topic.merged", { topic_id: keep, ref_id: drop, payload: { keep, drop } });
}

export function reviewAction(id: string, action: string, arg?: string): Row {
  const r = db().get(`SELECT * FROM review_items WHERE id=?`, id);
  if (!r) throw new Error("no review item");
  const refs: string[] = j(r.ref_ids, []);
  const payload = j<Row>(r.payload, {});
  switch (`${r.kind}:${action}`) {
    case "topic_merge:merge":
      mergeTopics(refs[0], refs[1]);
      break;
    case "topic_archived:undo":
      updateTopic(refs[0], { status: "active", archived_at: null, last_activity_at: nowIso() });
      break;
    case "filing_check:ok":
      db().run(`UPDATE capture_items SET provisional=0 WHERE id=?`, refs[0]);
      break;
    case "unfiled_text:file":
      return { refile: payload.text, ...(resolveReview(id, "accepted"), {}) };
  }
  const rejected = ["keep", "ignore", "no", "not_now"].includes(action);
  resolveReview(id, rejected ? "rejected" : "accepted");
  return { ok: true };
}
