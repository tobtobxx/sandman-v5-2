// Builds every prompt once with sample inputs and lints its schema (P3: reasoning key sorts first).

import { lintSchema } from "../llm/schema.ts";
import * as W from "./work.ts";
import * as C from "./conversation.ts";
import * as M from "./memory.ts";

export function samplePrompts(): Record<string, W.P> {
  const desk: C.DeskCtx = {
    owner: "Alex", mode: "capture", topic_title: "T", topic_summary: "", profile: "", history: [], cards: [{ id: "crd_1", line: "x" }],
    questions: [{ id: "qst_1", line: "q" }], memory: "", input: "i", receipts: [], now: "now",
  };
  return {
    triage: W.triage({ title: "t", goal: "g", done_when: [], steps: 5, tools: ["web_search"], recipes: [] }),
    pick_recipe: W.pickRecipe({ title: "t", goal: "g", recipes: [{ id: "r", title: "t", description: "d" }] }),
    plan_fill: W.planFill({ request: "r", goal: "g", params: { subject: "s", criteria: "c", max_items: "m" } }),
    plan_generate: W.planGenerate({ title: "t", goal: "g", done_when: [] }),
    worker_step: W.workerStep({ role: "research", tools: ["web_search", "web_fetch"], withItems: true, owner: "", title: "t", goal: "g", done_when: [], constraints: [], memory: "", inputs: "", comments: [], steps: [], step: 1, maxSteps: 3 }),
    verify_criterion: W.verifyCriterion({ criterion: "c", result: "r", recorded: "", excerpts: "" }),
    extract_entities: W.extractEntities({ title: "t", goal: "g" }),
    librarian: W.librarian({ goal: "g", done_when: [], notes: "", answerable: ["not_1"] }),
    render_answer: W.renderAnswer({ goal: "g", notes: "" }),
    segment_capture: C.segmentCapture({ transcript: "t" }),
    route_item: C.routeItem({ quote: "q", candidates: [{ slug: "a", title: "A", summary: "" }] }),
    topic_title: C.topicTitle({ quote: "q" }),
    match_answer: C.matchAnswer({ question: "q", options: ["a", "b"], answer: "a" }),
    topic_same: C.topicSame({ a: "a", b: "b" }),
    desk_intent: C.deskIntent({ ...desk, intents: ["new_work", "done"] }),
    desk_more: C.deskMore(desk),
    desk_args_new_work: C.deskArgsNewWork(desk),
    desk_args_reminder: C.deskArgsReminder(desk),
    desk_args_answer: C.deskArgsAnswer(desk),
    desk_args_add: C.deskArgsAdd(desk),
    desk_args_cancel: C.deskArgsCancel(desk),
    resolve_when: C.resolveWhen({ when_text: "w", now: "n", days: ["2026-01-01 thursday"] }),
    extract_owner_facts: C.extractOwnerFacts({ owner: "Alex", messages: [] }),
    match_subject: M.matchSubject({ subject: "s", claim: "c", notes: [{ id: "not_1", title: "t", one_liner: "" }] }),
    relevance_rubric: M.relevanceRubric({ subject: "s", claim: "c", source: "s", card_title: "t" }),
    consolidate_fact: M.consolidateFact({ note_title: "n", claim: "c", claims: [{ id: "clm_1", text: "t", date: "d" }] }),
  };
}

export function lintAll(): string[] {
  const out: string[] = [];
  for (const [name, p] of Object.entries(samplePrompts())) for (const e of lintSchema(p.schema)) out.push(`${name}: ${e}`);
  return out;
}
