// Unified API (DESIGN Appendix B, subset) + both web UIs + background loops.
//   /          client UI (capture, needs-you, topics, review, board, memory)
//   /observer  observer UI (all internal state: cards, sessions, LLM calls, captures, raw tables)

import { db, j, nowIso, Row } from "./db.ts";
import { config } from "./config.ts";
import { eventsAfter, presence, subscribe } from "./events.ts";
import { spend } from "./llm/gateway.ts";
import { seedRecipes } from "./work/recipes.ts";
import { startDispatcher } from "./work/dispatcher.ts";
import { addComment, cancelCard, createCard, getCard, transition } from "./work/board.ts";
import { moveItem, processCapture, receiveCapture } from "./conversation/capture.ts";
import { undoReceipt } from "./conversation/receipts.ts";
import { createTopic, listTopics, updateTopic } from "./conversation/topics.ts";
import { ownerMessage, topicPage } from "./conversation/pages.ts";
import { answerQuestion, needsYou } from "./conversation/questions.ts";
import { replyBriefing, startBriefing } from "./conversation/briefing.ts";
import { listReview } from "./conversation/review.ts";
import { reviewAction, tidy } from "./conversation/tidy.ts";
import { consolidate, rerender } from "./memory/consolidator.ts";
import { noteView } from "./memory/retriever.ts";
import { recordedFacts } from "./work/worker.ts";

type H = (req: Request, p: Record<string, string>, body: Row, url: URL) => Promise<unknown> | unknown;
const routes: { method: string; re: RegExp; keys: string[]; h: H }[] = [];
function route(method: string, path: string, h: H) {
  const keys: string[] = [];
  const re = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
  routes.push({ method, re, keys, h });
}
const bg = (p: Promise<unknown>) => p.catch((e) => console.error("background:", e));

// ---------------------------------------------------------------- events
route("GET", "/events", (_r, _p, _b, u) => eventsAfter(Number(u.searchParams.get("after") ?? 0)));

// ---------------------------------------------------------------- capture
route("POST", "/captures", (_r, _p, b) => {
  const cap = receiveCapture({ text: b.text ?? "", url: b.url, source: b.source ?? "text", client_id: b.client_id, client_msg_id: b.client_msg_id });
  if (cap.state === "transcribed") bg(processCapture(cap.id));
  return cap;
});
route("GET", "/captures", () => db().all(`SELECT * FROM captures ORDER BY created_at DESC LIMIT 50`).map((c) => ({ ...c, confirmation: j(c.confirmation, null) })));
route("GET", "/captures/:id", (_r, p) => captureDetail(p.id));
route("POST", "/items/:id/move", (_r, p, b) => moveItem(p.id, b.topic_id ?? "new"));
route("POST", "/receipts/:id/undo", (_r, p) => undoReceipt(p.id));

// ---------------------------------------------------------------- topics & messages
route("GET", "/topics", (_r, _p, _b, u) => listTopics(u.searchParams.get("status") ?? "active"));
route("POST", "/topics", (_r, _p, b) => createTopic(b.title));
route("PATCH", "/topics/:id", (_r, p, b) => (updateTopic(p.id, pick(b, ["title", "status", "summary"])), { ok: true }));
route("GET", "/topics/:id/page", (_r, p) => topicPage(p.id));
route("POST", "/messages", (_r, _p, b) => {
  bg(ownerMessage({ topic_id: b.topic_id, text: b.text, client_id: b.client_id, client_msg_id: b.client_msg_id }));
  return { ok: true };
});
route("PATCH", "/topics/:id/facts/:claim", (_r, p, b) => {
  const c = db().get(`SELECT * FROM claims WHERE id=?`, p.claim);
  db().update("claims", p.claim, { text: b.text, source: { type: "owner", ref: "edit", previous: c?.text }, observed_at: nowIso(), status: "active" });
  if (c) rerender(c.note_id);
  return { ok: true };
});
route("DELETE", "/topics/:id/facts/:claim", (_r, p) => {
  const c = db().get(`SELECT * FROM claims WHERE id=?`, p.claim);
  db().update("claims", p.claim, { status: "retracted" });
  if (c) rerender(c.note_id);
  return { ok: true };
});

