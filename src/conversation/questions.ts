// Questions and the needs-you list (DESIGN §6.9).

import { db, j, nowIso, Row } from "../db.ts";
import { newId } from "../ids.ts";
import { emit } from "../events.ts";
import { postMessage } from "./messages.ts";
import { addComment, getCard, transition } from "../work/board.ts";
import { llmJson } from "../llm/gateway.ts";
import { matchAnswer } from "../prompts/conversation.ts";

/** What the owner needs to answer well: why it is asked (`why`, one entry each) and the work so far (`result`). */
export interface QuestionDetails {
  why?: string[];
  result?: string | null;
}

export function createQuestion(q: { card_id?: string | null; topic_id: string | null; text: string; options: string[]; reason: string; details?: QuestionDetails }): Row {
  const id = newId("qst");
  const topic_id = q.topic_id ?? systemTopicId();
  const msg = postMessage({ topic_id, role: "sandman", kind: "question", body: q.text, payload: { question_id: id, options: q.options, card_id: q.card_id } });
  const row = { id, card_id: q.card_id ?? null, topic_id, message_id: msg.id, text: q.text, options: q.options, reason: q.reason, status: "open", details: q.details ?? null, created_at: nowIso() };
  db().insert("questions", row);
  emit("question.created", { topic_id, ref_id: id, payload: row, kind: q.reason === "memory_conflict" ? "review" : "question" });
  return row;
}

/** A question's details. Escalations from before details were stored fall back to the card's last
 *  verifier or harness comment and its result. */
export function questionDetails(q: Row | undefined): QuestionDetails | null {
  if (!q) return null;
  const d = j<QuestionDetails | null>(q.details, null);
  if (d || q.reason !== "escalation" || !q.card_id) return d;
  const card = db().get(`SELECT result FROM cards WHERE id=?`, q.card_id);
  const c = db().get(`SELECT author, body FROM comments WHERE card_id=? AND author IN ('verifier','harness') AND created_at <= ? ORDER BY created_at DESC, rowid DESC LIMIT 1`, q.card_id, q.created_at);
  const why = !c ? [] : c.author === "verifier" ? String(c.body).split("\n").slice(1).filter(Boolean) : [String(c.body)];
  const result = j<Row | null>(card?.result, null)?.summary ?? null;
  return why.length || result ? { why, result } : null;
}

export function systemTopicId(): string {
  const t = db().get(`SELECT id FROM topics WHERE slug='sandman'`);
  if (t) return t.id;
  const id = newId("top");
  db().insert("topics", { id, slug: "sandman", title: "Sandman", is_system: 1, status: "active", summary: "System messages.", created_at: nowIso(), last_activity_at: nowIso() });
  return id;
}

/** Cards waiting on a question: the blocked card plus everything that depends on it, transitively. */
function waitingCount(card_id: string | null): number {
  if (!card_id) return 0;
  let n = 0;
  let cur: string | null = card_id;
  while (cur) {
    n++;
    cur = db().get(`SELECT parent_id FROM cards WHERE id=?`, cur)?.parent_id ?? null;
  }
  return n;
}

export function needsYou(topic_id?: string): Row[] {
  const rows = db().all(`SELECT * FROM questions WHERE status='open' ${topic_id ? "AND topic_id=?" : ""} ORDER BY created_at`, ...(topic_id ? [topic_id] : []));
  return rows
    .map((q) => ({ ...q, options: j(q.options, []), details: questionDetails(q), blocked_cards: waitingCount(q.card_id), topic_title: db().get(`SELECT title FROM topics WHERE id=?`, q.topic_id)?.title }))
    .sort((a, b) => b.blocked_cards - a.blocked_cards || a.created_at.localeCompare(b.created_at));
}

// ---------------------------------------------------------------- answer matching (code first)
const NUM_WORDS: Record<string, number> = {
  one: 1, first: 1, "1st": 1, two: 2, second: 2, "2nd": 2, three: 3, third: 3, "3rd": 3, four: 4, fourth: 4, "4th": 4,
};

