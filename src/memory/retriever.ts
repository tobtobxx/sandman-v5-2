// Memory retrieval (DESIGN §7.6): exact/alias lookup, FTS and embeddings; staleness computed in code.

import { db, ftsQuery, ftsWords, j, now, Row } from "../db.ts";
import { config, modelFor } from "../config.ts";
import { embed, LLMFailure, Priority } from "../llm/gateway.ts";

export interface NoteView {
  id: string;
  kind: string;
  title: string;
  one_liner: string;
  claims: (Row & { stale: boolean })[];
  answerable: boolean;
  pending?: boolean; // candidate facts the consolidator has not reviewed yet
}

export function isStale(c: Row): boolean {
  const max = (config.memory.volatility_max_age_days as any)[c.volatility];
  if (max === null || max === undefined) return false;
  const age = (now().getTime() - new Date(c.observed_at).getTime()) / 86400000;
  return age > max;
}

export function noteView(n: Row): NoteView {
  const claims = db()
    .all(`SELECT * FROM claims WHERE note_id=? AND status IN ('active','disputed') ORDER BY observed_at DESC`, n.id)
    .map((c) => ({ ...c, stale: isStale(c) }));
  return { id: n.id, kind: n.kind, title: n.title, one_liner: n.one_liner, claims, answerable: claims.some((c) => !c.stale) };
}

// Memory search (DESIGN §7.6, §19 q3). One ranking serves the librarian, workers, the desk, the
// consolidator's subject match and the Memory page's search box, so the owner sees what the model sees.
// A note (or a subject of pending facts) is ranked by up to three lists, fused by reciprocal rank:
// - exact: a named entity equals its title or an alias (always first)
// - words: FTS over notes; for pending facts, shared words (see pendingByWords)
// - meaning: cosine similarity of embeddings (the "embedding" profile), at least min_similarity
// With embeddings off (no model) or unreachable, the word lists alone decide.

const RRF_K = 60; // the usual reciprocal-rank constant: rank 1 scores 1/61, rank 10 scores 1/70

export interface SearchOpts {
  entities?: string[];
  k?: number;
  /** only notes of these kinds, and no pending facts (the consolidator's subject match) */
  kinds?: string[];
  priority?: Priority;
}

/** Notes, and subjects of pending facts, relevant to a text: best first, at most k. */
export async function findNotes(text: string, entities: string[] = [], k = config.memory.top_k, priority: Priority = "normal"): Promise<NoteView[]> {
  const ranked = await rankMemory(text, { entities, k, priority });
  const pending = pendingGroups();
  return ranked
    .map((key) => key.startsWith(PENDING) ? pendingView(pending.get(key)!) : noteView(db().get(`SELECT * FROM notes WHERE id=?`, key)))
    .filter((v) => v.claims.length);
}

/** Ranked keys: note ids, and pending subjects as "pending:<subject>". */
export async function rankMemory(text: string, o: SearchOpts = {}): Promise<string[]> {
  const entities = o.entities ?? [];
  const k = o.k ?? config.memory.top_k;
  const withPending = !o.kinds;
  const notes = new Map<string, Row>(
    db().all(`SELECT * FROM notes WHERE status='active' AND kind != 'profile'`).filter((n) => !o.kinds || o.kinds.includes(n.kind)).map((n) => [n.id, n]),
  );
  const pending = withPending ? pendingGroups() : new Map<string, PendingGroup>();
  if (!notes.size && !pending.size) return [];

  const score = new Map<string, number>();
  const add = (keys: string[]) => keys.forEach((key, i) => score.set(key, (score.get(key) ?? 0) + 1 / (RRF_K + i + 1)));

  const ents = new Set(entities.map((e) => fold(e.toLowerCase().trim())));
  const exact = [
    ...[...notes.values()].filter((n) => [n.title, ...j<string[]>(n.aliases, [])].some((x) => ents.has(fold(String(x).toLowerCase().trim())))).map((n) => n.id),
    ...[...pending.keys()].filter((key) => ents.has(key.slice(PENDING.length))),
  ];
  for (const key of exact) score.set(key, (score.get(key) ?? 0) + 1);

  const q = ftsQuery([text, ...entities].join(" "));
  if (q) add(db().all(`SELECT id FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?`, q, k * 3).map((r) => r.id).filter((id) => notes.has(id)));
  if (withPending) add(pendingByWords(pending, text, entities));
  const sem = await semanticScores([text, ...entities.filter((e) => !text.toLowerCase().includes(e.toLowerCase()))].join("; "), o.priority);
  add([...sem.entries()].filter(([key]) => notes.has(key) || pending.has(key)).sort((a, b) => b[1] - a[1]).map(([key]) => key));

  // ties (e.g. first by words vs. first by meaning) go to the closer meaning
  return [...score.entries()].sort((a, b) => b[1] - a[1] || (sem.get(b[0]) ?? 0) - (sem.get(a[0]) ?? 0)).slice(0, k).map(([key]) => key);
}

