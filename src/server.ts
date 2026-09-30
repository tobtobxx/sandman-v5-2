// Unified API (DESIGN Appendix B, subset) + both web UIs + background loops.
//   /          client UI (capture, needs-you, topics, review, board, memory)
//   /observer  observer UI (all internal state: cards, sessions, LLM calls, captures, raw tables)

import { db, j, nowIso, Row } from "./db.ts";
import { config, modelFor } from "./config.ts";
import { eventsAfter, presence, subscribe } from "./events.ts";
import { spend } from "./llm/gateway.ts";
import { seedRecipes } from "./work/recipes.ts";
import { startDispatcher } from "./work/dispatcher.ts";
import { addComment, cancelCard, createCard, getCard, transition } from "./work/board.ts";
import { moveItem, receiveCapture, retryCaptures, runCapture } from "./conversation/capture.ts";
import { installModelAlerts, modelBackoff } from "./conversation/alerts.ts";
import { undoReceipt } from "./conversation/receipts.ts";
import { listTopics, unarchiveTopic, updateTopic } from "./conversation/topics.ts";
import { ownerMessage } from "./conversation/pages.ts";
import { homeView, sendView, topicView } from "./conversation/views.ts";
import { answerQuestion, needsYou } from "./conversation/questions.ts";
import { replyBriefing, startBriefing } from "./conversation/briefing.ts";
import { listReview } from "./conversation/review.ts";
import { reviewAction, tidy } from "./conversation/tidy.ts";
import { consolidate, consolidationRunning, consolidationStatus, rerender } from "./memory/consolidator.ts";
import { findNotes, listPendingFacts, NoteView, noteView, syncEmbeddings } from "./memory/retriever.ts";
import { recordedFacts } from "./work/worker.ts";
import { addSubscription, installPush, listSubscriptions, removeSubscription, sendTest, vapidKeys } from "./push.ts";

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
// Send from home (docs/API.md): split and file now, let the desk work in the background.
// If filing fails (model down), the capture is kept and retried; the reply says it is pending.
// A resend with the same client_msg_id joins or restarts the same capture.
route("POST", "/send", async (_r, _p, b) => {
  const text = String(b.text ?? "").trim();
  if (!text) throw new Error("empty message");
  const cap = receiveCapture({ text, url: b.url, source: b.source ?? "text", client_id: b.client_id, client_msg_id: b.client_msg_id });
  const run = runCapture(cap.id);
  let filed;
  try {
    filed = await run.filed;
  } catch {
    return { send_id: cap.id, pending: true, items: [] };
  }
  return {
    send_id: cap.id,
    items: filed.map((f) => {
      const t = db().get(`SELECT title, kind FROM topics WHERE id=?`, f.route.topic_id);
      return { item_id: f.item_id, quote: f.quote, topic_id: f.route.topic_id, topic_title: t?.title, topic_kind: t?.kind, created: f.route.created, confidence: f.route.confidence };
    }),
  };
});
route("GET", "/sends/:id", (_r, p) => sendView(p.id));
route("GET", "/home", () => homeView());
route("GET", "/captures", () => db().all(`SELECT * FROM captures ORDER BY created_at DESC LIMIT 50`).map((c) => ({ ...c, confirmation: j(c.confirmation, null) })));
route("GET", "/captures/:id", (_r, p) => captureDetail(p.id));
route("POST", "/items/:id/move", (_r, p, b) => moveItem(p.id, b.topic_id ?? "new"));
route("POST", "/receipts/:id/undo", (_r, p) => undoReceipt(p.id));

