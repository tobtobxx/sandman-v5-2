// View assembly for the chat-first client (docs/API.md): home, send result, topic chat.
// Everything here is code; opening a view costs no model calls.

import { db, j, now, nowIso, Row } from "../db.ts";
import { config } from "../config.ts";
import { getTopic } from "./topics.ts";
import { needsYou, questionDetails } from "./questions.ts";
import { workingTopics } from "./desk.ts";

const TZ = () => config.owner.timezone;
const dayKey = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ() }).format(new Date(iso));

function dayLabel(iso: string): string {
  const k = dayKey(iso);
  const today = dayKey(now().toISOString());
  const yesterday = dayKey(new Date(now().getTime() - 86400e3).toISOString());
  if (k === today) return "Today";
  if (k === yesterday) return "Yesterday";
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ(), weekday: "short", day: "numeric", month: "short" }).format(new Date(iso));
}

export function homeView() {
  const qs = needsYou();
  const finished = db().all(
    `SELECT m.payload, m.body, m.topic_id, t.title topic_title FROM messages m JOIN topics t ON t.id=m.topic_id
     WHERE m.kind='card_result' AND m.created_at > ? ORDER BY m.created_at DESC LIMIT 5`,
    new Date(now().getTime() - 86400e3).toISOString(),
  ).map((m) => {
    const p = j<Row>(m.payload, {});
    return { card_id: p.card_id, title: p.title, state: p.state, summary: m.body, topic_id: m.topic_id, topic_title: m.topic_title };
  });
  const nowText = new Intl.DateTimeFormat("en-GB", { timeZone: TZ(), weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(now()).replace(" at ", " · ");
  return {
    owner: config.owner.name,
    now: nowText,
    needs_you: qs.slice(0, 5).map((q) => ({ id: q.id, text: q.text, topic_id: q.topic_id, topic_title: q.topic_title })),
    needs_you_count: qs.length,
    finished,
    review_count: db().get(`SELECT count(*) n FROM review_items WHERE status='open'`)!.n,
  };
}

export function sendView(id: string) {
  const cap = db().get(`SELECT * FROM captures WHERE id=?`, id);
  if (!cap) throw new Error(`no send ${id}`);
  const items = db().all(`SELECT i.*, t.title topic_title, t.kind topic_kind FROM capture_items i JOIN topics t ON t.id=i.topic_id WHERE i.capture_id=? ORDER BY i.seq`, id).map((i) => {
    const route = j<Row>(i.route_info, {});
    const reply = i.desk_turn_id ? db().get(`SELECT m.body FROM desk_turns d JOIN messages m ON m.id=d.reply_message_id WHERE d.id=?`, i.desk_turn_id)?.body ?? null : null;
    return {
      item_id: i.id, quote: i.quote, topic_id: i.topic_id, topic_title: i.topic_title, topic_kind: i.topic_kind,
      created: !!route.created && i.route_confidence !== "moved", confidence: i.route_confidence,
      receipts: db().all(`SELECT id, kind, text, undone_at FROM receipts WHERE capture_item_id=? ORDER BY created_at, rowid`, i.id).map((r) => ({ id: r.id, kind: r.kind, text: r.text, undone: !!r.undone_at })),
      reply,
    };
  });
  const state = cap.state === "handled" ? "handled" : cap.state === "filed" ? "filed" : "pending";
  return { send_id: id, text: cap.transcript, state, items };
}

function cardProgress(card_id: string): Row | null {
  const c = db().get(`SELECT id, title, state, kind FROM cards WHERE id=?`, card_id);
  if (!c || c.kind !== "task") return null;
  const kids = db().all(`SELECT state FROM cards WHERE parent_id=?`, c.id);
  const done = kids.filter((k) => ["done", "failed", "cancelled"].includes(k.state)).length;
  const blocked = kids.some((k) => k.state === "blocked");
  let progress = kids.length ? `${done} of ${kids.length} parts done` : "";
  if (blocked || c.state === "blocked") progress = progress ? `${progress}, waiting for you` : "waiting for you";
  return { id: c.id, title: c.title, state: c.state, progress };
}

export function topicView(id: string) {
  const t = getTopic(id);
  const isNew = !t.seen_at && t.created_at > new Date(now().getTime() - 3600e3).toISOString();
  db().update("topics", id, { seen_at: nowIso() });
  const msgs = db().all(`SELECT * FROM messages WHERE topic_id=? ORDER BY created_at, rowid`, id).slice(-200);
  const timeline: Row[] = [];
  let lastDay = "";
  for (const m of msgs) {
    const day = dayKey(m.created_at);
    if (day !== lastDay) {
      timeline.push({ type: "day", label: dayLabel(m.created_at) });
      lastDay = day;
    }
    const p = j<Row>(m.payload, {});
    const at = m.created_at;
    if (m.role === "owner") {
      let siblings = 0;
      if (m.capture_item_id) {
        const cap = db().get(`SELECT capture_id FROM capture_items WHERE id=?`, m.capture_item_id);
        siblings = cap ? db().get(`SELECT count(*) n FROM capture_items WHERE capture_id=?`, cap.capture_id)!.n - 1 : 0;
      }
      timeline.push({ type: "owner", id: m.id, text: m.body, at, from_home: m.kind === "capture_item", item_id: m.capture_item_id ?? null, siblings });
    } else if (m.kind === "text") timeline.push({ type: "reply", id: m.id, text: m.body, at });
    else if (m.kind === "receipt") {
      const r = db().get(`SELECT * FROM receipts WHERE id=?`, p.receipt_id);
      timeline.push({ type: "receipt", id: p.receipt_id, text: m.body, at, undone: !!r?.undone_at, card: r?.kind === "card_created" ? cardProgress(r.ref_id) : null });
    } else if (m.kind === "question") {
      const q = db().get(`SELECT * FROM questions WHERE id=?`, p.question_id);
      timeline.push({ type: "question", id: p.question_id, card_id: q?.card_id ?? null, text: m.body, at, options: j(q?.options, []), details: questionDetails(q), status: q?.status ?? "expired", answer: q?.answer_option ?? q?.answer_text ?? null });
    } else if (m.kind === "card_result") {
      timeline.push({ type: "result", card_id: p.card_id, title: p.title, state: p.state, summary: p.summary ?? m.body, recommendation: p.recommendation ?? null, artifacts: (p.artifacts ?? []).map((a: Row) => ({ id: a.id, name: a.name })), at });
    } else if (m.kind === "reminder") timeline.push({ type: "reminder", text: m.body, at });
    else timeline.push({ type: "system", text: m.body, at });
  }
  const cards = db().all(
    `SELECT id, title, state FROM cards WHERE origin_topic_id=? AND depth=0 AND kind='task' AND state != 'cancelled' AND (state NOT IN ('done','failed') OR updated_at > ?) ORDER BY created_at DESC LIMIT 4`,
    id, new Date(now().getTime() - 3 * 86400e3).toISOString(),
  );
  const cardIds = db().all(`SELECT id FROM cards WHERE origin_topic_id=?`, id).map((r) => r.id);
  const facts = db().get(
    `SELECT count(*) n FROM claims WHERE status IN ('active','disputed') AND (topic_id=? ${cardIds.length ? `OR json_extract(source,'$.card_id') IN (${cardIds.map(() => "?").join(",")})` : ""})`,
    id, ...cardIds,
  )!.n;
  return {
    topic: { id: t.id, title: t.title, kind: t.kind ?? "subject", summary: t.summary ?? "", created_at: t.created_at, is_new: isNew },
    chips: { cards, open_questions: db().get(`SELECT count(*) n FROM questions WHERE topic_id=? AND status='open'`, id)!.n, facts },
    working: workingTopics.has(id),
    timeline,
  };
}