// ---- pending facts ----
// Candidate facts wait for the consolidator (≥20 pending, or nightly). Until then they are searched as
// unreviewed notes, one per subject, so what a card found today can be used by the next card and found
// on the Memory page. Negative results are left out until reviewed: an owner who asks to try again right
// after a failed search should get a new search, not the failure back.
const PENDING = "pending:";
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "");
const wordsOf = (s: string, min: number) => fold(s.toLowerCase()).match(new RegExp(`[\\p{L}\\p{N}]{${min},}`, "gu")) ?? [];

interface PendingGroup {
  key: string;
  facts: Row[]; // newest first, distinct texts
}

/** Pending, non-negative facts grouped by subject (newest 200 facts). */
function pendingGroups(): Map<string, PendingGroup> {
  const groups = new Map<string, PendingGroup>();
  for (const f of db().all(`SELECT * FROM facts WHERE status='pending' ORDER BY created_at DESC LIMIT 200`)) {
    if (j<Row>(f.source, {}).negative) continue;
    const key = PENDING + fold(String(f.subject ?? "").toLowerCase().trim());
    const g = groups.get(key) ?? { key, facts: [] };
    if (!g.facts.some((x) => x.text === f.text)) g.facts.push(f);
    groups.set(key, g);
  }
  return groups;
}

/** Subjects sharing at least two words with the query (one if it has one; a word of 4+ letters may start a longer one). */
function pendingByWords(groups: Map<string, PendingGroup>, text: string, entities: string[]): string[] {
  const words = new Set([...ftsWords(fold(text)), ...ftsWords(fold(entities.join(" ")))]);
  const need = Math.min(2, words.size);
  if (!need) return [];
  const scored = [...groups.values()].map((g) => {
    const have = new Set(g.facts.flatMap((f) => wordsOf(`${f.subject} ${f.text}`, 3)));
    return { key: g.key, n: [...words].filter((w) => have.has(w) || (w.length >= 4 && [...have].some((h) => h.startsWith(w)))).length };
  });
  return scored.filter((s) => s.n >= need).sort((a, b) => b.n - a.n).map((s) => s.key); // stable: ties stay newest first
}

function pendingView(g: PendingGroup): NoteView {
  const claims = g.facts.map((f) => {
    const c = { id: f.id, text: f.text, source: f.source, observed_at: f.created_at, volatility: f.volatility, pending: true };
    return { ...c, stale: isStale(c) };
  });
  return { id: g.facts[0].id, kind: "entity", title: String(g.facts[0].subject), one_liner: "", claims, answerable: claims.some((c) => !c.stale), pending: true };
}

/** Every pending fact (negative ones too), one entry per subject, newest first: the Memory page without a query. */
export function listPendingFacts(): NoteView[] {
  const groups = new Map<string, Row[]>();
  for (const f of db().all(`SELECT * FROM facts WHERE status='pending' ORDER BY created_at DESC LIMIT 200`)) {
    const key = fold(String(f.subject ?? "").toLowerCase().trim());
    const fs = groups.get(key) ?? [];
    if (!fs.some((x) => x.text === f.text)) fs.push(f);
    groups.set(key, fs);
  }
  return [...groups.values()].map((facts) => pendingView({ key: "", facts }));
}

// ---- embeddings ----
// Embedded: each note's title with its aliases, each active claim as "<title>: <claim>", and each pending
// fact as "<subject>: <text>". A note or pending subject scores as its best-matching text. Vectors are
// made on demand: a search first embeds whatever is new or changed (syncEmbeddings), and drops the rest.

const embeddingOn = () => config.roles.embedding != null;
/** Vectors are only comparable within one model and document prefix. */
const embeddingModel = () => `${modelFor("embedding").model}|${modelFor("embedding").document_prefix ?? ""}`;

function memoryTexts(): { id: string; grp: string; text: string }[] {
  const out = db().all(`SELECT id, title, aliases FROM notes WHERE status='active' AND kind != 'profile'`)
    .map((n) => ({ id: n.id as string, grp: n.id as string, text: [n.title, ...j<string[]>(n.aliases, [])].join("; ") }));
  for (const c of db().all(`SELECT c.id, c.note_id, c.text, n.title FROM claims c JOIN notes n ON n.id=c.note_id WHERE n.status='active' AND n.kind != 'profile' AND c.status IN ('active','disputed')`)) {
    out.push({ id: c.id, grp: c.note_id, text: `${c.title}: ${c.text}` });
  }
  for (const g of pendingGroups().values()) for (const f of g.facts) out.push({ id: f.id, grp: g.key, text: `${f.subject}: ${f.text}` });
  return out;
}