// ---------------------------------------------------------------- topics & messages
route("GET", "/topics", (_r, _p, _b, u) => listTopics(u.searchParams.get("status") ?? "active"));
route("PATCH", "/topics/:id", (_r, p, b) => (updateTopic(p.id, pick(b, ["title", "status", "summary"])), { ok: true }));
route("POST", "/topics/:id/unarchive", (_r, p) => (unarchiveTopic(p.id), { ok: true }));
route("GET", "/topics/:id", (_r, p) => topicView(p.id));
// A message typed in a topic goes straight to that topic (no splitting, no routing).
route("POST", "/topics/:id/messages", (_r, p, b) => {
  const text = String(b.text ?? "").trim();
  if (!text) throw new Error("empty message");
  const { message, done } = ownerMessage({ topic_id: p.id, text, client_id: b.client_id, client_msg_id: b.client_msg_id });
  bg(done);
  return { message_id: message.id };
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
  if (r.refile) runCapture(receiveCapture({ text: r.refile, source: "text" }).id).filed.catch(() => {}); // retried on failure
  if (p.action === "move" && b.topic_id) {
    const item = db().get(`SELECT ref_ids FROM review_items WHERE id=?`, p.id);
    moveItem(j<string[]>(item?.ref_ids, [])[0], b.topic_id);
  }
  return r;
});
route("POST", "/presence", (_r, _p, b) => (Object.assign(presence, { topic_id: b.topic_id ?? null }), presence));
// Web Push (src/push.ts): browsers and the Android app (UnifiedPush) register the same way.
route("GET", "/push-subscriptions/key", async () => ({ vapid_public_key: (await vapidKeys()).publicKey }));
route("GET", "/push-subscriptions", () => listSubscriptions());
route("POST", "/push-subscriptions", (_r, _p, b) => addSubscription(b));
route("DELETE", "/push-subscriptions", (_r, _p, b) => removeSubscription(String(b.endpoint ?? "")));
route("POST", "/push-subscriptions/test", async () => ({ results: await sendTest() }));
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
// With a query: the same search, and the same results in the same order, that the librarian and workers
// get for that text (findNotes). Without one: every note, newest first, then every pending fact.
// Candidate facts still waiting for the consolidator come as status "pending" (kind "fact", grouped by subject).
route("GET", "/memory/notes", async (_r, _p, _b, u) => {
  const query = (u.searchParams.get("query") ?? "").trim();
  const shown = (v: NoteView) => {
    if (v.pending) return { ...v, kind: "fact", status: "pending", aliases: [] };
    const n = db().get(`SELECT status, aliases FROM notes WHERE id=?`, v.id);
    return { ...v, status: n.status, aliases: j(n.aliases, []) };
  };
  if (query) return (await findNotes(query, [], config.memory.top_k, "interactive")).map(shown);
  return [...db().all(`SELECT * FROM notes ORDER BY created_at DESC LIMIT 100`).map(noteView), ...listPendingFacts()].map(shown);
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
// Starts a run in the background (or joins the one in flight) and returns the status right away;
// `memory.consolidated` announces the end.
route("POST", "/memory/consolidate", () => {
  const started = !consolidationRunning();
  bg(consolidate());
  return { started, ...consolidationStatus() };
});
route("GET", "/memory/status", () => consolidationStatus());

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
    `SELECT id, call_type, model, provider, session_id, card_id, topic_id, step, attempt, ok, error, repaired, tokens_in, tokens_out, cost, ms, at, substr(raw_output,1,200) preview, length(reasoning) reasoning_chars, eval_label
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
route("GET", "/inspect/tables", () => db().all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%fts%' AND name NOT LIKE 'sqlite_%' AND name != 'vapid_keys' ORDER BY name`).map((r) => r.name));
route("GET", "/inspect/table/:name", (_r, p, _b, u) => {
  const ok = p.name !== "vapid_keys" && db().get(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, p.name);
  if (!ok) throw new HttpError(404, "no table");
  // vectors are shown by their size, not their bytes
  const cols = p.name === "embeddings" ? "id, grp, model, text, length(vec) / 4 AS dims" : "*";
  return db().all(`SELECT ${cols} FROM ${p.name} ORDER BY rowid DESC LIMIT ?`, Number(u.searchParams.get("limit") ?? 200));
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
  const token = config.api.token;
  if (url.pathname === "/" || url.pathname === "/observer") {
    const f = url.pathname === "/" ? "client.html" : "observer.html";
    return new Response(await Deno.readTextFile(new URL(`../ui/${f}`, import.meta.url)), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (url.pathname === "/sw.js") {
    return new Response(await Deno.readTextFile(new URL("../ui/sw.js", import.meta.url)), {
      headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" },
    });
  }
  const font = url.pathname.match(/^\/fonts\/([a-z0-9-]+\.(woff2|css))$/);
  if (font) {
    const type = font[2] === "css" ? "text/css; charset=utf-8" : "font/woff2";
    try {
      return new Response(await Deno.readFile(new URL(`../ui/fonts/${font[1]}`, import.meta.url)), {
        headers: { "content-type": type, "cache-control": "public, max-age=86400" },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
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
  installModelAlerts();
  installPush();
  startDispatcher();
  bg(syncEmbeddings("background")); // memory written before this version, or with another embedding model
  // captures not yet handled (model was down, server restarted) are retried with backoff (§13)
  setInterval(() => modelBackoff() || retryCaptures(), 5_000);
  retryCaptures();
  // opportunistic consolidation (§7.5): when ≥20 facts are pending, and once a night
  let lastNight = "";
  setInterval(() => {
    const pending = db().get(`SELECT count(*) n FROM facts WHERE status='pending'`)!.n;
    const d = new Date();
    const night = d.getHours() === 3 ? d.toDateString() : "";
    if (consolidationRunning()) return;
    if (pending >= 20 || (night && night !== lastNight && pending)) {
      lastNight = night || lastNight;
      bg(consolidate().then(() => tidy()));
    }
  }, 60_000);
  const { host, port } = config.api;
  console.log(`Sandman on http://${host.includes(":") ? `[${host}]` : host}:${port}  (observer: /observer)  model: ${modelFor("main").model}${config.roles.interactive ? `, interactive: ${modelFor("interactive").model}` : ""}  web: ${config.web.searxng || "DuckDuckGo"}`);
  await Deno.serve({ hostname: host, port, onListen: () => {} }, handle).finished;
}
