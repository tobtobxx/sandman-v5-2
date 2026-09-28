// Recipes (DESIGN §5.6, §7.8). Seeded in code; stored in the recipes table for FTS and the UI.

import { db } from "../db.ts";

export interface RecipeStep {
  key: string;
  role: string;
  title: string;
  goal: string;
  done_when: string[];
  result_items?: boolean;
  fanout?: { from: string; max: string };
}
export interface Recipe {
  id: string;
  title: string;
  description: string;
  params: Record<string, string>;
  steps: RecipeStep[];
}

export const RECIPES: Recipe[] = [
  {
    id: "rcp_research_detail",
    title: "Research candidates, detail each, then compare",
    description: "For choosing ONE thing among several options of the same kind (e.g. which kit to buy), or comparing several named things of the same kind.",
    params: {
      subject: "what kind of thing to find, e.g. 'drip irrigation kits'",
      criteria: "only the qualities to compare, quoted from the request, e.g. 'price and coverage' (not the whole request)",
      max_items: "how many to detail: the number of named things if the owner named them, else 3 unless the owner asked for another number (at most 5)",
    },
    steps: [
      {
        key: "gather",
        role: "research",
        title: "Find candidate {subject}",
        goal: "Find candidate {subject} for this request: {request}. List the best ones you find, at most {max_items}; fewer is fine. If the owner named them, list those.",
        done_when: ["Lists candidate {subject} (at most {max_items}), each with a name and one line why it fits"],
        result_items: true,
      },
      {
        key: "detail",
        role: "research",
        fanout: { from: "gather", max: "{max_items}" },
        title: "Detail {item.name}",
        goal: "Find {criteria} for {item.name} ({item.note}).",
        done_when: ["Covers {criteria} for {item.name}, or states which of them are not available"],
      },
    ],
  },
  {
    id: "rcp_research_write",
    title: "Research the facts, then write the text",
    description: "For writing ONE text (an email or a letter) that needs a few facts looked up first.",
    params: {
      document: "the text to write, e.g. 'an email to the landlord'",
      topics: "the facts that must be looked up, quoted from the request",
    },
    steps: [
      {
        key: "gather",
        role: "research",
        title: "Collect facts for {document}",
        goal: "Find {topics}. They are needed to write {document}.",
        done_when: ["Covers {topics}, or states which of them are not available"],
      },
    ],
  },
];

export function seedRecipes() {
  for (const r of RECIPES) {
    if (db().get(`SELECT id FROM recipes WHERE id=?`, r.id)) continue;
    db().insert("recipes", { id: r.id, title: r.title, description: r.description, body: JSON.stringify(r) });
    db().run(`INSERT INTO recipes_fts (id, title, description) VALUES (?,?,?)`, r.id, r.title, r.description);
  }
}

export function getRecipe(id: string): Recipe | null {
  return RECIPES.find((r) => r.id === id) ?? null;
}

export function fill(tpl: string, params: Record<string, any>): string {
  return tpl.replace(/\{([\w.]+)\}/g, (m, k) => {
    const v = k.split(".").reduce((o: any, p: string) => (o == null ? undefined : o[p]), params);
    return v === undefined || v === null ? m : String(v);
  });
}
