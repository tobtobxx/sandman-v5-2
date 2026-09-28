// The board (DESIGN §5): cards, dependencies, comments and the card state machine.
// Every state change goes through transition(), which writes cards + card_events in one transaction.

import { db, j, nowIso, Row } from "../db.ts";
import { newId } from "../ids.ts";
import { emit } from "../events.ts";
import { config } from "../config.ts";

export type State = "new" | "ready" | "running" | "waiting" | "blocked" | "verifying" | "done" | "failed" | "cancelled";
export const TERMINAL: State[] = ["done", "failed", "cancelled"];

const ALLOWED: Record<string, State[]> = {
  new: ["verifying", "blocked", "ready", "waiting", "cancelled", "done", "failed"],
  ready: ["running", "cancelled", "done", "blocked"],
  running: ["verifying", "blocked", "ready", "failed", "cancelled", "waiting"],
  waiting: ["waiting", "ready", "cancelled"],
  blocked: ["new", "ready", "cancelled", "failed"],
  verifying: ["done", "ready", "blocked", "failed", "cancelled"],
  done: ["cancelled"],
  failed: [],
  cancelled: [],
};

export interface Card {
  id: string;
  kind: string;
  role: string;
  title: string;
  goal: string;
  original_goal: string | null;
  done_when: string[];
  constraints: string[];
  inputs: string[];
  depth: number;
  parent_id: string | null;
  root_id: string;
  origin_topic_id: string | null;
  state: State;
  blocked_reason: string | null;
  phase: string;
  attempt: number;
  priority: string;
  created_by: string;
  recipe_id: string | null;
  recipe_step: string | null;
  recipe_params: Record<string, any> | null;
  fanout_item: Record<string, any> | null;
  due_at: string | null;
  result: Record<string, any> | null;
  result_source: string | null;
  llm_calls_used: number;
  created_at: string;
}

export function parseCard(r: Row | undefined): Card | null {
  if (!r) return null;
  return {
    ...r,
    done_when: j(r.done_when, []),
    constraints: j(r.constraints, []),
    inputs: j(r.inputs, []),
    recipe_params: j(r.recipe_params, null),
    fanout_item: j(r.fanout_item, null),
    result: j(r.result, null),
  } as Card;
}

export function getCard(id: string): Card {
  const c = parseCard(db().get(`SELECT * FROM cards WHERE id=?`, id));
  if (!c) throw new Error(`no card ${id}`);
  return c;
}

export function createCard(f: Partial<Card> & { title: string; goal?: string; kind?: string }): Card {
  const id = newId("crd");
  const parent = f.parent_id ? getCard(f.parent_id) : null;
  const row: Row = {
    id,
    kind: f.kind ?? "task",
    role: f.role ?? "research",
    title: f.title,
    goal: f.goal ?? f.title,
    done_when: f.done_when ?? [],
    constraints: f.constraints ?? [],
    inputs: f.inputs ?? [],
    depth: parent ? 1 : 0,
    parent_id: f.parent_id ?? null,
    root_id: parent ? parent.root_id : id,
    origin_topic_id: f.origin_topic_id ?? parent?.origin_topic_id ?? null,
    state: f.state ?? (f.kind === "reminder" ? "ready" : "new"),
    phase: "execute",
    attempt: 1,
    priority: f.priority ?? "normal",
    created_by: f.created_by ?? "owner",
    recipe_id: f.recipe_id ?? null,
    recipe_step: f.recipe_step ?? null,
    recipe_params: f.recipe_params ?? null,
    fanout_item: f.fanout_item ?? null,
    due_at: f.due_at ?? null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  db().tx(() => {
    db().insert("cards", row);
    db().insert("card_events", { card_id: id, from_state: null, to_state: row.state, event: "created", actor: row.created_by, at: nowIso() });
    if (parent) db().insert("card_deps", { card_id: parent.id, depends_on: id });
  });
  emit("card.created", { topic_id: row.origin_topic_id, ref_id: id, payload: { id, title: row.title, state: row.state, kind: row.kind } });
  return getCard(id);
}

export function transition(id: string, to: State, event: string, actor = "harness", patch: Row = {}, payload: any = {}): Card {
  const c = getCard(id);
  if (!ALLOWED[c.state].includes(to)) throw new Error(`illegal transition ${c.state} → ${to} (${event}) on ${id}`);
  db().tx(() => {
    db().update("cards", id, { ...patch, state: to, updated_at: nowIso() });
    db().insert("card_events", { card_id: id, from_state: c.state, to_state: to, event, actor, payload, at: nowIso() });
  });
  emit("card.state", { topic_id: c.origin_topic_id, ref_id: id, payload: { id, title: c.title, from: c.state, to, event } });
  const after = getCard(id);
  if (TERMINAL.includes(to)) onTerminal(after);
  return after;
}

export function addComment(card_id: string, author: string, body: string) {
  const id = newId("cmt");
  db().insert("comments", { id, card_id, author, body, created_at: nowIso() });
  emit("card.comment", { ref_id: card_id, payload: { id, card_id, author, body } });
  return id;
}

export function comments(card_id: string): Row[] {
  return db().all(`SELECT * FROM comments WHERE card_id=? ORDER BY created_at, rowid`, card_id);
}

export function children(id: string): Card[] {
  return db().all(`SELECT * FROM cards WHERE parent_id=? ORDER BY created_at, rowid`, id).map((r) => parseCard(r)!);
}

export function cancelCard(id: string, actor = "owner") {
  const c = getCard(id);
  for (const ch of children(id)) if (!TERMINAL.includes(ch.state)) cancelCard(ch.id, actor);
  if (!TERMINAL.includes(c.state) || c.state === "done") {
    if (c.state !== "cancelled") transition(id, "cancelled", "cancel", actor);
  }
  db().run(`UPDATE questions SET status='expired' WHERE card_id=? AND status='open'`, id);
}

export function countCall(card: Card) {
  db().run(`UPDATE cards SET llm_calls_used = llm_calls_used + 1 WHERE id=?`, card.root_id);
}

export function treeCallsUsed(card: Card): number {
  return db().get(`SELECT llm_calls_used n FROM cards WHERE id=?`, card.root_id)?.n ?? 0;
}

// ---- terminal hooks (§5.9) ----
type Hook = (c: Card) => void;
const terminalHooks: Hook[] = [];
export function onCardTerminal(h: Hook) {
  terminalHooks.push(h);
}
function onTerminal(c: Card) {
  for (const h of terminalHooks) h(c);
}

export function maxSteps(role: string) {
  return config.roles[role]?.steps ?? 8;
}
