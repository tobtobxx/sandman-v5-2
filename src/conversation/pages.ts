// Topic pages (DESIGN §6.5) assembled in code, plus conversation-mode messages and topic summaries.

import { db, j, nowIso, Row } from "../db.ts";
import { config } from "../config.ts";
import { llmJson, llmText } from "../llm/gateway.ts";
import * as C from "../prompts/conversation.ts";
import { getTopic, updateTopic } from "./topics.ts";
import { needsYou } from "./questions.ts";
import { postMessage, topicMessages } from "./messages.ts";
import { deskTurn } from "./desk.ts";
import { addOwnerFact } from "../memory/facts.ts";

export function topicPage(topic_id: string) {
  const topic = getTopic(topic_id);
  const roots = db().all(`SELECT * FROM cards WHERE origin_topic_id=? AND depth=0 ORDER BY created_at DESC LIMIT 30`, topic_id);
  const work = roots.map((c) => ({
    ...c, result: j(c.result, null), done_when: j(c.done_when, []),
    children: db().all(`SELECT id, title, state, role, result FROM cards WHERE parent_id=? ORDER BY created_at`, c.id).map((x) => ({ ...x, result: j(x.result, null) })),
  }));
  const cardIds = db().all(`SELECT id FROM cards WHERE origin_topic_id=?`, topic_id).map((r) => r.id);
  const facts = db().all(
    `SELECT c.*, n.title note_title FROM claims c JOIN notes n ON n.id=c.note_id
     WHERE c.status IN ('active','disputed') AND (c.topic_id=? ${cardIds.length ? `OR json_extract(c.source,'$.card_id') IN (${cardIds.map(() => "?").join(",")})` : ""})
     ORDER BY c.observed_at DESC LIMIT 30`,
    topic_id, ...cardIds,
  ).map((c) => ({ ...c, source: j(c.source, {}) }));
  return {
    topic,
    summary: topic.summary,
    needs_you: needsYou(topic_id),
    work,
    facts,
    review: db().all(`SELECT * FROM review_items WHERE topic_id=? AND status='open'`, topic_id).map((r) => ({ ...r, payload: j(r.payload, {}) })),
    messages: topicMessages(topic_id, 80),
  };
}

/** Conversation mode (§6.5): the owner writes on a topic page. */
export async function ownerMessage(m: { topic_id: string; text: string; client_id?: string; client_msg_id?: string }) {
  if (m.client_msg_id) {
    const dup = db().get(`SELECT * FROM messages WHERE client_id IS ? AND client_msg_id=?`, m.client_id ?? null, m.client_msg_id);
    if (dup) return { message: dup, desk: null };
  }
  const msg = postMessage({ topic_id: m.topic_id, role: "owner", kind: "text", body: m.text, client_id: m.client_id, client_msg_id: m.client_msg_id });
  const desk = await deskTurn({ topic_id: m.topic_id, mode: "conversation", input: m.text, message_ids: [msg.id] });
  maybeSummarize(m.topic_id).catch((e) => console.error("summary:", e));
  return { message: msg, desk };
}

/** Rolling summary + owner-fact extraction, every few messages (§6.5, §7.4). */
export async function maybeSummarize(topic_id: string, every = 4) {
  const t = getTopic(topic_id);
  const count = db().get(`SELECT count(*) n FROM messages WHERE topic_id=?`, topic_id)!.n;
  if (count - (t.summary_msg_count ?? 0) < every) return;
  const msgs = db().all(`SELECT * FROM messages WHERE topic_id=? AND kind IN ('text','capture_item','card_result','reminder') ORDER BY created_at DESC, rowid DESC LIMIT 20`, topic_id).reverse();
  const lines = msgs.map((m) => `${m.role === "owner" ? config.owner.name : "Sandman"}: ${String(m.body).slice(0, 300)}`);
  const p = C.summarizeTopic({ title: t.title, old: t.summary ?? "", messages: lines });
  const summary = await llmText("summarize_topic", p.prompt, { maxTokens: p.maxTokens, version: p.version, topic_id, priority: "background" });
  updateTopic(topic_id, { summary, summary_msg_count: count });
  const since = t.summary_msg_count ?? 0;
  const owner = db().all(`SELECT * FROM messages WHERE topic_id=? AND role='owner' ORDER BY created_at`, topic_id).slice(Math.max(0, since - 4));
  if (owner.length) await extractFacts(topic_id, owner);
}

export async function extractFacts(topic_id: string, owner: Row[]) {
  const p = C.extractOwnerFacts({ owner: config.owner.name, messages: owner.map((m) => `- ${m.body}`) });
  const r = await llmJson<{ facts: Row[] }>("extract_owner_facts", p.prompt, p.schema, { maxTokens: p.maxTokens, version: p.version, topic_id, priority: "background" });
  for (const f of r.facts) addOwnerFact({ ...f, topic_id, message_id: owner.at(-1)?.id });
  return r.facts;
}

export { nowIso };
