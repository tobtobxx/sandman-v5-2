// Quick capture (DESIGN §6.3, §6.4, §6.7): segment → verify quotes → route each item → desk (capture mode)
// → one confirmation built from receipts, without a model call.

import { db, ftsQuery, j, now, nowIso, Row } from "../db.ts";
import { newId } from "../ids.ts";
import { config } from "../config.ts";
import { emit } from "../events.ts";
import { llmJson } from "../llm/gateway.ts";
import { fmtDate } from "./when.ts";
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
    const p = C.routeItem({ quote, candidates: cands.map((t) => ({ slug: t.slug, title: t.title, summary: t.summary ?? "", last_active: fmtDate(new Date(t.last_activity_at ?? t.created_at)) })), today: fmtDate(now()), allowChat });
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

const filedItem = (i: Row): FiledItem => ({ item_id: i.id, quote: i.quote, route: j<RouteResult>(i.route_info, {} as RouteResult) });

/** Step 1 of a send (docs/API.md POST /send): split and file. Fast: segmentation and routing only.
 *  Resumes after a failure: a stored segmentation and the items already routed are kept. */
export async function fileCapture(capture_id: string): Promise<FiledItem[]> {
  const cap = db().get(`SELECT * FROM captures WHERE id=?`, capture_id)!;
  const existing = db().all(`SELECT * FROM capture_items WHERE capture_id=? ORDER BY seq`, capture_id);
  if (cap.state === "filed" || cap.state === "handled") return existing.map(filedItem);
  let seg: { items: string[]; uncovered: string[] };
  const stored = cap.state === "segmented" ? db().get(`SELECT payload FROM events WHERE type='capture.segmented' AND ref_id=? ORDER BY id DESC LIMIT 1`, capture_id) : null;
  if (stored) seg = j(stored.payload, { items: [], uncovered: [] });
  else {
    const s = await segment(cap.transcript, capture_id);
    seg = s;
    db().update("captures", capture_id, { state: "segmented" });
    emit("capture.segmented", { ref_id: capture_id, payload: { items: s.items, matches: s.matches, uncovered: s.uncovered } });
  }
  const out: FiledItem[] = [];
  for (const [seq, quote] of seg.items.entries()) {
    const done = existing.find((i) => i.seq === seq);
    if (done) {
      out.push(filedItem(done));
      continue;
    }
    const item_id = newId("itm");
    const route = await routeItem(quote, { allowChat: true });
    const msg = postMessage({ topic_id: route.topic_id, role: "owner", kind: "capture_item", body: quote, capture_item_id: item_id, payload: { capture_id, provisional: route.confidence === "low" } });
    db().insert("capture_items", {
      id: item_id, capture_id, seq, quote, topic_id: route.topic_id, route_confidence: route.confidence, provisional: route.confidence === "low",
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

/** Step 2: the desk handles each filed item. Conversation topics get a conversation-mode turn (a reply).
 *  Resumes after a failure: an item whose desk turn finished, or already acted (left receipts), is not
 *  handled again; its outcome is read back. */
export async function handleCapture(capture_id: string, filed: FiledItem[]) {
  const cap = db().get(`SELECT * FROM captures WHERE id=?`, capture_id)!;
  const out: ItemOutcome[] = [];
  for (const it of filed) {
    const prior = priorDesk(it.item_id);
    if (prior) {
      out.push({ ...it, desk: prior });
      continue;
    }
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

/** The desk outcome of an item handled (or partly handled) by an earlier attempt, or null. */
function priorDesk(item_id: string): DeskResult | null {
  const item = db().get(`SELECT desk_turn_id FROM capture_items WHERE id=?`, item_id);
  const receipts = db().all(`SELECT * FROM receipts WHERE capture_item_id=? ORDER BY created_at, rowid`, item_id);
  const turn_id = item?.desk_turn_id ?? receipts[0]?.desk_turn_id;
  if (!turn_id) return null;
  if (!item?.desk_turn_id) db().update("capture_items", item_id, { desk_turn_id: turn_id });
  const t = db().get(`SELECT intents, reply_message_id FROM desk_turns WHERE id=?`, turn_id);
  const reply = t?.reply_message_id ? db().get(`SELECT body FROM messages WHERE id=?`, t.reply_message_id)?.body ?? null : null;
  return { turn_id, intents: j<string[]>(t?.intents, []), receipts, reply };
}

// ---------------------------------------------------------------- running and retrying (§13)
// A send is filed and handled by one run at a time. A run that fails (model down) leaves the capture
// short of `handled`; the retry loop picks it up again with backoff.
const running = new Map<string, { filed: Promise<FiledItem[]>; handled: Promise<boolean> }>();
const retries = new Map<string, { n: number; at: number }>();
const RETRY_MIN_MS = 30_000, RETRY_MAX_MS = 30 * 60_000;
/** Captures older than this are left alone (e.g. traces copied from the benchmark). */
const RETRY_MAX_AGE_MS = 24 * 3600e3;

/** File (unless filed) and handle (unless handled) a capture, or join the run in flight.
 *  `filed` rejects if filing fails; `handled` never rejects (false: failed, will be retried). */
export function runCapture(capture_id: string): { filed: Promise<FiledItem[]>; handled: Promise<boolean> } {
  const cur = running.get(capture_id);
  if (cur) return cur;
  const filed = fileCapture(capture_id);
  const handled = filed
    .then(async (items) => {
      if (db().get(`SELECT state FROM captures WHERE id=?`, capture_id)?.state !== "handled") await handleCapture(capture_id, items);
      retries.delete(capture_id);
      return true;
    })
    .catch((e) => {
      const n = (retries.get(capture_id)?.n ?? 0) + 1;
      const wait = Math.min(RETRY_MIN_MS * 2 ** (n - 1), RETRY_MAX_MS);
      retries.set(capture_id, { n, at: Date.now() + wait });
      console.warn(`capture ${capture_id} failed (attempt ${n}), retrying in ${Math.round(wait / 1000)}s:`, (e as Error).message);
      emit("capture.failed", { ref_id: capture_id, payload: { capture_id, attempt: n, error: (e as Error).message, retry_in_s: Math.round(wait / 1000) } });
      return false;
    })
    .finally(() => running.delete(capture_id));
  const run = { filed, handled };
  running.set(capture_id, run);
  return run;
}

/** Restart captures that are not handled yet and whose backoff has passed. */
export function retryCaptures() {
  const since = new Date(Date.now() - RETRY_MAX_AGE_MS).toISOString();
  for (const c of db().all(`SELECT id FROM captures WHERE state != 'handled' AND created_at > ? ORDER BY created_at`, since)) {
    if (running.has(c.id) || Date.now() < (retries.get(c.id)?.at ?? 0)) continue;
    runCapture(c.id);
  }
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

