// Librarian → triage → planner (DESIGN §5.4–5.6, §7.6). Runs on cards in state `new`.

import { db, ftsQuery, Row } from "../db.ts";
import { config } from "../config.ts";
import { llmJson } from "../llm/gateway.ts";
import * as W from "../prompts/work.ts";
import { addComment, Card, createCard, getCard, maxSteps, transition } from "./board.ts";
import { fill, getRecipe, RECIPES } from "./recipes.ts";
import { findNotes, profileText, renderNotes } from "../memory/retriever.ts";
import { createQuestion } from "../conversation/questions.ts";
import { endSession, startSession } from "../trace.ts";

const ask = <T>(name: string, p: W.P, card: Card, session_id?: string) =>
  llmJson<T>(name, p.prompt, p.schema, { maxTokens: p.maxTokens, version: p.version, card_id: card.id, topic_id: card.origin_topic_id ?? undefined, session_id });

export async function preflight(card_id: string): Promise<string> {
  let card = getCard(card_id);
  const lib = await runLibrarian(card);
  if (lib === "answered") return "answered";
  card = getCard(card_id);
  if (card.depth > 0) {
    transition(card.id, "ready", "child_ready", "harness");
    return "ready";
  }
  return await runTriage(card);
}

// ---------------------------------------------------------------- librarian
export async function runLibrarian(card: Card): Promise<"answered" | "narrow" | "proceed"> {
  const hasNotes = db().get(`SELECT count(*) n FROM notes WHERE status='active' AND kind != 'profile'`)!.n > 0;
  if (!hasNotes) return "proceed";
  const session_id = startSession("librarian", { card_id: card.id });
  const ent = await ask<{ entities: string[] }>("extract_entities", W.extractEntities(card), card, session_id);
  const notes = findNotes(`${card.title} ${card.goal}`, ent.entities);
  if (!notes.length) return endSession(session_id, "proceed:no_notes"), "proceed";
  const answerable = notes.filter((n) => n.answerable).map((n) => n.id);
  const text = renderNotes(notes);
  const r = await ask<Row>("librarian", W.librarian({ goal: card.goal, done_when: card.done_when, notes: text, answerable }), card, session_id);
  const ids = (r.answer_note_ids ?? []).filter((id: string) => answerable.includes(id));
  if (r.verdict === "answered" && ids.length) {
    const used = notes.filter((n) => ids.includes(n.id));
    const a = await ask<{ summary: string }>("render_answer", W.renderAnswer({ goal: card.goal, notes: renderNotes(used) }), card, session_id);
    endSession(session_id, "answered");
    transition(card.id, "verifying", "librarian_answered", "librarian", { result: { summary: a.summary, facts: [], source: "memory", notes: ids }, result_source: "memory" });
    return "answered";
  }
  if (r.verdict === "narrow" && r.narrowed_goal) {
    db().update("cards", card.id, { original_goal: card.goal, goal: r.narrowed_goal });
    addComment(card.id, "librarian", `Narrowed using ${notes.map((n) => n.id).join(", ")}. Original goal: ${card.goal}`);
    endSession(session_id, "narrow");
    return "narrow";
  }
  endSession(session_id, "proceed");
  return "proceed";
}

// ---------------------------------------------------------------- triage
/** The triage decision alone (no side effects). */
export const COMPARE_SPLIT_THRESHOLD = 3; // DESIGN §19 open question 1: comparing ≥3 things always splits

export async function triageDecide(card: Card, session_id?: string): Promise<{ analysis: string; fits: string; missing_info: string | null; compare_count?: number }> {
  const r = await ask<Row>("triage", W.triage({
    title: card.title, goal: card.goal, done_when: card.done_when, steps: maxSteps(card.role), tools: config.roles[card.role].tools,
    recipes: RECIPES.map((r) => r.title), owner: profileText(),
  }), card, session_id);
  const m = r.missing_info && String(r.missing_info).trim();
  const fits = (r.compare_count ?? 0) >= COMPARE_SPLIT_THRESHOLD ? "no" : r.fits; // code rule, not the model
  return { analysis: r.analysis, fits, missing_info: m && !/^(null|none|n\/a)$/i.test(m) ? m : null, compare_count: r.compare_count };
}

