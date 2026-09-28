// Quick capture (DESIGN §6.3, §6.4, §6.7): segment → verify quotes → route each item → desk (capture mode)
// → one confirmation built from receipts, without a model call.

import { db, ftsQuery, j, nowIso, Row } from "../db.ts";
import { newId } from "../ids.ts";
import { config } from "../config.ts";
import { emit } from "../events.ts";
import { llmJson } from "../llm/gateway.ts";
import * as C from "../prompts/conversation.ts";
import { postMessage } from "./messages.ts";
import { createConversationTopic, createTopic, getTopic, updateTopic } from "./topics.ts";
import { createReview } from "./review.ts";
import { deskTurn, DeskResult } from "./desk.ts";

// ---------------------------------------------------------------- segmentation + quote verification
const toks = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[\p{L}\p{N}']+/gu) ?? [];

export interface QuoteMatch {
  quote: string;
  score: number;
  start: number; // token span in transcript
  end: number;
}

/** Best token-overlap match of a quote inside the transcript (≥ quote_match_min to count). */
export function matchQuote(quote: string, transcript: string): QuoteMatch {
  const q = toks(quote), t = toks(transcript);
  if (!q.length) return { quote, score: 0, start: 0, end: 0 };
  let best = { score: 0, start: 0, end: 0 };
  for (let len = Math.max(1, q.length - 2); len <= q.length + 2; len++) {
    for (let i = 0; i + len <= t.length; i++) {
      const win = t.slice(i, i + len);
      const bag = new Map<string, number>();
      for (const w of win) bag.set(w, (bag.get(w) ?? 0) + 1);
      let hit = 0;
      for (const w of q) if ((bag.get(w) ?? 0) > 0) hit++, bag.set(w, bag.get(w)! - 1);
      const score = hit / Math.max(q.length, len);
      if (score > best.score) best = { score, start: i, end: i + len };
    }
  }
  return { quote, ...best };
}

export function needsSegmentation(text: string): boolean {
  const words = toks(text).length;
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => toks(s).length > 0).length;
  return words > config.capture.segment_min_words || sentences > 1;
}

export async function segment(transcript: string, capture_id?: string): Promise<{ items: string[]; matches: QuoteMatch[]; uncovered: string[]; model: boolean }> {
  if (!needsSegmentation(transcript)) return { items: [transcript.trim()], matches: [], uncovered: [], model: false };
  const p = C.segmentCapture({ transcript });
  const r = await llmJson<{ items: { quote: string }[] }>("segment_capture", p.prompt, p.schema, { maxTokens: p.maxTokens, version: p.version, priority: "interactive" });
  const matches = r.items.map((i) => matchQuote(i.quote, transcript));
  const good = matches.filter((m) => m.score >= config.capture.quote_match_min);
  if (!good.length) return { items: [transcript.trim()], matches, uncovered: [], model: true };
  // coverage: runs of transcript tokens that no item covers
  const t = toks(transcript);
  const covered = new Array(t.length).fill(false);
  for (const m of good) for (let i = m.start; i < m.end; i++) covered[i] = true;
  const uncovered: string[] = [];
  let run: string[] = [];
  for (let i = 0; i <= t.length; i++) {
    if (i < t.length && !covered[i]) run.push(t[i]);
    else {
      if (run.length > config.capture.unfiled_min_words) uncovered.push(run.join(" "));
      run = [];
    }
  }
  good.sort((a, b) => a.start - b.start);
  return { items: good.map((m) => m.quote), matches, uncovered, model: true };
}

// ---------------------------------------------------------------- routing
export interface RouteResult {
  topic_id: string;
  confidence: "high" | "low";
  created: boolean;
  candidates: string[];
  choice: string;
  kind: "subject" | "conversation";
}

export function routeCandidates(quote: string): Row[] {
  const recent = db().all(`SELECT * FROM topics WHERE status='active' AND is_system=0 AND kind='subject' ORDER BY last_activity_at DESC LIMIT ?`, config.router.recent_candidates);
  const seen = new Set(recent.map((t) => t.id));
  const q = ftsQuery(quote);
  const fts = q
    ? db().all(`SELECT t.* FROM topics_fts f JOIN topics t ON t.id=f.id WHERE topics_fts MATCH ? AND t.is_system=0 AND t.kind='subject' AND t.merged_into IS NULL ORDER BY rank LIMIT ?`, q, config.router.fts_candidates + 3)
      .filter((t) => !seen.has(t.id)).slice(0, config.router.fts_candidates)
    : [];
  return [...recent, ...fts];
}