/** Embed what is new or changed in memory; drop vectors of what is gone. */
export async function syncEmbeddings(priority: Priority = "normal") {
  if (!embeddingOn()) return;
  const model = embeddingModel();
  const texts = memoryTexts();
  const have = new Map(db().all(`SELECT id, grp, model, text FROM embeddings`).map((r) => [r.id as string, r]));
  const ids = new Set(texts.map((t) => t.id));
  for (const id of have.keys()) if (!ids.has(id)) db().run(`DELETE FROM embeddings WHERE id=?`, id);
  const todo = texts.filter((t) => {
    const h = have.get(t.id);
    return !h || h.model !== model || h.text !== t.text || h.grp !== t.grp;
  });
  for (let i = 0; i < todo.length; i += 64) {
    const batch = todo.slice(i, i + 64);
    const vecs = await embed(batch.map((t) => t.text), "document", priority);
    db().tx(() => {
      batch.forEach((t, n) => db().run(`INSERT OR REPLACE INTO embeddings (id, grp, model, text, vec) VALUES (?,?,?,?,?)`, t.id, t.grp, model, t.text, new Uint8Array(vecs[n].buffer)));
    });
  }
}

/** Best similarity per note or pending subject, for those at or above min_similarity. Empty when embeddings are off or fail. */
async function semanticScores(query: string, priority: Priority = "normal"): Promise<Map<string, number>> {
  const best = new Map<string, number>();
  if (!embeddingOn() || !query.trim()) return best;
  try {
    await syncEmbeddings(priority);
    const rows = db().all(`SELECT grp, vec FROM embeddings WHERE model=?`, embeddingModel());
    if (!rows.length) return best;
    const [q] = await embed([query], "query", priority);
    const min = modelFor("embedding").min_similarity ?? 0.3;
    for (const r of rows) {
      const v = new Float32Array((r.vec as Uint8Array).slice().buffer);
      if (v.length !== q.length) continue;
      let s = 0;
      for (let i = 0; i < v.length; i++) s += v[i] * q[i];
      if (s >= min && s > (best.get(r.grp) ?? -1)) best.set(r.grp, s);
    }
  } catch (e) {
    if (!(e instanceof LLMFailure)) throw e;
    console.warn(`memory search by meaning unavailable (${e.kind}: ${e.message}); searching by words only`);
  }
  return best;
}

export function renderNotes(notes: NoteView[]): string {
  return notes
    .map((n) => {
      const cl = n.claims.map((c) => {
        const date = String(c.observed_at).slice(0, 10);
        const src = claimSource(c);
        const from = src ? `; source: ${src}` : "";
        return `  - ${c.text}${c.stale ? ` [as of ${date}, may be outdated${from}]` : ` (${date}${from})`}`;
      });
      const label = [n.kind === "negative" ? "earlier search that found nothing" : "", n.pending ? "found recently, not yet reviewed" : ""].filter(Boolean).join("; ");
      return `${n.id}: ${n.title}${label ? ` (${label})` : ""}\n${cl.join("\n")}`;
    })
    .join("\n");
}

/** Where a claim came from, as shown to the model: the URL, or the owner. */
export function claimSource(c: Row): string {
  const src = j<Row>(c.source, {});
  if (src.type === "url" && /^https?:/.test(src.ref ?? "")) return src.ref;
  if (src.type === "owner") return `told by ${config.owner.name}`;
  return "";
}

/** The URLs behind a set of notes' current claims (for results answered from memory). */
export function noteUrls(notes: NoteView[]): string[] {
  const urls = notes.flatMap((n) => n.claims.filter((c) => !c.stale).map((c) => j<Row>(c.source, {})))
    .filter((s) => s.type === "url" && /^https?:/.test(s.ref ?? "")).map((s) => s.ref as string);
  return [...new Set(urls)];
}

export function profileText(): string {
  const p = db().get(`SELECT * FROM notes WHERE kind='profile' AND status='active'`);
  if (!p) return "";
  return db().all(`SELECT text FROM claims WHERE note_id=? AND status='active' ORDER BY observed_at`, p.id).map((c) => `- ${c.text}`).join("\n").slice(0, 1200);
}

export function indexNote(id: string) {
  const n = db().get(`SELECT * FROM notes WHERE id=?`, id);
  db().run(`DELETE FROM notes_fts WHERE id=?`, id);
  if (!n) return;
  const body = db().all(`SELECT text FROM claims WHERE note_id=? AND status='active'`, id).map((c) => c.text).join(" ");
  db().run(`INSERT INTO notes_fts (id, title, aliases, one_liner, body) VALUES (?,?,?,?,?)`, id, n.title, j<string[]>(n.aliases, []).join(" "), n.one_liner, body);
}
