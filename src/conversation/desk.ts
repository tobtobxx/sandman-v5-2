// Front desk (DESIGN §6.6): intent → arguments → (maybe) reply. Capture mode and conversation mode.

import { db, j, nowIso, Row } from "../db.ts";
import { newId } from "../ids.ts";
import { config } from "../config.ts";
import { llmJson, llmText } from "../llm/gateway.ts";
import * as C from "../prompts/conversation.ts";
import { P } from "../prompts/work.ts";
import { addComment, cancelCard, createCard, getCard } from "../work/board.ts";
import { answerQuestion } from "./questions.ts";
import { addReceipt } from "./receipts.ts";
import { postMessage } from "./messages.ts";
import { getTopic } from "./topics.ts";
import { routeItem } from "./capture.ts";
import { findNotes, profileText, renderNotes } from "../memory/retriever.ts";
import { fmtNow, fmtWhen, resolveReminderTime } from "./when.ts";
import { endSession, startSession } from "../trace.ts";
import { emit } from "../events.ts";

export interface DeskInput {
  topic_id: string;
  mode: "capture" | "conversation";
  input: string;
  transcript?: string;
  capture_item_id?: string;
  message_ids?: string[];
  url?: string | null;
}

export interface DeskResult {
  turn_id: string;
  intents: string[];
  receipts: Row[];
  reply: string | null;
}

function cardLine(c: Row): string {
  const parts = [c.title, c.state];
  const r = j<Row>(c.result, null);
  if (c.state === "done" && r?.summary) parts.push(String(r.summary).slice(0, 160));
  if (c.state === "blocked") {
    const q = db().get(`SELECT text FROM questions WHERE card_id=? AND status='open'`, c.id);
    if (q) parts.push(`waiting for answer: ${q.text}`);
  }
  return parts.join(" — ");
}

/** Topics where a desk turn is running right now (topic view "working" indicator). */
export const workingTopics = new Map<string, number>();

/** Where every topic stands, in code (conversation topics see all topics). */
export function overviewText(): string {
  const out: string[] = [];
  const topics = db().all(`SELECT * FROM topics WHERE status='active' AND is_system=0 AND kind='subject' ORDER BY last_activity_at DESC LIMIT 15`);
  out.push("Topics:");
  for (const t of topics) {
    const cards = db().all(`SELECT title, state FROM cards WHERE origin_topic_id=? AND depth=0 AND kind='task' AND state NOT IN ('done','failed','cancelled')`, t.id);
    const qn = db().get(`SELECT count(*) n FROM questions WHERE topic_id=? AND status='open'`, t.id)!.n;
    const sum = String(t.summary ?? "").split(/(?<=\.)\s/)[0].slice(0, 160);
    const open = [cards.length ? `working on: ${cards.map((c) => `${c.title} (${c.state})`).join(", ")}` : "", qn ? `${qn} open question${qn > 1 ? "s" : ""}` : ""].filter(Boolean).join("; ");
    out.push(`- ${t.title}${sum ? `: ${sum}` : ""}${open ? ` [${open}]` : ""}`);
  }
  if (!topics.length) out.push("- (no topics yet)");
  const done = db().all(
    `SELECT m.body, m.payload, t.title topic FROM messages m JOIN topics t ON t.id=m.topic_id WHERE m.kind='card_result' AND m.created_at > ? ORDER BY m.created_at DESC LIMIT 5`,
    new Date(Date.now() - 86400e3).toISOString(),
  );
  if (done.length) out.push("Finished in the last day:", ...done.map((m) => `- ${j<Row>(m.payload, {}).title} (${m.topic}): ${String(m.body).slice(0, 200)}`));
  const rem = db().all(`SELECT c.title, c.due_at, t.title topic FROM cards c LEFT JOIN topics t ON t.id=c.origin_topic_id WHERE c.kind='reminder' AND c.state='ready' ORDER BY c.due_at LIMIT 5`);
  if (rem.length) out.push("Reminders Sandman will send (the time is when Sandman reminds, not a deadline):", ...rem.map((r) => `- ${fmtWhen(new Date(r.due_at))}: ${r.title}`));
  return out.join("\n");
}