// ---------------------------------------------------------------- attention
route("GET", "/needs-you", () => needsYou());
route("POST", "/questions/:id/answer", async (_r, p, b) => await answerQuestion(p.id, { option: b.option, text: b.text, via: b.option !== undefined ? "button" : "text" }));
route("POST", "/briefings", () => startBriefing());
route("POST", "/briefings/:id/reply", async (_r, p, b) => await replyBriefing(p.id, b.text ?? ""));
route("GET", "/review", () => listReview());
route("POST", "/review/:id/:action", async (_r, p, b) => {
  const r = reviewAction(p.id, p.action, b.arg);
  if (r.refile) bg(processCapture(receiveCapture({ text: r.refile, source: "text" }).id));
  if (p.action === "move" && b.topic_id) {
    const item = db().get(`SELECT ref_ids FROM review_items WHERE id=?`, p.id);
    moveItem(j<string[]>(item?.ref_ids, [])[0], b.topic_id);
  }
  return r;
});
route("POST", "/presence", (_r, _p, b) => (Object.assign(presence, { mode: b.mode ?? "active", topic_id: b.topic_id ?? null }), presence));
route("POST", "/tidy", async () => (await tidy(), { ok: true }));

// ---------------------------------------------------------------- board
route("GET", "/cards", (_r, _p, _b, u) => {
  const t = u.searchParams.get("topic_id"), s = u.searchParams.get("state");
  return db().all(`SELECT * FROM cards WHERE 1=1 ${t ? "AND origin_topic_id=?" : ""} ${s ? "AND state=?" : ""} ORDER BY created_at DESC LIMIT 200`, ...[t, s].filter(Boolean))
    .map((c) => ({ ...c, result: j(c.result, null), done_when: j(c.done_when, []) }));
});
route("GET", "/cards/:id", (_r, p) => cardDetail(p.id));
route("POST", "/cards", (_r, _p, b) => createCard({ title: b.title, goal: b.goal, done_when: b.done_when ?? [], role: b.role ?? "research", origin_topic_id: b.topic_id, created_by: "owner" }));
route("POST", "/cards/:id/comment", (_r, p, b) => ({ id: addComment(p.id, "owner", b.text) }));
route("POST", "/cards/:id/cancel", (_r, p) => (cancelCard(p.id), { ok: true }));
route("POST", "/cards/:id/retry", (_r, p) => {
  const c = getCard(p.id);
  if (["failed", "blocked"].includes(c.state)) transition(c.id, c.state === "failed" ? "ready" : "ready", "owner_retry", "owner", { attempt: 1 });
  return { ok: true };
});
route("GET", "/artifacts/:id", (_r, p) => db().get(`SELECT * FROM artifacts WHERE id=?`, p.id));

// ---------------------------------------------------------------- memory
route("GET", "/memory/notes", (_r, _p, _b, u) => {
  const q = u.searchParams.get("query");
  const rows = q
    ? db().all(`SELECT n.* FROM notes_fts f JOIN notes n ON n.id=f.id WHERE notes_fts MATCH ? LIMIT 50`, q.split(/\s+/).map((w) => `"${w.replace(/"/g, "")}"`).join(" OR "))
    : db().all(`SELECT * FROM notes ORDER BY created_at DESC LIMIT 100`);
  return rows.map((n) => ({ ...noteView(n), status: n.status, aliases: j(n.aliases, []) }));
});
route("GET", "/memory/notes/:id", (_r, p) => {
  const n = db().get(`SELECT * FROM notes WHERE id=?`, p.id);
  return { ...n, claims: db().all(`SELECT * FROM claims WHERE note_id=? ORDER BY observed_at DESC`, p.id).map((c) => ({ ...c, source: j(c.source, {}) })) };
});
route("POST", "/memory/retract", (_r, _p, b) => {
  if (b.claim_id) db().update("claims", b.claim_id, { status: "retracted" });
  if (b.note_id) db().update("notes", b.note_id, { status: "retracted" });
  return { ok: true };
});
route("POST", "/memory/consolidate", async () => await consolidate());