/** Route one item. `allowChat`: general talk may go to a new conversation topic (messages from home). */
export async function routeItem(quote: string, opts: { allowChat?: boolean } = {}): Promise<RouteResult> {
  const allowChat = opts.allowChat ?? true;
  const cands = routeCandidates(quote);
  let choice = "new", confidence: "high" | "low" = "high";
  if (cands.length || allowChat) {
    const p = C.routeItem({ quote, candidates: cands.map((t) => ({ slug: t.slug, title: t.title, summary: t.summary ?? "" })), allowChat });
    const r = await llmJson<{ choice: string; confidence: "high" | "low" }>("route_item", p.prompt, p.schema, { maxTokens: p.maxTokens, version: p.version, priority: "interactive" });
    choice = r.choice;
    confidence = r.confidence;
  }
  const slugs = cands.map((c) => c.slug);
  if (choice === "chat") {
    const t = createConversationTopic();
    return { topic_id: t.id, confidence, created: true, candidates: slugs, choice, kind: "conversation" };
  }
  if (choice === "new") {
    const p = C.topicTitle({ quote });
    const r = await llmJson<{ title: string }>("topic_title", p.prompt, p.schema, { maxTokens: p.maxTokens, version: p.version, priority: "interactive" });
    const t = createTopic(r.title.trim() || quote.slice(0, 40));
    return { topic_id: t.id, confidence, created: true, candidates: slugs, choice, kind: "subject" };
  }
  const t = cands.find((c) => c.slug === choice)!;
  if (t.status === "archived") updateTopic(t.id, { status: "active", archived_at: null });
  return { topic_id: t.id, confidence, created: false, candidates: slugs, choice, kind: "subject" };
}

// ---------------------------------------------------------------- capture
export function receiveCapture(c: { text: string; url?: string | null; source?: string; client_id?: string; client_msg_id?: string }): Row {
  if (c.client_msg_id) {
    const dup = db().get(`SELECT * FROM captures WHERE client_id IS ? AND client_msg_id=?`, c.client_id ?? null, c.client_msg_id);
    if (dup) return dup;
  }
  const row = { id: newId("cap"), client_id: c.client_id ?? null, client_msg_id: c.client_msg_id ?? null, source: c.source ?? "text", url: c.url ?? null, transcript: c.text, state: "transcribed", created_at: nowIso() };
  db().insert("captures", row);
  emit("capture.received", { ref_id: row.id, payload: row });
  return row;
}

export interface ItemOutcome {
  item_id: string;
  quote: string;
  route: RouteResult;
  desk: DeskResult;
}

export interface FiledItem {
  item_id: string;
  quote: string;
  route: RouteResult;
}

/** Step 1 of a send (docs/API.md POST /send): split and file. Fast: segmentation and routing only. */
export async function fileCapture(capture_id: string): Promise<FiledItem[]> {
  const cap = db().get(`SELECT * FROM captures WHERE id=?`, capture_id)!;
  const existing = db().all(`SELECT * FROM capture_items WHERE capture_id=? ORDER BY seq`, capture_id);
  if (existing.length) return existing.map((i) => ({ item_id: i.id, quote: i.quote, route: j<RouteResult>(i.route_info, {} as RouteResult) }));
  const seg = await segment(cap.transcript, capture_id);
  db().update("captures", capture_id, { state: "segmented" });
  emit("capture.segmented", { ref_id: capture_id, payload: { items: seg.items, matches: seg.matches, uncovered: seg.uncovered } });
  const out: FiledItem[] = [];
  let seq = 0;
  for (const quote of seg.items) {
    const item_id = newId("itm");
    const route = await routeItem(quote, { allowChat: true });
    const msg = postMessage({ topic_id: route.topic_id, role: "owner", kind: "capture_item", body: quote, capture_item_id: item_id, payload: { capture_id, provisional: route.confidence === "low" } });
    db().insert("capture_items", {
      id: item_id, capture_id, seq: seq++, quote, topic_id: route.topic_id, route_confidence: route.confidence, provisional: route.confidence === "low",
      message_id: msg.id, route_info: route,
    });
    emit("item.routed", { topic_id: route.topic_id, ref_id: item_id, payload: { item_id, quote, ...route } });
    if (route.confidence === "low" && route.kind === "subject") createReview({ kind: "filing_check", topic_id: route.topic_id, ref_ids: [item_id], payload: { quote, topic_title: getTopic(route.topic_id).title } });
    out.push({ item_id, quote, route });
  }
  for (const u of seg.uncovered) createReview({ kind: "unfiled_text", ref_ids: [capture_id], payload: { text: u } });
  db().update("captures", capture_id, { state: "filed" });
  emit("send.filed", { ref_id: capture_id, payload: { items: out.map((i) => ({ item_id: i.item_id, topic_id: i.route.topic_id })) } });
  return out;
}

