// Consolidator (DESIGN §7.5): offline merge of candidate facts into notes and claims.

import { db, ftsQuery, j, nowIso, Row } from "../db.ts";
import { newId } from "../ids.ts";
import { config } from "../config.ts";
import { llmJson } from "../llm/gateway.ts";
import * as M from "../prompts/memory.ts";
import { indexNote } from "./retriever.ts";
import { createQuestion } from "../conversation/questions.ts";
import { emit } from "../events.ts";
import { PRICE } from "./facts.ts";

const toks = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
function sim(a: string, b: string) {
  const A = toks(a), B = toks(b);
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.max(1, Math.min(A.size, B.size));
}
const SOURCE_RANK: Record<string, number> = { owner: 3, url: 2, card: 1 };

export function createNote(kind: string, title: string, aliases: string[] = []): Row {
  const row = { id: newId("not"), kind, title, aliases, one_liner: "", status: "active", created_at: nowIso() };
  db().insert("notes", row);
  indexNote(row.id);
  return row;
}

export function addClaim(note_id: string, f: { text: string; source: Row; volatility: string; topic_id?: string | null; observed_at?: string }): Row {
  const row = {
    id: newId("clm"), note_id, text: f.text, source: f.source, observed_at: f.observed_at ?? nowIso(), volatility: f.volatility,
    status: "active", confidence: f.source.type === "owner" ? "high" : "medium", corroborations: 0, topic_id: f.topic_id ?? null,
  };
  db().insert("claims", row);
  rerender(note_id);
  return row;
}

export function rerender(note_id: string) {
  const claims = db().all(`SELECT text FROM claims WHERE note_id=? AND status='active' ORDER BY observed_at DESC`, note_id);
  db().update("notes", note_id, { one_liner: (claims[0]?.text ?? "").slice(0, 140), body_rendered: claims.map((c) => `- ${c.text}`).join("\n") });
  indexNote(note_id);
}

function profileNote(): Row {
  return db().get(`SELECT * FROM notes WHERE kind='profile'`) ?? createNote("profile", `${config.owner.name} (profile)`);
}

const opts = (p: { maxTokens: number; version: string }) => ({ maxTokens: p.maxTokens, version: p.version, priority: "background" as const });

/** Resolve the note a fact belongs to (step 1). */
export async function resolveSubject(f: Row): Promise<{ note: Row; created: boolean; via: string }> {
  const src = j<Row>(f.source, {});
  const subj = String(f.subject).trim();
  if (src.type === "owner" && ["owner", "the owner", config.owner.name.toLowerCase(), "me", "i"].includes(subj.toLowerCase())) {
    return { note: profileNote(), created: false, via: "profile" };
  }
  const kind = src.negative ? "negative" : "entity";
  for (const n of db().all(`SELECT * FROM notes WHERE status='active' AND kind=?`, kind)) {
    const names = [n.title, ...j<string[]>(n.aliases, [])].map((x) => x.toLowerCase());
    if (names.includes(subj.toLowerCase())) return { note: n, created: false, via: "exact" };
  }
  const q = ftsQuery(`${subj}`);
  const cands = q ? db().all(`SELECT n.* FROM notes_fts f JOIN notes n ON n.id=f.id WHERE notes_fts MATCH ? AND n.status='active' AND n.kind=? ORDER BY rank LIMIT 3`, q, kind) : [];
  if (cands.length) {
    const p = M.matchSubject({ subject: subj, claim: f.text, notes: cands.map((n) => ({ id: n.id, title: n.title, one_liner: n.one_liner })) });
    const r = await llmJson<{ note_id: string }>("match_subject", p.prompt, p.schema, opts(p));
    if (r.note_id !== "none") {
      const n = cands.find((c) => c.id === r.note_id)!;
      if (n.title.toLowerCase() !== subj.toLowerCase()) db().update("notes", n.id, { aliases: [...new Set([...j<string[]>(n.aliases, []), subj])] }), indexNote(n.id);
      return { note: n, created: false, via: "match_subject" };
    }
  }
  return { note: createNote(kind, subj), created: true, via: "new" };
}

export async function relevant(f: Row): Promise<{ keep: boolean; rubric: Row | null }> {
  const src = j<Row>(f.source, {});
  if (src.type === "owner" || src.negative) return { keep: true, rubric: null };
  const card = f.card_id ? db().get(`SELECT title FROM cards WHERE id=?`, f.card_id) : null;
  const p = M.relevanceRubric({ subject: f.subject, claim: f.text, source: src.ref ?? src.type, card_title: card?.title ?? "" });
  const r = await llmJson<Row>("relevance_rubric", p.prompt, p.schema, opts(p));
  const keep = !r.task_mechanics && !r.trivial && (r.reusable || r.costly); // code, not the model
  return { keep, rubric: r };
}

