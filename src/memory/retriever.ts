// Memory retrieval (DESIGN §7.6): exact/alias lookup + FTS, staleness computed in code.

import { db, ftsQuery, ftsWords, j, now, Row } from "../db.ts";
import { config } from "../config.ts";

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

/** Notes relevant to a text, plus exact matches for named entities. */
export function findNotes(text: string, entities: string[] = [], k = config.memory.top_k): NoteView[] {
  const seen = new Map<string, Row>();
  for (const e of entities) {
    const low = e.toLowerCase();
    for (const n of db().all(`SELECT * FROM notes WHERE status='active' AND kind != 'profile'`)) {
      const names = [n.title, ...j<string[]>(n.aliases, [])].map((x) => x.toLowerCase());
      if (names.includes(low)) seen.set(n.id, n);
    }
  }
  const q = ftsQuery([text, ...entities].join(" "));
  if (q) {
    for (const r of db().all(`SELECT id FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?`, q, k * 2)) {
      if (seen.size >= k) break;
      const n = db().get(`SELECT * FROM notes WHERE id=? AND status='active' AND kind != 'profile'`, r.id);
      if (n) seen.set(n.id, n);
    }
  }
  const notes = [...seen.values()].slice(0, k).map(noteView).filter((v) => v.claims.length);
  return [...notes, ...findPendingFacts(text, entities, Math.ceil(k / 2))];
}

// Candidate facts wait for the consolidator (≥20 pending, or nightly). Until then they are shown as
// unreviewed notes, one per subject, so what a card found today can be used by the next card.
// There are few of them, so they are matched in code: at least two words shared with the query (one if the
// query has one; a word of 4+ letters may be the start of a longer one), or the subject named exactly. Negative results are left out until reviewed: an owner who
// asks to try again right after a failed search should get a new search, not the failure back.
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "");

export function findPendingFacts(text: string, entities: string[] = [], k = 3): NoteView[] {
  const words = new Set([...ftsWords(fold(text)), ...ftsWords(fold(entities.join(" ")))]);
  const ents = new Set(entities.map((e) => fold(e.toLowerCase())));
  const groups = new Map<string, { score: number; facts: Row[] }>();
  const need = Math.min(2, words.size);
  for (const f of db().all(`SELECT * FROM facts WHERE status='pending' ORDER BY created_at DESC LIMIT 200`)) {
    if (j<Row>(f.source, {}).negative) continue;
    const subj = fold(String(f.subject ?? "").toLowerCase().trim());
    const have = new Set(fold(`${f.subject} ${f.text}`.toLowerCase()).match(/[\p{L}\p{N}]{3,}/gu) ?? []);
    // a word of 4+ letters also matches the start of a longer one: "wald" finds "waldlabor"
    let score = [...words].filter((w) => have.has(w) || (w.length >= 4 && [...have].some((h) => h.startsWith(w)))).length;
    if (ents.has(subj)) score += 10;
    const g = groups.get(subj) ?? { score: 0, facts: [] };
    g.score = Math.max(g.score, score);
    if (!g.facts.some((x) => x.text === f.text)) g.facts.push(f);
    groups.set(subj, g);
  }
  return [...groups.values()]
    .filter((g) => need > 0 && g.score >= need)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((g) => {
      const f0 = g.facts[0];
      const claims = g.facts.map((f) => {
        const c = { text: f.text, source: f.source, observed_at: f.created_at, volatility: f.volatility };
        return { ...c, stale: isStale(c) };
      });
      return { id: f0.id, kind: "entity", title: String(f0.subject), one_liner: "", claims, answerable: claims.some((c) => !c.stale), pending: true };
    });
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