/** Step 2: the desk handles each filed item. Conversation topics get a conversation-mode turn (a reply). */
export async function handleCapture(capture_id: string, filed: FiledItem[]) {
  const cap = db().get(`SELECT * FROM captures WHERE id=?`, capture_id)!;
  const out: ItemOutcome[] = [];
  for (const it of filed) {
    const conv = it.route.kind === "conversation";
    const desk = await deskTurn({ topic_id: it.route.topic_id, mode: conv ? "conversation" : "capture", input: it.quote, transcript: cap.transcript, capture_item_id: it.item_id, url: cap.url });
    db().update("capture_items", it.item_id, { desk_turn_id: desk.turn_id });
    out.push({ ...it, desk });
  }
  const confirmation = confirm(out);
  db().update("captures", capture_id, { state: "handled", confirmation });
  emit("capture.confirmed", { ref_id: capture_id, payload: { capture_id, ...confirmation }, kind: "receipt" });
  emit("send.handled", { ref_id: capture_id, payload: { capture_id } });
  return { items: out, confirmation };
}

/** Both steps, awaited (benchmark, tests). */
export async function processCapture(capture_id: string): Promise<{ items: ItemOutcome[]; confirmation: { text: string; speech: string } }> {
  return await handleCapture(capture_id, await fileCapture(capture_id));
}

const NUM = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight"];

/** Template confirmation from receipts (§6.7). Can only mention what happened. */
export function confirm(items: ItemOutcome[]): { text: string; speech: string } {
  const parts: string[] = [];
  const speech: string[] = [];
  for (const it of items) {
    const t = getTopic(it.route.topic_id);
    const bits: string[] = [];
    if (it.route.created) bits.push(`New topic: ${t.title}.`);
    for (const r of it.desk.receipts) bits.push(r.text.replace(/ · /g, ": ").replace(/$/, "."));
    if (!it.desk.receipts.length && !it.desk.reply) bits.push(`Noted under ${t.title}.`);
    if (it.desk.reply) bits.push(it.desk.reply);
    parts.push(bits.join(" "));
    speech.push(bits.map((b) => b.replace(/\s*\(.*?\)/g, "")).join(" "));
  }
  const head = items.length > 1 ? `Got it, ${NUM[items.length] ?? items.length} items.` : "Got it.";
  return { text: [head, ...parts].join(" "), speech: [head, ...speech].join(" ") };
}

// ---------------------------------------------------------------- move (§6.4)
export function moveItem(item_id: string, target: string): Row {
  const item = db().get(`SELECT * FROM capture_items WHERE id=?`, item_id);
  if (!item) throw new Error(`no item ${item_id}`);
  const topic = target === "new" ? createTopic(item.quote.split(/\s+/).slice(0, 4).join(" ")) : getTopic(target);
  db().tx(() => {
    db().run(`UPDATE messages SET topic_id=? WHERE capture_item_id=? OR desk_turn_id=?`, topic.id, item_id, item.desk_turn_id);
    db().run(`UPDATE receipts SET topic_id=? WHERE capture_item_id=?`, topic.id, item_id);
    for (const r of db().all(`SELECT ref_id, kind FROM receipts WHERE capture_item_id=?`, item_id)) {
      if (r.kind === "card_created" || r.kind === "reminder_set") {
        db().run(`UPDATE cards SET origin_topic_id=? WHERE root_id=?`, topic.id, r.ref_id);
        db().run(`UPDATE questions SET topic_id=? WHERE card_id IN (SELECT id FROM cards WHERE root_id=?)`, topic.id, r.ref_id);
      }
    }
    db().update("capture_items", item_id, { topic_id: topic.id, provisional: 0, route_confidence: "moved" });
    db().run(`UPDATE review_items SET status='accepted', resolved_at=? WHERE kind='filing_check' AND ref_ids LIKE ? AND status='open'`, nowIso(), `%${item_id}%`);
  });
  emit("item.moved", { topic_id: topic.id, ref_id: item_id, payload: { item_id, from: item.topic_id, to: topic.id, quote: item.quote } });
  return topic;
}