// ---------------------------------------------------------------- inspection (observer UI)
route("GET", "/inspect/overview", () => ({
  spend,
  counts: Object.fromEntries(["cards", "sessions", "llm_calls", "tool_calls", "topics", "messages", "captures", "questions", "notes", "claims", "facts", "review_items"].map((t) => [t, db().get(`SELECT count(*) n FROM ${t}`)!.n])),
  cards_by_state: db().all(`SELECT state, count(*) n FROM cards GROUP BY state`),
  calls_by_type: db().all(`SELECT call_type, count(*) n, sum(ok) ok, round(avg(ms)) ms, sum(tokens_in) tin, sum(tokens_out) tout, round(sum(cost),5) cost FROM llm_calls GROUP BY call_type ORDER BY n DESC`),
  presence,
}));
route("GET", "/inspect/sessions", (_r, _p, _b, u) => {
  const c = u.searchParams.get("card_id");
  return db().all(`SELECT * FROM sessions ${c ? "WHERE card_id=?" : ""} ORDER BY started_at DESC LIMIT 200`, ...(c ? [c] : []));
});
route("GET", "/inspect/sessions/:id", (_r, p) => ({
  session: db().get(`SELECT * FROM sessions WHERE id=?`, p.id),
  calls: db().all(`SELECT * FROM llm_calls WHERE session_id=? ORDER BY at, rowid`, p.id),
  tools: db().all(`SELECT * FROM tool_calls WHERE session_id=? ORDER BY at, rowid`, p.id),
}));
route("GET", "/inspect/calls", (_r, _p, _b, u) => {
  const t = u.searchParams.get("type"), bad = u.searchParams.get("failed");
  return db().all(
    `SELECT id, call_type, model, provider, session_id, card_id, topic_id, step, attempt, ok, error, repaired, tokens_in, tokens_out, cost, ms, at, substr(raw_output,1,200) preview, eval_label
     FROM llm_calls WHERE 1=1 ${t ? "AND call_type=?" : ""} ${bad ? "AND ok=0" : ""} ORDER BY at DESC, rowid DESC LIMIT 300`,
    ...(t ? [t] : []),
  );
});
route("GET", "/inspect/calls/:id", (_r, p) => db().get(`SELECT * FROM llm_calls WHERE id=?`, p.id));
route("POST", "/inspect/calls/:id/label", (_r, p, b) => (db().update("llm_calls", p.id, { eval_label: { ...j(db().get(`SELECT eval_label FROM llm_calls WHERE id=?`, p.id)?.eval_label, {}), label: b.label, note: b.note } }), { ok: true }));
route("GET", "/inspect/cards/:id/timeline", (_r, p) => cardDetail(p.id));
route("GET", "/inspect/desk_turns", () => db().all(`SELECT * FROM desk_turns ORDER BY created_at DESC LIMIT 100`));
route("GET", "/inspect/desk_turns/:id", (_r, p) => {
  const t = db().get(`SELECT * FROM desk_turns WHERE id=?`, p.id);
  return { turn: t, calls: t ? db().all(`SELECT * FROM llm_calls WHERE session_id=? ORDER BY at, rowid`, t.session_id) : [], receipts: db().all(`SELECT * FROM receipts WHERE desk_turn_id=?`, p.id) };
});
route("GET", "/inspect/tables", () => db().all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%fts%' AND name NOT LIKE 'sqlite_%' ORDER BY name`).map((r) => r.name));
route("GET", "/inspect/table/:name", (_r, p, _b, u) => {
  const ok = db().get(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, p.name);
  if (!ok) throw new HttpError(404, "no table");
  return db().all(`SELECT * FROM ${p.name} ORDER BY rowid DESC LIMIT ?`, Number(u.searchParams.get("limit") ?? 200));
});

// ---------------------------------------------------------------- helpers
class HttpError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}
const pick = (o: Row, keys: string[]) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

