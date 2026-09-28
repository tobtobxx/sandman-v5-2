// Conversation-mode messages and topic summaries. (Topic views are in views.ts.)

import { db, j, nowIso, Row } from "../db.ts";
import { config } from "../config.ts";
import { llmJson, llmText } from "../llm/gateway.ts";
import * as C from "../prompts/conversation.ts";
import { getTopic, updateTopic } from "./topics.ts";
import { postMessage } from "./messages.ts";
import { deskTurn } from "./desk.ts";
import { addOwnerFact } from "../memory/facts.ts";

/** Conversation mode (§6.5): the owner writes in a topic's chat. The message is stored at once;
 *  `done` resolves when the desk has handled it. */
export function ownerMessage(m: { topic_id: string; text: string; client_id?: string; client_msg_id?: string }): { message: Row; done: Promise<unknown> } {
  if (m.client_msg_id) {
    const dup = db().get(`SELECT * FROM messages WHERE client_id IS ? AND client_msg_id=?`, m.client_id ?? null, m.client_msg_id);
    if (dup) return { message: dup, done: Promise.resolve(null) };
  }
  const msg = postMessage({ topic_id: m.topic_id, role: "owner", kind: "text", body: m.text, client_id: m.client_id, client_msg_id: m.client_msg_id });
  const done = (async () => {
    const desk = await deskTurn({ topic_id: m.topic_id, mode: "conversation", input: m.text, message_ids: [msg.id] });
    if (getTopic(m.topic_id).kind !== "conversation") maybeSummarize(m.topic_id).catch((e) => console.error("summary:", e));
    return desk;
  })();
  return { message: msg, done };
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