export async function runTriage(card: Card): Promise<string> {
  const session_id = startSession("triage", { card_id: card.id });
  const r = await triageDecide(card, session_id);
  if (r.missing_info) {
    endSession(session_id, "missing_info");
    const q = createQuestion({ card_id: card.id, topic_id: card.origin_topic_id, text: r.missing_info, options: [], reason: "missing_info" });
    transition(card.id, "blocked", "missing_info", "triage", { blocked_reason: "missing_info" }, { question_id: q.id });
    return "blocked";
  }
  if (r.fits === "yes") {
    endSession(session_id, "fits");
    transition(card.id, "ready", "triage_fits", "triage");
    return "ready";
  }
  endSession(session_id, "split");
  return await runPlanner(card);
}

// ---------------------------------------------------------------- planner
function ownerRequest(card: Card): string {
  const t = db().get(
    `SELECT d.input_text FROM receipts r JOIN desk_turns d ON d.id = r.desk_turn_id WHERE r.ref_id=? AND r.kind='card_created'`,
    card.id,
  );
  return t?.input_text ?? `${card.title}. ${card.goal}`;
}

export async function runPlanner(card: Card): Promise<string> {
  const session_id = startSession("planner", { card_id: card.id });
  const q = ftsQuery(card.goal);
  let recipes = q ? db().all(`SELECT id FROM recipes_fts WHERE recipes_fts MATCH ? LIMIT 6`, q).map((r) => getRecipe(r.id)!).filter(Boolean) : [];
  if (!recipes.length) recipes = RECIPES.slice(0, 6);
  // FTS only narrows the list shown; keep all seeds when there are few
  if (RECIPES.length <= 6) recipes = RECIPES;
  const pick = await ask<Row>("pick_recipe", W.pickRecipe({ title: card.title, goal: card.goal, recipes }), card, session_id);
  const recipe = pick.recipe_id !== "none" ? getRecipe(pick.recipe_id) : null;
  if (recipe) {
    const request = ownerRequest(card);
    const fillP = W.planFill({ request, goal: card.goal, params: recipe.params });
    let params = await ask<Row>("plan_fill", fillP, card, session_id);
    // code guard: criteria must be a short list of qualities, not the request itself
    const badCriteria = (p: Row) => typeof p.criteria === "string" && (p.criteria.length > 120 || /\b(compare|recommend)\b/i.test(p.criteria));
    if (badCriteria(params)) params = await llmJson<Row>("plan_fill", fillP.prompt, fillP.schema, { maxTokens: fillP.maxTokens, version: fillP.version, card_id: card.id, session_id, temperature: 0 });
    if (badCriteria(params)) params.criteria = "the qualities the owner asked about";
    if (params.max_items !== undefined) params.max_items = Math.max(1, Math.min(config.board.max_children, Number(params.max_items) || 3));
    params.request = request;
    db().update("cards", card.id, { recipe_id: recipe.id, recipe_params: params });
    for (const s of recipe.steps.filter((s) => !s.fanout)) {
      createCard({
        parent_id: card.id, role: s.role, title: fill(s.title, params), goal: fill(s.goal, params), done_when: s.done_when.map((d) => fill(d, params)),
        constraints: card.constraints, created_by: "planner", recipe_id: recipe.id, recipe_step: s.key, recipe_params: params, inputs: card.inputs,
      });
    }
    endSession(session_id, `recipe:${recipe.id}`);
  } else {
    const plan = await ask<Row>("plan_generate", W.planGenerate({ title: card.title, goal: card.goal, done_when: card.done_when }), card, session_id);
    for (const s of plan.subtasks.slice(0, config.board.max_children)) {
      createCard({ parent_id: card.id, role: "research", title: s.title, goal: s.goal, done_when: s.done_when, constraints: card.constraints, created_by: "planner", inputs: card.inputs });
    }
    endSession(session_id, "free_plan");
  }
  transition(card.id, "waiting", "planned", "planner");
  return "waiting";
}

/** Fan-out (§5.6): when a result_items step finishes, create one child per item. */
export function fanOut(child: Card) {
  if (!child.parent_id || !child.recipe_id || child.state !== "done") return;
  const recipe = getRecipe(child.recipe_id);
  const parent = getCard(child.parent_id);
  if (!recipe) return;
  const params = parent.recipe_params ?? {};
  for (const s of recipe.steps.filter((s) => s.fanout?.from === child.recipe_step)) {
    const max = Math.min(config.board.max_children, Number(fill(s.fanout!.max, params)) || config.board.max_children);
    for (const item of (child.result?.items ?? []).slice(0, max)) {
      const p = { ...params, item };
      createCard({
        parent_id: parent.id, role: s.role, title: fill(s.title, p), goal: fill(s.goal, p), done_when: s.done_when.map((d) => fill(d, p)),
        constraints: parent.constraints, created_by: "planner", recipe_id: recipe.id, recipe_step: s.key, fanout_item: item,
      });
    }
  }
}