export function buildDeskCtx(d: DeskInput): C.DeskCtx {
  const t = getTopic(d.topic_id);
  if (t.kind === "conversation") return buildConversationCtx(d, t);
  const exclude = new Set(d.message_ids ?? []);
  const history = db()
    .all(`SELECT * FROM messages WHERE topic_id=? AND kind IN ('text','capture_item','card_result','reminder','question') ORDER BY created_at DESC, rowid DESC LIMIT ?`, d.topic_id, config.desk.history_messages + exclude.size)
    .filter((m) => !exclude.has(m.id) && m.capture_item_id !== d.capture_item_id)
    .slice(0, config.desk.history_messages)
    .reverse()
    .map((m) => `${m.role === "owner" ? config.owner.name : "Sandman"}: ${String(m.body).slice(0, 300)}`);
  const cards = db()
    .all(`SELECT * FROM cards WHERE origin_topic_id=? AND depth=0 AND kind='task' AND state != 'cancelled' AND (state NOT IN ('done','failed') OR updated_at > ?) ORDER BY created_at DESC LIMIT 8`, d.topic_id, new Date(Date.now() - 14 * 86400e3).toISOString())
    .map((c) => ({ id: c.id, line: cardLine(c) }));
  const questions = db()
    .all(`SELECT * FROM questions WHERE topic_id=? AND status='open' ORDER BY created_at`, d.topic_id)
    .map((q) => {
      const opts: string[] = j(q.options, []);
      return { id: q.id, line: `${q.text}${opts.length ? ` (options: ${opts.map((o, i) => `${i + 1}. ${o}`).join(", ")})` : ""}` };
    });
  return {
    owner: config.owner.name, mode: d.mode, topic_title: t.title, topic_summary: t.summary ?? "", profile: profileText(), history, cards, questions,
    memory: renderNotes(findNotes(d.input, [], 3)), input: d.input, transcript: d.transcript, receipts: [], now: fmtNow(),
  };
}

/** A conversation topic sees every topic: open cards and questions from all of them, plus an overview. */
function buildConversationCtx(d: DeskInput, t: Row): C.DeskCtx {
  const exclude = new Set(d.message_ids ?? []);
  const history = db()
    .all(`SELECT * FROM messages WHERE topic_id=? AND kind IN ('text','capture_item') ORDER BY created_at DESC, rowid DESC LIMIT ?`, d.topic_id, config.desk.history_messages + exclude.size)
    .filter((m) => !exclude.has(m.id) && m.capture_item_id !== d.capture_item_id)
    .slice(0, config.desk.history_messages).reverse()
    .map((m) => `${m.role === "owner" ? config.owner.name : "Sandman"}: ${String(m.body).slice(0, 300)}`);
  const cards = db()
    .all(`SELECT c.*, t.title topic FROM cards c JOIN topics t ON t.id=c.origin_topic_id WHERE c.depth=0 AND c.kind='task' AND c.state NOT IN ('cancelled','done','failed') ORDER BY c.created_at DESC LIMIT 12`)
    .map((c) => ({ id: c.id, line: `[${c.topic}] ${cardLine(c)}` }));
  const questions = db()
    .all(`SELECT q.*, t.title topic FROM questions q LEFT JOIN topics t ON t.id=q.topic_id WHERE q.status='open' ORDER BY q.created_at LIMIT 8`)
    .map((q) => {
      const opts: string[] = j(q.options, []);
      return { id: q.id, line: `[${q.topic ?? "Sandman"}] ${q.text}${opts.length ? ` (options: ${opts.map((o, i) => `${i + 1}. ${o}`).join(", ")})` : ""}` };
    });
  return {
    owner: config.owner.name, mode: d.mode, topic_title: t.title, topic_summary: `General talk with ${config.owner.name}, not about one subject.`,
    profile: profileText(), history, cards, questions, memory: renderNotes(findNotes(d.input, [], 3)), input: d.input, receipts: [],
    now: fmtNow(), overview: overviewText(),
  };
}