export async function consolidateOne(f: Row): Promise<string> {
  const rel = await relevant(f);
  if (!rel.keep) {
    db().update("facts", f.id, { status: "discarded", decision: "irrelevant", decision_analysis: rel.rubric?.analysis, decided_at: nowIso() });
    return "irrelevant";
  }
  const { note, created } = await resolveSubject(f);
  const src = j<Row>(f.source, {});
  const base = { text: f.text, source: src, volatility: f.volatility, topic_id: f.topic_id, observed_at: f.created_at };
  if (created) {
    addClaim(note.id, base);
    db().update("facts", f.id, { status: "merged", decision: "new", decided_at: nowIso() });
    return "new";
  }
  const claims = db().all(`SELECT * FROM claims WHERE note_id=? AND status='active'`, note.id)
    .map((c) => ({ c, s: sim(c.text, f.text) })).sort((a, b) => b.s - a.s).slice(0, 5).map((x) => x.c);
  if (!claims.length) {
    addClaim(note.id, base);
    db().update("facts", f.id, { status: "merged", decision: "new", decided_at: nowIso() });
    return "new";
  }
  const p = M.consolidateFact({ note_title: note.title, claim: f.text, claims: claims.map((c) => ({ id: c.id, text: c.text, date: String(c.observed_at).slice(0, 10) })) });
  const r = await llmJson<Row>("consolidate_fact", p.prompt, p.schema, opts(p));
  const target = claims.find((c) => c.id === r.target_claim_id);
  let decision = r.decision;
  if (["duplicate", "update", "contradicts"].includes(decision) && !target) decision = "new";
  // code guard: an update or contradiction must be about the same detail — similar wording, or both are prices
  const sameDetail = target && (sim(target.text, f.text) >= 0.35 || (PRICE.test(target.text) && PRICE.test(f.text)));
  if ((decision === "update" || decision === "contradicts") && !sameDetail) decision = "new";
  switch (decision) {
    case "new":
      addClaim(note.id, base);
      break;
    case "duplicate":
      db().run(`UPDATE claims SET corroborations = corroborations + 1, confidence = CASE WHEN corroborations >= 1 THEN 'high' ELSE confidence END WHERE id=?`, target.id);
      break;
    case "update": {
      if (String(f.created_at) >= String(target.observed_at)) {
        const nc = addClaim(note.id, base);
        db().update("claims", target.id, { status: "superseded", superseded_by: nc.id });
        rerender(note.id);
      }
      break;
    }
    case "contradicts": {
      const tsrc = j<Row>(target.source, {});
      const newer = String(f.created_at) >= String(target.observed_at);
      const better = (SOURCE_RANK[src.type] ?? 0) >= (SOURCE_RANK[tsrc.type] ?? 0);
      if (src.type === "owner" && tsrc.type !== "owner") decision = "update";
      else if (f.volatility !== "evergreen" && newer && better && src.type === tsrc.type) decision = "update";
      if (decision === "update") {
        const nc = addClaim(note.id, base);
        db().update("claims", target.id, { status: "superseded", superseded_by: nc.id });
        rerender(note.id);
      } else {
        const nc = addClaim(note.id, base);
        db().run(`UPDATE claims SET status='disputed' WHERE id IN (?,?)`, nc.id, target.id);
        createQuestion({
          topic_id: f.topic_id ?? null, card_id: null, reason: "memory_conflict",
          text: `Two notes disagree on ${note.title}: which is right?`,
          options: [target.text.slice(0, 40), f.text.slice(0, 40), "Keep both"],
        });
      }
      break;
    }
    case "discard":
      break;
  }
  db().update("facts", f.id, { status: decision === "discard" ? "discarded" : "merged", decision, decision_analysis: r.analysis, target_claim_id: target?.id ?? null, decided_at: nowIso() });
  return decision;
}

// One run at a time per database: a second call (button, idle loop, night) joins the run in flight.
const running = new WeakMap<object, { started_at: string; done: Promise<Record<string, number>> }>();

export function consolidationRunning(): boolean {
  return running.has(db());
}

/** Running state, the last completed run (from the event log, so it survives restarts) and the queue size. */
export function consolidationStatus() {
  const r = running.get(db());
  const last = db().get(`SELECT payload, at FROM events WHERE type='memory.consolidated' ORDER BY id DESC LIMIT 1`);
  return {
    running: !!r,
    started_at: r?.started_at ?? null,
    last_completed_at: last?.at ?? null,
    last_counts: last ? j<Record<string, number>>(last.payload, {}) : null,
    pending: db().get(`SELECT count(*) n FROM facts WHERE status='pending'`)!.n as number,
  };
}

export function consolidate(limit = 50): Promise<Record<string, number>> {
  const key = db();
  const cur = running.get(key);
  if (cur) return cur.done;
  const started_at = nowIso();
  emit("memory.consolidating", { payload: { started_at } });
  const done = consolidateRun(limit).finally(() => running.delete(key));
  running.set(key, { started_at, done });
  return done;
}

async function consolidateRun(limit: number): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const f of db().all(`SELECT * FROM facts WHERE status='pending' ORDER BY created_at LIMIT ?`, limit)) {
    try {
      const d = await consolidateOne(f);
      counts[d] = (counts[d] ?? 0) + 1;
    } catch (e) {
      counts.error = (counts.error ?? 0) + 1;
      console.error("consolidate:", f.id, (e as Error).message);
    }
  }
  emit("memory.consolidated", { payload: counts });
  return counts;
}
