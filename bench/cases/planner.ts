// Planner (§5.6): pick_recipe, plan_fill (criteria quoted, never invented), plan_generate.

import { all, Case, has } from "../lib.ts";
import { llmJson } from "../../src/llm/gateway.ts";
import * as W from "../../src/prompts/work.ts";
import { RECIPES } from "../../src/work/recipes.ts";

const ask = (name: string, p: W.P) => llmJson<any>(name, p.prompt, p.schema, { maxTokens: p.maxTokens, version: p.version });

function pick(name: string, title: string, goal: string, want: string): Case {
  return {
    id: `planner/pick-${name}`,
    run: () => ask("pick_recipe", W.pickRecipe({ title, goal, recipes: RECIPES })),
    check: (o) => ({ pass: o.recipe_id === want, detail: `got ${o.recipe_id}, want ${want}. ${o.analysis}` }),
  };
}

const COMPARE = "compare the Gardena, Hozelock and AquaLine drip kits on price and coverage for my 3 raised beds and recommend one";

export const cases: Case[] = [
  pick("compare", "Compare drip kits", COMPARE, "rcp_research_detail"),
  pick("choose-among", "Find a dentist", "Find 3 dentists near Oerlikon that take new patients, and recommend the one with the best reviews.", "rcp_research_detail"),
  pick("research-then-write", "Email to accountant", "Write an email to my accountant asking them to request the tax extension, including the current extension deadlines and fees for Zurich, which need to be looked up.", "rcp_research_write"),
  pick("none", "Plan Portugal trip", "Plan a 10-day trip through Portugal in October with hotels, trains and a day-by-day itinerary.", "none"),
  {
    id: "planner/fill-compare-quotes-criteria",
    run: () => ask("plan_fill", W.planFill({ request: COMPARE, goal: COMPARE, params: RECIPES[0].params })),
    check: (o) => all(
      [has(o.criteria, "price") && has(o.criteria, "coverage"), `criteria: ${o.criteria}`],
      [!/warrant|review|durab|install|water use|quality|brand/i.test(o.criteria), `invented criteria: ${o.criteria}`],
      [Number(o.max_items) === 3, `max_items ${o.max_items}`],
      [has(o.subject, "drip"), `subject ${o.subject}`],
    ),
  },
  {
    id: "planner/fill-choose-among",
    run: () => ask("plan_fill", W.planFill({ request: "find me a quiet robot vacuum for a small flat with cats, under 400 francs", goal: "Find a quiet robot vacuum for a small flat with cats, under CHF 400", params: RECIPES[0].params })),
    check: (o) => all(
      [/quiet|noise|loud/i.test(o.criteria) && /cat|hair|pet/i.test(o.criteria) && /400|price|budget/i.test(o.criteria), `criteria: ${o.criteria}`],
      [Number(o.max_items) >= 2 && Number(o.max_items) <= 5, `max_items ${o.max_items}`],
    ),
  },
  {
    id: "planner/generate-trip",
    run: () => ask("plan_generate", W.planGenerate({ title: "Plan Portugal trip", goal: "Plan a 10-day trip through Portugal in October with hotels, trains and a day-by-day itinerary.", done_when: ["Includes a day-by-day plan", "Names a hotel for each night"] })),
    check: (o) => all(
      [o.subtasks.length >= 2 && o.subtasks.length <= 5, `${o.subtasks.length} subtasks`],
      [o.subtasks.every((s: any) => s.done_when.length >= 1), "missing done_when"],
    ),
    judge: {
      criteria: [
        "Each subtask can be done on its own, without needing the result of another subtask",
        "No subtask only combines or summarizes the results of the other subtasks",
      ],
      material: (o) => o.subtasks.map((s: any, i: number) => `${i + 1}. [${s.role}] ${s.title}: ${s.goal} (done when: ${s.done_when.join("; ")})`).join("\n"),
    },
  },
];