export async function deskTurn(d: DeskInput): Promise<DeskResult> {
  const turn_id = newId("dsk");
  db().insert("desk_turns", { id: turn_id, topic_id: d.topic_id, mode: d.mode, input_ref: d.capture_item_id ?? (d.message_ids ?? []).join(","), input_text: d.input, created_at: nowIso() });
  const session_id = startSession("desk", { topic_id: d.topic_id, desk_turn_id: turn_id });
  db().update("desk_turns", turn_id, { session_id });
  workingTopics.set(d.topic_id, (workingTopics.get(d.topic_id) ?? 0) + 1);
  emit("desk.working", { topic_id: d.topic_id, ref_id: turn_id });
  const ctx = buildDeskCtx(d);
  const ask = <T>(name: string, p: P, step: number) =>
    llmJson<T>(name, p.prompt, p.schema, { maxTokens: p.maxTokens, version: p.version, session_id, topic_id: d.topic_id, step, priority: "interactive" });
  const intents: string[] = [];
  const receipts: Row[] = [];
  let answered = false;
  let step = 0;
  let last = "";
  try {
    for (let i = 0; i < config.desk.max_actions; i++) {
      if (i > 0) {
        const more = await ask<{ left: string }>("desk_more", C.deskMore(ctx), ++step);
        if (more.left !== "yes") {
          intents.push("done");
          break;
        }
      }
      // an action already taken this turn is not offered again (P4: offer a tool only when it can apply)
      const allowed = ["new_work", "reminder"].filter((x) => !intents.includes(x));
      if (ctx.questions.length && !answered) allowed.push("answer_question");
      const open = ctx.cards.filter((c) => !/ — (done|failed) —?/.test(c.line + " —"));
      if (ctx.cards.length && !intents.includes("add_to_card")) allowed.push("add_to_card");
      if (open.length && !intents.includes("cancel_card")) allowed.push("cancel_card");
      // in a conversation topic Sandman always answers: "nothing" (stay silent) is not offered there
      if (i === 0) allowed.push(...(ctx.overview ? ["reply_only"] : ["reply_only", "nothing"]));
      else allowed.push("done");
      const r = await ask<{ intent: string }>("desk_intent", C.deskIntent({ ...ctx, intents: allowed }), ++step);
      last = r.intent;
      intents.push(r.intent);
      if (["reply_only", "nothing", "done"].includes(r.intent)) break;
      const rc = await execute(r.intent, ctx, d, turn_id, ask, () => ++step);
      if (!rc) break;
      if (r.intent === "answer_question") answered = true;
      receipts.push(rc.row);
      ctx.receipts.push(rc.toolResult);
    }
    let reply: string | null = null;
    const wantReply = d.mode === "conversation" ? !(last === "nothing" && !receipts.length) : last === "reply_only";
    if (wantReply) {
      const p = C.deskReply({ ...ctx, receipts: receipts.map((r) => r.text) });
      reply = await llmText("desk_reply", p.prompt, { maxTokens: p.maxTokens, version: p.version, session_id, topic_id: d.topic_id, step: ++step, priority: "interactive" });
      const msg = postMessage({ topic_id: d.topic_id, role: "sandman", kind: "text", body: reply, desk_turn_id: turn_id });
      db().update("desk_turns", turn_id, { reply_message_id: msg.id });
    }
    db().update("desk_turns", turn_id, { intents });
    endSession(session_id, intents.join(","), step);
    return { turn_id, intents, receipts, reply };
  } finally {
    const n = (workingTopics.get(d.topic_id) ?? 1) - 1;
    if (n > 0) workingTopics.set(d.topic_id, n);
    else workingTopics.delete(d.topic_id);
    emit("desk.idle", { topic_id: d.topic_id, ref_id: turn_id });
  }
}

/** Work belongs to a subject topic. From a conversation topic, route it there and leave a note. */
async function workTopic(d: DeskInput, label: string): Promise<Row> {
  const here = getTopic(d.topic_id);
  if (here.kind !== "conversation") return here;
  const r = await routeItem(d.input, { allowChat: false });
  const target = getTopic(r.topic_id);
  postMessage({ topic_id: target.id, role: "sandman", kind: "system", body: `From ${here.title}: “${d.input}” → ${label}` });
  return target;
}