/** Returns an option index, "skip", or null when code can't decide. */
export function codeMatch(text: string, options: string[]): number | "skip" | null {
  const t = text.trim().toLowerCase().replace(/[.!?,]+$/g, "");
  if (!t) return null;
  if (/^(skip|later|not now)$/.test(t)) return "skip";
  const bare = t.replace(/^(option|number|nr\.?|the)\s+/, "").replace(/\s+(one|option)$/, (m) => (m.includes("option") ? "" : m));
  const d = bare.match(/^(\d)$/);
  if (d && Number(d[1]) >= 1 && Number(d[1]) <= options.length) return Number(d[1]) - 1;
  const w = bare.match(/^(one|two|three|four|first|second|third|fourth|1st|2nd|3rd|4th)( one)?$/);
  if (w && NUM_WORDS[w[1]] <= options.length) return NUM_WORDS[w[1]] - 1;
  const exact = options.findIndex((o) => o.trim().toLowerCase().replace(/[.!?]+$/, "") === t);
  if (exact >= 0) return exact;
  const yn = options.map((o) => o.trim().toLowerCase());
  if (options.length === 2 && yn[0].startsWith("yes") && yn[1].startsWith("no")) {
    if (/^(yes|yeah|yep|sure|ok|okay|do it)$/.test(t)) return 0;
    if (/^(no|nope|don't|do not)$/.test(t)) return 1;
  }
  return null;
}

export interface AnswerOutcome {
  question: Row;
  option: string | null;
  text: string;
  via: string;
  skipped?: boolean;
  model_call?: boolean;
}

export async function answerQuestion(id: string, a: { option?: string | number; text?: string; via?: string }): Promise<AnswerOutcome> {
  const q = db().get(`SELECT * FROM questions WHERE id=?`, id);
  if (!q) throw new Error(`no question ${id}`);
  if (q.status !== "open") throw new Error(`question ${id} is ${q.status}`);
  const options: string[] = j(q.options, []);
  let option: string | null = null;
  let text = a.text ?? "";
  let model_call = false;
  if (a.option !== undefined && a.option !== null) {
    option = typeof a.option === "number" ? options[a.option] : a.option;
    text = option ?? text;
  } else if (options.length && text) {
    const m = codeMatch(text, options);
    if (m === "skip") return { question: q, option: null, text, via: a.via ?? "text", skipped: true };
    if (typeof m === "number") option = options[m];
    else {
      model_call = true;
      const choice = await matchAnswerCall(q.text, options, text);
      if (choice !== "free_text") option = choice;
    }
  }
  applyAnswer(q, option, text, a.via ?? (a.option !== undefined ? "button" : "text"));
  return { question: q, option, text, via: a.via ?? "text", model_call };
}

async function matchAnswerCall(question: string, options: string[], answer: string): Promise<string> {
  const p = matchAnswer({ question, options, answer });
  const r = await llmJson<{ analysis: string; choice: string }>("match_answer", p.prompt, p.schema, { maxTokens: p.maxTokens, version: p.version, priority: "interactive" });
  return r.choice;
}

export function applyAnswer(q: Row, option: string | null, text: string, via: string) {
  db().update("questions", q.id, { status: "answered", answer_option: option, answer_text: text, answered_via: via, answered_at: nowIso() });
  emit("question.answered", { topic_id: q.topic_id, ref_id: q.id, payload: { id: q.id, option, text } });
  if (!q.card_id) return;
  const card = getCard(q.card_id);
  const answer = option && text && option !== text ? `${option} (owner said: "${text}")` : option ?? text;
  addComment(card.id, "owner", `Question: ${q.text}\nOwner's answer: ${answer}`);
  if (card.state !== "blocked") return;
  if (q.reason === "escalation") {
    const o = (option ?? "").toLowerCase();
    if (o.startsWith("cancel")) return void transition(card.id, "cancelled", "escalation_cancel", "owner");
    return void transition(card.id, "ready", "answered", "owner", { attempt: 1, blocked_reason: null });
  }
  transition(card.id, q.reason === "missing_info" ? "new" : "ready", "answered", "owner", { blocked_reason: null });
}

/** Reopen an answered question (undo), if its card hasn't resumed yet. */
export function reopenQuestion(id: string): boolean {
  const q = db().get(`SELECT * FROM questions WHERE id=?`, id);
  if (!q || q.status !== "answered") return false;
  if (q.card_id) {
    const c = getCard(q.card_id);
    if (!["ready", "new"].includes(c.state)) return false;
    transition(c.id, "blocked", "answer_undone", "owner", { blocked_reason: q.reason });
    addComment(c.id, "owner", "Owner withdrew the previous answer.");
  }
  db().update("questions", id, { status: "open", answer_option: null, answer_text: null, answered_at: null });
  emit("question.reopened", { topic_id: q.topic_id, ref_id: id });
  return true;
}