function captureDetail(id: string) {
  const c = db().get(`SELECT * FROM captures WHERE id=?`, id);
  if (!c) throw new HttpError(404, "no capture");
  const items = db().all(`SELECT * FROM capture_items WHERE capture_id=? ORDER BY seq`, id).map((i) => ({
    ...i, route_info: j(i.route_info, null), topic: db().get(`SELECT id, slug, title FROM topics WHERE id=?`, i.topic_id),
    receipts: db().all(`SELECT * FROM receipts WHERE capture_item_id=?`, i.id),
    desk_calls: i.desk_turn_id ? db().all(`SELECT l.* FROM llm_calls l JOIN desk_turns d ON d.session_id=l.session_id WHERE d.id=? ORDER BY l.at, l.rowid`, i.desk_turn_id) : [],
  }));
  const seg = db().get(`SELECT payload FROM events WHERE type='capture.segmented' AND ref_id=?`, id);
  const segCalls = db().all(`SELECT * FROM llm_calls WHERE call_type='segment_capture' AND at >= ? ORDER BY at LIMIT 1`, c.created_at);
  return { ...c, confirmation: j(c.confirmation, null), segmentation: j(seg?.payload, null), segment_calls: segCalls, items };
}

function cardDetail(id: string) {
  const c = getCard(id);
  return {
    card: c,
    events: db().all(`SELECT * FROM card_events WHERE card_id=? ORDER BY id`, id),
    comments: db().all(`SELECT * FROM comments WHERE card_id=? ORDER BY created_at, rowid`, id),
    children: db().all(`SELECT id, title, state, role FROM cards WHERE parent_id=? ORDER BY created_at`, id),
    sessions: db().all(`SELECT * FROM sessions WHERE card_id=? ORDER BY started_at`, id),
    artifacts: db().all(`SELECT id, name, bytes, origin, summary, content FROM artifacts WHERE card_id=?`, id),
    recorded: recordedFacts(id).lines,
    questions: db().all(`SELECT * FROM questions WHERE card_id=?`, id),
  };
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = Deno.env.get("SANDMAN_TOKEN");
  if (url.pathname === "/" || url.pathname === "/observer") {
    const f = url.pathname === "/" ? "client.html" : "observer.html";
    return new Response(await Deno.readTextFile(new URL(`../ui/${f}`, import.meta.url)), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (token && req.headers.get("authorization") !== `Bearer ${token}` && url.searchParams.get("token") !== token) {
    return new Response("unauthorized", { status: 401 });
  }
  if (url.pathname === "/events/stream") {
    let after = Number(url.searchParams.get("after") ?? 0);
    if (after < 0) after = db().get(`SELECT coalesce(max(id),0) m FROM events`)!.m; // -1: from now on
    return sse(after);
  }
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.re);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    try {
      const body = req.method === "GET" ? {} : await req.json().catch(() => ({}));
      const out = await r.h(req, params, body, url);
      return Response.json(out ?? null);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 400;
      return Response.json({ error: (e as Error).message }, { status });
    }
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

function sse(after: number): Response {
  let unsub: () => void = () => {};
  let ping: ReturnType<typeof setInterval>;
  const stream = new ReadableStream({
    start(ctl) {
      const enc = new TextEncoder();
      const send = (ev: Row) => ctl.enqueue(enc.encode(`id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`));
      for (const ev of eventsAfter(after)) send(ev);
      unsub = subscribe(send);
      ping = setInterval(() => ctl.enqueue(enc.encode(": ping\n\n")), 20000);
    },
    cancel() {
      unsub();
      clearInterval(ping);
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

export async function serve() {
  seedRecipes();
  startDispatcher();
  // opportunistic consolidation (§7.5): when ≥20 facts are pending, and once a night
  let lastNight = "";
  setInterval(() => {
    const pending = db().get(`SELECT count(*) n FROM facts WHERE status='pending'`)!.n;
    const d = new Date();
    const night = d.getHours() === 3 ? d.toDateString() : "";
    if (pending >= 20 || (night && night !== lastNight && pending)) {
      lastNight = night || lastNight;
      bg(consolidate().then(() => tidy()));
    }
  }, 60_000);
  console.log(`Sandman on http://localhost:${config.api.port}  (observer: /observer)  model: ${config.profiles.small.model}  web: ${config.web_backend}`);
  await Deno.serve({ port: config.api.port, onListen: () => {} }, handle).finished;
}