async function execute(
  intent: string, ctx: C.DeskCtx, d: DeskInput, turn_id: string,
  ask: <T>(name: string, p: P, step: number) => Promise<T>, nextStep: () => number,
): Promise<{ row: Row; toolResult: string } | null> {
  const base = { desk_turn_id: turn_id, topic_id: d.topic_id, capture_item_id: d.capture_item_id ?? null };
  const more = "That part is handled; don't do it again. If nothing else is left, choose done.";
  switch (intent) {
    case "new_work": {
      const a = await ask<Row>("desk_args_new_work", C.deskArgsNewWork(ctx), nextStep());
      const target = await workTopic(d, a.title);
      const card = createCard({
        title: a.title, goal: a.goal, done_when: a.done_when.length ? a.done_when : ["The result answers the goal"], role: a.role, origin_topic_id: target.id, created_by: "frontdesk",
        inputs: d.url ? [`url:${d.url}`] : [],
      });
      const where = target.id !== d.topic_id ? ` in ${target.title}` : "";
      const row = addReceipt({ ...base, kind: "card_created", ref_id: card.id, text: `New card${where} · ${card.title}` });
      return { row, toolResult: `Created card "${card.title}"${where} for the ${card.role} part. ${more}` };
    }
    case "reminder": {
      const a = await ask<Row>("desk_args_reminder", C.deskArgsReminder(ctx), nextStep());
      const when = await resolveReminderTime(a.when_text, { topic_id: d.topic_id });
      const target = await workTopic(d, a.text);
      const card = createCard({ kind: "reminder", title: a.text, goal: a.text, origin_topic_id: target.id, created_by: "frontdesk", due_at: when.at.toISOString(), priority: "high" });
      const where = target.id !== d.topic_id ? ` in ${target.title}` : "";
      const row = addReceipt({ ...base, kind: "reminder_set", ref_id: card.id, text: `Reminder${where} · ${fmtWhen(when.at)} · ${a.text}`, undo: { when_text: a.when_text } });
      return { row, toolResult: `Reminder "${a.text}" set for ${fmtWhen(when.at)} (${config.owner.timezone})${where}. ${more}` };
    }
    case "answer_question": {
      const a = await ask<Row>("desk_args_answer", C.deskArgsAnswer(ctx), nextStep());
      const q = db().get(`SELECT * FROM questions WHERE id=?`, a.question_id);
      if (!q || q.status !== "open") return null;
      const out = await answerQuestion(q.id, { text: a.response, via: "desk" });
      ctx.questions = ctx.questions.filter((x) => x.id !== q.id);
      const row = addReceipt({ ...base, kind: "answered", ref_id: q.id, text: `Answered: ${q.text} → ${out.option ?? a.response}` });
      return { row, toolResult: `Answered the question "${q.text}" with "${out.option ?? a.response}". ${more}` };
    }
    case "add_to_card": {
      const a = await ask<Row>("desk_args_add", C.deskArgsAdd(ctx), nextStep());
      const card = getCard(a.card_id);
      if (card.state === "done" || card.state === "failed") {
        // §5.13: a finished card is reopened as a new root card with the old result as input
        const nc = createCard({
          title: card.title, goal: card.goal, done_when: card.done_when, role: card.role === "synthesize" ? "research" : card.role, origin_topic_id: d.topic_id,
          created_by: "frontdesk", inputs: [`card:${card.id}`], constraints: [...card.constraints, a.note],
        });
        const row = addReceipt({ ...base, kind: "card_created", ref_id: nc.id, text: `Reopened · ${card.title} (+ ${a.note})` });
        return { row, toolResult: `Reopened "${card.title}" as a new card with the addition. ${more}` };
      }
      const comment_id = addComment(card.id, "owner", a.note);
      const row = addReceipt({ ...base, kind: "added_to_card", ref_id: card.id, text: `Added to ${card.title}: ${a.note}`, undo: { comment_id, note: a.note } });
      return { row, toolResult: `Added "${a.note}" to card "${card.title}". ${more}` };
    }
    case "cancel_card": {
      const open = ctx.cards.filter((c) => !/ — (done|failed) —?/.test(c.line + " —"));
      const a = await ask<Row>("desk_args_cancel", C.deskArgsCancel({ ...ctx, cards: open }), nextStep());
      const card = getCard(a.card_id);
      cancelCard(card.id);
      ctx.cards = ctx.cards.filter((c) => c.id !== card.id);
      const row = addReceipt({ ...base, kind: "card_cancelled", ref_id: card.id, text: `Cancelled · ${card.title}` });
      return { row, toolResult: `Cancelled card "${card.title}". ${more}` };
    }
  }
  return null;
}
